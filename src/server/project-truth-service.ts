import { randomUUID } from "node:crypto";
import type { PoolClient, QueryResultRow } from "pg";
import {
  approveProjectFactCommandSchema,
  createProjectTruthSnapshotCommandSchema,
  proposeProjectFactCommandSchema,
  rejectProjectFactCommandSchema,
  supersedeProjectFactCommandSchema,
  type ProjectFactRevisionView,
  type ProjectFactStatus,
  type ProjectFactView,
  type ProjectTruthSnapshotView,
} from "@/core/truth/project-fact-schema";
import {
  projectFactRevisionHash,
  type JsonValue,
} from "@/core/truth/project-truth-hash";
import {
  assertExpectedFactRevision,
  assertProposalCanBeCreated,
  assertResolvableProposal,
  assertTemporalRange,
  projectionAfterApproval,
  projectionAfterProposal,
  projectionAfterRejection,
  projectionAfterSupersede,
  ProjectTruthPolicyError,
  type FactPolicyRevision,
  type FactPolicyState,
} from "@/core/truth/project-truth-policy";
import {
  freezeProjectTruthSnapshot,
  ProjectTruthSnapshotError,
  type SnapshotFactCandidate,
} from "@/core/truth/project-truth-snapshot";
import { readDatabaseCommandTime } from "@/server/database-clock";
import { databaseQuery, transaction } from "@/server/db";
import { HttpCommandError } from "@/server/errors";

const PROJECT_FACT_SCHEMA_VERSION = "project-fact/v1";
type Queryable = Pick<PoolClient, "query">;

async function runWithOptionalClient<T>(
  client: PoolClient | undefined,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return client ? work(client) : transaction(work);
}

function assertUuid(value: string, label: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new HttpCommandError(400, "INVALID_IDENTIFIER", `${label} must be a valid UUID.`);
  }
}

function asIso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function asJson<T>(value: unknown): T {
  if (typeof value === "string") return JSON.parse(value) as T;
  return value as T;
}

function postgresCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code ?? "")
    : undefined;
}

function policyError(error: unknown): never {
  if (error instanceof ProjectTruthPolicyError || error instanceof ProjectTruthSnapshotError) {
    const conflictCodes = new Set([
      "REVISION_CONFLICT",
      "UNRESOLVED_FACT_PROPOSAL_EXISTS",
      "FACT_PROPOSAL_ALREADY_DECIDED",
      "CURRENT_APPROVED_FACT_REQUIRES_SUPERSEDE",
      "CURRENT_APPROVED_FACT_MISMATCH",
    ]);
    throw new HttpCommandError(conflictCodes.has(error.code) ? 409 : 422, error.code, error.message);
  }
  if (postgresCode(error) === "23505") {
    throw new HttpCommandError(
      409,
      "PROJECT_TRUTH_UNIQUE_CONFLICT",
      "A concurrent Project Truth command created a conflicting authoritative identity.",
    );
  }
  if (postgresCode(error) === "23503") {
    throw new HttpCommandError(
      409,
      "PROJECT_TRUTH_REFERENCE_CONFLICT",
      "A Project Truth command references an identity that is not available in the same authoritative scope.",
    );
  }
  if (postgresCode(error) === "23514") {
    throw new HttpCommandError(422, "PROJECT_TRUTH_CONSTRAINT_VIOLATION", "A Project Truth constraint rejected the command.");
  }
  throw error;
}

type FactRow = QueryResultRow & {
  id: string;
  project_context_id: string;
  fact_key: string;
  fact_type: string;
  current_revision: string | number;
  current_status: ProjectFactStatus;
  current_fact_revision_id: string;
  created_at: Date | string;
  updated_at: Date | string;
};

type RevisionRow = QueryResultRow & {
  id: string;
  project_fact_id: string;
  revision: string | number;
  value_json: JsonValue | string;
  status: ProjectFactStatus;
  valid_from: Date | string;
  valid_until: Date | string | null;
  source_proposal_revision_id: string | null;
  supersedes_revision_id: string | null;
  provenance_json: Record<string, JsonValue> | string;
  owner_decision_id: string | null;
  content_sha256: string;
  created_at: Date | string;
};

type SnapshotRow = QueryResultRow & {
  id: string;
  project_context_id: string;
  snapshot_version: string;
  effective_at: Date | string;
  selected_fact_revision_ids: string[] | string;
  content_sha256: string;
  created_by_authority: string;
  created_at: Date | string;
};

function unresolvedProposalIds(revisions: RevisionRow[]): string[] {
  const decided = new Set(
    revisions
      .map(revision => revision.source_proposal_revision_id)
      .filter((id): id is string => Boolean(id)),
  );
  return revisions
    .filter(revision => revision.status === "PROPOSED" && !decided.has(revision.id))
    .map(revision => revision.id);
}

function mapRevision(row: RevisionRow, unresolved: Set<string>): ProjectFactRevisionView {
  return {
    id: row.id,
    projectFactId: row.project_fact_id,
    revision: Number(row.revision),
    value: asJson<JsonValue>(row.value_json),
    status: row.status,
    validFrom: asIso(row.valid_from),
    ...(row.valid_until ? { validUntil: asIso(row.valid_until) } : {}),
    ...(row.source_proposal_revision_id ? { sourceProposalRevisionId: row.source_proposal_revision_id } : {}),
    ...(row.supersedes_revision_id ? { supersedesRevisionId: row.supersedes_revision_id } : {}),
    provenance: asJson<Record<string, JsonValue>>(row.provenance_json),
    ...(row.owner_decision_id ? { ownerDecisionId: row.owner_decision_id } : {}),
    contentSha256: row.content_sha256,
    createdAt: asIso(row.created_at),
    unresolvedProposal: unresolved.has(row.id),
  };
}

function mapFact(row: FactRow, revisions: RevisionRow[]): ProjectFactView {
  const unresolved = new Set(unresolvedProposalIds(revisions));
  const mapped = revisions.map(revision => mapRevision(revision, unresolved));
  const current = mapped.find(revision => revision.id === row.current_fact_revision_id);
  if (!current) {
    throw new HttpCommandError(500, "PROJECT_FACT_PROJECTION_INVALID", "The Project Fact current revision is missing from its immutable history.");
  }
  return {
    id: row.id,
    projectContextId: row.project_context_id,
    factKey: row.fact_key,
    factType: row.fact_type,
    currentRevision: Number(row.current_revision),
    currentStatus: row.current_status,
    currentFactRevisionId: row.current_fact_revision_id,
    createdAt: asIso(row.created_at),
    updatedAt: asIso(row.updated_at),
    current,
    revisions: mapped,
  };
}

function toPolicyRevision(row: RevisionRow): FactPolicyRevision {
  return {
    id: row.id,
    revision: Number(row.revision),
    status: row.status,
    value: asJson<JsonValue>(row.value_json),
    validFrom: asIso(row.valid_from),
    ...(row.valid_until ? { validUntil: asIso(row.valid_until) } : {}),
    ...(row.source_proposal_revision_id ? { sourceProposalRevisionId: row.source_proposal_revision_id } : {}),
    ...(row.supersedes_revision_id ? { supersedesRevisionId: row.supersedes_revision_id } : {}),
  };
}

function toPolicyState(fact: FactRow, revisions: RevisionRow[]): FactPolicyState {
  const current = revisions.find(revision => revision.id === fact.current_fact_revision_id);
  if (!current) {
    throw new HttpCommandError(500, "PROJECT_FACT_PROJECTION_INVALID", "The Project Fact projection references missing history.");
  }
  return {
    currentRevision: Number(fact.current_revision),
    currentStatus: fact.current_status,
    currentFactRevisionId: fact.current_fact_revision_id,
    current: toPolicyRevision(current),
    unresolvedProposalIds: unresolvedProposalIds(revisions),
  };
}

async function loadFactRows(queryable: Queryable, projectContextId?: string, projectFactId?: string): Promise<{
  facts: FactRow[];
  revisionsByFact: Map<string, RevisionRow[]>;
}> {
  const conditions: string[] = [];
  const values: unknown[] = [];
  if (projectContextId) {
    values.push(projectContextId);
    conditions.push(`pf.project_context_id=$${values.length}`);
  }
  if (projectFactId) {
    values.push(projectFactId);
    conditions.push(`pf.id=$${values.length}`);
  }
  const facts = await queryable.query<FactRow>(
    `select pf.id,pf.project_context_id,pf.fact_key,pf.fact_type,pf.current_revision,
       pf.current_status,pf.current_fact_revision_id,pf.created_at,pf.updated_at
     from intentchord.project_facts pf
     ${conditions.length ? `where ${conditions.join(" and ")}` : ""}
     order by pf.fact_key,pf.id`,
    values,
  );
  if (!facts.rowCount) return { facts: [], revisionsByFact: new Map() };
  const revisions = await queryable.query<RevisionRow>(
    `select id,project_fact_id,revision,value_json,status,valid_from,valid_until,
       source_proposal_revision_id,supersedes_revision_id,provenance_json,
       owner_decision_id,content_sha256,created_at
     from intentchord.project_fact_revisions
     where project_fact_id=any($1::uuid[])
     order by project_fact_id,revision,id`,
    [facts.rows.map(row => row.id)],
  );
  const revisionsByFact = new Map<string, RevisionRow[]>();
  for (const revision of revisions.rows) {
    const rows = revisionsByFact.get(revision.project_fact_id) ?? [];
    rows.push(revision);
    revisionsByFact.set(revision.project_fact_id, rows);
  }
  return { facts: facts.rows, revisionsByFact };
}

async function loadFactForUpdate(client: PoolClient, projectFactId: string): Promise<{
  fact: FactRow;
  revisions: RevisionRow[];
}> {
  const factResult = await client.query<FactRow>(
    `select id,project_context_id,fact_key,fact_type,current_revision,current_status,
       current_fact_revision_id,created_at,updated_at
     from intentchord.project_facts where id=$1 for update`,
    [projectFactId],
  );
  const fact = factResult.rows[0];
  if (!fact) throw new HttpCommandError(404, "PROJECT_FACT_NOT_FOUND", "The Project Fact was not found.");
  const revisions = await client.query<RevisionRow>(
    `select id,project_fact_id,revision,value_json,status,valid_from,valid_until,
       source_proposal_revision_id,supersedes_revision_id,provenance_json,
       owner_decision_id,content_sha256,created_at
     from intentchord.project_fact_revisions
     where project_fact_id=$1 order by revision,id`,
    [projectFactId],
  );
  return { fact, revisions: revisions.rows };
}

async function appendFactAudit(
  client: PoolClient,
  input: {
    id?: string;
    projectFactId: string;
    eventType: string;
    actorAuthority: string;
    revision: number;
    metadata: Record<string, unknown>;
  },
): Promise<string> {
  const id = input.id ?? randomUUID();
  await client.query(
    `insert into intentchord.audit_events(
      id,aggregate_type,aggregate_id,event_type,actor_authority,related_revision,metadata
    ) values($1,'PROJECT_FACT',$2,$3,$4,$5,$6)`,
    [
      id,
      input.projectFactId,
      input.eventType,
      input.actorAuthority,
      input.revision,
      JSON.stringify({ schemaVersion: PROJECT_FACT_SCHEMA_VERSION, ...input.metadata }),
    ],
  );
  return id;
}

async function insertFactRevision(client: PoolClient, input: {
  id: string;
  projectContextId: string;
  projectFactId: string;
  factKey: string;
  factType: string;
  revision: number;
  value: JsonValue;
  status: ProjectFactStatus;
  validFrom: string;
  validUntil?: string;
  sourceProposalRevisionId?: string;
  supersedesRevisionId?: string;
  provenance: Record<string, JsonValue>;
  ownerDecisionId?: string;
  precomputedContentSha256?: string;
}): Promise<string> {
  assertTemporalRange(input.validFrom, input.validUntil);
  const calculatedContentSha256 = projectFactRevisionHash({
    schemaVersion: "project-fact-revision/v1",
    projectContextId: input.projectContextId,
    projectFactId: input.projectFactId,
    factKey: input.factKey,
    factType: input.factType,
    revision: input.revision,
    value: input.value,
    status: input.status,
    validFrom: input.validFrom,
    ...(input.validUntil ? { validUntil: input.validUntil } : {}),
    ...(input.sourceProposalRevisionId ? { sourceProposalRevisionId: input.sourceProposalRevisionId } : {}),
    ...(input.supersedesRevisionId ? { supersedesRevisionId: input.supersedesRevisionId } : {}),
    provenance: input.provenance,
    ...(input.ownerDecisionId ? { ownerDecisionId: input.ownerDecisionId } : {}),
  });
  const contentSha256 = input.precomputedContentSha256 ?? calculatedContentSha256;
  if (contentSha256 !== calculatedContentSha256) {
    throw new HttpCommandError(500, "PROJECT_FACT_HASH_MISMATCH", "The precomputed Project Fact revision hash is inconsistent.");
  }
  await client.query(
    `insert into intentchord.project_fact_revisions(
      id,project_fact_id,revision,value_json,status,valid_from,valid_until,
      source_proposal_revision_id,supersedes_revision_id,provenance_json,
      owner_decision_id,content_sha256
    ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      input.id,
      input.projectFactId,
      input.revision,
      JSON.stringify(input.value),
      input.status,
      input.validFrom,
      input.validUntil ?? null,
      input.sourceProposalRevisionId ?? null,
      input.supersedesRevisionId ?? null,
      JSON.stringify(input.provenance),
      input.ownerDecisionId ?? null,
      contentSha256,
    ],
  );
  return contentSha256;
}

async function ensureActiveContext(client: PoolClient, projectContextId: string): Promise<void> {
  const context = await client.query<{ status: string }>(
    "select status from intentchord.project_contexts where id=$1",
    [projectContextId],
  );
  if (!context.rowCount) throw new HttpCommandError(404, "PROJECT_CONTEXT_NOT_FOUND", "The Project Context was not found.");
  if (context.rows[0].status !== "ACTIVE") {
    throw new HttpCommandError(409, "PROJECT_CONTEXT_ARCHIVED", "Archived Project Contexts cannot accept Project Truth changes.");
  }
}

export async function listProjectFacts(
  projectContextId: string,
  clientOverride?: PoolClient,
): Promise<ProjectFactView[]> {
  assertUuid(projectContextId, "projectContextId");
  const queryable = clientOverride ?? { query: databaseQuery as PoolClient["query"] };
  const context = await queryable.query<{ id: string }>(
    "select id from intentchord.project_contexts where id=$1",
    [projectContextId],
  );
  if (!context.rowCount) throw new HttpCommandError(404, "PROJECT_CONTEXT_NOT_FOUND", "The Project Context was not found.");
  const { facts, revisionsByFact } = await loadFactRows(queryable, projectContextId);
  return facts.map(fact => mapFact(fact, revisionsByFact.get(fact.id) ?? []));
}

export async function readProjectFact(projectFactId: string, clientOverride?: PoolClient): Promise<ProjectFactView> {
  assertUuid(projectFactId, "projectFactId");
  const { facts, revisionsByFact } = await loadFactRows(
    clientOverride ?? { query: databaseQuery as PoolClient["query"] },
    undefined,
    projectFactId,
  );
  const fact = facts[0];
  if (!fact) throw new HttpCommandError(404, "PROJECT_FACT_NOT_FOUND", "The Project Fact was not found.");
  return mapFact(fact, revisionsByFact.get(fact.id) ?? []);
}

export async function proposeProjectFact(
  projectContextId: string,
  raw: unknown,
  actorAuthority: string,
  clientOverride?: PoolClient,
): Promise<ProjectFactView> {
  assertUuid(projectContextId, "projectContextId");
  const command = proposeProjectFactCommandSchema.parse(raw);
  try {
    return await runWithOptionalClient(clientOverride, async client => {
      await ensureActiveContext(client, projectContextId);
      const existing = await client.query<FactRow>(
        `select id,project_context_id,fact_key,fact_type,current_revision,current_status,
           current_fact_revision_id,created_at,updated_at
         from intentchord.project_facts
         where project_context_id=$1 and fact_key=$2 for update`,
        [projectContextId, command.factKey],
      );
      const commandTime = await readDatabaseCommandTime(client);
      const validFrom = command.validFrom ?? commandTime;
      assertTemporalRange(validFrom, command.validUntil);
      const proposalRevisionId = randomUUID();

      if (!existing.rowCount) {
        if (command.expectedFactRevision !== 0) {
          throw new ProjectTruthPolicyError("REVISION_CONFLICT", "A new Project Fact requires expectedFactRevision=0.");
        }
        const projectFactId = randomUUID();
        await client.query(
          `insert into intentchord.project_facts(
            id,project_context_id,fact_key,fact_type,current_revision,current_status,
            current_fact_revision_id
          ) values($1,$2,$3,$4,1,'PROPOSED',$5)`,
          [projectFactId, projectContextId, command.factKey, command.factType, proposalRevisionId],
        );
        const contentSha256 = await insertFactRevision(client, {
          id: proposalRevisionId,
          projectContextId,
          projectFactId,
          factKey: command.factKey,
          factType: command.factType,
          revision: 1,
          value: command.value,
          status: "PROPOSED",
          validFrom,
          ...(command.validUntil ? { validUntil: command.validUntil } : {}),
          provenance: { ...command.provenance, proposedByAuthority: actorAuthority },
        });
        await appendFactAudit(client, {
          projectFactId,
          eventType: "PROJECT_FACT_PROPOSED",
          actorAuthority,
          revision: 1,
          metadata: {
            projectContextId,
            proposalRevisionId,
            factKey: command.factKey,
            factType: command.factType,
            contentSha256,
            currentApprovedFactChanged: false,
          },
        });
        const loaded = await loadFactForUpdate(client, projectFactId);
        return mapFact(loaded.fact, loaded.revisions);
      }

      const fact = existing.rows[0];
      if (fact.fact_type !== command.factType) {
        throw new HttpCommandError(
          409,
          "PROJECT_FACT_TYPE_IMMUTABLE",
          "An existing Project Fact key cannot be proposed with a different fact type.",
        );
      }
      const revisionsResult = await client.query<RevisionRow>(
        `select id,project_fact_id,revision,value_json,status,valid_from,valid_until,
           source_proposal_revision_id,supersedes_revision_id,provenance_json,
           owner_decision_id,content_sha256,created_at
         from intentchord.project_fact_revisions where project_fact_id=$1 order by revision,id`,
        [fact.id],
      );
      const state = toPolicyState(fact, revisionsResult.rows);
      assertExpectedFactRevision(state.currentRevision, command.expectedFactRevision);
      assertProposalCanBeCreated(state);
      const nextRevision = state.currentRevision + 1;
      const projection = projectionAfterProposal({
        state,
        proposalRevisionId,
        nextAggregateRevision: nextRevision,
      });
      const contentSha256 = await insertFactRevision(client, {
        id: proposalRevisionId,
        projectContextId,
        projectFactId: fact.id,
        factKey: fact.fact_key,
        factType: fact.fact_type,
        revision: nextRevision,
        value: command.value,
        status: "PROPOSED",
        validFrom,
        ...(command.validUntil ? { validUntil: command.validUntil } : {}),
        provenance: { ...command.provenance, proposedByAuthority: actorAuthority },
      });
      await client.query(
        `update intentchord.project_facts
         set current_revision=$2,current_status=$3,current_fact_revision_id=$4
         where id=$1`,
        [fact.id, projection.nextAggregateRevision, projection.nextCurrentStatus, projection.nextCurrentFactRevisionId],
      );
      await appendFactAudit(client, {
        projectFactId: fact.id,
        eventType: "PROJECT_FACT_PROPOSED",
        actorAuthority,
        revision: nextRevision,
        metadata: {
          projectContextId,
          proposalRevisionId,
          factKey: fact.fact_key,
          factType: fact.fact_type,
          contentSha256,
          currentApprovedFactChanged: false,
        },
      });
      const loaded = await loadFactForUpdate(client, fact.id);
      return mapFact(loaded.fact, loaded.revisions);
    });
  } catch (error) {
    policyError(error);
  }
}

export async function approveProjectFact(
  projectFactId: string,
  raw: unknown,
  ownerAuthority: string,
  clientOverride?: PoolClient,
): Promise<ProjectFactView> {
  assertUuid(projectFactId, "projectFactId");
  const command = approveProjectFactCommandSchema.parse(raw);
  try {
    return await runWithOptionalClient(clientOverride, async client => {
      const loaded = await loadFactForUpdate(client, projectFactId);
      await ensureActiveContext(client, loaded.fact.project_context_id);
      const state = toPolicyState(loaded.fact, loaded.revisions);
      assertExpectedFactRevision(state.currentRevision, command.expectedRevision);
      const proposalRow = loaded.revisions.find(revision => revision.id === command.proposalRevisionId);
      if (!proposalRow) throw new HttpCommandError(404, "PROJECT_FACT_PROPOSAL_NOT_FOUND", "The Project Fact proposal was not found.");
      const proposal = toPolicyRevision(proposalRow);
      const nextRevision = state.currentRevision + 1;
      const approvedRevisionId = randomUUID();
      const projection = projectionAfterApproval({ state, proposal, approvedRevisionId, nextAggregateRevision: nextRevision });
      const validFrom = command.effectiveFrom ?? proposal.validFrom;
      const validUntil = command.effectiveUntil ?? proposal.validUntil;
      assertTemporalRange(validFrom, validUntil);
      const decisionEventId = randomUUID();
      const approvalProvenance = {
        decisionReason: command.decisionReason,
        approvedByAuthority: ownerAuthority,
        proposalContentSha256: proposalRow.content_sha256,
      };
      const contentSha256 = projectFactRevisionHash({
        schemaVersion: "project-fact-revision/v1",
        projectContextId: loaded.fact.project_context_id,
        projectFactId,
        factKey: loaded.fact.fact_key,
        factType: loaded.fact.fact_type,
        revision: nextRevision,
        value: proposal.value,
        status: "OWNER_APPROVED",
        validFrom,
        ...(validUntil ? { validUntil } : {}),
        sourceProposalRevisionId: proposal.id,
        provenance: approvalProvenance,
        ownerDecisionId: decisionEventId,
      });
      await appendFactAudit(client, {
        id: decisionEventId,
        projectFactId,
        eventType: "PROJECT_FACT_APPROVED",
        actorAuthority: ownerAuthority,
        revision: nextRevision,
        metadata: {
          proposalRevisionId: proposal.id,
          approvedRevisionId,
          decisionReason: command.decisionReason,
          contentSha256,
          currentApprovedFactChanged: true,
        },
      });
      await insertFactRevision(client, {
        id: approvedRevisionId,
        projectContextId: loaded.fact.project_context_id,
        projectFactId,
        factKey: loaded.fact.fact_key,
        factType: loaded.fact.fact_type,
        revision: nextRevision,
        value: proposal.value,
        status: "OWNER_APPROVED",
        validFrom,
        ...(validUntil ? { validUntil } : {}),
        sourceProposalRevisionId: proposal.id,
        provenance: approvalProvenance,
        ownerDecisionId: decisionEventId,
        precomputedContentSha256: contentSha256,
      });
      await client.query(
        `update intentchord.project_facts
         set current_revision=$2,current_status=$3,current_fact_revision_id=$4
         where id=$1`,
        [projectFactId, projection.nextAggregateRevision, projection.nextCurrentStatus, projection.nextCurrentFactRevisionId],
      );
      const result = await loadFactForUpdate(client, projectFactId);
      return mapFact(result.fact, result.revisions);
    });
  } catch (error) {
    policyError(error);
  }
}

export async function rejectProjectFact(
  projectFactId: string,
  raw: unknown,
  ownerAuthority: string,
  clientOverride?: PoolClient,
): Promise<ProjectFactView> {
  assertUuid(projectFactId, "projectFactId");
  const command = rejectProjectFactCommandSchema.parse(raw);
  try {
    return await runWithOptionalClient(clientOverride, async client => {
      const loaded = await loadFactForUpdate(client, projectFactId);
      await ensureActiveContext(client, loaded.fact.project_context_id);
      const state = toPolicyState(loaded.fact, loaded.revisions);
      assertExpectedFactRevision(state.currentRevision, command.expectedRevision);
      const proposalRow = loaded.revisions.find(revision => revision.id === command.proposalRevisionId);
      if (!proposalRow) throw new HttpCommandError(404, "PROJECT_FACT_PROPOSAL_NOT_FOUND", "The Project Fact proposal was not found.");
      const proposal = toPolicyRevision(proposalRow);
      assertResolvableProposal(state, proposal);
      const nextRevision = state.currentRevision + 1;
      const rejectedRevisionId = randomUUID();
      const projection = projectionAfterRejection({ state, proposal, rejectedRevisionId, nextAggregateRevision: nextRevision });
      const decisionEventId = randomUUID();
      const rejectedAt = await readDatabaseCommandTime(client);
      const rejectionProvenance = {
        decisionReason: command.decisionReason,
        rejectedByAuthority: ownerAuthority,
        proposalContentSha256: proposalRow.content_sha256,
      };
      const contentSha256 = projectFactRevisionHash({
        schemaVersion: "project-fact-revision/v1",
        projectContextId: loaded.fact.project_context_id,
        projectFactId,
        factKey: loaded.fact.fact_key,
        factType: loaded.fact.fact_type,
        revision: nextRevision,
        value: proposal.value,
        status: "REJECTED",
        validFrom: rejectedAt,
        sourceProposalRevisionId: proposal.id,
        provenance: rejectionProvenance,
        ownerDecisionId: decisionEventId,
      });
      await appendFactAudit(client, {
        id: decisionEventId,
        projectFactId,
        eventType: "PROJECT_FACT_REJECTED",
        actorAuthority: ownerAuthority,
        revision: nextRevision,
        metadata: {
          proposalRevisionId: proposal.id,
          rejectedRevisionId,
          decisionReason: command.decisionReason,
          contentSha256,
          currentApprovedFactChanged: false,
        },
      });
      await insertFactRevision(client, {
        id: rejectedRevisionId,
        projectContextId: loaded.fact.project_context_id,
        projectFactId,
        factKey: loaded.fact.fact_key,
        factType: loaded.fact.fact_type,
        revision: nextRevision,
        value: proposal.value,
        status: "REJECTED",
        validFrom: rejectedAt,
        sourceProposalRevisionId: proposal.id,
        provenance: rejectionProvenance,
        ownerDecisionId: decisionEventId,
        precomputedContentSha256: contentSha256,
      });
      await client.query(
        `update intentchord.project_facts
         set current_revision=$2,current_status=$3,current_fact_revision_id=$4
         where id=$1`,
        [projectFactId, projection.nextAggregateRevision, projection.nextCurrentStatus, projection.nextCurrentFactRevisionId],
      );
      const result = await loadFactForUpdate(client, projectFactId);
      return mapFact(result.fact, result.revisions);
    });
  } catch (error) {
    policyError(error);
  }
}

export async function supersedeProjectFact(
  projectFactId: string,
  raw: unknown,
  ownerAuthority: string,
  clientOverride?: PoolClient,
): Promise<ProjectFactView> {
  assertUuid(projectFactId, "projectFactId");
  const command = supersedeProjectFactCommandSchema.parse(raw);
  try {
    return await runWithOptionalClient(clientOverride, async client => {
      const loaded = await loadFactForUpdate(client, projectFactId);
      await ensureActiveContext(client, loaded.fact.project_context_id);
      const state = toPolicyState(loaded.fact, loaded.revisions);
      assertExpectedFactRevision(state.currentRevision, command.expectedRevision);
      const replacementRow = command.replacementProposalRevisionId
        ? loaded.revisions.find(revision => revision.id === command.replacementProposalRevisionId)
        : undefined;
      if (command.replacementProposalRevisionId && !replacementRow) {
        throw new HttpCommandError(404, "PROJECT_FACT_PROPOSAL_NOT_FOUND", "The replacement Project Fact proposal was not found.");
      }
      const replacementProposal = replacementRow ? toPolicyRevision(replacementRow) : undefined;
      const nextRevision = state.currentRevision + 1;
      const nextRevisionId = randomUUID();
      const commandTime = await readDatabaseCommandTime(client);
      const effectiveAt = command.effectiveAt ?? commandTime;
      const projection = projectionAfterSupersede({
        state,
        expectedCurrentApprovedRevisionId: command.expectedCurrentApprovedRevisionId,
        ...(replacementProposal ? { replacementProposal, replacementApprovedRevisionId: nextRevisionId } : { supersededMarkerRevisionId: nextRevisionId }),
        nextAggregateRevision: nextRevision,
        effectiveAt,
      });
      const decisionEventId = randomUUID();
      const eventType = replacementProposal ? "PROJECT_FACT_REPLACED" : "PROJECT_FACT_SUPERSEDED";
      const status: ProjectFactStatus = replacementProposal ? "OWNER_APPROVED" : "SUPERSEDED";
      const value = replacementProposal?.value ?? state.current.value;
      const validUntil = command.effectiveUntil ?? replacementProposal?.validUntil;
      const supersedeProvenance = {
        decisionReason: command.decisionReason,
        decidedByAuthority: ownerAuthority,
        priorApprovedContentSha256: loaded.revisions.find(row => row.id === state.currentFactRevisionId)?.content_sha256 ?? "",
        ...(replacementRow ? { proposalContentSha256: replacementRow.content_sha256 } : {}),
      };
      const contentSha256 = projectFactRevisionHash({
        schemaVersion: "project-fact-revision/v1",
        projectContextId: loaded.fact.project_context_id,
        projectFactId,
        factKey: loaded.fact.fact_key,
        factType: loaded.fact.fact_type,
        revision: nextRevision,
        value,
        status,
        validFrom: effectiveAt,
        ...(validUntil ? { validUntil } : {}),
        ...(replacementProposal ? { sourceProposalRevisionId: replacementProposal.id } : {}),
        supersedesRevisionId: state.currentFactRevisionId,
        provenance: supersedeProvenance,
        ownerDecisionId: decisionEventId,
      });
      await appendFactAudit(client, {
        id: decisionEventId,
        projectFactId,
        eventType,
        actorAuthority: ownerAuthority,
        revision: nextRevision,
        metadata: {
          supersededRevisionId: state.currentFactRevisionId,
          replacementProposalRevisionId: replacementProposal?.id ?? null,
          replacementRevisionId: replacementProposal ? nextRevisionId : null,
          supersededMarkerRevisionId: replacementProposal ? null : nextRevisionId,
          decisionReason: command.decisionReason,
          effectiveAt,
          contentSha256,
          currentApprovedFactChanged: true,
        },
      });
      await insertFactRevision(client, {
        id: nextRevisionId,
        projectContextId: loaded.fact.project_context_id,
        projectFactId,
        factKey: loaded.fact.fact_key,
        factType: loaded.fact.fact_type,
        revision: nextRevision,
        value,
        status,
        validFrom: effectiveAt,
        ...(validUntil ? { validUntil } : {}),
        ...(replacementProposal ? { sourceProposalRevisionId: replacementProposal.id } : {}),
        supersedesRevisionId: state.currentFactRevisionId,
        provenance: supersedeProvenance,
        ownerDecisionId: decisionEventId,
        precomputedContentSha256: contentSha256,
      });
      await client.query(
        `update intentchord.project_facts
         set current_revision=$2,current_status=$3,current_fact_revision_id=$4
         where id=$1`,
        [projectFactId, projection.nextAggregateRevision, projection.nextCurrentStatus, projection.nextCurrentFactRevisionId],
      );
      const result = await loadFactForUpdate(client, projectFactId);
      return mapFact(result.fact, result.revisions);
    });
  } catch (error) {
    policyError(error);
  }
}

function mapSnapshot(row: SnapshotRow): ProjectTruthSnapshotView {
  return {
    id: row.id,
    projectContextId: row.project_context_id,
    snapshotVersion: row.snapshot_version,
    effectiveAt: asIso(row.effective_at),
    selectedFactRevisionIds: asJson<string[]>(row.selected_fact_revision_ids),
    contentSha256: row.content_sha256,
    createdByAuthority: row.created_by_authority,
    createdAt: asIso(row.created_at),
  };
}

export async function listProjectTruthSnapshots(
  projectContextId: string,
  clientOverride?: PoolClient,
): Promise<ProjectTruthSnapshotView[]> {
  assertUuid(projectContextId, "projectContextId");
  const queryable = clientOverride ?? { query: databaseQuery as PoolClient["query"] };
  const rows = await queryable.query<SnapshotRow>(
    `select id,project_context_id,snapshot_version,effective_at,selected_fact_revision_ids,
       content_sha256,created_by_authority,created_at
     from intentchord.project_truth_snapshots
     where project_context_id=$1 order by created_at,id`,
    [projectContextId],
  );
  return rows.rows.map(mapSnapshot);
}

export async function createProjectTruthSnapshot(
  projectContextId: string,
  raw: unknown,
  ownerAuthority: string,
  clientOverride?: PoolClient,
): Promise<ProjectTruthSnapshotView> {
  assertUuid(projectContextId, "projectContextId");
  const command = createProjectTruthSnapshotCommandSchema.parse(raw);
  try {
    return await runWithOptionalClient(clientOverride, async client => {
      await ensureActiveContext(client, projectContextId);
      const rows = await client.query<
        QueryResultRow & SnapshotFactCandidate
      >(
        `select pf.fact_key as "factKey",pf.fact_type as "factType",pf.id as "projectFactId",
           pfr.id as "projectFactRevisionId",pfr.revision::int as revision,
           pfr.status as "revisionStatus",pfr.valid_from::text as "validFrom",
           pfr.valid_until::text as "validUntil",
           pfr.supersedes_revision_id as "supersedesRevisionId",
           pfr.content_sha256 as "contentSha256"
         from intentchord.project_facts pf
         join intentchord.project_fact_revisions pfr on pfr.project_fact_id=pf.id
         where pf.project_context_id=$1
         order by pf.fact_key,pf.id,pfr.revision,pfr.id`,
        [projectContextId],
      );
      const commandTime = await readDatabaseCommandTime(client);
      const effectiveAt = command.effectiveAt ?? commandTime;
      const frozen = freezeProjectTruthSnapshot({
        projectContextId,
        snapshotVersion: command.snapshotVersion,
        effectiveAt,
        candidates: rows.rows.map(row => ({
          factKey: row.factKey,
          factType: row.factType,
          projectFactId: row.projectFactId,
          projectFactRevisionId: row.projectFactRevisionId,
          revision: Number(row.revision),
          contentSha256: row.contentSha256,
          revisionStatus: row.revisionStatus,
          validFrom: row.validFrom,
          ...(row.validUntil ? { validUntil: row.validUntil } : {}),
          ...(row.supersedesRevisionId ? { supersedesRevisionId: row.supersedesRevisionId } : {}),
        })),
        ...(command.factRevisionIds ? { requestedFactRevisionIds: command.factRevisionIds } : {}),
      });
      const existing = await client.query<SnapshotRow>(
        `select id,project_context_id,snapshot_version,effective_at,selected_fact_revision_ids,
           content_sha256,created_by_authority,created_at
         from intentchord.project_truth_snapshots
         where project_context_id=$1 and snapshot_version=$2 and content_sha256=$3`,
        [projectContextId, frozen.snapshotVersion, frozen.contentSha256],
      );
      if (existing.rowCount) return mapSnapshot(existing.rows[0]);

      const id = randomUUID();
      const inserted = await client.query<SnapshotRow>(
        `insert into intentchord.project_truth_snapshots(
          id,project_context_id,snapshot_version,effective_at,selected_fact_revision_ids,
          content_sha256,created_by_authority
        ) values($1,$2,$3,$4,$5,$6,$7)
        returning id,project_context_id,snapshot_version,effective_at,selected_fact_revision_ids,
          content_sha256,created_by_authority,created_at`,
        [
          id,
          projectContextId,
          frozen.snapshotVersion,
          frozen.effectiveAt,
          JSON.stringify(frozen.selectedFactRevisionIds),
          frozen.contentSha256,
          ownerAuthority,
        ],
      );
      await client.query(
        `insert into intentchord.audit_events(
          id,aggregate_type,aggregate_id,event_type,actor_authority,metadata
        ) values($1,'PROJECT_TRUTH_SNAPSHOT',$2,'PROJECT_TRUTH_SNAPSHOT_CREATED',$3,$4)`,
        [
          randomUUID(),
          id,
          ownerAuthority,
          JSON.stringify({
            schemaVersion: "project-truth-snapshot/v1",
            projectContextId,
            snapshotVersion: frozen.snapshotVersion,
            effectiveAt: frozen.effectiveAt,
            selectedFactRevisionIds: frozen.selectedFactRevisionIds,
            contentSha256: frozen.contentSha256,
          }),
        ],
      );
      return mapSnapshot(inserted.rows[0]);
    });
  } catch (error) {
    policyError(error);
  }
}

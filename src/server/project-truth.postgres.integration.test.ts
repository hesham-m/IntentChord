import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createProjectContext,
  linkProjectContextWorkspace,
  readProjectContext,
} from "@/server/project-context-service";
import {
  approveProjectFact,
  createProjectTruthSnapshot,
  listProjectFacts,
  proposeProjectFact,
  rejectProjectFact,
  supersedeProjectFact,
} from "@/server/project-truth-service";
import { databasePool, verifyDatabaseIdentity } from "@/server/db";

function loadAuthorizedDatabaseUrl(): void {
  if (process.env.DATABASE_URL) return;
  const env = readFileSync(".env.local", "utf8");
  const match = env.match(/^DATABASE_URL\s*=\s*["']?([^\r\n"']+)/m);
  if (!match) throw new Error("DATABASE_URL is required for Project Truth PostgreSQL integration tests.");
  process.env.DATABASE_URL = match[1].trim();
}

async function withRollback<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await databasePool().connect();
  try {
    await verifyDatabaseIdentity(client);
    await client.query("begin");
    return await work(client);
  } finally {
    try {
      await client.query("rollback");
    } catch {
      // Preserve the primary assertion failure.
    }
    client.release();
  }
}

async function insertWorkspace(client: PoolClient): Promise<string> {
  const id = randomUUID();
  const reference = `C:\\intentchord-project-truth-test-${id}`;
  await client.query(
    `insert into intentchord.workspaces(
      id,display_name,role,reference_type,reference,repository_identity,branch,commit_sha,
      fingerprint,provenance,revision,normalized_reference,verification_status,
      verification_method,verified_at,verification_authority,device_provenance,source_type
    ) values($1,$2,'primary','LOCAL_PATH',$3,null,null,null,$4,$5,0,$3,'UNVERIFIED',
      'PROJECT_TRUTH_INTEGRATION',null,'BACKEND',$6,'MANUAL_UNVERIFIED')`,
    [
      id,
      "Project Truth integration Workspace",
      reference,
      `unverified:${id}`,
      JSON.stringify({ integrationTest: true, fileContentRead: false }),
      JSON.stringify({ integrationTest: true }),
    ],
  );
  return id;
}

async function setupContext(client: PoolClient) {
  const workspaceId = await insertWorkspace(client);
  let context = await createProjectContext({
    displayName: "Project Truth integration",
    slug: `project-truth-${randomUUID().replaceAll("-", "")}`,
  }, "owner-local:Hisham", client);
  context = await linkProjectContextWorkspace(context.id, {
    expectedRevision: context.revision,
    workspaceRegistrationId: workspaceId,
    role: "PRIMARY",
    ordering: 0,
  }, "owner-local:Hisham", client);
  return { context, workspaceId };
}

async function proposeVersion(
  client: PoolClient,
  projectContextId: string,
  expectedFactRevision: number,
  version: string,
  validFrom?: string,
  validUntil?: string,
) {
  return proposeProjectFact(projectContextId, {
    expectedFactRevision,
    factKey: "EIT.UPDATE_CHANNEL.CURRENT_VERSION",
    factType: "CURRENT_VERSION",
    value: { version },
    ...(validFrom ? { validFrom } : {}),
    ...(validUntil ? { validUntil } : {}),
    provenance: { source: "INTEGRATION_TEST" },
  }, "owner-local:Hisham", client);
}

const phase1PostgresEnabled = process.env.INTENTCHORD_ENABLE_PROJECT_TRUTH_PG === "1";
const phase1Describe = phase1PostgresEnabled ? describe.sequential : describe.skip;

phase1Describe("Project Context and temporal Project Truth PostgreSQL invariants", () => {
  beforeAll(async () => {
    loadAuthorizedDatabaseUrl();
    const client = await databasePool().connect();
    try {
      await verifyDatabaseIdentity(client);
      const migration = await client.query(
        "select 1 from intentchord.schema_migrations where id='007_project_context_and_truth_registry.sql'",
      );
      if (!migration.rowCount) throw new Error("MIGRATION_007_REQUIRED_FOR_PROJECT_TRUTH_INTEGRATION");
    } finally {
      client.release();
    }
  });

  afterAll(async () => {
    await databasePool().end();
  });

  it("keeps Project Context Workspace association separate from Task authority", async () => {
    await withRollback(async client => {
      const { context, workspaceId } = await setupContext(client);
      expect(context.workspaces).toHaveLength(1);
      expect(context.workspaces[0].workspaceRegistrationId).toBe(workspaceId);
      const taskAuthority = await client.query(
        "select count(*)::int as count from intentchord.task_workspaces where workspace_id=$1",
        [workspaceId],
      );
      expect(taskAuthority.rows[0].count).toBe(0);
      expect((await readProjectContext(context.id, client)).revision).toBe(1);
    });
  });

  it("uses PostgreSQL as the sole metadata clock authority across multiple commands in one transaction", async () => {
    await withRollback(async client => {
      const { context } = await setupContext(client);
      expect(Date.parse(context.updatedAt)).toBeGreaterThanOrEqual(Date.parse(context.createdAt));

      let fact = await proposeVersion(client, context.id, 0, "1.5.3");
      const proposal = fact.revisions.find(revision => revision.unresolvedProposal)!;
      fact = await approveProjectFact(fact.id, {
        expectedRevision: fact.currentRevision,
        proposalRevisionId: proposal.id,
        decisionReason: "Owner confirms database-clock authority in one caller-managed transaction.",
      }, "owner-local:Hisham", client);

      expect(Date.parse(fact.updatedAt)).toBeGreaterThanOrEqual(Date.parse(fact.createdAt));
      const databaseClock = await client.query<{ database_time: Date | string }>(
        "select clock_timestamp() as database_time",
      );
      expect(Date.parse(fact.updatedAt)).toBeLessThanOrEqual(
        Date.parse(databaseClock.rows[0].database_time instanceof Date
          ? databaseClock.rows[0].database_time.toISOString()
          : String(databaseClock.rows[0].database_time)),
      );

      await client.query("savepoint project_fact_timestamp_injection");
      await expect(client.query(
        `update intentchord.project_facts
         set current_revision=current_revision+1,updated_at='2099-01-01T00:00:00.000Z'
         where id=$1`,
        [fact.id],
      )).rejects.toThrow(/INTENTCHORD_PROJECT_FACT_UPDATED_AT_DATABASE_MANAGED/);
      await client.query("rollback to savepoint project_fact_timestamp_injection");

      const spoofedContextId = randomUUID();
      const spoofed = await client.query<{ created_at: Date | string; updated_at: Date | string }>(
        `insert into intentchord.project_contexts(
          id,display_name,slug,status,revision,created_at,updated_at
        ) values($1,'Clock injection probe',$2,'ACTIVE',0,
          '2099-01-01T00:00:00.000Z','2099-01-01T00:00:00.000Z')
        returning created_at,updated_at`,
        [spoofedContextId, `clock-probe-${spoofedContextId.replaceAll("-", "")}`],
      );
      expect(new Date(spoofed.rows[0].created_at).getUTCFullYear()).not.toBe(2099);
      expect(new Date(spoofed.rows[0].updated_at).getUTCFullYear()).not.toBe(2099);
    });
  });

  it("preserves approved truth when a candidate is proposed then rejected", async () => {
    await withRollback(async client => {
      const { context } = await setupContext(client);
      let fact = await proposeVersion(client, context.id, 0, "1.5.3");
      const firstProposal = fact.revisions.find(revision => revision.unresolvedProposal)!;
      fact = await approveProjectFact(fact.id, {
        expectedRevision: fact.currentRevision,
        proposalRevisionId: firstProposal.id,
        decisionReason: "Owner confirms version 1.5.3 as the current approved Update Channel version.",
      }, "owner-local:Hisham", client);
      const approvedRevisionId = fact.currentFactRevisionId;

      fact = await proposeVersion(client, context.id, fact.currentRevision, "1.3.5");
      expect(fact.currentStatus).toBe("OWNER_APPROVED");
      expect(fact.currentFactRevisionId).toBe(approvedRevisionId);
      const candidate = fact.revisions.find(revision => revision.unresolvedProposal)!;

      fact = await rejectProjectFact(fact.id, {
        expectedRevision: fact.currentRevision,
        proposalRevisionId: candidate.id,
        decisionReason: "Owner rejects 1.3.5 as the current version while retaining it as an audited candidate.",
      }, "owner-local:Hisham", client);
      expect(fact.currentStatus).toBe("OWNER_APPROVED");
      expect(fact.currentFactRevisionId).toBe(approvedRevisionId);
      expect(fact.revisions.some(revision => revision.status === "REJECTED")).toBe(true);
    });
  });

  it("requires explicit supersede and freezes only replacement owner-approved truth", async () => {
    await withRollback(async client => {
      const { context } = await setupContext(client);
      let fact = await proposeVersion(client, context.id, 0, "1.5.2");
      let proposal = fact.revisions.find(revision => revision.unresolvedProposal)!;
      fact = await approveProjectFact(fact.id, {
        expectedRevision: fact.currentRevision,
        proposalRevisionId: proposal.id,
        decisionReason: "Owner confirms the initial current version for replacement testing.",
      }, "owner-local:Hisham", client);
      const oldApprovedRevisionId = fact.currentFactRevisionId;

      fact = await proposeVersion(client, context.id, fact.currentRevision, "1.5.3");
      proposal = fact.revisions.find(revision => revision.unresolvedProposal)!;
      await expect(approveProjectFact(fact.id, {
        expectedRevision: fact.currentRevision,
        proposalRevisionId: proposal.id,
        decisionReason: "Direct approval must fail because current owner-approved truth already exists.",
      }, "owner-local:Hisham", client)).rejects.toMatchObject({
        code: "CURRENT_APPROVED_FACT_REQUIRES_SUPERSEDE",
      });

      fact = await supersedeProjectFact(fact.id, {
        expectedRevision: fact.currentRevision,
        expectedCurrentApprovedRevisionId: oldApprovedRevisionId,
        replacementProposalRevisionId: proposal.id,
        decisionReason: "Owner explicitly supersedes 1.5.2 with the reviewed 1.5.3 replacement.",
      }, "owner-local:Hisham", client);
      expect(fact.currentStatus).toBe("OWNER_APPROVED");
      expect(fact.current.value).toEqual({ version: "1.5.3" });
      expect(fact.current.supersedesRevisionId).toBe(oldApprovedRevisionId);

      const snapshot = await createProjectTruthSnapshot(context.id, {
        snapshotVersion: "integration-truth/v1",
      }, "owner-local:Hisham", client);
      expect(snapshot.selectedFactRevisionIds).toEqual([fact.currentFactRevisionId]);
      expect(snapshot.contentSha256).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  it("freezes historical truth before a future replacement and the replacement after it becomes effective", async () => {
    await withRollback(async client => {
      const { context } = await setupContext(client);
      let fact = await proposeVersion(client, context.id, 0, "1.5.2", "2026-07-01T00:00:00.000Z");
      let proposal = fact.revisions.find(revision => revision.unresolvedProposal)!;
      fact = await approveProjectFact(fact.id, {
        expectedRevision: fact.currentRevision,
        proposalRevisionId: proposal.id,
        decisionReason: "Owner confirms the historical version before scheduling a reviewed replacement.",
      }, "owner-local:Hisham", client);
      const oldApprovedRevisionId = fact.currentFactRevisionId;

      fact = await proposeVersion(client, context.id, fact.currentRevision, "1.5.3", "2026-08-01T00:00:00.000Z");
      proposal = fact.revisions.find(revision => revision.unresolvedProposal)!;
      fact = await supersedeProjectFact(fact.id, {
        expectedRevision: fact.currentRevision,
        expectedCurrentApprovedRevisionId: oldApprovedRevisionId,
        replacementProposalRevisionId: proposal.id,
        decisionReason: "Owner schedules the reviewed replacement without rewriting prior temporal truth.",
        effectiveAt: "2026-08-01T00:00:00.000Z",
      }, "owner-local:Hisham", client);
      const replacementRevisionId = fact.currentFactRevisionId;

      const historical = await createProjectTruthSnapshot(context.id, {
        snapshotVersion: "historical-before-replacement/v1",
        effectiveAt: "2026-07-28T00:00:00.000Z",
      }, "owner-local:Hisham", client);
      const current = await createProjectTruthSnapshot(context.id, {
        snapshotVersion: "replacement-effective/v1",
        effectiveAt: "2026-08-01T00:00:00.000Z",
      }, "owner-local:Hisham", client);

      expect(historical.selectedFactRevisionIds).toEqual([oldApprovedRevisionId]);
      expect(current.selectedFactRevisionIds).toEqual([replacementRevisionId]);
    });
  });

  it("blocks proposed-only and temporally inactive facts from snapshots", async () => {
    await withRollback(async client => {
      const { context } = await setupContext(client);
      await proposeVersion(client, context.id, 0, "1.3.5");
      await expect(createProjectTruthSnapshot(context.id, {
        snapshotVersion: "proposed-only/v1",
      }, "owner-local:Hisham", client)).rejects.toMatchObject({
        code: "SNAPSHOT_REQUIRES_EFFECTIVE_APPROVED_FACT",
      });
    });

    await withRollback(async client => {
      const { context } = await setupContext(client);
      let fact = await proposeVersion(
        client,
        context.id,
        0,
        "1.6.0",
        "2027-01-01T00:00:00.000Z",
      );
      const proposal = fact.revisions.find(revision => revision.unresolvedProposal)!;
      fact = await approveProjectFact(fact.id, {
        expectedRevision: fact.currentRevision,
        proposalRevisionId: proposal.id,
        decisionReason: "Owner approves a future version without making it effective before its validity date.",
      }, "owner-local:Hisham", client);
      await expect(createProjectTruthSnapshot(context.id, {
        snapshotVersion: "future-not-effective/v1",
        effectiveAt: "2026-07-28T00:00:00.000Z",
      }, "owner-local:Hisham", client)).rejects.toMatchObject({
        code: "SNAPSHOT_REQUIRES_EFFECTIVE_APPROVED_FACT",
      });
      expect(fact.currentStatus).toBe("OWNER_APPROVED");
    });
  });

  it("enforces append-only Project Truth and Context Workspace history at the database boundary", async () => {
    await withRollback(async client => {
      const { context, workspaceId } = await setupContext(client);
      const fact = await proposeVersion(client, context.id, 0, "1.5.3");
      const revisionId = fact.revisions[0].id;

      await client.query("savepoint immutable_fact_history");
      await expect(client.query(
        "update intentchord.project_fact_revisions set provenance_json='{}'::jsonb where id=$1",
        [revisionId],
      )).rejects.toThrow(/INTENTCHORD_PROJECT_TRUTH_HISTORY_APPEND_ONLY/);
      await client.query("rollback to savepoint immutable_fact_history");

      await client.query("savepoint immutable_workspace_history");
      await expect(client.query(
        `delete from intentchord.project_context_workspaces
         where project_context_id=$1 and workspace_registration_id=$2`,
        [context.id, workspaceId],
      )).rejects.toThrow(/INTENTCHORD_PROJECT_TRUTH_HISTORY_APPEND_ONLY/);
      await client.query("rollback to savepoint immutable_workspace_history");

      expect((await listProjectFacts(context.id, client))[0].revisions[0].id).toBe(revisionId);
    });
  });
});

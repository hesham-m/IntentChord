import { randomUUID } from "node:crypto";
import type { PoolClient, QueryResultRow } from "pg";
import {
  createProjectContextCommandSchema,
  linkProjectContextWorkspaceCommandSchema,
  projectContextSlug,
  type ProjectContextView,
  type ProjectContextWorkspaceRole,
  type ProjectContextWorkspaceView,
} from "@/core/truth/project-context-schema";
import { projectContextWorkspaceHash } from "@/core/truth/project-truth-hash";
import { readDatabaseCommandTime } from "@/server/database-clock";
import { databaseQuery, transaction } from "@/server/db";
import { ConflictError, HttpCommandError } from "@/server/errors";

const PROJECT_CONTEXT_SCHEMA_VERSION = "project-context/v1";
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

function postgresCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code ?? "")
    : undefined;
}

type ContextRow = QueryResultRow & {
  id: string;
  display_name: string;
  slug: string;
  status: "ACTIVE" | "ARCHIVED";
  revision: string | number;
  created_at: Date | string;
  updated_at: Date | string;
};

type WorkspaceRow = QueryResultRow & {
  project_context_id: string;
  workspace_registration_id: string;
  display_name: string;
  workspace_registration_role: string;
  context_role: ProjectContextWorkspaceRole;
  ordering: number;
  valid_from: Date | string;
  valid_until: Date | string | null;
  revision: string | number;
  content_sha256: string;
  verification_status: string;
  source_type: string;
};

function mapWorkspace(row: WorkspaceRow): ProjectContextWorkspaceView {
  return {
    workspaceRegistrationId: row.workspace_registration_id,
    displayName: row.display_name,
    workspaceRegistrationRole: row.workspace_registration_role,
    role: row.context_role,
    ordering: row.ordering,
    validFrom: asIso(row.valid_from),
    ...(row.valid_until ? { validUntil: asIso(row.valid_until) } : {}),
    revision: Number(row.revision),
    contentSha256: row.content_sha256,
    verificationStatus: row.verification_status,
    sourceType: row.source_type,
  };
}

async function readContextViews(queryable: Queryable, projectContextId?: string): Promise<ProjectContextView[]> {
  const contexts = await queryable.query<ContextRow>(
    `select id,display_name,slug,status,revision,created_at,updated_at
     from intentchord.project_contexts
     ${projectContextId ? "where id=$1" : ""}
     order by created_at,id`,
    projectContextId ? [projectContextId] : [],
  );
  if (!contexts.rowCount) return [];
  const ids = contexts.rows.map(row => row.id);
  const workspaces = await queryable.query<WorkspaceRow>(
    `select pcw.project_context_id,pcw.workspace_registration_id,w.display_name,
       w.role as workspace_registration_role,pcw.role as context_role,pcw.ordering,
       pcw.valid_from,pcw.valid_until,pcw.revision,pcw.content_sha256,
       w.verification_status,w.source_type
     from intentchord.project_context_workspaces pcw
     join intentchord.workspaces w on w.id=pcw.workspace_registration_id
     where pcw.project_context_id = any($1::uuid[])
     order by pcw.project_context_id,pcw.ordering,pcw.valid_from`,
    [ids],
  );
  const grouped = new Map<string, ProjectContextWorkspaceView[]>();
  for (const row of workspaces.rows) {
    const rows = grouped.get(row.project_context_id) ?? [];
    rows.push(mapWorkspace(row));
    grouped.set(row.project_context_id, rows);
  }
  return contexts.rows.map(row => ({
    id: row.id,
    displayName: row.display_name,
    slug: row.slug,
    status: row.status,
    revision: Number(row.revision),
    createdAt: asIso(row.created_at),
    updatedAt: asIso(row.updated_at),
    workspaces: grouped.get(row.id) ?? [],
  }));
}

async function appendContextAudit(
  client: PoolClient,
  input: {
    id?: string;
    projectContextId: string;
    eventType: string;
    ownerAuthority: string;
    revision: number;
    metadata: Record<string, unknown>;
  },
): Promise<string> {
  const id = input.id ?? randomUUID();
  await client.query(
    `insert into intentchord.audit_events(
      id,aggregate_type,aggregate_id,event_type,actor_authority,related_revision,metadata
    ) values($1,'PROJECT_CONTEXT',$2,$3,$4,$5,$6)`,
    [
      id,
      input.projectContextId,
      input.eventType,
      input.ownerAuthority,
      input.revision,
      JSON.stringify({ schemaVersion: PROJECT_CONTEXT_SCHEMA_VERSION, ...input.metadata }),
    ],
  );
  return id;
}

export async function createProjectContext(
  raw: unknown,
  ownerAuthority: string,
  clientOverride?: PoolClient,
): Promise<ProjectContextView> {
  const command = createProjectContextCommandSchema.parse(raw);
  const id = randomUUID();
  const slug = command.slug ?? projectContextSlug(command.displayName, id);
  try {
    return await runWithOptionalClient(clientOverride, async client => {
      const result = await client.query<ContextRow>(
        `insert into intentchord.project_contexts(
          id,display_name,slug,status,revision
        ) values($1,$2,$3,'ACTIVE',0)
        returning id,display_name,slug,status,revision,created_at,updated_at`,
        [id, command.displayName, slug],
      );
      await appendContextAudit(client, {
        projectContextId: id,
        eventType: "PROJECT_CONTEXT_CREATED",
        ownerAuthority,
        revision: 0,
        metadata: { displayName: command.displayName, slug },
      });
      const row = result.rows[0];
      return {
        id: row.id,
        displayName: row.display_name,
        slug: row.slug,
        status: row.status,
        revision: Number(row.revision),
        createdAt: asIso(row.created_at),
        updatedAt: asIso(row.updated_at),
        workspaces: [],
      };
    });
  } catch (error) {
    if (postgresCode(error) === "23505") {
      throw new HttpCommandError(409, "PROJECT_CONTEXT_SLUG_CONFLICT", "The Project Context slug is already in use.");
    }
    throw error;
  }
}

export async function listProjectContexts(clientOverride?: PoolClient): Promise<ProjectContextView[]> {
  return readContextViews(clientOverride ?? { query: databaseQuery as PoolClient["query"] });
}

export async function readProjectContext(projectContextId: string, clientOverride?: PoolClient): Promise<ProjectContextView> {
  assertUuid(projectContextId, "projectContextId");
  const rows = await readContextViews(clientOverride ?? { query: databaseQuery as PoolClient["query"] }, projectContextId);
  if (!rows[0]) throw new HttpCommandError(404, "PROJECT_CONTEXT_NOT_FOUND", "The Project Context was not found.");
  return rows[0];
}

export async function linkProjectContextWorkspace(
  projectContextId: string,
  raw: unknown,
  ownerAuthority: string,
  clientOverride?: PoolClient,
): Promise<ProjectContextView> {
  assertUuid(projectContextId, "projectContextId");
  const command = linkProjectContextWorkspaceCommandSchema.parse(raw);
  try {
    return await runWithOptionalClient(clientOverride, async client => {
      const contextResult = await client.query<ContextRow>(
        `select id,display_name,slug,status,revision,created_at,updated_at
         from intentchord.project_contexts where id=$1 for update`,
        [projectContextId],
      );
      const context = contextResult.rows[0];
      if (!context) throw new HttpCommandError(404, "PROJECT_CONTEXT_NOT_FOUND", "The Project Context was not found.");
      if (context.status !== "ACTIVE") {
        throw new HttpCommandError(409, "PROJECT_CONTEXT_ARCHIVED", "Archived Project Contexts cannot accept Workspace links.");
      }
      const currentRevision = Number(context.revision);
      if (currentRevision !== command.expectedRevision) throw new ConflictError("The Project Context revision is stale.");

      const workspace = await client.query<{ id: string }>(
        "select id from intentchord.workspaces where id=$1",
        [command.workspaceRegistrationId],
      );
      if (!workspace.rowCount) {
        throw new HttpCommandError(404, "WORKSPACE_REGISTRATION_NOT_FOUND", "The Workspace registration was not found.");
      }

      const commandTime = await readDatabaseCommandTime(client);
      const validFrom = command.validFrom ?? commandTime;
      const nextRevision = currentRevision + 1;
      const contentSha256 = projectContextWorkspaceHash({
        schemaVersion: "project-context-workspace/v1",
        projectContextId,
        workspaceRegistrationId: command.workspaceRegistrationId,
        role: command.role,
        ordering: command.ordering,
        validFrom,
        ...(command.validUntil ? { validUntil: command.validUntil } : {}),
        revision: nextRevision,
      });
      await client.query(
        `insert into intentchord.project_context_workspaces(
          project_context_id,workspace_registration_id,role,ordering,
          valid_from,valid_until,revision,content_sha256
        ) values($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          projectContextId,
          command.workspaceRegistrationId,
          command.role,
          command.ordering,
          validFrom,
          command.validUntil ?? null,
          nextRevision,
          contentSha256,
        ],
      );
      await client.query(
        `update intentchord.project_contexts
         set revision=$2
         where id=$1 and revision=$3`,
        [projectContextId, nextRevision, currentRevision],
      );
      await appendContextAudit(client, {
        projectContextId,
        eventType: "PROJECT_CONTEXT_WORKSPACE_LINKED",
        ownerAuthority,
        revision: nextRevision,
        metadata: {
          workspaceRegistrationId: command.workspaceRegistrationId,
          role: command.role,
          ordering: command.ordering,
          validFrom,
          validUntil: command.validUntil ?? null,
          contentSha256,
          taskAuthorityGranted: false,
        },
      });
      const rows = await readContextViews(client, projectContextId);
      return rows[0];
    });
  } catch (error) {
    if (postgresCode(error) === "23505") {
      throw new HttpCommandError(
        409,
        "PROJECT_CONTEXT_WORKSPACE_LINK_CONFLICT",
        "The Workspace or ordering already has an active link in this Project Context.",
      );
    }
    throw error;
  }
}

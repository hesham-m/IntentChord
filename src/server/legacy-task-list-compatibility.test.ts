import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PoolClient } from "pg";
import {
  bindRollbackOnlyTestClient,
  databasePool,
  verifyDatabaseIdentity,
} from "@/server/db";
import { readTaskLifecycle } from "@/server/lifecycle";
import { generatedTaskTitle } from "@/core/tasks/task-input";

let rollbackClient: PoolClient;
let releaseRollbackBinding: (() => void) | undefined;

function loadAuthorizedDatabaseUrl() {
  if (process.env.DATABASE_URL) return;
  const env = readFileSync(".env.local", "utf8");
  const match = env.match(/^DATABASE_URL\s*=\s*["']?([^\r\n"']+)/m);
  if (!match) throw new Error("DATABASE_URL is required.");
  process.env.DATABASE_URL = match[1].trim();
}

function draftPayload(title: string, objective: string, mode: "CONTROLLED_AUDIT" | "SOURCE_IMPLEMENTATION") {
  return {
    title,
    titleManuallyEdited: false,
    objective,
    taskMode: mode,
    ownerRequirements: [],
    workspaces: [],
    workspaceRef: "",
    workspaceSource: "MANUAL_UNVERIFIED" as const,
    workspaceFingerprint: "",
    allowedPaths: [],
    excludedPaths: [],
    evidenceFiles: [],
    identity: "",
    readFiles: false,
    modifySource: false,
    runStaticValidation: false,
    runTests: false,
    build: false,
    deploy: false,
    restartServices: false,
    writeDatabase: false,
    changeEnvironment: false,
    useNetwork: false,
  };
}

async function insertTask(client: PoolClient, id: string, draft: ReturnType<typeof draftPayload>) {
  await client.query(
    `insert into intentchord.tasks(id,title,title_manually_edited,objective,task_mode,draft,revision)
     values($1,$2,$3,$4,$5,$6,0)`,
    [id, draft.title, false, draft.objective, draft.taskMode, JSON.stringify(draft)],
  );
}

async function insertTaskWithDraftRevision(client: PoolClient, id: string, draft: ReturnType<typeof draftPayload>) {
  await insertTask(client, id, draft);
  const draftRevisionId = randomUUID();
  await client.query(
    `insert into intentchord.task_draft_revisions(id,task_id,revision,title,title_manually_edited,objective,task_mode,draft_projection,content_sha256)
     values($1,$2,0,$3,$4,$5,$6,$7,'test')`,
    [draftRevisionId, id, draft.title, false, draft.objective, draft.taskMode, JSON.stringify(draft)],
  );
}

describe("Legacy task list compatibility and GET /api/tasks 500 closure", () => {
  beforeAll(async () => {
    loadAuthorizedDatabaseUrl();
    process.env.INTENTCHORD_ROLLBACK_ONLY_PG_TEST = "1";
    rollbackClient = await databasePool().connect();
    await verifyDatabaseIdentity(rollbackClient);
    await rollbackClient.query("BEGIN");
    releaseRollbackBinding = bindRollbackOnlyTestClient(rollbackClient);
  });

  afterAll(async () => {
    try {
      if (rollbackClient) await rollbackClient.query("ROLLBACK");
    } finally {
      releaseRollbackBinding?.();
      rollbackClient?.release();
      delete process.env.INTENTCHORD_ROLLBACK_ONLY_PG_TEST;
      await databasePool().end();
    }
  });

  it("collection with normal lifecycle Task produces a valid TaskRecord", async () => {
    const taskId = randomUUID();
    const draft = draftPayload("Normal lifecycle task", "Prove normal lifecycle works", "SOURCE_IMPLEMENTATION");
    await insertTaskWithDraftRevision(rollbackClient, taskId, draft);

    const lifecycle = await readTaskLifecycle(taskId);
    expect(lifecycle).toBeDefined();
    expect(lifecycle!.id).toBe(taskId);
    expect(lifecycle!.draft).toBeDefined();
    expect(lifecycle!.draft.title).toBe(generatedTaskTitle("Prove normal lifecycle works"));
    expect(lifecycle!.runs).toEqual([]);
  });

  it("collection with legacy Task without Draft returns valid TaskRecord with no fabricated draft authority", async () => {
    const legacyId = randomUUID();
    const draft = draftPayload("Legacy task title", "Legacy objective", "CONTROLLED_AUDIT");
    await insertTask(rollbackClient, legacyId, draft);

    const noDraftResult = await rollbackClient.query(
      "select count(*) as c from intentchord.task_draft_revisions where task_id=$1",
      [legacyId],
    );
    expect(Number(noDraftResult.rows[0].c)).toBe(0);

    const lifecycle = await readTaskLifecycle(legacyId);
    expect(lifecycle).toBeDefined();
    expect(lifecycle!.id).toBe(legacyId);
    expect(lifecycle!.draft).toBeDefined();
    expect(lifecycle!.draft.title).toBe("Legacy task title");
    expect(lifecycle!.draft.objective).toBe("Legacy objective");
    expect(lifecycle!.draft.taskMode).toBe("CONTROLLED_AUDIT");
    expect(lifecycle!.runs).toEqual([]);
    expect(lifecycle!.contract).toBeUndefined();
    expect(lifecycle!.intentResolution).toBeUndefined();
  });

  it("mixed collection with both normal and legacy Tasks returns all without failing", async () => {
    const normalId = randomUUID();
    const normalDraft = draftPayload("Normal task in mixed", "Normal objective", "SOURCE_IMPLEMENTATION");
    await insertTaskWithDraftRevision(rollbackClient, normalId, normalDraft);

    const legacyId = randomUUID();
    const legacyDraft = draftPayload("Legacy task in mixed", "Legacy objective", "CONTROLLED_AUDIT");
    await insertTask(rollbackClient, legacyId, legacyDraft);

    const bothIds = [normalId, legacyId];
    const results: Array<{ id: string; error?: string }> = [];
    for (const id of bothIds) {
      try {
        const lc = await readTaskLifecycle(id);
        results.push({ id });
        expect(lc).toBeDefined();
        expect(lc!.draft).toBeDefined();
        expect(lc!.runs).toEqual([]);
      } catch (e: unknown) {
        results.push({ id, error: String(e) });
      }
    }
    expect(results.every(r => !r.error)).toBe(true);
    expect(results.length).toBe(2);
  });

  it("one legacy Task does not fail sequential list operation", async () => {
    const normalId = randomUUID();
    const normalDraft = draftPayload("Normal for list", "Objective", "SOURCE_IMPLEMENTATION");
    await insertTaskWithDraftRevision(rollbackClient, normalId, normalDraft);

    const legacyId = randomUUID();
    const legacyDraft = draftPayload("Legacy for list", "Legacy", "CONTROLLED_AUDIT");
    await insertTask(rollbackClient, legacyId, legacyDraft);

    const taskIds = await rollbackClient.query(
      "select id from intentchord.tasks where id in ($1,$2) order by created_at",
      [normalId, legacyId],
    );

    const lifecycles = [];
    for (const row of taskIds.rows) {
      lifecycles.push(await readTaskLifecycle(row.id));
    }
    expect(lifecycles.length).toBe(2);
    expect(lifecycles.every(lc => lc !== undefined && lc!.draft && Array.isArray(lc!.runs))).toBe(true);
  });

  it("all production tasks are readable via readTaskLifecycle without throwing", async () => {
    const ids = await rollbackClient.query("select id from intentchord.tasks order by updated_at desc");
    expect(ids.rows.length).toBeGreaterThan(0);

    let successCount = 0;
    let legacyCount = 0;
    let normalCount = 0;
    for (const row of ids.rows as { id: string }[]) {
      const lc = await readTaskLifecycle(row.id);
      expect(lc).toBeDefined();
      expect(lc!.id).toBe(row.id);
      expect(lc!.draft).toBeDefined();
      expect(Array.isArray(lc!.runs)).toBe(true);

      const hasDraftRev = await rollbackClient.query(
        "select count(*) as c from intentchord.task_draft_revisions where task_id=$1",
        [row.id],
      );
      if (Number(hasDraftRev.rows[0].c) === 0) {
        legacyCount++;
      } else {
        normalCount++;
      }
      successCount++;
    }
    expect(successCount).toBe(ids.rows.length);
    expect(legacyCount).toBeGreaterThan(0);
    expect(normalCount).toBeGreaterThan(0);
  });
});

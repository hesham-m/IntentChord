import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Client, type Notification, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DatabaseExecutionGovernanceError,
  bindRollbackOnlyTestClient,
  databasePool,
  transactionGoverned,
  verifyDatabaseIdentity,
} from "@/server/db";

function loadDatabaseUrl(): void {
  if (process.env.DATABASE_URL) return;
  const env = readFileSync(".env.local", "utf8");
  const match = env.match(/^DATABASE_URL\s*=\s*["']?([^\r\n"']+)/m);
  if (!match) throw new Error("DATABASE_URL is required for Workspace Index duration-governance PostgreSQL tests.");
  process.env.DATABASE_URL = match[1].trim();
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("POSTGRES_NOTIFICATION_WAIT_TIMEOUT");
    await delay(10);
  }
}

let suiteClient: PoolClient | undefined;
let unbindSuiteClient: (() => void) | undefined;

function requireSuiteClient(): PoolClient {
  if (!suiteClient) throw new Error("WORKSPACE_DURATION_PG_CLIENT_NOT_READY");
  return suiteClient;
}

function bindSuiteClient(): void {
  if (unbindSuiteClient) throw new Error("WORKSPACE_DURATION_PG_CLIENT_ALREADY_BOUND");
  unbindSuiteClient = bindRollbackOnlyTestClient(requireSuiteClient());
}

async function withProductionTransactionPath<T>(work: () => Promise<T>): Promise<T> {
  const rebind = Boolean(unbindSuiteClient);
  unbindSuiteClient?.();
  unbindSuiteClient = undefined;
  try {
    return await work();
  } finally {
    if (rebind) bindSuiteClient();
  }
}

const enabled = process.env.INTENTCHORD_ENABLE_WORKSPACE_ANALYSIS_PG === "1";
const suite = enabled ? describe.sequential : describe.skip;

suite("Workspace Index real PostgreSQL duration/cancellation authority", () => {
  beforeAll(async () => {
    loadDatabaseUrl();
    process.env.INTENTCHORD_ROLLBACK_ONLY_PG_TEST = "1";
    suiteClient = await databasePool().connect();
    await verifyDatabaseIdentity(suiteClient);
    await suiteClient.query("BEGIN");
    await suiteClient.query(
      `create temporary table intentchord_workspace_duration_probe(
        probe_key text primary key,
        ordinal integer not null
      ) on commit preserve rows`,
    );
    bindSuiteClient();
  });

  afterAll(async () => {
    unbindSuiteClient?.();
    unbindSuiteClient = undefined;
    if (suiteClient) {
      try {
        await suiteClient.query("ROLLBACK");
      } finally {
        suiteClient.release();
        suiteClient = undefined;
      }
    }
    await databasePool().end();
    delete process.env.INTENTCHORD_ROLLBACK_ONLY_PG_TEST;
  });

  it("cancels a real delayed multi-write transaction and never commits a late row", async () => {
    const client = requireSuiteClient();
    await client.query("truncate pg_temp.intentchord_workspace_duration_probe");
    const key = `timeout-${randomUUID()}`;
    await expect(transactionGoverned(
      { deadlineAtMs: Date.now() + 150 },
      async governedClient => {
        await governedClient.query(
          "insert into pg_temp.intentchord_workspace_duration_probe(probe_key,ordinal) values($1,1)",
          [key],
        );
        await governedClient.query(
          "insert into pg_temp.intentchord_workspace_duration_probe(probe_key,ordinal) values($1,2)",
          [`${key}-second`],
        );
        await governedClient.query("select pg_sleep(0.5)");
        await governedClient.query(
          "insert into pg_temp.intentchord_workspace_duration_probe(probe_key,ordinal) values($1,3)",
          [`${key}-late`],
        );
      },
    )).rejects.toMatchObject({
      name: "DatabaseExecutionGovernanceError",
      reason: "TIMEOUT",
    } satisfies Partial<DatabaseExecutionGovernanceError>);

    const immediate = await client.query<{ count: string }>(
      "select count(*)::text count from pg_temp.intentchord_workspace_duration_probe",
    );
    expect(immediate.rows[0].count).toBe("0");
    await delay(650);
    const later = await client.query<{ count: string }>(
      "select count(*)::text count from pg_temp.intentchord_workspace_duration_probe",
    );
    expect(later.rows[0].count).toBe("0");
    await expect(client.query("select 1")).resolves.toBeTruthy();
  });

  it("rolls back real PostgreSQL work when AbortSignal becomes terminal", async () => {
    const client = requireSuiteClient();
    await client.query("truncate pg_temp.intentchord_workspace_duration_probe");
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), 100);
    try {
      await expect(transactionGoverned(
        { deadlineAtMs: Date.now() + 2_000, signal: controller.signal },
        async governedClient => {
          await governedClient.query(
            "insert into pg_temp.intentchord_workspace_duration_probe(probe_key,ordinal) values($1,1)",
            [`abort-${randomUUID()}`],
          );
          await governedClient.query("select pg_sleep(1)");
        },
      )).rejects.toMatchObject({
        name: "DatabaseExecutionGovernanceError",
        reason: "ABORTED",
      } satisfies Partial<DatabaseExecutionGovernanceError>);
    } finally {
      clearTimeout(abortTimer);
    }
    const stored = await client.query<{ count: string }>(
      "select count(*)::text count from pg_temp.intentchord_workspace_duration_probe",
    );
    expect(stored.rows[0].count).toBe("0");
  });

  it("bounds a real FOR UPDATE lock wait by the same governed database deadline", async () => {
    await withProductionTransactionPath(async () => {
      const locker = new Client({
        connectionString: process.env.DATABASE_URL,
        options: "-c search_path=intentchord",
      });
      await locker.connect();
      try {
        const migration = await locker.query<{ id: string }>(
          "select id from intentchord.schema_migrations order by id limit 1",
        );
        if (!migration.rowCount) throw new Error("WORKSPACE_DURATION_PG_SCHEMA_MIGRATION_ROW_REQUIRED");
        const migrationId = migration.rows[0].id;
        await locker.query("BEGIN");
        await locker.query("select id from intentchord.schema_migrations where id=$1 for update", [migrationId]);
        await expect(transactionGoverned(
          { deadlineAtMs: Date.now() + 150 },
          client => client.query("select id from intentchord.schema_migrations where id=$1 for update", [migrationId]),
        )).rejects.toMatchObject({
          name: "DatabaseExecutionGovernanceError",
          reason: "TIMEOUT",
        } satisfies Partial<DatabaseExecutionGovernanceError>);
      } finally {
        await locker.query("ROLLBACK").catch(() => undefined);
        await locker.end();
      }
    });
  });

  it("destroys the real governed PostgreSQL session after a production-path timeout", async () => {
    await withProductionTransactionPath(async () => {
      let governedBackendPid: number | undefined;
      await expect(transactionGoverned(
        { deadlineAtMs: Date.now() + 150 },
        async client => {
          const backend = await client.query<{ pid: number }>("select pg_backend_pid() pid");
          governedBackendPid = Number(backend.rows[0].pid);
          await client.query("select pg_sleep(0.5)");
        },
      )).rejects.toMatchObject({
        name: "DatabaseExecutionGovernanceError",
        reason: "TIMEOUT",
      } satisfies Partial<DatabaseExecutionGovernanceError>);
      expect(governedBackendPid).toBeGreaterThan(0);

      const observer = requireSuiteClient();
      const backendDeadline = Date.now() + 2_000;
      while (true) {
        const activity = await observer.query<{ count: string }>(
          "select count(*)::text count from pg_stat_activity where pid=$1",
          [governedBackendPid],
        );
        if (activity.rows[0].count === "0") break;
        if (Date.now() >= backendDeadline) throw new Error("GOVERNED_DATABASE_SESSION_DESTRUCTION_NOT_OBSERVED");
        await delay(20);
      }
    });
  });

  it("uses the production governed COMMIT path and suppresses transactional effects after timeout", async () => {
    await withProductionTransactionPath(async () => {
      const channel = `intentchord_duration_${randomUUID().replaceAll("-", "")}`;
      const listener = new Client({
        connectionString: process.env.DATABASE_URL,
        options: "-c search_path=intentchord",
      });
      const notifications: string[] = [];
      listener.on("notification", (message: Notification) => {
        if (message.channel === channel && message.payload) notifications.push(message.payload);
      });
      await listener.connect();
      try {
        await listener.query(`LISTEN ${channel}`);
        const committedPayload = `commit-${randomUUID()}`;
        await transactionGoverned(
          { deadlineAtMs: Date.now() + 2_000 },
          client => client.query("select pg_notify($1,$2)", [channel, committedPayload]),
        );
        await waitUntil(() => notifications.includes(committedPayload));

        const rolledBackPayload = `rollback-${randomUUID()}`;
        await expect(transactionGoverned(
          { deadlineAtMs: Date.now() + 150 },
          async client => {
            await client.query("select pg_notify($1,$2)", [channel, rolledBackPayload]);
            await client.query("select pg_sleep(0.5)");
          },
        )).rejects.toMatchObject({
          name: "DatabaseExecutionGovernanceError",
          reason: "TIMEOUT",
        } satisfies Partial<DatabaseExecutionGovernanceError>);
        await delay(650);
        expect(notifications).not.toContain(rolledBackPayload);
      } finally {
        await listener.query(`UNLISTEN ${channel}`).catch(() => undefined);
        await listener.end();
      }
    });
  });

  it("commits a within-deadline multi-write savepoint transaction normally in rollback-only validation", async () => {
    const client = requireSuiteClient();
    await client.query("truncate pg_temp.intentchord_workspace_duration_probe");
    const key = `success-${randomUUID()}`;
    await transactionGoverned(
      { deadlineAtMs: Date.now() + 2_000 },
      async governedClient => {
        await governedClient.query(
          "insert into pg_temp.intentchord_workspace_duration_probe(probe_key,ordinal) values($1,1)",
          [key],
        );
        await governedClient.query(
          "insert into pg_temp.intentchord_workspace_duration_probe(probe_key,ordinal) values($1,2)",
          [`${key}-second`],
        );
      },
    );
    const stored = await client.query<{ count: string }>(
      "select count(*)::text count from pg_temp.intentchord_workspace_duration_probe where probe_key=$1 or probe_key=$2",
      [key, `${key}-second`],
    );
    expect(stored.rows[0].count).toBe("2");
  });
});

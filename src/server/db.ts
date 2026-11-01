import type { QueryResult, QueryResultRow } from "pg";
import { Client, Pool, type PoolClient } from "pg";

const EXPECTED_DATABASE = "intentchord_dev";
const EXPECTED_USER = "intentchord_app";
const EXPECTED_SCHEMA = "intentchord";
const EXPECTED_HOST = "127.0.0.1";
const EXPECTED_PORT = "5432";
const GOVERNED_CANCEL_CONNECTION_TIMEOUT_MS = 2_000;

let pool: Pool | undefined;
let rollbackOnlyTestClient: PoolClient | undefined;
let rollbackOnlySavepointSequence = 0;

export type DatabaseExecutionGovernance = {
  deadlineAtMs: number;
  signal?: AbortSignal;
};

export class DatabaseExecutionGovernanceError extends Error {
  readonly reason: "TIMEOUT" | "ABORTED";
  readonly deadlineAtMs: number;

  constructor(reason: "TIMEOUT" | "ABORTED", deadlineAtMs: number) {
    super(`DATABASE_EXECUTION_${reason}`);
    this.name = "DatabaseExecutionGovernanceError";
    this.reason = reason;
    this.deadlineAtMs = deadlineAtMs;
  }
}

export function bindRollbackOnlyTestClient(client: PoolClient): () => void {
  if (process.env.NODE_ENV !== "test" || process.env.INTENTCHORD_ROLLBACK_ONLY_PG_TEST !== "1") {
    throw new Error("ROLLBACK_ONLY_TEST_CLIENT_BLOCKED: explicit test mode is required.");
  }
  if (rollbackOnlyTestClient) throw new Error("ROLLBACK_ONLY_TEST_CLIENT_ALREADY_BOUND");
  rollbackOnlyTestClient = client;
  return () => {
    if (rollbackOnlyTestClient === client) rollbackOnlyTestClient = undefined;
  };
}

export function validateRuntimeDatabaseUrl(raw: string | undefined): string {
  if (!raw) throw new Error("DATABASE_URL is required for server persistence.");

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("DATABASE_URL must be a valid PostgreSQL connection URL.");
  }

  const database = parsed.pathname.replace(/^\//, "");
  const username = decodeURIComponent(parsed.username);
  const protocolAllowed = parsed.protocol === "postgres:" || parsed.protocol === "postgresql:";
  const port = parsed.port || EXPECTED_PORT;
  if (
    !protocolAllowed
    || database !== EXPECTED_DATABASE
    || username !== EXPECTED_USER
    || parsed.hostname !== EXPECTED_HOST
    || port !== EXPECTED_PORT
  ) {
    throw new Error(
      `INTENTCHORD_DATABASE_IDENTITY_BLOCKED: expected postgresql://${EXPECTED_USER}@${EXPECTED_HOST}:${EXPECTED_PORT}/${EXPECTED_DATABASE}; received protocol=${parsed.protocol || "<missing>"}, user=${username || "<missing>"}, host=${parsed.hostname || "<missing>"}, port=${port || "<missing>"}, database=${database || "<missing>"}.`,
    );
  }
  return raw;
}

function validatedConnectionString(): string {
  return validateRuntimeDatabaseUrl(process.env.DATABASE_URL);
}

export function databasePool() {
  if (!pool) {
    pool = new Pool({
      connectionString: validatedConnectionString(),
      options: `-c search_path=${EXPECTED_SCHEMA}`,
      keepAlive: true,
      keepAliveInitialDelayMillis: 10000,
    });
  }
  if (rollbackOnlyTestClient) {
    return new Proxy(pool, {
      get(target, property, receiver) {
        if (property === "query") {
          return async (text: string, values?: unknown[]) => {
            const client = rollbackOnlyTestClient!;
            const savepoint = `intentchord_test_pool_query_${++rollbackOnlySavepointSequence}`;
            await client.query(`SAVEPOINT ${savepoint}`);
            try {
              const result = await client.query(text, values);
              await client.query(`RELEASE SAVEPOINT ${savepoint}`);
              return result;
            } catch (error) {
              try {
                await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
                await client.query(`RELEASE SAVEPOINT ${savepoint}`);
              } catch {
                // Preserve the original test query failure.
              }
              throw error;
            }
          };
        }
        if (property === "end") return async () => undefined;
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
  }
  return pool;
}

export async function verifyDatabaseIdentity(client: PoolClient): Promise<void> {
  const result = await client.query<{
    database_name: string;
    user_name: string;
    schema_name: string;
  }>(
    `select current_database() as database_name,
      current_user as user_name,
      current_schema() as schema_name`,
  );
  const identity = result.rows[0];
  if (
    identity?.database_name !== EXPECTED_DATABASE
    || identity?.user_name !== EXPECTED_USER
    || identity?.schema_name !== EXPECTED_SCHEMA
  ) {
    throw new Error(
      `INTENTCHORD_DATABASE_IDENTITY_BLOCKED: expected ${EXPECTED_DATABASE}/${EXPECTED_USER}/${EXPECTED_SCHEMA}; received ${identity?.database_name ?? "<missing>"}/${identity?.user_name ?? "<missing>"}/${identity?.schema_name ?? "<missing>"}.`,
    );
  }
}

function requireGovernanceActive(governance: DatabaseExecutionGovernance): number {
  if (governance.signal?.aborted) {
    throw new DatabaseExecutionGovernanceError("ABORTED", governance.deadlineAtMs);
  }
  const remainingMs = governance.deadlineAtMs - Date.now();
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
    throw new DatabaseExecutionGovernanceError("TIMEOUT", governance.deadlineAtMs);
  }
  return Math.max(1, Math.ceil(remainingMs));
}

function acquireGovernedClient(governance: DatabaseExecutionGovernance): Promise<PoolClient> {
  const remainingMs = requireGovernanceActive(governance);
  return new Promise<PoolClient>((resolve, reject) => {
    let settled = false;
    const fail = (reason: "TIMEOUT" | "ABORTED") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      governance.signal?.removeEventListener("abort", onAbort);
      reject(new DatabaseExecutionGovernanceError(reason, governance.deadlineAtMs));
    };
    const onAbort = () => fail("ABORTED");
    const timer = setTimeout(() => fail("TIMEOUT"), remainingMs);
    governance.signal?.addEventListener("abort", onAbort, { once: true });
    databasePool().connect().then(
      client => {
        if (settled) {
          client.release();
          return;
        }
        settled = true;
        clearTimeout(timer);
        governance.signal?.removeEventListener("abort", onAbort);
        resolve(client);
      },
      error => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        governance.signal?.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

async function cancelDatabaseBackend(processId: number): Promise<void> {
  const client = new Client({
    connectionString: validatedConnectionString(),
    options: `-c search_path=${EXPECTED_SCHEMA}`,
    connectionTimeoutMillis: GOVERNED_CANCEL_CONNECTION_TIMEOUT_MS,
    query_timeout: GOVERNED_CANCEL_CONNECTION_TIMEOUT_MS,
  });
  try {
    await client.connect();
    await client.query("select pg_cancel_backend($1)", [processId]);
  } catch {
    // Server-side statement_timeout remains the authoritative deadline backstop.
  } finally {
    await client.end().catch(() => undefined);
  }
}

function poolClientProcessId(client: PoolClient): number | undefined {
  const processId = (client as PoolClient & { processID?: number }).processID;
  return Number.isInteger(processId) && Number(processId) > 0 ? Number(processId) : undefined;
}

async function queryWithGovernance<R extends QueryResultRow = QueryResultRow>(
  client: PoolClient,
  text: string,
  values: unknown[] | undefined,
  governance: DatabaseExecutionGovernance,
): Promise<QueryResult<R>> {
  let remainingMs = requireGovernanceActive(governance);
  const processId = poolClientProcessId(client);
  let cancellationRequested = false;
  const requestCancellation = () => {
    if (cancellationRequested || processId === undefined) return;
    cancellationRequested = true;
    void cancelDatabaseBackend(processId);
  };
  const onAbort = () => requestCancellation();
  const armDeadlineCancellation = () => setTimeout(requestCancellation, Math.max(1, governance.deadlineAtMs - Date.now()));
  governance.signal?.addEventListener("abort", onAbort, { once: true });
  let deadlineTimer = armDeadlineCancellation();
  try {
    // PostgreSQL 16 has statement_timeout but no transaction_timeout. Refresh it before every
    // governed statement so every statement, including COMMIT, is bounded by the same absolute deadline.
    await client.query("select set_config('statement_timeout',$1,true)", [`${remainingMs}ms`]);
    remainingMs = requireGovernanceActive(governance);
    clearTimeout(deadlineTimer);
    deadlineTimer = armDeadlineCancellation();
    const result = await client.query<R>(text, values);
    if (governance.signal?.aborted) {
      throw new DatabaseExecutionGovernanceError("ABORTED", governance.deadlineAtMs);
    }
    return result;
  } catch (error) {
    if (error instanceof DatabaseExecutionGovernanceError) throw error;
    const pgCode = (error as { code?: string } | undefined)?.code;
    if (governance.signal?.aborted) {
      throw new DatabaseExecutionGovernanceError("ABORTED", governance.deadlineAtMs);
    }
    if (pgCode === "57014" || Date.now() >= governance.deadlineAtMs) {
      throw new DatabaseExecutionGovernanceError("TIMEOUT", governance.deadlineAtMs);
    }
    throw error;
  } finally {
    clearTimeout(deadlineTimer);
    governance.signal?.removeEventListener("abort", onAbort);
  }
}

export async function databaseQuery<R extends QueryResultRow = QueryResultRow>(
  text: string,
  values?: unknown[],
): Promise<QueryResult<R>> {
  if (rollbackOnlyTestClient) {
    const client = rollbackOnlyTestClient;
    const savepoint = `intentchord_test_query_${++rollbackOnlySavepointSequence}`;
    await client.query(`SAVEPOINT ${savepoint}`);
    try {
      const result = await client.query<R>(text, values);
      await client.query(`RELEASE SAVEPOINT ${savepoint}`);
      return result;
    } catch (error) {
      try {
        await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        await client.query(`RELEASE SAVEPOINT ${savepoint}`);
      } catch {
        // Preserve the original query failure.
      }
      throw error;
    }
  }
  const client = await databasePool().connect();
  try {
    await verifyDatabaseIdentity(client);
    return await client.query<R>(text, values);
  } finally {
    client.release();
  }
}

export async function databaseQueryGoverned<R extends QueryResultRow = QueryResultRow>(
  text: string,
  values: unknown[] | undefined,
  governance: DatabaseExecutionGovernance,
): Promise<QueryResult<R>> {
  return transactionGoverned(governance, client => client.query<R>(text, values));
}

export async function transaction<T>(work: (client: PoolClient) => Promise<T>) {
  if (rollbackOnlyTestClient) {
    const client = rollbackOnlyTestClient;
    const savepoint = `intentchord_test_${++rollbackOnlySavepointSequence}`;
    await client.query(`SAVEPOINT ${savepoint}`);
    try {
      const value = await work(client);
      await client.query(`RELEASE SAVEPOINT ${savepoint}`);
      return value;
    } catch (error) {
      try {
        await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        await client.query(`RELEASE SAVEPOINT ${savepoint}`);
      } catch {
        // Preserve the original error; the outer rollback-only transaction remains authoritative.
      }
      throw error;
    }
  }

  const client = await databasePool().connect();
  try {
    await verifyDatabaseIdentity(client);
    await client.query("BEGIN");
    const value = await work(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Preserve the original error; a failed rollback is secondary evidence.
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function transactionGoverned<T>(
  governance: DatabaseExecutionGovernance,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  if (rollbackOnlyTestClient) {
    const client = rollbackOnlyTestClient;
    const savepoint = `intentchord_test_governed_${++rollbackOnlySavepointSequence}`;
    await queryWithGovernance(client, `SAVEPOINT ${savepoint}`, undefined, governance);
    try {
      const governedClient = new Proxy(client, {
        get(target, property, receiver) {
          if (property === "query") {
            return <R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]) => queryWithGovernance<R>(target, text, values, governance);
          }
          return Reflect.get(target, property, receiver) as unknown;
        },
      });
      const value = await work(governedClient);
      await queryWithGovernance(client, `RELEASE SAVEPOINT ${savepoint}`, undefined, governance);
      await client.query("select set_config('statement_timeout','0',true)");
      return value;
    } catch (error) {
      try {
        await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        await client.query(`RELEASE SAVEPOINT ${savepoint}`);
        await client.query("select set_config('statement_timeout','0',true)");
      } catch {
        // Preserve the governed failure; the outer rollback-only transaction remains authoritative.
      }
      throw error;
    }
  }

  const client = await acquireGovernedClient(governance);
  let released = false;
  try {
    await queryWithGovernance(client, `select current_database() as database_name, current_user as user_name, current_schema() as schema_name`, undefined, governance).then(result => {
      const identity = result.rows[0] as { database_name?: string; user_name?: string; schema_name?: string } | undefined;
      if (identity?.database_name !== EXPECTED_DATABASE || identity?.user_name !== EXPECTED_USER || identity?.schema_name !== EXPECTED_SCHEMA) {
        throw new Error("INTENTCHORD_DATABASE_IDENTITY_BLOCKED: governed transaction database identity mismatch.");
      }
    });
    await queryWithGovernance(client, "BEGIN", undefined, governance);
    const governedClient = new Proxy(client, {
      get(target, property, receiver) {
        if (property === "query") {
          return <R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]) => queryWithGovernance<R>(target, text, values, governance);
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
    const value = await work(governedClient);
    await queryWithGovernance(client, "COMMIT", undefined, governance);
    client.release();
    released = true;
    return value;
  } catch (error) {
    if (
      error instanceof DatabaseExecutionGovernanceError
      || governance.signal?.aborted
      || Date.now() >= governance.deadlineAtMs
    ) {
      // Destroying the connection is the rollback/cancellation boundary. No timed-out/aborted transaction
      // is left alive to commit in the background after the governed operation has terminated.
      client.release(true);
      released = true;
      throw error;
    }
    try {
      await queryWithGovernance(client, "ROLLBACK", undefined, governance);
    } catch {
      // Rollback is itself governed. If it cannot complete within the same authority, destroy the session.
      client.release(true);
      released = true;
    }
    throw error;
  } finally {
    if (!released) client.release();
  }
}

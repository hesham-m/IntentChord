import { AsyncLocalStorage } from "node:async_hooks";
import type { QueryResult, QueryResultRow } from "pg";
import { Pool, type PoolClient } from "pg";

const EXPECTED_USER = "intentchord_app";
const EXPECTED_SCHEMA = "intentchord";
const DISPOSABLE_PREFIX = "intentchord_validation_";
const OWNER_DATABASE = "intentchord_dev";

let pool: Pool | undefined;

export type DisposableValidationIdentity = {
  database: string;
  user: string;
  host: string;
  port: string;
  schema: string;
};

export type ValidationBranchIdentity = {
  caseId: string;
  branchId: "A" | "B";
};

export type ValidationLockMilestone = "TASK_LOCK" | "CONTEXT_LOCK" | "WORKSPACE_LOCK" | "CONTRACT_LOCK" | "RUN_LOCK";
export type ValidationTraceMilestone =
  | "TRANSACTION_STARTED"
  | "TRANSACTION_RELEASED"
  | `${ValidationLockMilestone}_ATTEMPTED`
  | `${ValidationLockMilestone}_ACQUIRED`
  | "CONTROLLED_CONTENTION_PROVEN";

export const VALIDATION_BRANCH_TRACE_CONTRACT: readonly ValidationTraceMilestone[] = [
  "TRANSACTION_STARTED",
  "TASK_LOCK_ATTEMPTED", "TASK_LOCK_ACQUIRED",
  "CONTEXT_LOCK_ATTEMPTED", "CONTEXT_LOCK_ACQUIRED",
  "WORKSPACE_LOCK_ATTEMPTED", "WORKSPACE_LOCK_ACQUIRED",
  "CONTRACT_LOCK_ATTEMPTED", "CONTRACT_LOCK_ACQUIRED",
  "RUN_LOCK_ATTEMPTED", "RUN_LOCK_ACQUIRED",
  "TRANSACTION_RELEASED",
  "CONTROLLED_CONTENTION_PROVEN",
];

export type ValidationTransactionId = number;

export type ValidationBranchTraceEvent = {
  sequence: number;
  caseId: string;
  branchId: "A" | "B";
  transactionId: ValidationTransactionId;
  milestone: ValidationTraceMilestone;
  detail?: string;
};

export type ValidationContentionTransactionTrace = {
  branchId: "A" | "B";
  transactionId: ValidationTransactionId;
  startSequence: number;
  anchorSequence: number;
  releaseSequence: number;
  events: ValidationBranchTraceEvent[];
};

export type ValidationContentionPlan =
  | {
      mode: "FIRST_OWNER_THEN_CONTEND";
      milestone: ValidationLockMilestone;
      firstBranchId: "A" | "B";
      secondBranchId: "A" | "B";
    }
  | {
      mode: "SIMULTANEOUS_ATTEMPT";
      milestone: ValidationLockMilestone;
      branchIds: ["A", "B"];
    };

type Deferred = { promise: Promise<void>; resolve: () => void; settled: boolean };
type ValidationContentionState = {
  plan: ValidationContentionPlan;
  firstAcquired: Deferred;
  secondQueryIssued: Deferred;
  simultaneousArrivals: Set<string>;
  simultaneousRelease: Deferred;
  simultaneousIssued: Set<string>;
  simultaneousIssuedRelease: Deferred;
  contentionProven: boolean;
};

const branchContext = new AsyncLocalStorage<ValidationBranchIdentity>();
const traceEvents: ValidationBranchTraceEvent[] = [];
const contentionStates = new Map<string, ValidationContentionState>();
let traceSequence = 0;
let validationTransactionSequence = 0;

function deferred(): Deferred {
  let resolvePromise!: () => void;
  const state: Deferred = {
    promise: new Promise<void>(resolve => { resolvePromise = resolve; }),
    resolve: () => undefined,
    settled: false,
  };
  state.resolve = () => {
    if (state.settled) return;
    state.settled = true;
    resolvePromise();
  };
  return state;
}

async function waitBounded(promise: Promise<void>, label: string, timeoutMs = 5_000): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`VALIDATION_CONTENTION_COORDINATION_TIMEOUT:${label}`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function allocateValidationTransactionId(): ValidationTransactionId {
  validationTransactionSequence += 1;
  return validationTransactionSequence;
}

function recordTrace(transactionId: ValidationTransactionId, milestone: ValidationTraceMilestone, detail?: string): void {
  const branch = branchContext.getStore();
  if (!branch) return;
  traceEvents.push({
    sequence: ++traceSequence,
    caseId: branch.caseId,
    branchId: branch.branchId,
    transactionId,
    milestone,
    ...(detail ? { detail } : {}),
  });
}

function normalizeSql(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

function lockMilestoneForQuery(text: string): ValidationLockMilestone | undefined {
  const normalized = normalizeSql(text);
  if (!normalized.includes("for update")) return undefined;
  if (normalized.includes("from intentchord.tasks")) return "TASK_LOCK";
  if (normalized.includes("from intentchord.context_assemblies")) return "CONTEXT_LOCK";
  if (normalized.includes("from intentchord.workspaces")) return "WORKSPACE_LOCK";
  if (normalized.includes("from intentchord.contract_revisions")) return "CONTRACT_LOCK";
  if (normalized.includes("from intentchord.runs")) return "RUN_LOCK";
  return undefined;
}

function contentionStateForCurrentBranch(milestone: ValidationLockMilestone): ValidationContentionState | undefined {
  const branch = branchContext.getStore();
  if (!branch) return undefined;
  const state = contentionStates.get(branch.caseId);
  return state?.plan.milestone === milestone ? state : undefined;
}

function proveContention(state: ValidationContentionState, transactionId: ValidationTransactionId): void {
  if (state.contentionProven) return;
  state.contentionProven = true;
  recordTrace(transactionId, "CONTROLLED_CONTENTION_PROVEN", `${state.plan.mode}:${state.plan.milestone}`);
}

async function tracedQuery(client: PoolClient, transactionId: ValidationTransactionId, args: unknown[]): Promise<unknown> {
  const first = args[0];
  const text = typeof first === "string" ? first : (first && typeof first === "object" && "text" in first ? String((first as { text: unknown }).text) : "");
  const milestone = text ? lockMilestoneForQuery(text) : undefined;
  if (!milestone) return Reflect.apply(client.query, client, args) as Promise<unknown>;

  const branch = branchContext.getStore();
  const state = contentionStateForCurrentBranch(milestone);
  const attempted = `${milestone}_ATTEMPTED` as ValidationTraceMilestone;
  const acquired = `${milestone}_ACQUIRED` as ValidationTraceMilestone;

  if (state && branch && state.plan.mode === "FIRST_OWNER_THEN_CONTEND") {
    if (branch.branchId === state.plan.secondBranchId) {
      await waitBounded(state.firstAcquired.promise, `${branch.caseId}:${branch.branchId}:WAIT_FIRST_${milestone}`);
      recordTrace(transactionId, attempted);
      const queryPromise = Reflect.apply(client.query, client, args) as Promise<unknown>;
      state.secondQueryIssued.resolve();
      proveContention(state, transactionId);
      const result = await queryPromise;
      recordTrace(transactionId, acquired);
      return result;
    }

    recordTrace(transactionId, attempted);
    const result = await Reflect.apply(client.query, client, args) as Promise<unknown>;
    recordTrace(transactionId, acquired);
    if (branch.branchId === state.plan.firstBranchId) {
      state.firstAcquired.resolve();
      await waitBounded(state.secondQueryIssued.promise, `${branch.caseId}:${branch.branchId}:WAIT_SECOND_${milestone}_ISSUED`);
    }
    return result;
  }

  if (state && branch && state.plan.mode === "SIMULTANEOUS_ATTEMPT" && state.plan.branchIds.includes(branch.branchId)) {
    recordTrace(transactionId, attempted);
    state.simultaneousArrivals.add(branch.branchId);
    if (state.simultaneousArrivals.size === state.plan.branchIds.length) {
      state.simultaneousRelease.resolve();
    }
    await waitBounded(state.simultaneousRelease.promise, `${branch.caseId}:${branch.branchId}:SIMULTANEOUS_${milestone}`);
    const queryPromise = Reflect.apply(client.query, client, args) as Promise<unknown>;
    state.simultaneousIssued.add(branch.branchId);
    if (state.simultaneousIssued.size === state.plan.branchIds.length) {
      state.simultaneousIssuedRelease.resolve();
      proveContention(state, transactionId);
    }
    await waitBounded(state.simultaneousIssuedRelease.promise, `${branch.caseId}:${branch.branchId}:SIMULTANEOUS_${milestone}_ISSUED`);
    const result = await queryPromise;
    recordTrace(transactionId, acquired);
    return result;
  }

  recordTrace(transactionId, attempted);
  const result = await Reflect.apply(client.query, client, args) as Promise<unknown>;
  recordTrace(transactionId, acquired);
  return result;
}

function tracedClient(client: PoolClient, transactionId: ValidationTransactionId): PoolClient {
  return new Proxy(client, {
    get(target, property, receiver) {
      if (property !== "query") return Reflect.get(target, property, receiver);
      return (...args: unknown[]) => tracedQuery(target, transactionId, args);
    },
  }) as PoolClient;
}

function exactTransactionById(
  trace: readonly ValidationBranchTraceEvent[],
  branchId: "A" | "B",
  transactionId: ValidationTransactionId,
  anchorSequence: number,
): ValidationContentionTransactionTrace {
  if (!Number.isSafeInteger(transactionId) || transactionId <= 0) {
    throw new Error(`VALIDATION_CONTENTION_TRANSACTION_ID_MISSING_OR_INVALID:${branchId}:${String(transactionId)}`);
  }
  const allForId = trace.filter(event => event.transactionId === transactionId);
  if (!allForId.length) throw new Error(`VALIDATION_CONTENTION_TRANSACTION_ID_NOT_FOUND:${branchId}:TX${transactionId}`);
  if (allForId.some(event => event.branchId !== branchId)) {
    throw new Error(`VALIDATION_CONTENTION_TRANSACTION_ID_REUSED_ACROSS_BRANCHES:TX${transactionId}`);
  }
  const events = [...allForId].sort((left, right) => left.sequence - right.sequence);
  const starts = events.filter(event => event.milestone === "TRANSACTION_STARTED");
  const releases = events.filter(event => event.milestone === "TRANSACTION_RELEASED");
  if (starts.length !== 1) {
    throw new Error(`VALIDATION_CONTENTION_TRANSACTION_START_COUNT_INVALID:${branchId}:TX${transactionId}:${starts.length}`);
  }
  if (releases.length !== 1) {
    throw new Error(`VALIDATION_CONTENTION_TRANSACTION_RELEASE_COUNT_INVALID:${branchId}:TX${transactionId}:${releases.length}`);
  }
  const startSequence = starts[0].sequence;
  const releaseSequence = releases[0].sequence;
  if (!(startSequence < anchorSequence && anchorSequence < releaseSequence)) {
    throw new Error(`VALIDATION_CONTENTION_ANCHOR_OUTSIDE_TRANSACTION:${branchId}:TX${transactionId}:${anchorSequence}`);
  }
  if (events.some(event => event.sequence < startSequence || event.sequence > releaseSequence)) {
    throw new Error(`VALIDATION_CONTENTION_TRANSACTION_EVENT_OUTSIDE_LIFETIME:${branchId}:TX${transactionId}`);
  }
  return { branchId, transactionId, startSequence, anchorSequence, releaseSequence, events };
}

function uniqueAnchor(
  events: ValidationBranchTraceEvent[],
  errorLabel: string,
): ValidationBranchTraceEvent {
  if (events.length !== 1) throw new Error(`${errorLabel}:${events.length}`);
  const [event] = events;
  if (!Number.isSafeInteger(event.transactionId) || event.transactionId <= 0) {
    throw new Error(`VALIDATION_CONTENTION_ANCHOR_TRANSACTION_ID_MISSING:${errorLabel}`);
  }
  return event;
}

export function contentionTransactionTrace(
  trace: readonly ValidationBranchTraceEvent[],
  plan: ValidationContentionPlan,
): Record<"A" | "B", ValidationContentionTransactionTrace> {
  const ordered = [...trace].sort((left, right) => left.sequence - right.sequence);
  const contention = uniqueAnchor(
    ordered.filter(event => event.milestone === "CONTROLLED_CONTENTION_PROVEN"),
    "VALIDATION_CONTROLLED_CONTENTION_EVENT_COUNT_INVALID",
  );
  const attempted = `${plan.milestone}_ATTEMPTED` as ValidationTraceMilestone;
  const acquired = `${plan.milestone}_ACQUIRED` as ValidationTraceMilestone;

  if (plan.mode === "FIRST_OWNER_THEN_CONTEND") {
    const secondAttempt = uniqueAnchor(
      ordered.filter(event =>
        event.branchId === plan.secondBranchId
        && event.milestone === attempted
        && event.sequence < contention.sequence
        && event.transactionId === contention.transactionId
      ),
      `VALIDATION_SECOND_CONTENTION_ANCHOR_COUNT_INVALID:${plan.secondBranchId}`,
    );
    const secondWindow = exactTransactionById(
      ordered,
      plan.secondBranchId,
      secondAttempt.transactionId,
      secondAttempt.sequence,
    );
    if (!(secondAttempt.sequence < contention.sequence && contention.sequence < secondWindow.releaseSequence)) {
      throw new Error(`VALIDATION_SECOND_CONTENTION_LIFETIME_INVALID:${plan.secondBranchId}:TX${secondWindow.transactionId}`);
    }

    const firstCandidates = ordered.filter(event => {
      if (event.branchId !== plan.firstBranchId || event.milestone !== acquired || event.sequence >= secondAttempt.sequence) return false;
      try {
        const window = exactTransactionById(ordered, plan.firstBranchId, event.transactionId, event.sequence);
        return contention.sequence < window.releaseSequence;
      } catch {
        return false;
      }
    });
    const firstAcquire = uniqueAnchor(
      firstCandidates,
      `VALIDATION_FIRST_CONTENTION_ANCHOR_COUNT_INVALID:${plan.firstBranchId}`,
    );
    const firstWindow = exactTransactionById(
      ordered,
      plan.firstBranchId,
      firstAcquire.transactionId,
      firstAcquire.sequence,
    );
    if (!(firstAcquire.sequence < secondAttempt.sequence
      && secondAttempt.sequence < contention.sequence
      && contention.sequence < firstWindow.releaseSequence)) {
      throw new Error(`VALIDATION_FIRST_OWNER_THEN_CONTEND_SEQUENCE_INVALID:${plan.milestone}`);
    }

    return {
      [plan.firstBranchId]: firstWindow,
      [plan.secondBranchId]: secondWindow,
    } as Record<"A" | "B", ValidationContentionTransactionTrace>;
  }

  const selected = {} as Record<"A" | "B", ValidationContentionTransactionTrace>;
  for (const branchId of plan.branchIds) {
    const candidates = ordered.filter(event => {
      if (event.branchId !== branchId || event.milestone !== attempted || event.sequence >= contention.sequence) return false;
      try {
        const window = exactTransactionById(ordered, branchId, event.transactionId, event.sequence);
        return contention.sequence < window.releaseSequence;
      } catch {
        return false;
      }
    });
    const anchorEvent = uniqueAnchor(candidates, `VALIDATION_SIMULTANEOUS_CONTENTION_ANCHOR_COUNT_INVALID:${branchId}`);
    selected[branchId] = exactTransactionById(ordered, branchId, anchorEvent.transactionId, anchorEvent.sequence);
  }
  if (![selected.A.transactionId, selected.B.transactionId].includes(contention.transactionId)) {
    throw new Error(`VALIDATION_SIMULTANEOUS_CONTENTION_EVENT_TRANSACTION_INVALID:TX${contention.transactionId}`);
  }
  return selected;
}

export function configureValidationContention(caseId: string, plan: ValidationContentionPlan): void {
  if (contentionStates.has(caseId)) throw new Error(`VALIDATION_CONTENTION_CASE_ALREADY_CONFIGURED:${caseId}`);
  if (plan.mode === "FIRST_OWNER_THEN_CONTEND" && plan.firstBranchId === plan.secondBranchId) {
    throw new Error(`VALIDATION_CONTENTION_BRANCHES_MUST_DIFFER:${caseId}`);
  }
  contentionStates.set(caseId, {
    plan,
    firstAcquired: deferred(),
    secondQueryIssued: deferred(),
    simultaneousArrivals: new Set<string>(),
    simultaneousRelease: deferred(),
    simultaneousIssued: new Set<string>(),
    simultaneousIssuedRelease: deferred(),
    contentionProven: false,
  });
}

export function resetValidationCaseTrace(caseId: string): void {
  for (let index = traceEvents.length - 1; index >= 0; index -= 1) {
    if (traceEvents[index].caseId === caseId) traceEvents.splice(index, 1);
  }
  contentionStates.delete(caseId);
}

export function validationBranchTrace(caseId: string): ValidationBranchTraceEvent[] {
  return traceEvents.filter(event => event.caseId === caseId).map(event => ({ ...event }));
}

export function formatValidationBranchTrace(caseId: string): string {
  const events = validationBranchTrace(caseId);
  if (!events.length) return `${caseId}:<no-trace>`;
  return events.map(event => `${event.sequence}:${event.branchId}:TX${event.transactionId}:${event.milestone}${event.detail ? `:${event.detail}` : ""}`).join(" | ");
}

export function runValidationBranch<T>(caseId: string, branchId: "A" | "B", work: () => Promise<T>): Promise<T> {
  return branchContext.run({ caseId, branchId }, work);
}

export function validateDisposableValidationDatabaseUrl(raw = process.env.INTENTCHORD_CURRENT_CONTEXT_VALIDATION_DATABASE_URL): string {
  if (process.env.INTENTCHORD_DISPOSABLE_VALIDATION_AUTHORIZED !== "1") {
    throw new Error("DISPOSABLE_VALIDATION_AUTHORIZATION_REQUIRED");
  }
  if (!raw) throw new Error("INTENTCHORD_CURRENT_CONTEXT_VALIDATION_DATABASE_URL_REQUIRED");
  let parsed: URL;
  try { parsed = new URL(raw); } catch { throw new Error("DISPOSABLE_VALIDATION_DATABASE_URL_INVALID"); }
  const protocolAllowed = parsed.protocol === "postgres:" || parsed.protocol === "postgresql:";
  const database = parsed.pathname.replace(/^\//, "");
  const user = decodeURIComponent(parsed.username);
  if (!protocolAllowed || user !== EXPECTED_USER || database === OWNER_DATABASE || !database.startsWith(DISPOSABLE_PREFIX)) {
    throw new Error(`DISPOSABLE_VALIDATION_DATABASE_IDENTITY_BLOCKED: protocol=${parsed.protocol || "<missing>"}, user=${user || "<missing>"}, database=${database || "<missing>"}`);
  }
  return raw;
}

export function safeDisposableValidationIdentity(raw = validateDisposableValidationDatabaseUrl()): DisposableValidationIdentity {
  const parsed = new URL(raw);
  return {
    database: parsed.pathname.replace(/^\//, ""),
    user: decodeURIComponent(parsed.username),
    host: parsed.hostname,
    port: parsed.port || "5432",
    schema: EXPECTED_SCHEMA,
  };
}

export function databasePool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: validateDisposableValidationDatabaseUrl(),
      options: `-c search_path=${EXPECTED_SCHEMA}`,
      max: 12,
    });
  }
  return pool;
}

export async function verifyDatabaseIdentity(client: Pick<PoolClient, "query">): Promise<void> {
  const expected = safeDisposableValidationIdentity();
  const result = await client.query<{ database_name: string; user_name: string; schema_name: string }>(
    `select current_database() database_name,current_user user_name,current_schema() schema_name`,
  );
  const row = result.rows[0];
  if (row?.database_name !== expected.database || row?.user_name !== expected.user || row?.schema_name !== expected.schema) {
    throw new Error(`DISPOSABLE_VALIDATION_RUNTIME_IDENTITY_BLOCKED: database=${row?.database_name ?? "<missing>"}, user=${row?.user_name ?? "<missing>"}, schema=${row?.schema_name ?? "<missing>"}`);
  }
}

export async function databaseQuery<R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<R>> {
  const client = await databasePool().connect();
  try {
    await verifyDatabaseIdentity(client);
    return await client.query<R>(text, values);
  } finally {
    client.release();
  }
}

export async function transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await databasePool().connect();
  const transactionId = allocateValidationTransactionId();
  const traced = tracedClient(client, transactionId);
  let began = false;
  try {
    await verifyDatabaseIdentity(client);
    await client.query("BEGIN");
    began = true;
    recordTrace(transactionId, "TRANSACTION_STARTED");
    await client.query("SET LOCAL lock_timeout = '8s'");
    await client.query("SET LOCAL statement_timeout = '20s'");
    const value = await work(traced);
    await client.query("COMMIT");
    recordTrace(transactionId, "TRANSACTION_RELEASED", "COMMIT");
    return value;
  } catch (error) {
    if (began) {
      try {
        await client.query("ROLLBACK");
        recordTrace(transactionId, "TRANSACTION_RELEASED", "ROLLBACK");
      } catch {
        recordTrace(transactionId, "TRANSACTION_RELEASED", "ROLLBACK_FAILED");
      }
    }
    throw error;
  } finally {
    client.release();
  }
}

export function validateRuntimeDatabaseUrl(raw: string | undefined): string {
  return validateDisposableValidationDatabaseUrl(raw);
}

export function bindRollbackOnlyTestClient(): never {
  throw new Error("DISPOSABLE_VALIDATION_ROLLBACK_BINDING_NOT_SUPPORTED: production services own independent transactions in this concurrency suite.");
}

export async function closeDisposableValidationPool(): Promise<void> {
  if (!pool) return;
  const current = pool;
  pool = undefined;
  await current.end();
}

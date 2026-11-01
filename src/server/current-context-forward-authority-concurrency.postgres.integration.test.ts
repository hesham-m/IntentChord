import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import { candidateScopeIdentityFromScope } from "@/core/tasks/task-input";

vi.mock("@/server/db", async () => await import("@/server/current-context-forward-authority-validation-db.test-support"));

import {
  approveContractRevision,
  commitTaskWorkSelection,
  compileContractArtifact,
  confirmTaskScope,
  readTaskLifecycle,
  resolveContract,
} from "@/server/lifecycle";
import { authorizeTaskContextSource, runTaskContextClosure } from "@/server/context-closure-service";
import {
  closeDisposableValidationPool,
  configureValidationContention,
  contentionTransactionTrace,
  databasePool,
  formatValidationBranchTrace,
  resetValidationCaseTrace,
  runValidationBranch,
  safeDisposableValidationIdentity,
  validationBranchTrace,
  verifyDatabaseIdentity,
  type ValidationLockMilestone,
  type ValidationTraceMilestone,
} from "@/server/current-context-forward-authority-validation-db.test-support";
import {
  bootstrapDeterministicConcurrencyFixtures,
  cleanupValidationWorkspaceRoots,
} from "@/server/current-context-forward-authority-validation-fixtures.test-support";

const OWNER = "owner-local:Hisham";
const PG_CONCURRENCY_CODES = new Set(["40P01", "55P03", "57014"]);

type Fixture = Awaited<ReturnType<typeof bootstrapDeterministicConcurrencyFixtures>>;
type BranchResult = PromiseSettledResult<unknown>;
type BranchId = "A" | "B";

type ProductContentionCase = {
  caseId: `CASE${26 | 27 | 28 | 29 | 30 | 31}`;
  plan:
    | { mode: "FIRST_OWNER_THEN_CONTEND"; milestone: ValidationLockMilestone; firstBranchId: BranchId; secondBranchId: BranchId }
    | { mode: "SIMULTANEOUS_ATTEMPT"; milestone: ValidationLockMilestone; branchIds: ["A", "B"] };
  required: Record<BranchId, ValidationTraceMilestone[]>;
  forbidden?: Partial<Record<BranchId, ValidationTraceMilestone[]>>;
  allowedDomainCodes: ReadonlySet<string>;
  a: () => Promise<unknown>;
  b: () => Promise<unknown>;
};

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const direct = (error as { code?: unknown }).code;
  if (typeof direct === "string") return direct;
  const cause = (error as { cause?: unknown }).cause;
  return cause === error ? undefined : errorCode(cause);
}

function pgCode(error: unknown): string | undefined {
  const code = errorCode(error);
  return code && PG_CONCURRENCY_CODES.has(code) ? code : undefined;
}

function describeError(error: unknown) {
  const code = errorCode(error);
  if (error instanceof Error) return `${code ? `${code}:` : ""}${error.name}:${error.message}`;
  return `${code ? `${code}:` : ""}${String(error)}`;
}

function traceFailure(caseId: string, reason: string): never {
  throw new Error(`${caseId}_${reason}\nBRANCH_TRACE=${formatValidationBranchTrace(caseId)}`);
}

function assertNoUnexpectedPostgresBlocking(label: string, results: BranchResult[]) {
  for (const result of results) {
    if (result.status !== "rejected") continue;
    const code = pgCode(result.reason);
    if (code) throw new Error(`${label}_POSTGRES_CONCURRENCY_FAILURE:${code}:${describeError(result.reason)}`);
  }
  if (!results.some(result => result.status === "fulfilled")) {
    throw new Error(`${label}_NO_BRANCH_COMPLETED:${results.map(r => r.status === "rejected" ? describeError(r.reason) : "fulfilled").join("|")}`);
  }
}

function assertRequiredMilestones(
  caseId: string,
  branchId: BranchId,
  trace: Array<{ milestone: ValidationTraceMilestone }>,
  milestones: ValidationTraceMilestone[],
): void {
  for (const milestone of milestones) {
    if (!trace.some(event => event.milestone === milestone)) traceFailure(caseId, `${branchId}_MISSING_${milestone}`);
  }
}

function assertForcedOverlap(testCase: ProductContentionCase): void {
  const trace = validationBranchTrace(testCase.caseId);
  let transactions: ReturnType<typeof contentionTransactionTrace>;
  try {
    transactions = contentionTransactionTrace(trace, testCase.plan);
  } catch (error) {
    traceFailure(testCase.caseId, `CONTENTION_TRANSACTION_IDENTITY_INVALID:${describeError(error)}`);
  }

  for (const branchId of ["A", "B"] as const) {
    const transaction = transactions[branchId];
    assertRequiredMilestones(testCase.caseId, branchId, transaction.events, testCase.required[branchId]);
    for (const milestone of testCase.forbidden?.[branchId] ?? []) {
      if (transaction.events.some(event => event.milestone === milestone)) {
        traceFailure(testCase.caseId, `${branchId}_FORBIDDEN_${milestone}`);
      }
    }
    if (!(transaction.startSequence < transaction.anchorSequence && transaction.anchorSequence < transaction.releaseSequence)) {
      traceFailure(testCase.caseId, `${branchId}_TRANSACTION_LIFETIME_UNPROVEN`);
    }
  }
}

function assertBranchOutcome(testCase: ProductContentionCase, branchId: BranchId, result: BranchResult): void {
  if (result.status === "fulfilled") return;
  const pg = pgCode(result.reason);
  if (pg) traceFailure(testCase.caseId, `${branchId}_POSTGRES_BLOCKING_${pg}`);
  const code = errorCode(result.reason);
  if (!code || !testCase.allowedDomainCodes.has(code)) {
    traceFailure(testCase.caseId, `${branchId}_UNEXPECTED_EARLY_FAILURE:${describeError(result.reason)}`);
  }
}

async function runProductContentionCase(testCase: ProductContentionCase) {
  resetValidationCaseTrace(testCase.caseId);
  configureValidationContention(testCase.caseId, testCase.plan);
  const [ra, rb] = await Promise.allSettled([
    runValidationBranch(testCase.caseId, "A", testCase.a),
    runValidationBranch(testCase.caseId, "B", testCase.b),
  ]);
  assertForcedOverlap(testCase);
  assertBranchOutcome(testCase, "A", ra);
  assertBranchOutcome(testCase, "B", rb);
  if (ra.status !== "fulfilled" && rb.status !== "fulfilled") traceFailure(testCase.caseId, "NO_PRODUCT_BRANCH_COMPLETED");
  return [ra, rb] as const;
}

function barrier(parties: number) {
  let count = 0;
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return async () => {
    count += 1;
    if (count === parties) release();
    await promise;
  };
}

async function rawBranch(work: (client: PoolClient) => Promise<void>) {
  const client = await databasePool().connect();
  try {
    await verifyDatabaseIdentity(client);
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout='4s'");
    await client.query("SET LOCAL statement_timeout='12s'");
    await work(client);
    await client.query("ROLLBACK");
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* preserve primary failure */ }
    throw error;
  } finally {
    client.release();
  }
}

async function currentStatus(taskId: string, assemblyRevisionId: string) {
  const client = await databasePool().connect();
  try {
    await verifyDatabaseIdentity(client);
    const result = await client.query<{ status: string }>(
      `select intentchord.current_effective_context_authority_status($1::uuid,$2::uuid) status`,
      [taskId, assemblyRevisionId],
    );
    return result.rows[0]?.status;
  } finally {
    client.release();
  }
}

let fixture: Fixture;

const sameTaskRequired: Record<BranchId, ValidationTraceMilestone[]> = {
  A: ["TRANSACTION_STARTED", "TASK_LOCK_ATTEMPTED", "TASK_LOCK_ACQUIRED", "CONTEXT_LOCK_ATTEMPTED", "WORKSPACE_LOCK_ATTEMPTED", "TRANSACTION_RELEASED"],
  B: ["TRANSACTION_STARTED", "TASK_LOCK_ATTEMPTED", "TASK_LOCK_ACQUIRED", "CONTEXT_LOCK_ATTEMPTED", "WORKSPACE_LOCK_ATTEMPTED", "TRANSACTION_RELEASED"],
};

const contractBranchRequired: Record<BranchId, ValidationTraceMilestone[]> = {
  A: sameTaskRequired.A,
  B: [...sameTaskRequired.B.slice(0, -1), "CONTRACT_LOCK_ATTEMPTED", "TRANSACTION_RELEASED"],
};

const taskEarlyStopRequired: Record<BranchId, ValidationTraceMilestone[]> = {
  A: sameTaskRequired.A,
  B: ["TRANSACTION_STARTED", "TASK_LOCK_ATTEMPTED", "TASK_LOCK_ACQUIRED", "TRANSACTION_RELEASED"],
};

const taskEarlyStopForbidden: Partial<Record<BranchId, ValidationTraceMilestone[]>> = {
  B: ["CONTEXT_LOCK_ATTEMPTED", "WORKSPACE_LOCK_ATTEMPTED", "CONTRACT_LOCK_ATTEMPTED"],
};

describe("Owner disposable PostgreSQL Current Context product concurrency", () => {
  beforeAll(async () => {
    if (process.env.INTENTCHORD_CURRENT_CONTEXT_CONCURRENCY_PG_TEST !== "1") {
      throw new Error("CURRENT_CONTEXT_CONCURRENCY_PG_TEST_EXPLICIT_AUTHORIZATION_REQUIRED");
    }
    const identity = safeDisposableValidationIdentity();
    expect(identity.database).not.toBe("intentchord_dev");
    expect(identity.database.startsWith("intentchord_validation_")).toBe(true);
    const client = await databasePool().connect();
    try {
      await verifyDatabaseIdentity(client);
      const migration = await client.query(
        `select id from intentchord.schema_migrations where id='014_governed_context_assembly_and_ai_context_mapping_v2.sql'`,
      );
      if (migration.rowCount !== 1) throw new Error("DISPOSABLE_MIGRATION_014_APPLIED_FOR_VALIDATION_REQUIRED");
    } finally {
      client.release();
    }
    fixture = await bootstrapDeterministicConcurrencyFixtures();
  }, 120_000);

  afterAll(async () => {
    try {
      await cleanupValidationWorkspaceRoots();
    } finally {
      await closeDisposableValidationPool();
    }
  });

  it("fixture preconditions prove real Workspace Root Object authority and persisted Case 26-31 objects", () => {
    expect(fixture.preconditions.workspaceCount).toBeGreaterThanOrEqual(7);
    for (const caseId of ["CASE26", "CASE27", "CASE28", "CASE29:A", "CASE29:B", "CASE30", "CASE31"]) {
      expect(fixture.preconditions.caseObjects[caseId]?.length).toBeGreaterThan(0);
    }
  });

  it("mutable Product concurrency cases use isolated Task/Contract fixture identities", () => {
    const taskIds = [
      fixture.contract26.taskId, fixture.contract27.taskId, fixture.contract28.taskId,
      fixture.scope30.taskId, fixture.closure31.taskId,
      fixture.crossWorkspace.a.taskId, fixture.crossWorkspace.b.taskId,
    ];
    expect(new Set(taskIds).size).toBe(taskIds.length);
    const contractIds = [fixture.contract26.contractRevisionId, fixture.contract27.contractRevisionId, fixture.contract28.contractRevisionId];
    expect(new Set(contractIds).size).toBe(contractIds.length);
  });

  it("harness control: each canonical branch releases its transaction independently", async () => {
    const workspaceId = fixture.crossWorkspace.a.currentWorkspaceId;
    const start = barrier(2);
    const results = await Promise.allSettled([
      rawBranch(async client => {
        await start();
        await client.query(`select id from intentchord.workspaces where id=$1 for update`, [workspaceId]);
        await new Promise(resolve => setTimeout(resolve, 150));
      }),
      rawBranch(async client => {
        await start();
        await new Promise(resolve => setTimeout(resolve, 20));
        await client.query(`select id from intentchord.workspaces where id=$1 for update`, [workspaceId]);
      }),
    ]);
    assertNoUnexpectedPostgresBlocking("CANONICAL_BRANCH_RELEASE", results);
  });

  it("harness negative control detects inverse lock order with real PostgreSQL blocking evidence", async () => {
    const w1 = fixture.crossWorkspace.a.currentWorkspaceId;
    const w2 = fixture.crossWorkspace.a.targetWorkspaceId;
    const firstLockBarrier = barrier(2);
    const results = await Promise.allSettled([
      rawBranch(async client => {
        await client.query(`select id from intentchord.workspaces where id=$1 for update`, [w1]);
        await firstLockBarrier();
        await client.query(`select id from intentchord.workspaces where id=$1 for update`, [w2]);
      }),
      rawBranch(async client => {
        await client.query(`select id from intentchord.workspaces where id=$1 for update`, [w2]);
        await firstLockBarrier();
        await client.query(`select id from intentchord.workspaces where id=$1 for update`, [w1]);
      }),
    ]);
    const codes = results.filter(r => r.status === "rejected").map(r => pgCode((r as PromiseRejectedResult).reason));
    expect(codes.some(code => code && PG_CONCURRENCY_CODES.has(code))).toBe(true);
  });

  it("26 actual resolveContract vs approveContractRevision forces Task-first contention", async () => {
    const f = fixture.contract26;
    await runProductContentionCase({
      caseId: "CASE26",
      plan: { mode: "FIRST_OWNER_THEN_CONTEND", milestone: "TASK_LOCK", firstBranchId: "A", secondBranchId: "B" },
      required: contractBranchRequired,
      allowedDomainCodes: new Set(["REVISION_CONFLICT"]),
      a: async () => {
        const task = await readTaskLifecycle(f.taskId);
        if (!task) throw new Error("CASE26_TASK_REQUIRED");
        return resolveContract(f.taskId, { expectedRevision: task.revision, locale: "en" });
      },
      b: () => approveContractRevision(f.contractRevisionId!, {
        expectedRevision: f.contractStateRevision!, expectedContentSha256: f.contractContentSha256!, approvalChannel: "DISPOSABLE_VALIDATION_CASE26",
      }),
    });
  });

  it("27 actual resolveContract vs compileContractArtifact forces Task-first contention", async () => {
    const f = fixture.contract27;
    await runProductContentionCase({
      caseId: "CASE27",
      plan: { mode: "FIRST_OWNER_THEN_CONTEND", milestone: "TASK_LOCK", firstBranchId: "A", secondBranchId: "B" },
      required: contractBranchRequired,
      allowedDomainCodes: new Set(["REVISION_CONFLICT"]),
      a: async () => {
        const task = await readTaskLifecycle(f.taskId);
        if (!task) throw new Error("CASE27_TASK_REQUIRED");
        return resolveContract(f.taskId, { expectedRevision: task.revision, locale: "en" });
      },
      b: () => compileContractArtifact(f.contractRevisionId!, { expectedRevision: f.contractStateRevision!, locale: "en" }),
    });
  });

  it("28 actual commitTaskWorkSelection vs approveContractRevision forces Task-first contention", async () => {
    const f = fixture.contract28;
    await runProductContentionCase({
      caseId: "CASE28",
      plan: { mode: "FIRST_OWNER_THEN_CONTEND", milestone: "TASK_LOCK", firstBranchId: "A", secondBranchId: "B" },
      required: taskEarlyStopRequired,
      forbidden: taskEarlyStopForbidden,
      allowedDomainCodes: new Set(["UNIFIED_V2_SCOPE_AUTHORITY_REQUIRED"]),
      a: async () => {
        const task = await readTaskLifecycle(f.taskId);
        if (!task) throw new Error("CASE28_TASK_REQUIRED");
        return commitTaskWorkSelection(f.taskId, {
          expectedRevision: task.revision, acceptedCatalogRevisionId: f.acceptedCatalogRevisionId, selectedComponentIds: f.selectedComponentIds,
        });
      },
      b: () => approveContractRevision(f.contractRevisionId!, {
        expectedRevision: f.contractStateRevision!, expectedContentSha256: f.contractContentSha256!, approvalChannel: "DISPOSABLE_VALIDATION_CASE28",
      }),
    });
  });

  it("29 reciprocal authorizeTaskContextSource forces both Tasks into Workspace authority together", async () => {
    const a = fixture.crossWorkspace.a;
    const b = fixture.crossWorkspace.b;
    const required: Record<BranchId, ValidationTraceMilestone[]> = {
      A: ["TRANSACTION_STARTED", "TASK_LOCK_ATTEMPTED", "TASK_LOCK_ACQUIRED", "CONTEXT_LOCK_ATTEMPTED", "WORKSPACE_LOCK_ATTEMPTED", "TRANSACTION_RELEASED"],
      B: ["TRANSACTION_STARTED", "TASK_LOCK_ATTEMPTED", "TASK_LOCK_ACQUIRED", "CONTEXT_LOCK_ATTEMPTED", "WORKSPACE_LOCK_ATTEMPTED", "TRANSACTION_RELEASED"],
    };
    await runProductContentionCase({
      caseId: "CASE29",
      plan: { mode: "SIMULTANEOUS_ATTEMPT", milestone: "WORKSPACE_LOCK", branchIds: ["A", "B"] },
      required,
      allowedDomainCodes: new Set<string>(),
      a: () => authorizeTaskContextSource(a.taskId, {
        expectedTaskRevision: a.expectedRevision, missingEvidenceRequestId: a.missingEvidenceRequestId, decision: "APPROVE", workspaceRegistrationId: a.targetWorkspaceId,
      }, OWNER),
      b: () => authorizeTaskContextSource(b.taskId, {
        expectedTaskRevision: b.expectedRevision, missingEvidenceRequestId: b.missingEvidenceRequestId, decision: "APPROVE", workspaceRegistrationId: b.targetWorkspaceId,
      }, OWNER),
    });
  });

  it("30 actual confirmTaskScope vs resolveContract forces Task-first contention", async () => {
    const f = fixture.scope30;
    const candidate = f.candidate;
    if (candidate.authorityVersion !== "CONTEXT_ASSEMBLY_V2") throw new Error("CASE30_V2_CANDIDATE_REQUIRED");
    await runProductContentionCase({
      caseId: "CASE30",
      plan: { mode: "FIRST_OWNER_THEN_CONTEND", milestone: "TASK_LOCK", firstBranchId: "A", secondBranchId: "B" },
      required: taskEarlyStopRequired,
      forbidden: taskEarlyStopForbidden,
      allowedDomainCodes: new Set(["REVISION_CONFLICT"]),
      a: () => confirmTaskScope(f.taskId, {
        expectedRevision: f.expectedRevision,
        expectedCandidateIdentity: candidateScopeIdentityFromScope(candidate),
        confirmedAllowedPaths: candidate.candidateAllowedPaths,
        confirmedExcludedPaths: [],
      }),
      b: () => resolveContract(f.taskId, { expectedRevision: f.expectedRevision, locale: "en" }),
    });
  });

  it("31 actual runTaskContextClosure R2 vs Work Selection historical real C1 reaches real Catalog/Context gate", async () => {
    const f = fixture.closure31;
    const task = await readTaskLifecycle(f.taskId);
    if (!task) throw new Error("CASE31_TASK_REQUIRED");
    await runProductContentionCase({
      caseId: "CASE31",
      plan: { mode: "FIRST_OWNER_THEN_CONTEND", milestone: "TASK_LOCK", firstBranchId: "A", secondBranchId: "B" },
      required: sameTaskRequired,
      allowedDomainCodes: new Set(["ACCEPTED_CONTEXT_CATALOG_SUPERSEDED"]),
      a: () => runTaskContextClosure(f.taskId, { idempotencyKey: `disposable-validation-case31-${f.taskId}` }),
      b: () => commitTaskWorkSelection(f.taskId, {
        expectedRevision: task.revision, acceptedCatalogRevisionId: f.acceptedCatalogRevisionId, selectedComponentIds: f.selectedComponentIds,
      }),
    });
  });

  it("32 PostgreSQL semantic fixture returns CURRENT", async () => {
    expect(await currentStatus(fixture.semantic.current.taskId, fixture.semantic.current.assemblyRevisionId)).toBe("CURRENT");
  });

  it("33 PostgreSQL proven current mismatch returns DRIFT", async () => {
    expect(await currentStatus(fixture.semantic.drift.taskId, fixture.semantic.drift.assemblyRevisionId)).toBe("DRIFT");
  });

  it("34 PostgreSQL failed actual Observation head returns UNPROVEN", async () => {
    expect(await currentStatus(fixture.semantic.unprovenFailedHead.taskId, fixture.semantic.unprovenFailedHead.assemblyRevisionId)).toBe("UNPROVEN");
  });

  it("PostgreSQL consumed Assembly returns UNPROVEN", async () => {
    expect(await currentStatus(fixture.semantic.unprovenConsumed.taskId, fixture.semantic.unprovenConsumed.assemblyRevisionId)).toBe("UNPROVEN");
  });
});

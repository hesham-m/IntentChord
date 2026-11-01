import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { candidateScopeIdentityFromScope, candidateScopeIdentityMatches, type ContextAssemblyTaskCandidateScope, type TaskContextAssemblyBinding } from "@/core/tasks/task-input";
import { contextAssemblyBindingMatches } from "@/server/context-assembly-task-binding-service";
import { taskCandidateScopeIdentitySchema } from "@/server/schemas";
import {
  contentionTransactionTrace,
  safeDisposableValidationIdentity,
  validateDisposableValidationDatabaseUrl,
  type ValidationBranchTraceEvent,
} from "@/server/current-context-forward-authority-validation-db.test-support";
import { validateModelContextAnalysisV2 } from "@/core/ai-context-mapper/validator-v2";
import {
  CONTEXT_ASSEMBLY_MAPPING_INPUT_SCHEMA_VERSION,
  type ContextAssemblyMappingInputV2,
} from "@/core/ai-context-mapper/v2";
import {
  missingEvidenceAnalysis,
  noGapAnalysis,
} from "@/server/current-context-forward-authority-validation-fixtures.test-support";

const EXPECTED_MIGRATION_014 = "8ED111969E4D92CF2DFC613A0AC7573D1E1E2FF01ADA012A8EEABA90561947EB";
const EXPECTED_LOCK = "DDAA83B333CCBF7D61890914E769CA2666F8F779B842709DE8FAFF7496019D3F";
const PROTECTED_PRODUCT_HASHES: Record<string, string> = {
  "src/server/context-head-authority.ts": "FE454A73404A61BB770033106AEB02924F60EF7C82903499196C35E66DF0531E",
  "src/server/context-closure-service.ts": "409286CBC38E3541D5889B4529B5D3BB5527824826AFAAF5A0D1EFE9586FC858",
  "src/server/lifecycle.ts": "693719259E7971101511DADEF33DFFD8B7CA13F208B8EE69BDC3FFDD215E4049",
  "src/core/context-authority/current-effective-context.ts": "424D4EE1EC49451E38F942349EF16A68D69018C12348562263F5864FC2BD917F",
  "src/core/context-closure/v1.ts": "298BE3F0F72631AA8D20F871E001A01E6EEEB4ED63D5321F681877BD48891FFD",
  "src/core/tasks/task-input.ts": "E34CD0E3D869A124B827BA2CCDF58E997F58C443CA037EF6EA6B35210B2C869D",
  "src/core/tasks/correction-authority.ts": "E2B90592231D917D29445341555A6FDADC5916601E375051E93B9E6CBF24D486",
};

function sha(path: string) {
  return createHash("sha256").update(readFileSync(path)).digest("hex").toUpperCase();
}

function withEnv<T>(values: Record<string, string | undefined>, work: () => T): T {
  const before = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    return work();
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

describe("Current Context Owner PostgreSQL validation harness governance", () => {
  it("15 disposable target can never equal intentchord_dev", () => {
    expect(() => withEnv({
      INTENTCHORD_DISPOSABLE_VALIDATION_AUTHORIZED: "1",
      INTENTCHORD_CURRENT_CONTEXT_VALIDATION_DATABASE_URL: "postgresql://intentchord_app:secret@127.0.0.1:5432/intentchord_dev",
    }, () => validateDisposableValidationDatabaseUrl())).toThrow(/DISPOSABLE_VALIDATION_DATABASE_IDENTITY_BLOCKED/);
  });

  it("16 explicit disposable authorization is mandatory", () => {
    expect(() => withEnv({
      INTENTCHORD_DISPOSABLE_VALIDATION_AUTHORIZED: undefined,
      INTENTCHORD_CURRENT_CONTEXT_VALIDATION_DATABASE_URL: "postgresql://intentchord_app:secret@127.0.0.1:5432/intentchord_validation_gate",
    }, () => validateDisposableValidationDatabaseUrl())).toThrow(/DISPOSABLE_VALIDATION_AUTHORIZATION_REQUIRED/);
  });

  it("18 safe target identity never contains password or raw connection URL", () => {
    const identity = withEnv({
      INTENTCHORD_DISPOSABLE_VALIDATION_AUTHORIZED: "1",
      INTENTCHORD_CURRENT_CONTEXT_VALIDATION_DATABASE_URL: "postgresql://intentchord_app:do-not-print@db.example:5544/intentchord_validation_gate",
    }, () => safeDisposableValidationIdentity());
    expect(identity).toEqual({ database: "intentchord_validation_gate", user: "intentchord_app", host: "db.example", port: "5544", schema: "intentchord" });
    expect(JSON.stringify(identity)).not.toContain("do-not-print");
  });

  it("20 verifies exact Migration 014 and 23 package-lock identities", () => {
    expect(sha("migrations/014_governed_context_assembly_and_ai_context_mapping_v2.sql")).toBe(EXPECTED_MIGRATION_014);
    expect(sha("package-lock.json")).toBe(EXPECTED_LOCK);
  });

  it("24 protected Product authority sources remain byte-identical", () => {
    for (const [path, expected] of Object.entries(PROTECTED_PRODUCT_HASHES)) expect(sha(path), path).toBe(expected);
  });

  it("17 deterministic fixture bootstrap has no manual Owner UUID fixture dependency", () => {
    const fixture = readFileSync("src/server/current-context-forward-authority-validation-fixtures.test-support.ts", "utf8");
    const runner = readFileSync("scripts/run-current-context-forward-authority-concurrency-postgres-tests.mjs", "utf8");
    expect(fixture).toContain("bootstrapDeterministicConcurrencyFixtures");
    expect(fixture).toContain("deterministicUuid");
    expect(runner).not.toContain("INTENTCHORD_CURRENT_CONTEXT_CONCURRENCY_FIXTURE_FILE");
  });

  it("19 disposable path has no Owner DATABASE_URL or .env.local fallback", () => {
    for (const path of [
      "scripts/bootstrap-current-context-forward-authority-validation-db.mjs",
      "scripts/run-current-context-forward-authority-concurrency-postgres-tests.mjs",
      "src/server/current-context-forward-authority-validation-db.test-support.ts",
    ]) {
      const source = readFileSync(path, "utf8");
      expect(source, path).not.toContain(".env.local");
      expect(source, path).not.toMatch(/process\.env\.DATABASE_URL/);
    }
  });

  it("21 disposable apply is separately classified from Owner persistent apply", () => {
    const bootstrap = readFileSync("scripts/bootstrap-current-context-forward-authority-validation-db.mjs", "utf8");
    expect(bootstrap).toContain("DISPOSABLE_DB_MIGRATION_014_APPLIED_FOR_VALIDATION=PASS");
    expect(bootstrap).toContain("OWNER_DB_MIGRATION_014_PERSISTENT_APPLY=NO");
    expect(bootstrap).not.toMatch(/CREATE\s+DATABASE/i);
    expect(bootstrap).not.toMatch(/DROP\s+DATABASE/i);
  });

  it("22 official Vitest is the PostgreSQL test execution authority", () => {
    const runner = readFileSync("scripts/run-current-context-forward-authority-concurrency-postgres-tests.mjs", "utf8");
    expect(runner).toContain('node_modules", "vitest", "vitest.mjs"');
    expect(runner).toContain("current-context-forward-authority-concurrency.postgres.integration.test.ts");
    expect(runner).toContain("current-context-forward-authority-validation-harness.test.ts");
  });

  it("Owner sequence keeps rollback-only Owner qualify distinct from disposable applied validation", () => {
    const sequence = readFileSync("scripts/validate-current-context-forward-authority-owner-sequence.mjs", "utf8");
    expect(sequence).toContain("OWNER_DB_MIGRATION_014_QUALIFY_ROLLBACK_ONLY");
    expect(sequence).toContain("DISPOSABLE_DB_BOOTSTRAP");
    expect(sequence).not.toContain('run("OWNER_DB_MIGRATION_014_APPLY"');
    expect(sequence).toContain("OWNER_DB_MIGRATION_014_PERSISTENT_APPLY=NO");
  });

  it("H1 Product fixtures use real temporary roots and Production registration/root authority verification", () => {
    const fixture = readFileSync("src/server/current-context-forward-authority-validation-fixtures.test-support.ts", "utf8");
    expect(fixture).toContain("mkdtemp");
    expect(fixture).toContain("verifyAndRegisterWorkspace");
    expect(fixture).toContain("assertRegisteredWorkspaceSourceAuthority");
    expect(fixture).toContain("VERIFIED_MATCH");
    expect(fixture).toContain("cleanupValidationWorkspaceRoots");
    expect(fixture).not.toContain("/intentchord-validation/");
    expect(fixture).not.toContain("not-yet-published-catalog");
    expect(fixture).not.toContain("rootObjectDeviceId =");
  });

  it("H2/H3 test-only DB adapter forces contention and records branch lock milestones", () => {
    const adapter = readFileSync("src/server/current-context-forward-authority-validation-db.test-support.ts", "utf8");
    const concurrency = readFileSync("src/server/current-context-forward-authority-concurrency.postgres.integration.test.ts", "utf8");
    expect(adapter).toContain("AsyncLocalStorage");
    expect(adapter).toContain("FIRST_OWNER_THEN_CONTEND");
    expect(adapter).toContain("SIMULTANEOUS_ATTEMPT");
    for (const milestone of ["TRANSACTION_STARTED", "TASK_LOCK_ATTEMPTED", "CONTEXT_LOCK_ATTEMPTED", "WORKSPACE_LOCK_ATTEMPTED", "CONTRACT_LOCK_ATTEMPTED", "RUN_LOCK_ATTEMPTED", "TRANSACTION_RELEASED", "CONTROLLED_CONTENTION_PROVEN"]) {
      expect(adapter).toContain(milestone);
    }
    expect(concurrency).toContain("runProductContentionCase");
    expect(concurrency).toContain("BRANCH_TRACE=");
    expect(concurrency).toContain("40P01");
    expect(concurrency).toContain("55P03");
    expect(concurrency).toContain("57014");
    expect(concurrency).not.toContain("raceProductCommands");

    const caseBlock = (caseId: string, nextCaseId?: string) => {
      const start = concurrency.indexOf(`caseId: "${caseId}"`);
      const end = nextCaseId ? concurrency.indexOf(`caseId: "${nextCaseId}"`, start + 1) : concurrency.length;
      expect(start, caseId).toBeGreaterThanOrEqual(0);
      return concurrency.slice(start, end < 0 ? concurrency.length : end);
    };
    const case26 = caseBlock("CASE26", "CASE27");
    const case27 = caseBlock("CASE27", "CASE28");
    const case28 = caseBlock("CASE28", "CASE29");
    const case29 = caseBlock("CASE29", "CASE30");
    const case29Section = concurrency.slice(concurrency.indexOf('it("29 reciprocal authorizeTaskContextSource'), concurrency.indexOf('caseId: "CASE30"'));
    const case30 = caseBlock("CASE30", "CASE31");
    const case31 = caseBlock("CASE31");
    const contractRequired = concurrency.slice(concurrency.indexOf("const contractBranchRequired"), concurrency.indexOf("const taskEarlyStopRequired"));
    const earlyStopRequired = concurrency.slice(concurrency.indexOf("const taskEarlyStopRequired"), concurrency.indexOf("const taskEarlyStopForbidden"));
    const earlyStopForbidden = concurrency.slice(concurrency.indexOf("const taskEarlyStopForbidden"), concurrency.indexOf('describe("Owner disposable PostgreSQL Current Context product concurrency"'));

    expect(case26).toContain('allowedDomainCodes: new Set(["REVISION_CONFLICT"])');
    expect(case27).toContain('allowedDomainCodes: new Set(["REVISION_CONFLICT"])');
    expect(case26).toContain("required: contractBranchRequired");
    expect(case27).toContain("required: contractBranchRequired");
    expect(contractRequired).toContain("CONTRACT_LOCK_ATTEMPTED");

    expect(case28).toContain('allowedDomainCodes: new Set(["UNIFIED_V2_SCOPE_AUTHORITY_REQUIRED"])');
    expect(case28).toContain("required: taskEarlyStopRequired");
    expect(case28).toContain("forbidden: taskEarlyStopForbidden");
    expect(case30).toContain('allowedDomainCodes: new Set(["REVISION_CONFLICT"])');
    expect(case30).toContain("required: taskEarlyStopRequired");
    expect(case30).toContain("forbidden: taskEarlyStopForbidden");
    expect(earlyStopRequired).toContain('B: ["TRANSACTION_STARTED", "TASK_LOCK_ATTEMPTED", "TASK_LOCK_ACQUIRED", "TRANSACTION_RELEASED"]');
    expect(earlyStopForbidden).toContain('B: ["CONTEXT_LOCK_ATTEMPTED", "WORKSPACE_LOCK_ATTEMPTED", "CONTRACT_LOCK_ATTEMPTED"]');

    expect(case29).toContain('milestone: "WORKSPACE_LOCK"');
    expect(case29Section).toContain("CONTEXT_LOCK_ATTEMPTED");
    expect(case29Section).toContain("WORKSPACE_LOCK_ATTEMPTED");
    expect(case31).toContain('allowedDomainCodes: new Set(["ACCEPTED_CONTEXT_CATALOG_SUPERSEDED"])');
    expect(case31).toContain("required: sameTaskRequired");
  });

  it("H3B explicit transaction identity scopes contention across nested same-Branch transactions", () => {
    const event = (
      sequence: number,
      branchId: "A" | "B",
      transactionId: number,
      milestone: ValidationBranchTraceEvent["milestone"],
    ): ValidationBranchTraceEvent => ({ sequence, caseId: "CASE30", branchId, transactionId, milestone });

    const taskPlan = {
      mode: "FIRST_OWNER_THEN_CONTEND" as const,
      milestone: "TASK_LOCK" as const,
      firstBranchId: "A" as const,
      secondBranchId: "B" as const,
    };

    // Owner-proven Case30 topology: B owns an outer transaction, a nested preliminary
    // Workspace transaction, then a distinct Task-contention transaction.
    const case30Trace: ValidationBranchTraceEvent[] = [
      event(107, "A", 1001, "TRANSACTION_STARTED"),
      event(108, "B", 2001, "TRANSACTION_STARTED"),
      event(109, "A", 1001, "TASK_LOCK_ATTEMPTED"),
      event(110, "A", 1001, "TASK_LOCK_ACQUIRED"),
      event(111, "B", 2002, "TRANSACTION_STARTED"),
      event(112, "B", 2002, "WORKSPACE_LOCK_ATTEMPTED"),
      event(113, "B", 2002, "WORKSPACE_LOCK_ACQUIRED"),
      event(114, "B", 2002, "TRANSACTION_RELEASED"),
      event(115, "B", 2001, "TRANSACTION_RELEASED"),
      event(116, "B", 2003, "TRANSACTION_STARTED"),
      event(117, "B", 2003, "TASK_LOCK_ATTEMPTED"),
      event(118, "B", 2003, "CONTROLLED_CONTENTION_PROVEN"),
      event(119, "A", 1001, "TASK_LOCK_ATTEMPTED"),
      event(120, "A", 1001, "TASK_LOCK_ACQUIRED"),
      event(121, "A", 1001, "CONTEXT_LOCK_ATTEMPTED"),
      event(122, "A", 1001, "CONTEXT_LOCK_ACQUIRED"),
      event(123, "A", 1001, "WORKSPACE_LOCK_ATTEMPTED"),
      event(124, "A", 1001, "WORKSPACE_LOCK_ACQUIRED"),
      event(125, "A", 1001, "TRANSACTION_RELEASED"),
      event(126, "B", 2003, "TASK_LOCK_ACQUIRED"),
      event(127, "B", 2003, "TRANSACTION_RELEASED"),
    ];
    const case30 = contentionTransactionTrace(case30Trace, taskPlan);
    expect(case30.B.transactionId).toBe(2003);
    expect(case30.B.startSequence).toBe(116);
    expect(case30.B.releaseSequence).toBe(127);
    expect(case30.B.events.some(current => current.milestone === "WORKSPACE_LOCK_ATTEMPTED")).toBe(false);
    expect(case30Trace.some(current => current.transactionId === 2002 && current.milestone === "WORKSPACE_LOCK_ATTEMPTED")).toBe(true);

    // Case26 same-class topology: nested/preliminary transactions on one Branch are
    // legitimate; only the explicit Task-contention transaction may satisfy Contract proof.
    const case26Event = (
      sequence: number,
      branchId: "A" | "B",
      transactionId: number,
      milestone: ValidationBranchTraceEvent["milestone"],
    ): ValidationBranchTraceEvent => ({ sequence, caseId: "CASE26", branchId, transactionId, milestone });
    const case26Trace: ValidationBranchTraceEvent[] = [
      case26Event(300, "A", 3001, "TRANSACTION_STARTED"),
      case26Event(301, "A", 3002, "TRANSACTION_STARTED"),
      case26Event(302, "A", 3002, "WORKSPACE_LOCK_ATTEMPTED"),
      case26Event(303, "A", 3002, "WORKSPACE_LOCK_ACQUIRED"),
      case26Event(304, "A", 3002, "TRANSACTION_RELEASED"),
      case26Event(305, "A", 3001, "TRANSACTION_RELEASED"),
      case26Event(306, "A", 3003, "TRANSACTION_STARTED"),
      case26Event(307, "A", 3003, "TASK_LOCK_ATTEMPTED"),
      case26Event(308, "A", 3003, "TASK_LOCK_ACQUIRED"),
      case26Event(309, "B", 4001, "TRANSACTION_STARTED"),
      case26Event(310, "B", 4001, "TASK_LOCK_ATTEMPTED"),
      case26Event(311, "B", 4001, "CONTROLLED_CONTENTION_PROVEN"),
      case26Event(312, "A", 3003, "CONTEXT_LOCK_ATTEMPTED"),
      case26Event(313, "A", 3003, "WORKSPACE_LOCK_ATTEMPTED"),
      case26Event(314, "A", 3003, "TRANSACTION_RELEASED"),
      case26Event(315, "B", 4001, "TASK_LOCK_ACQUIRED"),
      case26Event(316, "B", 4001, "CONTEXT_LOCK_ATTEMPTED"),
      case26Event(317, "B", 4001, "WORKSPACE_LOCK_ATTEMPTED"),
      case26Event(318, "B", 4001, "CONTRACT_LOCK_ATTEMPTED"),
      case26Event(319, "B", 4001, "TRANSACTION_RELEASED"),
    ];
    const case26 = contentionTransactionTrace(case26Trace, taskPlan);
    expect(case26.A.transactionId).toBe(3003);
    expect(case26.B.transactionId).toBe(4001);
    expect(case26.B.events.some(current => current.milestone === "CONTRACT_LOCK_ATTEMPTED")).toBe(true);

    const falsePassTrace = case30Trace.map(current => ({ ...current }));
    falsePassTrace.splice(7, 0, event(113.5, "B", 2002, "CONTRACT_LOCK_ATTEMPTED"));
    const falsePass = contentionTransactionTrace(falsePassTrace, taskPlan);
    expect(falsePassTrace.some(current => current.branchId === "B" && current.milestone === "CONTRACT_LOCK_ATTEMPTED")).toBe(true);
    expect(falsePass.B.events.some(current => current.milestone === "CONTRACT_LOCK_ATTEMPTED")).toBe(false);

    const duplicateStart = [...case30Trace, event(116.5, "B", 2003, "TRANSACTION_STARTED")];
    expect(() => contentionTransactionTrace(duplicateStart, taskPlan)).toThrow(/TRANSACTION_START_COUNT_INVALID/);

    const adapter = readFileSync("src/server/current-context-forward-authority-validation-db.test-support.ts", "utf8");
    const concurrency = readFileSync("src/server/current-context-forward-authority-concurrency.postgres.integration.test.ts", "utf8");
    expect(adapter).toContain("transactionId: ValidationTransactionId");
    expect(adapter).toContain("allocateValidationTransactionId()");
    expect(adapter).toContain("tracedClient(client, transactionId)");
    expect(adapter).toContain("contentionTransactionTrace(");
    expect(adapter).not.toContain("branchTransactionWindows(");
    expect(concurrency).toContain("contentionTransactionTrace(trace, testCase.plan)");
    expect(concurrency).toContain("transaction.events.some(event => event.milestone === milestone)");
  });

  it("H4 Case 31 uses historical real C1 and current successor R2 with no fabricated catalog", () => {
    const fixture = readFileSync("src/server/current-context-forward-authority-validation-fixtures.test-support.ts", "utf8");
    const concurrency = readFileSync("src/server/current-context-forward-authority-concurrency.postgres.integration.test.ts", "utf8");
    expect(fixture).toContain("createCase31RealCatalogSuccessorFixture");
    expect(fixture).toContain("historicalAcceptedCatalogRevisionId");
    expect(fixture).toContain("CASE31:R2_READY_FOR_CLOSURE");
    expect(fixture).toContain("CASE31:NO_C2_BEFORE_RACE");
    expect(fixture).not.toContain("not-yet-published-catalog");
    expect(concurrency).toContain("runTaskContextClosure");
    expect(concurrency).toContain("ACCEPTED_CONTEXT_CATALOG_SUPERSEDED");
  });

  it("H5 fixture bootstrap proves persisted authority preconditions before concurrency cases", () => {
    const fixture = readFileSync("src/server/current-context-forward-authority-validation-fixtures.test-support.ts", "utf8");
    const proofIndex = fixture.indexOf("proveProductFixturePreconditions({");
    const semanticIndex = fixture.indexOf('createClosedContext("semantic-current"');
    expect(proofIndex).toBeGreaterThan(0);
    expect(semanticIndex).toBeGreaterThan(proofIndex);
    for (const token of ["CANDIDATE_SCOPE_PERSISTED", "MISSING_EVIDENCE_REQUIREMENT", "RESOLUTION_REQUIREMENT", "REAL_HISTORICAL_C1", "R2_READY_FOR_CLOSURE"]) {
      expect(fixture).toContain(token);
    }
  });

  it("H6 Case31 derives READY_FOR_CLOSURE from Product projection and real Mapping Iteration schema", () => {
    const fixture = readFileSync("src/server/current-context-forward-authority-validation-fixtures.test-support.ts", "utf8");
    const migration = readFileSync("migrations/014_governed_context_assembly_and_ai_context_mapping_v2.sql", "utf8");
    const normalize = (value: string) => value.replace(/\s+/g, " ").trim();

    const case31Start = fixture.indexOf("async function createCase31RealCatalogSuccessorFixture");
    const case31End = fixture.indexOf("async function createMissingContext", case31Start);
    const case31 = fixture.slice(case31Start, case31End);
    const preconditionStart = fixture.indexOf("async function proveProductFixturePreconditions");
    const preconditionEnd = fixture.indexOf("export async function bootstrapDeterministicConcurrencyFixtures", preconditionStart);
    const preconditions = fixture.slice(preconditionStart, preconditionEnd);

    expect(case31).toContain("const r2View = await readTaskContextClosure(taskId)");
    expect(case31).toContain('r2View.state !== "READY_FOR_CLOSURE"');
    expect(preconditions).toContain("const closure31View = await readTaskContextClosure(input.closure31.taskId)");
    expect(preconditions).toContain('closure31View.state !== "READY_FOR_CLOSURE"');
    expect(fixture).not.toMatch(/\bstatus\s*=\s*["']READY_FOR_CLOSURE["']/);

    const mappingIterationSql = fixture.match(/`[^`]*context_assembly_mapping_iterations[^`]*`/g) ?? [];
    expect(mappingIterationSql.length).toBeGreaterThanOrEqual(2);
    for (const sql of mappingIterationSql) expect(sql).not.toMatch(/\bstatus\b/i);

    expect(normalize(case31)).toContain(
      "select id, mapping_run_id, analysis_outcome from intentchord.context_assembly_mapping_iterations where context_assembly_revision_id=$1 order by iteration_ordinal desc,id desc limit 1",
    );
    expect(normalize(preconditions)).toContain(
      "select id,mapping_run_id,analysis_outcome from intentchord.context_assembly_mapping_iterations where id=$1 and context_assembly_revision_id=$2",
    );
    expect(case31).toContain("iteration.rows[0].mapping_run_id !== r2View.latestMappingRun.id");
    expect(preconditions).toContain("case31Iteration.rows[0].mapping_run_id !== closure31View.latestMappingRun.id");
    expect(case31).toContain('iteration.rows[0].analysis_outcome !== "ANALYSIS_FINDINGS_NO_KNOWN_BLOCKING_GAP"');
    expect(preconditions).toContain('case31Iteration.rows[0].analysis_outcome !== "ANALYSIS_FINDINGS_NO_KNOWN_BLOCKING_GAP"');
    expect(preconditions).toContain('"CASE31:NO_C2_BEFORE_RACE"');

    const tableStart = migration.indexOf("CREATE TABLE IF NOT EXISTS intentchord.context_assembly_mapping_iterations");
    const tableEnd = migration.indexOf("CREATE TABLE IF NOT EXISTS intentchord.context_missing_evidence_requests", tableStart);
    const mappingIterationTable = migration.slice(tableStart, tableEnd);
    for (const column of ["id uuid PRIMARY KEY", "context_assembly_revision_id uuid NOT NULL", "mapping_run_id uuid NOT NULL", "v2_result_id uuid NOT NULL", "iteration_ordinal integer NOT NULL", "analysis_outcome text NOT NULL", "created_at timestamptz NOT NULL"]) {
      expect(mappingIterationTable).toContain(column);
    }
    expect(mappingIterationTable).not.toMatch(/\bstatus\b/i);
  });


  it("V2 deterministic Owner PG analysis fixtures pass the real validator with governed Component identities", () => {
    const fixtureInput: ContextAssemblyMappingInputV2 = {
      schema_version: CONTEXT_ASSEMBLY_MAPPING_INPUT_SCHEMA_VERSION,
      context_assembly_id: "assembly_fixture",
      context_assembly_revision_id: "assembly_revision_fixture",
      context_assembly_revision: 1,
      created_at: "2026-08-21T00:00:00.000Z",
      source_bindings: [{
        workspace_id: "workspace_fixture",
        workspace_registration_revision: 1,
        workspace_registration_fingerprint: "workspace-fixture-fingerprint",
        workspace_revision_id: "workspace_revision_fixture",
        workspace_index_snapshot_id: "snapshot_fixture",
        canonical_index_artifact_id: "artifact_fixture",
        workspace_index_sha256: `sha256:${"a".repeat(64)}`,
        artifact_semantic_sha256: `sha256:${"b".repeat(64)}`,
      }],
      entries: [{
        entry_id: "entry_fixture",
        workspace_id: "workspace_fixture",
        normalized_path: "src/fixture.ts",
        entry_type: "FILE",
        language_or_format: "typescript",
        size_bytes: 42,
        content_or_metadata_fingerprint: `sha256:${"c".repeat(64)}`,
        index_supported_signals: {
          file_kind: "SOURCE",
          parse_status: "PARSED",
          coverage_state: "COVERED",
          fact_signals: [],
          relation_signals: [],
        },
      }],
      serialized_payload_sha256: `sha256:${"d".repeat(64)}`,
      provider_neutral_estimated_tokens: 100,
      proof_obligations: ["COMPONENTS_EVIDENCE_BACKED"],
    };

    const cases = [
      { name: "no-gap", analysis: noGapAnalysis(fixtureInput, "fixture-no-gap") },
      { name: "missing-evidence", analysis: missingEvidenceAnalysis(fixtureInput, "fixture-missing-evidence", "workspace_missing") },
    ];

    for (const current of cases) {
      const result = validateModelContextAnalysisV2(JSON.stringify(current.analysis), fixtureInput);
      expect(result.gates.find(gate => gate.gate === "JSON_PARSE")?.status, current.name).toBe("PASS");
      expect(result.gates.find(gate => gate.gate === "JSON_SCHEMA")?.status, current.name).toBe("PASS");
      expect(result.status, current.name).toBe("PASS");
      expect(current.analysis.components.every(component => /^ctx_[a-z0-9][a-z0-9_-]{2,63}$/.test(component.component_id)), current.name).toBe(true);
    }

    const missing = cases[1].analysis;
    expect(missing.missing_evidence_requests).toHaveLength(1);
    expect(missing.missing_evidence_requests[0].affected_component_ids).toEqual([missing.components[0].component_id]);
  });

  it("V2 expected Candidate identity is canonical, schema-valid, and fail-closed on missing contextAssemblyId", () => {
    const candidate: ContextAssemblyTaskCandidateScope = {
      authorityVersion: "CONTEXT_ASSEMBLY_V2",
      contextAssemblyId: "11111111-1111-4111-8111-111111111111",
      contextAssemblyRevisionId: "22222222-2222-4222-8222-222222222222",
      mappingIterationId: "33333333-3333-4333-8333-333333333333",
      closureEvaluationId: "44444444-4444-4444-8444-444444444444",
      acceptedCatalogRevisionId: "55555555-5555-4555-8555-555555555555",
      acceptedCatalogSha256: "a".repeat(64),
      selectedComponentIdsSha256: "b".repeat(64),
      candidateScopeSha256: "c".repeat(64),
      entries: [{
        workspaceId: "workspace_fixture",
        normalizedPath: "src/fixture.ts",
        componentId: "ctx_fixture",
        evidenceEntryId: "entry_fixture",
      }],
      candidateAllowedPaths: [{ workspaceId: "workspace_fixture", path: "src/fixture.ts" }],
    };

    const canonicalIdentity = candidateScopeIdentityFromScope(candidate);
    expect(canonicalIdentity.authorityVersion).toBe("CONTEXT_ASSEMBLY_V2");
    if (canonicalIdentity.authorityVersion !== "CONTEXT_ASSEMBLY_V2") {
      throw new Error("VALIDATION_HARNESS_V2_CANONICAL_IDENTITY_REQUIRED");
    }
    expect(canonicalIdentity.contextAssemblyId).toBe(candidate.contextAssemblyId);
    expect(taskCandidateScopeIdentitySchema.safeParse(canonicalIdentity).success).toBe(true);
    expect(candidateScopeIdentityMatches(canonicalIdentity, candidate)).toBe(true);

    const { contextAssemblyId: _omitted, ...missingContextAssemblyId } = canonicalIdentity;
    expect(taskCandidateScopeIdentitySchema.safeParse(missingContextAssemblyId).success).toBe(false);
  });


  it("Context Assembly binding equality is semantic, order-insensitive, and fail-closed per authority field", () => {
    const left: TaskContextAssemblyBinding = {
      contractVersion: "intentchord.context-assembly.v1",
      contextAssemblyId: "11111111-1111-4111-8111-111111111111",
      contextAssemblyRevisionId: "22222222-2222-4222-8222-222222222222",
      contextAssemblyRevision: 7,
      mappingIterationId: "33333333-3333-4333-8333-333333333333",
      closureEvaluationId: "44444444-4444-4444-8444-444444444444",
      acceptedCatalogRevisionId: "55555555-5555-4555-8555-555555555555",
      acceptedCatalogSha256: "a".repeat(64),
    };
    const reordered: TaskContextAssemblyBinding = {
      acceptedCatalogSha256: left.acceptedCatalogSha256,
      acceptedCatalogRevisionId: left.acceptedCatalogRevisionId,
      closureEvaluationId: left.closureEvaluationId,
      mappingIterationId: left.mappingIterationId,
      contextAssemblyRevision: left.contextAssemblyRevision,
      contextAssemblyRevisionId: left.contextAssemblyRevisionId,
      contextAssemblyId: left.contextAssemblyId,
      contractVersion: left.contractVersion,
    };

    expect(JSON.stringify(left)).not.toBe(JSON.stringify(reordered));
    expect(contextAssemblyBindingMatches(left, reordered)).toBe(true);

    const mutations: Array<[keyof TaskContextAssemblyBinding, unknown]> = [
      ["contractVersion", "intentchord.context-assembly.v2"],
      ["contextAssemblyId", "aaaaaaaa-1111-4111-8111-111111111111"],
      ["contextAssemblyRevisionId", "bbbbbbbb-2222-4222-8222-222222222222"],
      ["contextAssemblyRevision", left.contextAssemblyRevision + 1],
      ["mappingIterationId", "cccccccc-3333-4333-8333-333333333333"],
      ["closureEvaluationId", "dddddddd-4444-4444-8444-444444444444"],
      ["acceptedCatalogRevisionId", "eeeeeeee-5555-4555-8555-555555555555"],
      ["acceptedCatalogSha256", "b".repeat(64)],
    ];

    for (const [field, value] of mutations) {
      const changed = { ...reordered };
      Object.defineProperty(changed, field, { value, enumerable: true, configurable: true });
      expect(contextAssemblyBindingMatches(left, changed), field).toBe(false);
    }

    const serviceSource = readFileSync("src/server/context-assembly-task-binding-service.ts", "utf8");
    const staleGuard = serviceSource.slice(serviceSource.indexOf("export async function validateContextAssemblyCandidateScope"));
    expect(staleGuard).toContain("contextAssemblyBindingMatches(resolved.binding, input.binding)");
    expect(staleGuard).toContain("candidateScopeIdentityMatches(resolved.candidateScope, input.candidateScope)");
    expect(staleGuard).not.toMatch(/JSON\.stringify\([^\n]*binding/);
  });

  it("H7 Owner sequence runs TypeScript and focused Vitest before rollback-only Owner DB qualification, then disposable PG and build", () => {
    const sequence = readFileSync("scripts/validate-current-context-forward-authority-owner-sequence.mjs", "utf8");
    const ordered = [
      'run("GOVERNED_NPM_CI"',
      'run("AUTHORITATIVE_TYPESCRIPT"',
      'run("OFFICIAL_VITEST_VALIDATION_HARNESS"',
      'run("OFFICIAL_VITEST_SEMANTIC_LOCK"',
      'run("OWNER_DB_MIGRATION_014_PREFLIGHT"',
      'run("OWNER_DB_MIGRATION_014_QUALIFY_ROLLBACK_ONLY"',
      'run("DISPOSABLE_DB_BOOTSTRAP"',
      'run("OFFICIAL_VITEST_DISPOSABLE_PG"',
      'run("PRODUCTION_BUILD"',
    ].map(token => sequence.indexOf(token));
    expect(ordered.every(index => index >= 0)).toBe(true);
    expect(ordered).toEqual([...ordered].sort((a, b) => a - b));
    expect(sequence).not.toContain('migration:014:apply');
  });

});

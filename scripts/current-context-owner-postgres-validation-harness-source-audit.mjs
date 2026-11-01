import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const expected014 = "8ED111969E4D92CF2DFC613A0AC7573D1E1E2FF01ADA012A8EEABA90561947EB";
const expectedLock = "DDAA83B333CCBF7D61890914E769CA2666F8F779B842709DE8FAFF7496019D3F";
const protectedHashes = {
  "src/server/context-head-authority.ts": "FE454A73404A61BB770033106AEB02924F60EF7C82903499196C35E66DF0531E",
  "src/server/context-closure-service.ts": "409286CBC38E3541D5889B4529B5D3BB5527824826AFAAF5A0D1EFE9586FC858",
  "src/server/lifecycle.ts": "693719259E7971101511DADEF33DFFD8B7CA13F208B8EE69BDC3FFDD215E4049",
  "src/core/context-authority/current-effective-context.ts": "424D4EE1EC49451E38F942349EF16A68D69018C12348562263F5864FC2BD917F",
  "src/core/context-closure/v1.ts": "298BE3F0F72631AA8D20F871E001A01E6EEEB4ED63D5321F681877BD48891FFD",
  "src/core/tasks/task-input.ts": "E34CD0E3D869A124B827BA2CCDF58E997F58C443CA037EF6EA6B35210B2C869D",
  "src/core/tasks/correction-authority.ts": "E2B90592231D917D29445341555A6FDADC5916601E375051E93B9E6CBF24D486",
};
const sha = path => createHash("sha256").update(readFileSync(path)).digest("hex").toUpperCase();
const text = path => readFileSync(path, "utf8");
const concurrency = text("src/server/current-context-forward-authority-concurrency.postgres.integration.test.ts");
const dbAdapter = text("src/server/current-context-forward-authority-validation-db.test-support.ts");
const fixtures = text("src/server/current-context-forward-authority-validation-fixtures.test-support.ts");
const harness = text("src/server/current-context-forward-authority-validation-harness.test.ts");
const taskInput = text("src/core/tasks/task-input.ts");
const schemas = text("src/server/schemas.ts");
const bindingService = text("src/server/context-assembly-task-binding-service.ts");
const runner = text("scripts/run-current-context-forward-authority-concurrency-postgres-tests.mjs");
const bootstrap = text("scripts/bootstrap-current-context-forward-authority-validation-db.mjs");
const sequence = text("scripts/validate-current-context-forward-authority-owner-sequence.mjs");
const qualifier = text("scripts/migration-014-governed.mjs");
const snapshotStructuralProof = qualifier.slice(
  qualifier.indexOf("function canonicalConstraintExpression"),
  qualifier.indexOf("function legacyParenthesesDestructiveSnapshotFlatten"),
);
const migration014 = text("migrations/014_governed_context_assembly_and_ai_context_mapping_v2.sql");
const migration014Logic = migration014.toLowerCase().replace(/\s+/g, "");
const pkg = JSON.parse(text("package.json"));

const sequenceTokens = [
  'run("GOVERNED_NPM_CI", ["ci"])',
  'run("AUTHORITATIVE_TYPESCRIPT", ["run", "typecheck"])',
  'run("OFFICIAL_VITEST_VALIDATION_HARNESS", ["run", "test:current-context:validation-harness"])',
  'run("OFFICIAL_VITEST_SEMANTIC_LOCK", ["run", "test:current-context:semantic-lock"])',
  'run("OWNER_DB_MIGRATION_014_PREFLIGHT", ["run", "migration:014:preflight"])',
  'run("OWNER_DB_MIGRATION_014_QUALIFY_ROLLBACK_ONLY", ["run", "migration:014:qualify"])',
  'run("DISPOSABLE_DB_BOOTSTRAP", ["run", "validation:current-context:disposable:bootstrap"])',
  'run("OFFICIAL_VITEST_DISPOSABLE_PG", ["run", "test:current-context:pg-concurrency"]',
  'run("PRODUCTION_BUILD", ["run", "build"])',
];
const sequencePositions = sequenceTokens.map(token => sequence.indexOf(token));
const ownerSequenceExact = sequencePositions.every(index => index >= 0)
  && sequencePositions.every((index, i) => i === 0 || index > sequencePositions[i - 1]);

const requiredTraceTokens = [
  "TRANSACTION_STARTED", "TASK_LOCK_ATTEMPTED", "TASK_LOCK_ACQUIRED", "CONTEXT_LOCK_ATTEMPTED",
  "WORKSPACE_LOCK_ATTEMPTED", "CONTRACT_LOCK_ATTEMPTED", "RUN_LOCK_ATTEMPTED", "TRANSACTION_RELEASED",
  "CONTROLLED_CONTENTION_PROVEN",
];

function caseBlock(caseId, nextCaseId) {
  const start = concurrency.indexOf(`caseId: "${caseId}"`);
  const end = nextCaseId ? concurrency.indexOf(`caseId: "${nextCaseId}"`, start + 1) : concurrency.length;
  return start >= 0 ? concurrency.slice(start, end < 0 ? concurrency.length : end) : "";
}
const case26 = caseBlock("CASE26", "CASE27");
const case27 = caseBlock("CASE27", "CASE28");
const case28 = caseBlock("CASE28", "CASE29");
const case29 = caseBlock("CASE29", "CASE30");
const case29Section = concurrency.slice(concurrency.indexOf('it("29 reciprocal authorizeTaskContextSource'), concurrency.indexOf('caseId: "CASE30"'));
const case30 = caseBlock("CASE30", "CASE31");
const case31 = caseBlock("CASE31", undefined);
const contractRequired = concurrency.slice(concurrency.indexOf("const contractBranchRequired"), concurrency.indexOf("const taskEarlyStopRequired"));
const earlyStopRequired = concurrency.slice(concurrency.indexOf("const taskEarlyStopRequired"), concurrency.indexOf("const taskEarlyStopForbidden"));
const earlyStopForbidden = concurrency.slice(concurrency.indexOf("const taskEarlyStopForbidden"), concurrency.indexOf('describe("Owner disposable PostgreSQL Current Context product concurrency"'));

const checks = [
  ["01_MIGRATION_014_UNCHANGED", sha("migrations/014_governed_context_assembly_and_ai_context_mapping_v2.sql") === expected014],
  ["02_PACKAGE_LOCK_UNCHANGED", sha("package-lock.json") === expectedLock],
  ["03_PROTECTED_PRODUCT_SOURCE_UNCHANGED", Object.entries(protectedHashes).every(([p,h]) => sha(p) === h)],
  ["04_DISPOSABLE_DB_DENIES_OWNER", dbAdapter.includes('database === OWNER_DATABASE') && dbAdapter.includes('DISPOSABLE_VALIDATION_DATABASE_IDENTITY_BLOCKED')],
  ["05_EXPLICIT_DISPOSABLE_AUTHORIZATION", dbAdapter.includes('INTENTCHORD_DISPOSABLE_VALIDATION_AUTHORIZED')],
  ["06_NO_OWNER_DATABASE_URL_FALLBACK", !runner.includes('.env.local') && !runner.includes('process.env.DATABASE_URL') && !bootstrap.includes('process.env.DATABASE_URL')],
  ["07_REAL_TEMP_WORKSPACE_ROOTS", fixtures.includes('mkdtemp') && fixtures.includes('tmpdir()') && fixtures.includes('createRealFixtureWorkspaceRoot')],
  ["08_PRODUCTION_WORKSPACE_REGISTRATION_PATH", fixtures.includes('verifyAndRegisterWorkspace') && fixtures.includes('assertRegisteredWorkspaceSourceAuthority')],
  ["09_NO_SYNTHETIC_PRODUCT_ROOT", !fixtures.includes('/intentchord-validation/') && !fixtures.includes('not-yet-published-catalog') && !fixtures.includes('rootObjectDeviceId =')],
  ["10_REAL_ROOT_CLEANUP_AFTER_SUITE", fixtures.includes('cleanupValidationWorkspaceRoots') && concurrency.includes('cleanupValidationWorkspaceRoots')],
  ["11_FIXTURE_AUTHORITY_PRECONDITION_PROOF", fixtures.includes('proveProductFixturePreconditions') && fixtures.includes('CANDIDATE_SCOPE_PERSISTED') && fixtures.includes('MISSING_EVIDENCE_REQUIREMENT')],
  ["12_CASE31_REAL_C1_R2", fixtures.includes('createCase31RealCatalogSuccessorFixture') && fixtures.includes('historicalAcceptedCatalogRevisionId') && fixtures.includes('CASE31:NO_C2_BEFORE_RACE')],
  ["13_TEST_ONLY_ASYNC_BRANCH_CONTEXT", dbAdapter.includes('AsyncLocalStorage') && concurrency.includes('vi.mock("@/server/db"')],
  ["14_FORCED_TASK_CONTENTION", dbAdapter.includes('FIRST_OWNER_THEN_CONTEND') && concurrency.includes('milestone: "TASK_LOCK"')],
  ["15_FORCED_RECIPROCAL_WORKSPACE_CONTENTION", dbAdapter.includes('SIMULTANEOUS_ATTEMPT') && concurrency.includes('milestone: "WORKSPACE_LOCK"')],
  ["16_BRANCH_TRACE_MILESTONES", requiredTraceTokens.every(token => dbAdapter.includes(token))],
  ["17_BRANCH_TRACE_FAILURE_EVIDENCE", concurrency.includes('BRANCH_TRACE=') && concurrency.includes('formatValidationBranchTrace')],
  ["18_NO_WEAK_PROMISE_ONLY_ORACLE", !concurrency.includes('raceProductCommands') && concurrency.includes('assertRequiredMilestones') && concurrency.includes('assertForcedOverlap')],
  ["19_PRODUCT_BLOCKING_CODES_FATAL", concurrency.includes('40P01') && concurrency.includes('55P03') && concurrency.includes('57014') && concurrency.includes('POSTGRES_BLOCKING_')],
  ["20_ACTUAL_PRODUCT_CASE26", case26.includes("resolveContract(") && case26.includes("approveContractRevision(") && case26.includes('required: contractBranchRequired') && case26.includes('allowedDomainCodes: new Set(["REVISION_CONFLICT"])')],
  ["21_ACTUAL_PRODUCT_CASE27", case27.includes("resolveContract(") && case27.includes("compileContractArtifact(") && case27.includes('required: contractBranchRequired') && case27.includes('allowedDomainCodes: new Set(["REVISION_CONFLICT"])')],
  ["22_ACTUAL_PRODUCT_CASE28", case28.includes("commitTaskWorkSelection(") && case28.includes("approveContractRevision(") && case28.includes('required: taskEarlyStopRequired') && case28.includes('forbidden: taskEarlyStopForbidden') && case28.includes('allowedDomainCodes: new Set(["UNIFIED_V2_SCOPE_AUTHORITY_REQUIRED"])')],
  ["23_ACTUAL_PRODUCT_CASE29", case29Section.includes("authorizeTaskContextSource(") && case29Section.includes('milestone: "WORKSPACE_LOCK"') && case29Section.includes("CONTEXT_LOCK_ATTEMPTED") && case29Section.includes("WORKSPACE_LOCK_ATTEMPTED")],
  ["24_ACTUAL_PRODUCT_CASE30", case30.includes("confirmTaskScope(") && case30.includes("resolveContract(") && case30.includes('required: taskEarlyStopRequired') && case30.includes('forbidden: taskEarlyStopForbidden') && case30.includes('allowedDomainCodes: new Set(["REVISION_CONFLICT"])')],
  ["25_ACTUAL_PRODUCT_CASE31", case31.includes("runTaskContextClosure(") && case31.includes("commitTaskWorkSelection(") && case31.includes('required: sameTaskRequired') && case31.includes('allowedDomainCodes: new Set(["ACCEPTED_CONTEXT_CATALOG_SUPERSEDED"])')],
  ["26_POSITIVE_TRANSACTION_RELEASE_CONTROL", concurrency.includes('harness control: each canonical branch releases its transaction independently')],
  ["27_NEGATIVE_INVERSE_LOCK_CONTROL", concurrency.includes('harness negative control') && concurrency.includes('firstLockBarrier')],
  ["28_DISPOSABLE_APPLIES_001_014", bootstrap.includes('required.length !== 14') && bootstrap.includes('DISPOSABLE_DB_MIGRATION_014_APPLIED_FOR_VALIDATION=PASS')],
  ["29_NO_CREATE_DROP_DATABASE", !/CREATE\s+DATABASE/i.test(bootstrap) && !/DROP\s+DATABASE/i.test(bootstrap)],
  ["30_OWNER_SEQUENCE_EXACT_ORDER", ownerSequenceExact],
  ["31_OWNER_QUALIFY_ROLLBACK_ONLY", sequence.includes('migration:014:qualify') && sequence.includes('OWNER_DB_MIGRATION_014_PERSISTENT_APPLY=NO') && !sequence.includes('migration:014:apply')],
  ["32_TYPESCRIPT_BEFORE_DB_QUALIFICATION", sequence.indexOf('AUTHORITATIVE_TYPESCRIPT') < sequence.indexOf('OWNER_DB_MIGRATION_014_PREFLIGHT')],
  ["33_PRODUCTION_BUILD_AFTER_DISPOSABLE_PG", sequence.indexOf('PRODUCTION_BUILD') > sequence.indexOf('OFFICIAL_VITEST_DISPOSABLE_PG')],
  ["34_OFFICIAL_VITEST_RUNNER", runner.includes('node_modules", "vitest", "vitest.mjs')],
  ["35_PACKAGE_SCRIPTS_PRESENT", Boolean(pkg.scripts?.['validation:current-context:disposable:bootstrap'] && pkg.scripts?.['test:current-context:pg-concurrency'] && pkg.scripts?.['validate:current-context:owner-preapply'] && pkg.scripts?.typecheck && pkg.scripts?.build)],
  ["36_HARNESS_COVERS_H1_H7", ["H1 ", "H2/H3", "H4 ", "H5 ", "H7 "].every(token => harness.includes(token))],
  ["37_OWNER_SEQUENCE_NO_DIRECT_NPM_CMD", !/npm\.(?:cmd|bat)/i.test(sequence)],
  ["38_OWNER_SEQUENCE_NO_SHELL_TRUE", !/shell\s*:\s*true/.test(sequence) && /shell\s*:\s*false/.test(sequence)],
  ["39_OWNER_SEQUENCE_DETERMINISTIC_NPM_CLI_RESOLUTION", sequence.includes("process.env.INTENTCHORD_NPM_CLI_PATH") && sequence.includes("process.env.npm_execpath") && sequence.includes('"node_modules", "npm", "bin", "npm-cli.js"') && sequence.includes("existsSync(candidate)") && sequence.includes('path.basename(candidate).toLowerCase() !== "npm-cli.js"')],
  ["40_OWNER_SEQUENCE_NPM_EXECUTES_THROUGH_PROCESS_EXECPATH", sequence.includes("spawnSync(process.execPath, [npmCliPath, ...args]") && sequence.includes('spawnSync(process.execPath, [npmCliPath, "--version"]')],
  ["41_OWNER_SEQUENCE_NPM_VERSION_PROBE_FAIL_CLOSED", ["NPM_VERSION_PROBE_LAUNCH_ERROR", "NPM_VERSION_PROBE_NONZERO_CHILD_EXIT", "NPM_VERSION_PROBE_STDOUT_MISSING", "NPM_VERSION_MISMATCH", "if (npm !== EXPECTED_NPM)"].every(token => sequence.includes(token))],
  ["42_OWNER_SEQUENCE_ONE_RESOLVED_NPM_IDENTITY_FOR_ALL_STAGES", (sequence.match(/const npmCliPath = resolveNpmCliPath\(\);/g) ?? []).length === 1 && (sequence.match(/run\("/g) ?? []).length === 9 && sequence.includes("[npmCliPath, ...args]")],
  ["43_OWNER_SEQUENCE_CHILD_FAILURE_CLASSIFICATION", sequence.includes("_LAUNCH_ERROR") && sequence.includes("_NONZERO_CHILD_EXIT") && sequence.includes("_CHILD_TERMINATED_WITHOUT_EXIT")],
  ["44_OWNER_PREAPPLY_NO_DIRECT_BATCH_LAUNCH", [sequence, runner, bootstrap, qualifier].every(source => !/\.(?:cmd|bat)\b/i.test(source))],
  ["45_OWNER_SEQUENCE_NO_CMD_EXE", !/\bcmd(?:\.exe)?\b/i.test(sequence)],
  ["46_WORKSPACE_SOURCE_REVISION_SHARED_INSERT_CONTRACT", fixtures.includes("const WORKSPACE_SOURCE_REVISION_INSERT_SQL") && fixtures.includes("values($1,$2,$3,$4,$5,$6)")],
  ["47_WORKSPACE_SOURCE_REVISION_BOTH_FIXTURE_PATHS_USE_SHARED_CONTRACT", (fixtures.match(/WORKSPACE_SOURCE_REVISION_INSERT_SQL/g) ?? []).length === 3 && fixtures.includes("client.query(\n      WORKSPACE_SOURCE_REVISION_INSERT_SQL") && fixtures.includes("databaseQuery(\n    WORKSPACE_SOURCE_REVISION_INSERT_SQL")],
  ["48_WORKSPACE_SOURCE_REVISION_NO_UUID_TEXT_PLACEHOLDER_REUSE", !fixtures.includes("$2::text") && !/workspace_source_revisions[\s\S]{0,240}values\([^)]*\$(\d+)[^)]*\$\1::text/i.test(fixtures)],
  ["49_WORKSPACE_SOURCE_REVISION_DISTINCT_IDENTITY_BIND_VALUES", fixtures.includes("[semantic.workspace_revision_id, id, id, sourceTreeFingerprint") && fixtures.includes("[revisionId, workspaceId, workspaceId, sourceFingerprint")],
  ["50_MIGRATION_014_REPLACES_INHERITED_SNAPSHOT_BINDING_CONSTRAINT", migration014.includes("DROP CONSTRAINT IF EXISTS context_mapping_runs_snapshot_binding_shape_ck") && migration014.includes("ADD CONSTRAINT context_mapping_runs_snapshot_binding_shape_ck CHECK")],
  ["51_MIGRATION_014_PRESERVES_HISTORICAL_V1_NULL_SHAPE", migration014Logic.includes("qualification_scope='ai_context_mapping_v1'andworkspace_index_snapshot_idisnullandmapping_idempotency_keyisnullandmapping_request_fingerprint_sha256isnull")],
  ["52_MIGRATION_014_PRESERVES_GOVERNED_V1_SNAPSHOT_SHAPE", migration014Logic.includes("qualification_scope='ai_context_mapping_v1'andworkspace_index_snapshot_idisnotnullandmapping_idempotency_keyisnotnullandbtrim(mapping_idempotency_key)<>''andchar_length(mapping_idempotency_key)<=200andmapping_request_fingerprint_sha256isnotnull")],
  ["53_MIGRATION_014_ENABLES_V2_CONTEXT_ASSEMBLY_MAPPING_SHAPE", migration014Logic.includes("qualification_scope='ai_context_mapping_v2'andworkspace_index_snapshot_idisnullandmapping_idempotency_keyisnotnullandbtrim(mapping_idempotency_key)<>''andchar_length(mapping_idempotency_key)<=200andmapping_request_fingerprint_sha256isnotnull") && !migration014Logic.includes("qualification_scope='ai_context_mapping_v2'andworkspace_index_snapshot_idisnullandmapping_idempotency_keyisnull")],
  ["54_MIGRATION_014_QUALIFIER_READS_ACTUAL_SNAPSHOT_CONSTRAINT", qualifier.includes("assertContextMappingRunSnapshotBindingConstraint") && qualifier.includes("context_mapping_runs_snapshot_binding_shape_ck") && qualifier.includes("pg_get_constraintdef")],
  ["55_MIGRATION_014_QUALIFIER_PRESERVES_BOOLEAN_GROUPING", snapshotStructuralProof.includes("parseConstraintBooleanExpression") && snapshotStructuralProof.includes("splitTopLevelBoolean") && snapshotStructuralProof.includes("stripRedundantOuterParentheses") && !snapshotStructuralProof.includes('.replaceAll("(", "")') && !snapshotStructuralProof.includes('.replaceAll(")", "")') && !qualifier.includes("function normalizedConstraintLogic")],
  ["56_MIGRATION_014_QUALIFIER_REQUIRES_EXACTLY_THREE_TOP_LEVEL_OR_BRANCHES", qualifier.includes('branches.length !== 3') && qualifier.includes('flattenAssociativeBoolean(tree, "or")')],
  ["57_MIGRATION_014_QUALIFIER_BRANCH_LOCAL_PREDICATES_EXACT", qualifier.includes("SNAPSHOT_BINDING_EXPECTED_BRANCHES") && qualifier.includes("branchPredicateSignature") && qualifier.includes("BRANCH_LOCAL_PREDICATE_MISMATCH")],
  ["58_MIGRATION_014_QUALIFIER_STRUCTURAL_NEGATIVE_CONTROLS", ["PG_GET_CONSTRAINTDEF_STYLE", "HISTORICAL_AND_GOVERNED", "V2_BRANCH_MISSING", "V2_SNAPSHOT_NOT_NULL", "V2_IDEMPOTENCY_NULL", "V2_FINGERPRINT_NULL", "PREDICATE_MOVED_BETWEEN_BRANCHES", "SAME_TOKENS_DIFFERENT_GROUPING"].every(token => qualifier.includes(token))],
  ["59_MIGRATION_014_QUALIFIER_OLD_FLATTEN_COLLISION_CONTROL", qualifier.includes("legacyParenthesesDestructiveSnapshotFlatten(valid)") && qualifier.includes("legacyParenthesesDestructiveSnapshotFlatten(malformedSameFlatten)") && qualifier.includes("MIGRATION_014_SNAPSHOT_BINDING_LEGACY_FLATTEN_COLLISION")],
  ["60_MIGRATION_014_QUALIFIER_STRUCTURAL_SELF_TEST_SOURCE_SAFE_MODE", qualifier.includes('INTENTCHORD_MIGRATION_014_STRUCTURAL_SELF_TEST') && qualifier.includes("runSnapshotBindingStructuralSelfTest()")],
  ["61_V2_FIXTURE_GOVERNED_COMPONENT_ID_HELPER", fixtures.includes("function fixtureComponentId(label: string, index?: number): string") && fixtures.includes('return `ctx_${index === undefined ? sanitizedLabel : `${index}_${sanitizedLabel}`}`;')],
  ["62_V2_FIXTURE_NO_STALE_COMPONENT_PREFIX_GENERATOR", !fixtures.includes('component_id: `component_') && !fixtures.includes('affected_component_ids: [`component_')],
  ["63_V2_FIXTURE_BOTH_ANALYSIS_PATHS_USE_COMPONENT_ID_HELPER", fixtures.includes("component_id: fixtureComponentId(label, index)") && fixtures.includes("const componentId = fixtureComponentId(label)") && fixtures.includes("component_id: componentId") && fixtures.includes("affected_component_ids: [componentId]")],
  ["64_V2_FIXTURE_REAL_VALIDATOR_REGRESSION_PRESENT", harness.includes("validateModelContextAnalysisV2") && harness.includes('name: "no-gap", analysis: noGapAnalysis') && harness.includes('name: "missing-evidence", analysis: missingEvidenceAnalysis') && harness.includes('gate.gate === "JSON_PARSE"') && harness.includes('gate.gate === "JSON_SCHEMA"') && harness.includes('expect(result.status, current.name).toBe("PASS")')],
  ["65_V2_FIXTURE_COMPONENT_IDENTITY_AND_MISSING_REFERENCE_REGRESSION", harness.includes('/^ctx_[a-z0-9][a-z0-9_-]{2,63}$/') && harness.includes("affected_component_ids).toEqual([missing.components[0].component_id])")],
  ["66_FIXTURE_SCOPE_CONFIRMATION_USES_CANONICAL_CANDIDATE_IDENTITY", fixtures.includes('import { candidateScopeIdentityFromScope, createBlankTaskDraft') && fixtures.includes('expectedCandidateIdentity: candidateScopeIdentityFromScope(candidate)')],
  ["67_CASE30_USES_CANONICAL_CANDIDATE_IDENTITY", concurrency.includes('import { candidateScopeIdentityFromScope } from "@/core/tasks/task-input";') && concurrency.includes('expectedCandidateIdentity: candidateScopeIdentityFromScope(candidate)')],
  ["68_NO_STALE_MANUAL_V2_EXPECTED_CANDIDATE_IDENTITY", !/expectedCandidateIdentity\s*:\s*\{\s*authorityVersion\s*:\s*["']CONTEXT_ASSEMBLY_V2["']/s.test(`${fixtures}\n${concurrency}`)],
  ["69_CANONICAL_V2_IDENTITY_INCLUDES_CONTEXT_ASSEMBLY_ID", taskInput.includes('contextAssemblyId: scope.contextAssemblyId') && schemas.includes('contextAssemblyId: z.string().uuid()')],
  ["70_V2_CANDIDATE_IDENTITY_REAL_SCHEMA_REGRESSION", harness.includes('candidateScopeIdentityFromScope(candidate)') && harness.includes('taskCandidateScopeIdentitySchema.safeParse(canonicalIdentity).success') && harness.includes('candidateScopeIdentityMatches(canonicalIdentity, candidate)') && harness.includes('const { contextAssemblyId: _omitted, ...missingContextAssemblyId } = canonicalIdentity') && harness.includes('taskCandidateScopeIdentitySchema.safeParse(missingContextAssemblyId).success')],
  ["71_CONTEXT_ASSEMBLY_BINDING_FIELD_BY_FIELD_EQUALITY", ["contractVersion", "contextAssemblyId", "contextAssemblyRevisionId", "contextAssemblyRevision", "mappingIterationId", "closureEvaluationId", "acceptedCatalogRevisionId", "acceptedCatalogSha256"].every(field => bindingService.includes(`left.${field} === right.${field}`))],
  ["72_CONTEXT_ASSEMBLY_BINDING_NO_JSON_STRINGIFY_AUTHORITY_EQUALITY", !/JSON\.stringify\([^\n]*binding/i.test(bindingService) && bindingService.includes("contextAssemblyBindingMatches(resolved.binding, input.binding)")],
  ["73_CONTEXT_ASSEMBLY_STALE_GUARD_PRESERVES_CANDIDATE_IDENTITY_MATCH", bindingService.includes("contextAssemblyBindingMatches(resolved.binding, input.binding) || !candidateScopeIdentityMatches(resolved.candidateScope, input.candidateScope)")],
  ["74_CONTEXT_ASSEMBLY_BINDING_ORDER_AND_FIELD_REGRESSION", harness.includes("Context Assembly binding equality is semantic, order-insensitive, and fail-closed per authority field") && harness.includes("expect(JSON.stringify(left)).not.toBe(JSON.stringify(reordered))") && harness.includes("expect(contextAssemblyBindingMatches(left, reordered)).toBe(true)") && harness.includes("const mutations: Array<[keyof TaskContextAssemblyBinding, unknown]>") && harness.includes("expect(contextAssemblyBindingMatches(left, changed), field).toBe(false)")],
  ["75_CONTEXT_ASSEMBLY_BINDING_SAME_CLASS_SWEEP_ZERO", (bindingService.match(/JSON\.stringify\([^\n]*binding/gi) ?? []).length === 0],
  ["76_CASE31_DERIVED_READY_FOR_CLOSURE_PRODUCT_PROJECTION", fixtures.includes("const r2View = await readTaskContextClosure(taskId)") && fixtures.includes('r2View.state !== "READY_FOR_CLOSURE"') && fixtures.includes("const closure31View = await readTaskContextClosure(input.closure31.taskId)") && fixtures.includes('closure31View.state !== "READY_FOR_CLOSURE"')],
  ["77_CASE31_NO_PERSISTED_MAPPING_ITERATION_STATUS", !/\bstatus\s*=\s*["']READY_FOR_CLOSURE["']/.test(fixtures) && (fixtures.match(/`[^`]*context_assembly_mapping_iterations[^`]*`/gs) ?? []).every(sql => !/\bstatus\b/i.test(sql))],
  ["78_CASE31_LATEST_ITERATION_REAL_SCHEMA", /select\s+id,\s*mapping_run_id,\s*analysis_outcome\s+from intentchord\.context_assembly_mapping_iterations\s+where context_assembly_revision_id=\$1\s+order by iteration_ordinal desc,id desc\s+limit 1/s.test(fixtures) && /select\s+id,mapping_run_id,analysis_outcome\s+from intentchord\.context_assembly_mapping_iterations\s+where id=\$1 and context_assembly_revision_id=\$2/s.test(fixtures)],
  ["79_CASE31_LATEST_MAPPING_RUN_LINKAGE", fixtures.includes("iteration.rows[0].mapping_run_id !== r2View.latestMappingRun.id") && fixtures.includes("case31Iteration.rows[0].mapping_run_id !== closure31View.latestMappingRun.id") && fixtures.includes('iteration.rows[0].analysis_outcome !== "ANALYSIS_FINDINGS_NO_KNOWN_BLOCKING_GAP"') && fixtures.includes('case31Iteration.rows[0].analysis_outcome !== "ANALYSIS_FINDINGS_NO_KNOWN_BLOCKING_GAP"')],
  ["80_CASE31_DERIVED_STATE_REGRESSION", harness.includes("H6 Case31 derives READY_FOR_CLOSURE from Product projection and real Mapping Iteration schema") && harness.includes("mappingIterationSql") && harness.includes("mappingIterationTable") && harness.includes("readTaskContextClosure(taskId)") && harness.includes("latestMappingRun.id")],
  ["81_CASE28_BRANCH_B_TASK_ONLY_EARLY_STOP", earlyStopRequired.includes('B: ["TRANSACTION_STARTED", "TASK_LOCK_ATTEMPTED", "TASK_LOCK_ACQUIRED", "TRANSACTION_RELEASED"]') && earlyStopForbidden.includes('B: ["CONTEXT_LOCK_ATTEMPTED", "WORKSPACE_LOCK_ATTEMPTED", "CONTRACT_LOCK_ATTEMPTED"]') && !case28.includes("required: contractBranchRequired")],
  ["82_CASE30_BRANCH_B_TASK_ONLY_EARLY_STOP", earlyStopRequired.includes('B: ["TRANSACTION_STARTED", "TASK_LOCK_ATTEMPTED", "TASK_LOCK_ACQUIRED", "TRANSACTION_RELEASED"]') && earlyStopForbidden.includes('B: ["CONTEXT_LOCK_ATTEMPTED", "WORKSPACE_LOCK_ATTEMPTED", "CONTRACT_LOCK_ATTEMPTED"]') && !case30.includes("required: sameTaskRequired")],
  ["83_CASE26_27_PRESERVE_CONTRACT_LOCK_AFTER_CONTENTION", contractRequired.includes("CONTRACT_LOCK_ATTEMPTED") && case26.includes("required: contractBranchRequired") && case27.includes("required: contractBranchRequired")],
  ["84_CASE31_PRESERVES_CONTEXT_WORKSPACE_AUTHORITY_AFTER_CONTENTION", case31.includes("required: sameTaskRequired") && concurrency.slice(concurrency.indexOf("const sameTaskRequired"), concurrency.indexOf("const contractBranchRequired")).includes("CONTEXT_LOCK_ATTEMPTED") && concurrency.slice(concurrency.indexOf("const sameTaskRequired"), concurrency.indexOf("const contractBranchRequired")).includes("WORKSPACE_LOCK_ATTEMPTED")],
  ["85_EXPLICIT_VALIDATION_TRANSACTION_IDENTITY", dbAdapter.includes("export type ValidationTransactionId = number") && dbAdapter.includes("transactionId: ValidationTransactionId")],
  ["86_TRANSACTION_ALLOCATES_UNIQUE_IDENTITY", dbAdapter.includes("let validationTransactionSequence = 0") && dbAdapter.includes("allocateValidationTransactionId()") && dbAdapter.includes("const transactionId = allocateValidationTransactionId()")],
  ["87_TRACED_CLIENT_QUERY_PROPAGATES_TRANSACTION_IDENTITY", dbAdapter.includes("tracedClient(client, transactionId)") && dbAdapter.includes("tracedQuery(target, transactionId, args)") && dbAdapter.includes("recordTrace(transactionId, attempted)") && dbAdapter.includes("recordTrace(transactionId, acquired)")],
  ["88_TRANSACTION_RELEASE_AND_CONTENTION_PRESERVE_IDENTITY", dbAdapter.includes('recordTrace(transactionId, "TRANSACTION_STARTED")') && dbAdapter.includes('recordTrace(transactionId, "TRANSACTION_RELEASED", "COMMIT")') && dbAdapter.includes('recordTrace(transactionId, "TRANSACTION_RELEASED", "ROLLBACK")') && dbAdapter.includes('recordTrace(transactionId, "CONTROLLED_CONTENTION_PROVEN"')],
  ["89_CONTENTION_ANCHORS_SELECT_EXACT_TRANSACTION_ID", dbAdapter.includes("contentionTransactionTrace(") && dbAdapter.includes("exactTransactionById(") && dbAdapter.includes("event.transactionId === contention.transactionId") && concurrency.includes("contentionTransactionTrace(trace, testCase.plan)") && concurrency.includes("transaction.events")],
  ["90_NESTED_SAME_BRANCH_DISTINCT_TRANSACTIONS_ACCEPTED", harness.includes('event(108, "B", 2001, "TRANSACTION_STARTED")') && harness.includes('event(111, "B", 2002, "TRANSACTION_STARTED")') && harness.includes('event(115, "B", 2001, "TRANSACTION_RELEASED")') && !dbAdapter.includes("branchTransactionWindows(") && !dbAdapter.includes("NESTED_START")],
  ["91_CASE30_ACTUAL_NESTED_TRACE_REGRESSION", harness.includes('event(116, "B", 2003, "TRANSACTION_STARTED")') && harness.includes('event(117, "B", 2003, "TASK_LOCK_ATTEMPTED")') && harness.includes('event(118, "B", 2003, "CONTROLLED_CONTENTION_PROVEN")') && harness.includes('expect(case30.B.transactionId).toBe(2003)') && harness.includes('expect(case30.B.startSequence).toBe(116)') && harness.includes('expect(case30.B.releaseSequence).toBe(127)')],
  ["92_CASE26_NESTED_PRELIMINARY_TRACE_REGRESSION", harness.includes('case26Event(300, "A", 3001, "TRANSACTION_STARTED")') && harness.includes('case26Event(301, "A", 3002, "TRANSACTION_STARTED")') && harness.includes('case26Event(306, "A", 3003, "TRANSACTION_STARTED")') && harness.includes('expect(case26.A.transactionId).toBe(3003)') && harness.includes('expect(case26.B.transactionId).toBe(4001)')],
  ["93_PRELIMINARY_TRANSACTION_CANNOT_CREATE_FALSE_PASS", harness.includes('event(113.5, "B", 2002, "CONTRACT_LOCK_ATTEMPTED")') && harness.includes('expect(falsePassTrace.some(current => current.branchId === "B" && current.milestone === "CONTRACT_LOCK_ATTEMPTED")).toBe(true)') && harness.includes('expect(falsePass.B.events.some(current => current.milestone === "CONTRACT_LOCK_ATTEMPTED")).toBe(false)')],
  ["94_PRELIMINARY_TRANSACTION_CANNOT_CREATE_FALSE_FAIL", harness.includes('expect(case30Trace.some(current => current.transactionId === 2002 && current.milestone === "WORKSPACE_LOCK_ATTEMPTED")).toBe(true)') && harness.includes('expect(case30.B.events.some(current => current.milestone === "WORKSPACE_LOCK_ATTEMPTED")).toBe(false)')],
];
let failures=0;
for (const [name,pass] of checks) { console.log(`${name}=${pass?'PASS':'FAIL'}`); if(!pass) failures++; }
console.log(`OWNER_PG_VALIDATION_HARNESS_CHECKS=${checks.length}`);
console.log(`OWNER_PG_VALIDATION_HARNESS_FAIL=${failures}`);
console.log(`OWNER_PG_VALIDATION_HARNESS_SOURCE_AUDIT=${failures?'FAIL':'PASS'}`);
process.exit(failures?1:0);

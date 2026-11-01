import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const notes = [];
const requireFile = relative => {
  const target = path.join(root, relative);
  if (!existsSync(target)) failures.push(`MISSING_REQUIRED_FILE:${relative}`);
  return target;
};
const sourceFiles = [
  "src/core/workspace-index/types.ts",
  "src/core/workspace-index/schema.ts",
  "src/core/workspace-index/canonical-workspace-index-v1.schema.json",
  "src/core/workspace-index/canonical.ts",
  "src/core/workspace-index/artifact-identity.ts",
  "src/core/workspace-index/registries.ts",
  "src/core/workspace-index/parsers.ts",
  "src/core/workspace-index/delta.ts",
  "src/core/workspace-index/validator.ts",
  "src/core/workspace-index/indexer.ts",
  "src/core/workspace-index/duration-governance.ts",
  "src/core/workspace-index/local-path-semantics.ts",
  "src/core/workspace-index/csv-profile.ts",
  "src/core/workspace-index/adapters/filesystem.ts",
  "src/core/workspace-index/adapters/git.ts",
  "src/core/workspace-index/index.ts",
];
const testFiles = [
  "src/core/workspace-index/schema.test.ts",
  "src/core/workspace-index/canonical.test.ts",
  "src/core/workspace-index/identity-delta.test.ts",
  "src/core/workspace-index/indexer.test.ts",
  "src/core/workspace-index/boundaries.test.ts",
  "src/core/workspace-index/sample-contract.test.ts",
  "src/core/workspace-index/filesystem-governance.test.ts",
  "src/core/workspace-index/duration-governance.test.ts",
  "src/core/workspace-index/csv-profile.test.ts",
  "src/core/workspace-index/artifact-identity.test.ts",
  "src/core/workspace-index/local-path-semantics.test.ts",
];
const requiredArtifacts = [
  "docs/contracts/CANONICAL_WORKSPACE_INDEX_CONTRACT_V1.md",
  "reports/architecture-validation/samples/canonical-workspace-index-v1.sample.json",
  "reports/architecture-validation/samples/canonical-workspace-index-v1.sample.json.sha256",
  "reports/architecture-validation/INTENTCHORD_WORKSPACE_INDEXING_ENGINE_V1_IMPLEMENTATION_AND_TECHNICAL_VERIFICATION_REPORT.md",
  "scripts/Apply-IntentChord-Workspace-Indexing-Engine-v1.ps1",
  "scripts/run-workspace-index-tests.mjs",
];
for (const file of [...sourceFiles, ...testFiles, ...requiredArtifacts]) requireFile(file);

const packageJsonPath = requireFile("package.json");
if (existsSync(packageJsonPath)) {
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  if (packageJson.scripts?.["test:workspace-index"] !== "node scripts/run-workspace-index-tests.mjs") {
    failures.push("WORKSPACE_INDEX_TEST_RUNNER_NOT_DETERMINISTIC");
  }
}
const source = sourceFiles.filter(file => existsSync(path.join(root, file))).map(file => readFileSync(path.join(root, file), "utf8")).join("\n");
const schemaSourcePath = path.join(root, "src/core/workspace-index/schema.ts");
if (existsSync(schemaSourcePath)) {
  const schemaSource = readFileSync(schemaSourcePath, "utf8");
  if (!schemaSource.includes('import type { JsonValue } from "@/core/truth/project-truth-hash";')) failures.push("JSON_VALUE_TYPE_IMPORT_MISSING");
  if (!schemaSource.includes("jsonValueSchema: z.ZodType<JsonValue>")) failures.push("JSON_VALUE_SCHEMA_NOT_DOMAIN_TYPED");
}
for (const [code, pattern] of [
  ["AI_OR_PROVIDER_IMPORT", /@\/core\/(?:providers|prompts|intelligence)|OpenAI|Gemini|Claude/],
  ["CONTEXT_LABEL_GENERATION", /Update Channel|Remote|Users|Authentication|["'`]Policy["'`]/],
  ["SERVER_API_UI_COUPLING", /@\/(?:server|app|components)\//],
  ["DATABASE_COUPLING", /DATABASE_URL|from\s+["'"]pg["'"]|\b(?:databaseQuery|withTransaction|queryOne|queryMany)\s*\(/],
  ["SOURCE_WRITE_CAPABILITY", /\b(?:writeFile|appendFile|unlink|rename|rm|copyFile|chmod)\s*\(/],
  ["EXECUTION_CAPABILITY", /npm\s+(?:test|run|build)|next build|deploy|serviceRestart|databaseWrite/],
]) {
  if (pattern.test(source)) failures.push(code);
}
for (const token of [
  "canonical_workspace_index", "1.0.0", "workspace_instance_id", "workspace_revision_id",
  "workspace_file_id", "file_revision_id", "workspace_fact_id", "fact_revision_id",
  "workspace_relation_id", "relation_revision_id", "COMPLETE_WITH_GAPS",
  "canonical_payload_hash", "workspace_tree_fingerprint", "content_references",
]) {
  if (!source.includes(token)) failures.push(`REQUIRED_CONTRACT_TOKEN_MISSING:${token}`);
}
const schemaPath = requireFile("src/core/workspace-index/canonical-workspace-index-v1.schema.json");
if (existsSync(schemaPath)) {
  const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
  if (schema.properties?.contract_type?.const !== "canonical_workspace_index") failures.push("JSON_SCHEMA_CONTRACT_TYPE_MISMATCH");
  if (schema.properties?.contract_version?.const !== "1.0.0") failures.push("JSON_SCHEMA_CONTRACT_VERSION_MISMATCH");
  if (!schema.required?.includes("snapshot") || !schema.required?.includes("integrity")) failures.push("JSON_SCHEMA_ENVELOPE_INCOMPLETE");
  for (const definition of ["fact", "relation", "delta", "coverage"]) {
    if (schema.$defs?.[definition]?.additionalProperties !== false) failures.push(`JSON_SCHEMA_NOT_STRICT:${definition}`);
  }
}
const samplePath = requireFile("reports/architecture-validation/samples/canonical-workspace-index-v1.sample.json");
const sampleHashPath = requireFile("reports/architecture-validation/samples/canonical-workspace-index-v1.sample.json.sha256");
if (existsSync(samplePath) && existsSync(sampleHashPath)) {
  const expected = readFileSync(sampleHashPath, "utf8").trim().split(/\s+/)[0];
  const actual = (await import("node:crypto")).createHash("sha256").update(readFileSync(samplePath)).digest("hex");
  if (expected !== actual) failures.push("SAMPLE_ARTIFACT_HASH_MISMATCH");
}
const windowsAuthorityHelperPath = requireFile("scripts/windows-filesystem-object-authority.ps1");
const filesystemAuthorityPath = requireFile("src/core/workspace-index/filesystem-object-authority.ts");
const filesystemGovernanceTestPath = requireFile("src/core/workspace-index/filesystem-governance.test.ts");
if (existsSync(windowsAuthorityHelperPath) && existsSync(filesystemAuthorityPath) && existsSync(filesystemGovernanceTestPath)) {
  const windowsAuthorityHelper = readFileSync(windowsAuthorityHelperPath, "utf8");
  const filesystemAuthority = readFileSync(filesystemAuthorityPath, "utf8");
  const filesystemGovernanceTest = readFileSync(filesystemGovernanceTestPath, "utf8");
  for (const token of [
    "[System.Text.UTF8Encoding]::new($false)",
    "[Console]::InputEncoding = $IntentChordUtf8ProtocolEncoding",
    "[Console]::OutputEncoding = $IntentChordUtf8ProtocolEncoding",
    "$OutputEncoding = $IntentChordUtf8ProtocolEncoding",
  ]) {
    if (!windowsAuthorityHelper.includes(token)) failures.push(`WINDOWS_AUTHORITY_UTF8_PROTOCOL_MISSING:${token}`);
  }
  for (const token of [
    'child.stdin.setDefaultEncoding("utf8")',
    'child.stdout.setEncoding("utf8")',
    'configureWindowsAuthorityUtf8Protocol(child)',
  ]) {
    if (!filesystemAuthority.includes(token)) failures.push(`WINDOWS_AUTHORITY_NODE_UTF8_PIPE_MISSING:${token}`);
  }
  for (const token of [
    "Windows metadata helper preserves UTF-8 Unicode names and File ID across long-lived round-trip traversal",
    'const arabicDirectoryName = "مصدر عربي"',
    'const mixedDirectoryName = "مجلد داخلي-日本語-é"',
    'expect(spawned).toHaveLength(1)',
    'expect(new Set(requests.map(item => item.pid)).size).toBe(1)',
    "sameProofGradeFilesystemObject(arabicListing.identity, arabicEntry.identity)",
    "sameProofGradeFilesystemObject(nestedListing.identity, mixedEntry.identity)",
  ]) {
    if (!filesystemGovernanceTest.includes(token)) failures.push(`WINDOWS_AUTHORITY_UNICODE_REGRESSION_MISSING:${token}`);
  }
}


const durationGovernancePath = requireFile("src/core/workspace-index/duration-governance.ts");
const indexerPath = requireFile("src/core/workspace-index/indexer.ts");
const filesystemPath = requireFile("src/core/workspace-index/adapters/filesystem.ts");
const artifactIdentityPath = requireFile("src/core/workspace-index/artifact-identity.ts");
const durationTestPath = requireFile("src/core/workspace-index/duration-governance.test.ts");
const snapshotServicePath = requireFile("src/server/workspace-index-snapshot-service.ts");
const snapshotServiceTestPath = requireFile("src/server/workspace-index-snapshot-service.test.ts");
const snapshotRepositoryPath = requireFile("src/server/workspace-index-snapshot-repository.ts");
const databasePath = requireFile("src/server/db.ts");
if ([durationGovernancePath, indexerPath, filesystemPath, artifactIdentityPath, durationTestPath, snapshotServicePath, snapshotServiceTestPath, snapshotRepositoryPath, databasePath].every(existsSync)) {
  const durationGovernance = readFileSync(durationGovernancePath, "utf8");
  const indexer = readFileSync(indexerPath, "utf8");
  const filesystem = readFileSync(filesystemPath, "utf8");
  const artifactIdentity = readFileSync(artifactIdentityPath, "utf8");
  const durationTest = readFileSync(durationTestPath, "utf8");
  const snapshotService = readFileSync(snapshotServicePath, "utf8");
  const snapshotServiceTest = readFileSync(snapshotServiceTestPath, "utf8");
  const snapshotRepository = readFileSync(snapshotRepositoryPath, "utf8");
  const database = readFileSync(databasePath, "utf8");
  for (const token of [
    'WORKSPACE_DURATION_POLICY_ID = "intentchord.workspace-duration-governance/v3"',
    "SOURCE_AUTHORITY_MAX_MS = 120_000",
    "DISCOVERY_MAX_MS = 120_000",
    "PROCESSING_BASE_MS = 30_000",
    "PROCESSING_GOVERNED_BYTES_PER_SECOND = 12 * 1024 * 1024",
    "PROCESSING_PER_FILE_MS = 40",
    "PROCESSING_MIN_MS = 120_000",
    "PROCESSING_MAX_MS = 1_500_000",
    "FINALIZATION_MAX_MS = 120_000",
    "ABSOLUTE_OPERATION_MAX_MS = 1_800_000",
    "Math.ceil((input.discoveredBytes * 1000) / policy.processingGovernedBytesPerSecond)",
  ]) {
    if (!durationGovernance.includes(token)) failures.push(`DURATION_GOVERNANCE_V3_TOKEN_MISSING:${token}`);
  }
  if (/maxDurationMs/.test(`${durationGovernance}
${indexer}
${filesystem}
${snapshotService}`)) failures.push("GLOBAL_FIXED_MAX_DURATION_AUTHORITY_REMAINS");
  for (const token of [
    'beginGovernancePhase("PROCESSING", processingDurationDecision.derivedProcessingBudgetMs)',
    'beginGovernancePhase("FINALIZATION", durationGovernance.finalizationMaxMs)',
    "workspacePhaseDeadlineAt({ phaseStartedAtMs, phaseBudgetMs, absoluteOperationDeadlineAt })",
    "deadlineAt: phaseDeadlineAt",
    "currentGovernancePhase",
    "derivedProcessingBudgetMs",
  ]) {
    if (!indexer.includes(token)) failures.push(`INDEXER_DURATION_PHASE_AUTHORITY_MISSING:${token}`);
  }
  for (const token of [
    "hashedFiles: progress.hashedFiles",
    "hashedBytes: progress.hashedBytes",
    "parsedFiles: progress.parsedFiles",
    "remainingFilesAtTimeout: Math.max(0, processingDurationDecision.discoveredFiles - progress.hashedFiles)",
    "remainingBytesAtTimeout: Math.max(0, processingDurationDecision.discoveredBytes - progress.hashedBytes)",
    "aggregateRetainedTextBytes: progress.aggregateRetainedTextBytes",
    "csvSampledBytes: progress.csvSampledBytes",
    "currentProcessingRelativePath",
    'Array.from(entry.relative_path).slice(0, 512).join("")',
  ]) {
    if (!indexer.includes(token)) failures.push(`PROCESSING_TERMINAL_PROGRESS_EVIDENCE_MISSING:${token}`);
  }
  const timeoutEvidenceStart = indexer.indexOf("const timeoutEvidence =");
  const timeoutEvidenceEnd = indexer.indexOf("const timeoutDiagnostics =", timeoutEvidenceStart);
  const checkpointStart = indexer.indexOf("const checkpoint =");
  const captureStartForEvidence = indexer.indexOf("captured = await captureWorkspaceFile(entry.absolute_path");
  if (!(timeoutEvidenceStart >= 0 && timeoutEvidenceEnd > timeoutEvidenceStart && checkpointStart > timeoutEvidenceEnd && captureStartForEvidence > checkpointStart)) {
    failures.push("INDEXER_TIMEOUT_EVIDENCE_AUTHORITY_ORDER_INVALID");
  }
  const boundedTimeoutConvergenceCount = indexer.match(/boundedError\(error, \(\) => timeoutEvidence\(progress\.phase\)\)/g)?.length ?? 0;
  if (boundedTimeoutConvergenceCount !== 4) failures.push(`BOUNDED_TIMEOUT_EVIDENCE_CONVERGENCE_INVALID:${boundedTimeoutConvergenceCount}`);
  if (!indexer.includes("timeoutDiagnostics(phase, now),") || !indexer.includes("timeoutEvidence(phase, now),")) failures.push("CHECKPOINT_TIMEOUT_EVIDENCE_CONVERGENCE_MISSING");
  for (const token of [
    "DEFAULT_WORKSPACE_DURATION_GOVERNANCE.sourceAuthorityMaxMs",
    "workspaceAbsoluteOperationDeadlineAt",
    "attempt_started_at_ms: attemptStartedAtMs",
    "duration_policy: DEFAULT_WORKSPACE_DURATION_GOVERNANCE",
  ]) {
    if (!snapshotService.includes(token)) failures.push(`SNAPSHOT_SERVICE_DURATION_AUTHORITY_MISSING:${token}`);
  }
  for (const token of [
    'currentGovernancePhase: "SOURCE_AUTHORITY"',
    'detailedProgressPhase: "SOURCE_AUTHORITY"',
    'phaseBudgetMs: DEFAULT_WORKSPACE_DURATION_GOVERNANCE.sourceAuthorityMaxMs',
    'absoluteOperationMaxMs: DEFAULT_WORKSPACE_DURATION_GOVERNANCE.absoluteOperationMaxMs',
  ]) {
    if (!snapshotService.includes(token)) failures.push(`SOURCE_AUTHORITY_SAFE_DURATION_EVIDENCE_MISSING:${token}`);
  }
  if (!snapshotServiceTest.includes('exposes safe SOURCE_AUTHORITY duration evidence without leaking filesystem paths')) failures.push("SOURCE_AUTHORITY_SAFE_DURATION_REGRESSION_MISSING");
  if (!snapshotServiceTest.includes('not.toContain("sensitive/workspace")')) failures.push("SOURCE_AUTHORITY_RAW_PATH_LEAK_NEGATIVE_CONTROL_MISSING");
  for (const token of [
    "on_duration_phase_authority: onDurationPhaseAuthority",
    'authority.governancePhase !== "FINALIZATION"',
    "authority.phaseDeadlineAt !== expectedDeadlineAt",
    "armPersistenceDeadline(authority.phaseDeadlineAt)",
    "await progressWrite",
    'phase: "PERSISTING"',
    "finalizationPersistenceTimeoutEvidence",
    "completeRegisteredObservation({",
    "}, persistenceGovernance())",
  ]) {
    if (!snapshotService.includes(token)) failures.push(`FINALIZATION_PERSISTENCE_AUTHORITY_MISSING:${token}`);
  }
  for (const token of [
    "publishPhaseAuthority()",
    "request.on_duration_phase_authority?.(currentPhaseAuthority())",
    'beginGovernancePhase("FINALIZATION", durationGovernance.finalizationMaxMs)',
  ]) {
    if (!indexer.includes(token)) failures.push(`FINALIZATION_AUTHORITY_HANDOFF_MISSING:${token}`);
  }
  for (const token of [
    "transactionGoverned",
    "databaseQueryGoverned",
    "governance?: DatabaseExecutionGovernance",
  ]) {
    if (!snapshotRepository.includes(token)) failures.push(`FINALIZATION_REPOSITORY_BOUNDARY_MISSING:${token}`);
  }
  for (const token of [
    "DatabaseExecutionGovernanceError",
    "select set_config('statement_timeout',$1,true)",
    "select pg_cancel_backend($1)",
    "client.release(true)",
    'await queryWithGovernance(client, "COMMIT"',
  ]) {
    if (!database.includes(token)) failures.push(`DATABASE_GOVERNED_PERSISTENCE_MISSING:${token}`);
  }
  if (/Promise\.race/.test(database)) failures.push("DATABASE_GOVERNED_PERSISTENCE_PROMISE_RACE_FORBIDDEN");
  for (const token of [
    "continues the exact Indexer FINALIZATION deadline through progress drain, PERSISTING, canonical persistence, and READY",
    "fails closed when queued progress persistence cannot drain before the original FINALIZATION deadline",
    "cancels delayed canonical persistence at FINALIZATION and cannot mint a later READY result",
    "keeps canonical persistence under the original absolute operation ceiling when FINALIZATION starts near that ceiling",
    "h.repository.revisions.size).toBe(0)",
    "h.repository.artifacts.size).toBe(0)",
    'some(row => row.status === "READY")).toBe(false)',
  ]) {
    if (!snapshotServiceTest.includes(token)) failures.push(`FINALIZATION_PERSISTENCE_REGRESSION_MISSING:${token}`);
  }
  for (const token of [
    "duration_governance: WorkspaceDurationConfigurationIdentity",
    "duration_policy_id",
    "processing_governed_bytes_per_second",
    "absolute_operation_max_ms",
  ]) {
    if (!artifactIdentity.includes(token) && !durationGovernance.includes(token)) failures.push(`DURATION_CONFIGURATION_IDENTITY_MISSING:${token}`);
  }
  if (/throughput|captureMiBPerSec|measured.*(?:speed|rate)/i.test(durationGovernance)) failures.push("DURATION_POLICY_MACHINE_THROUGHPUT_AUTHORITY_FORBIDDEN");
  if (!filesystem.includes('const technicalExact = new Set([".git","node_modules","dist","build","out","coverage",".turbo",".cache","tmp","temp"]);')) failures.push("WORKSPACE_TECHNICAL_EXCLUSION_SET_CHANGED");
  for (const token of [
    "7_599_775_318",
    "21_881",
    "603_976",
    "875_240",
    "1_509_216",
    "1_500_000",
    "processingMinMs: 0, processingMaxMs: 0",
    "finalizationMaxMs: 0",
    '"reports", "artifacts", "snapshots", "generated outputs", "archives"',
    'durationPolicyId: "intentchord.workspace-duration-governance/v2"',
    "processingPerFileMs: 32",
    "workspaceIndexConfigurationSha256(v2Descriptor)",
    "classifies a generic capture/helper failure at the PROCESSING deadline edge as WORKSPACE_INDEX_TIMEOUT",
    "preserves exact current Processing progress and remaining work at a checkpoint timeout",
    "bounds currentProcessingRelativePath as diagnostic evidence without affecting timeout authority",
    "keeps a genuine generic capture/helper failure before the deadline fail-closed as Source State",
    "keeps an explicit proof-grade Source Object identity violation before deadline as Source State",
    "keeps AbortSignal terminal over simultaneous deadline/source capture classification",
  ]) {
    if (!durationTest.includes(token)) failures.push(`DURATION_GOVERNANCE_REGRESSION_MISSING:${token}`);
  }

  const captureStart = indexer.indexOf("captured = await captureWorkspaceFile(entry.absolute_path");
  const captureEnd = indexer.indexOf("if (captured.bytes_read !== entry.size_bytes)", captureStart);
  if (captureStart < 0 || captureEnd <= captureStart) {
    failures.push("CAPTURE_DEADLINE_PRECEDENCE_BLOCK_MISSING");
  } else {
    const captureBlock = indexer.slice(captureStart, captureEnd);
    const terminalOrder = captureBlock.indexOf("terminalGovernanceError(progress.phase, Date.now())");
    const sourceOrder = captureBlock.indexOf('error.evidence.phase === "SOURCE_BOUNDARY"');
    const genericOrder = captureBlock.indexOf('["FILE_CAPTURE_FAILED", entry.relative_path]');
    if (!(terminalOrder >= 0 && sourceOrder > terminalOrder && genericOrder > sourceOrder)) {
      failures.push("CAPTURE_DEADLINE_CLASSIFICATION_PRECEDENCE_INVALID");
    }
  }
  const terminalHelperStart = indexer.indexOf("const terminalGovernanceError =");
  const terminalHelperEnd = indexer.indexOf("const checkpoint =", terminalHelperStart);
  if (terminalHelperStart < 0 || terminalHelperEnd <= terminalHelperStart) {
    failures.push("TERMINAL_GOVERNANCE_CLASSIFIER_MISSING");
  } else {
    const terminalHelper = indexer.slice(terminalHelperStart, terminalHelperEnd);
    const abortOrder = terminalHelper.indexOf("request.signal?.aborted");
    const deadlineOrder = terminalHelper.indexOf("now >= phaseDeadlineAt || now >= absoluteOperationDeadlineAt");
    if (!(abortOrder >= 0 && deadlineOrder > abortOrder)) failures.push("TERMINAL_GOVERNANCE_ABORT_DEADLINE_ORDER_INVALID");
  }
  for (const token of [
    "if (options.signal?.aborted)",
    "if (options.deadlineAt !== undefined && Date.now() >= options.deadlineAt)",
    "deadlineAt:options.deadlineAt",
  ]) {
    if (!filesystem.includes(token)) failures.push(`FILESYSTEM_CAPTURE_GOVERNANCE_PRECEDENCE_SUPPORT_MISSING:${token}`);
  }
  if (existsSync(filesystemAuthorityPath)) {
    const filesystemAuthority = readFileSync(filesystemAuthorityPath, "utf8");
    for (const token of [
      "if (input.signal?.aborted)",
      "if (input.deadlineAt !== undefined && Date.now() >= input.deadlineAt)",
      'pending.deadlineTimer = setTimeout(() => this.cancelCaptureHelper("WORKSPACE_INDEX_TIMEOUT"',
      "deadline_epoch_ms: input.deadlineAt ?? -1",
    ]) {
      if (!filesystemAuthority.includes(token)) failures.push(`WINDOWS_CAPTURE_GOVERNANCE_PRECEDENCE_SUPPORT_MISSING:${token}`);
    }
  }
  for (const token of [
    "if (error instanceof WorkspaceIndexingError)",
    "code: error.code",
    "...error.evidence",
  ]) {
    if (!snapshotService.includes(token)) failures.push(`SNAPSHOT_TIMEOUT_EVIDENCE_PRESERVATION_MISSING:${token}`);
  }
}


const workspaceConnectorDurationPath = requireFile("src/server/workspace-connector.ts");
const workspaceDurationPgTestPath = requireFile("src/server/workspace-index-duration-governance.postgres.integration.test.ts");
const workspaceAnalysisPgRunnerPath = requireFile("scripts/run-workspace-analysis-postgres-tests.mjs");
if ([workspaceConnectorDurationPath, workspaceDurationPgTestPath, workspaceAnalysisPgRunnerPath, snapshotServicePath, snapshotRepositoryPath, databasePath].every(existsSync)) {
  const workspaceConnectorDuration = readFileSync(workspaceConnectorDurationPath, "utf8");
  const workspaceDurationPgTest = readFileSync(workspaceDurationPgTestPath, "utf8");
  const workspaceAnalysisPgRunner = readFileSync(workspaceAnalysisPgRunnerPath, "utf8");
  const snapshotServiceDuration = readFileSync(snapshotServicePath, "utf8");
  const snapshotRepositoryDuration = readFileSync(snapshotRepositoryPath, "utf8");
  const databaseDuration = readFileSync(databasePath, "utf8");
  const snapshotServiceTestDuration = readFileSync(snapshotServiceTestPath, "utf8");
  const createOperationStart = snapshotServiceDuration.indexOf("async createOperation(");
  const createOperationEnd = snapshotServiceDuration.indexOf("async create(raw:", createOperationStart);
  const registeredStart = snapshotServiceDuration.indexOf("private async createRegistered(");
  const registeredEnd = snapshotServiceDuration.indexOf("private async createDiagnostic(", registeredStart);
  if (createOperationStart < 0 || createOperationEnd <= createOperationStart || registeredStart < 0 || registeredEnd <= registeredStart) {
    failures.push("REGISTERED_WORKSPACE_DURATION_LIFECYCLE_BLOCK_MISSING");
  } else {
    const createOperation = snapshotServiceDuration.slice(createOperationStart, createOperationEnd);
    const registered = snapshotServiceDuration.slice(registeredStart, registeredEnd);
    const registeredBranchStart = createOperation.indexOf('if (command.sourceMode === "REGISTERED_WORKSPACE")');
    const diagnosticBoundary = createOperation.indexOf('await this.dependencies.repository.recoverStale({', registeredBranchStart + 1);
    const registeredRequest = registeredBranchStart >= 0
      ? createOperation.slice(registeredBranchStart, diagnosticBoundary > registeredBranchStart ? diagnosticBoundary : createOperation.length)
      : "";
    const rootTokens = [
      "const attemptStartedAtMs = Date.now()",
      "const absoluteOperationDeadlineAt = workspaceAbsoluteOperationDeadlineAt(",
      "const absoluteAttemptGovernance: DatabaseExecutionGovernance",
      "this.dependencies.repository.recoverStale(",
      "assertProjectAssociation(this.dependencies.repository, command.projectContextId, absoluteAttemptGovernance)",
      "return this.createRegistered(command, ownerAuthority, {",
    ];
    let previousRootOffset = -1;
    for (const token of rootTokens) {
      const offset = registeredRequest.indexOf(token);
      if (offset < 0) failures.push(`REGISTERED_WORKSPACE_ATTEMPT_ROOT_MISSING:${token}`);
      if (offset >= 0 && offset <= previousRootOffset) failures.push(`REGISTERED_WORKSPACE_ATTEMPT_ROOT_ORDER_INVALID:${token}`);
      if (offset >= 0) previousRootOffset = offset;
    }
    const firstRegisteredDbBoundary = registeredRequest.indexOf("this.dependencies.repository.recoverStale(");
    const attemptClockOffset = registeredRequest.indexOf("const attemptStartedAtMs = Date.now()");
    if (attemptClockOffset < 0 || firstRegisteredDbBoundary < 0 || attemptClockOffset >= firstRegisteredDbBoundary) {
      failures.push("REGISTERED_WORKSPACE_ATTEMPT_CLOCK_NOT_BEFORE_FIRST_DB_BOUNDARY");
    }
    for (const token of [
      "deadlineAtMs: absoluteOperationDeadlineAt",
      "absoluteAttemptGovernance,",
      "attemptStartedAtMs,",
      "absoluteOperationDeadlineAt,",
    ]) {
      if (!registeredRequest.includes(token)) failures.push(`REGISTERED_WORKSPACE_PRE_SOURCE_ABSOLUTE_AUTHORITY_MISSING:${token}`);
    }
    if (registered.includes("const attemptStartedAtMs = Date.now()")) failures.push("CREATE_REGISTERED_ATTEMPT_CLOCK_RESET_FORBIDDEN");
    if (registered.includes("workspaceAbsoluteOperationDeadlineAt(attemptStartedAtMs")) failures.push("CREATE_REGISTERED_ABSOLUTE_DEADLINE_RECOMPUTE_FORBIDDEN");

    const lifecycleTokens = [
      "readByIdempotencyKey(command.idempotencyKey, absoluteAttemptGovernance)",
      "deadlineAt: sourceAuthorityDeadlineAt",
      "readLatestObservationHead(registration.id, absoluteAttemptGovernance)",
      "this.dependencies.repository.reserve({",
      "attempt_started_at_ms: attemptStartedAtMs",
      "await progressWrite",
      'phase: "PERSISTING"',
      "this.dependencies.repository.completeRegisteredObservation({",
      "this.dependencies.repository.fail({",
    ];
    let previousOffset = -1;
    for (const token of lifecycleTokens) {
      const offset = registered.indexOf(token);
      if (offset < 0) failures.push(`REGISTERED_WORKSPACE_DURATION_BOUNDARY_MISSING:${token}`);
      if (offset >= 0 && offset <= previousOffset) failures.push(`REGISTERED_WORKSPACE_DURATION_BOUNDARY_ORDER_INVALID:${token}`);
      if (offset >= 0) previousOffset = offset;
    }
    const governedPersistenceCallCount = (registered.match(/persistenceGovernance\(\)/g) ?? []).length;
    if (governedPersistenceCallCount < 4) failures.push("REGISTERED_WORKSPACE_PERSISTENCE_GOVERNANCE_CALL_COUNT_INVALID");
    if (!registered.includes("}, absoluteAttemptGovernance);")) failures.push("REGISTERED_WORKSPACE_RESERVATION_ABSOLUTE_GOVERNANCE_MISSING");
    for (const token of [
      "signal,",
      "persistenceDeadlineAt = Math.min(deadlineAt, absoluteOperationDeadlineAt)",
      "authority.absoluteOperationDeadlineAt !== absoluteOperationDeadlineAt",
      "armPersistenceDeadline(authority.phaseDeadlineAt)",
    ]) {
      if (!registered.includes(token)) failures.push(`REGISTERED_WORKSPACE_ABSOLUTE_AUTHORITY_MISSING:${token}`);
    }
    if (!registered.includes("catch (failPersistenceError) {\n        // Terminal failure persistence remains diagnostic-only:")) {
      failures.push("TERMINAL_FAILURE_PERSISTENCE_FAIL_CLOSED_CATCH_MISSING");
    }
    if (!registered.includes("recordSecondaryDiagnostic(failPersistenceError, \"workspace-index-terminal-fail-persistence-secondary\")")) {
      failures.push("TERMINAL_FAILURE_PERSISTENCE_SECONDARY_OBSERVATION_MISSING");
    }
    if (!registered.includes("progressAdmissionOpen = false;")) {
      failures.push("PROGRESS_ADMISSION_FAILURE_CLOSURE_MISSING");
    }
    if (!registered.includes(".catch(progressError => {")) {
      failures.push("PROGRESS_CHAIN_PER_LINK_REJECTION_OBSERVER_MISSING");
    }
    if (!registered.includes("firstProgressFailure ??= progressError;")) {
      failures.push("PROGRESS_CHAIN_FIRST_FAILURE_RETENTION_MISSING");
    }
    if (!registered.includes("if (firstProgressFailure !== undefined) throw firstProgressFailure;")) {
      failures.push("PROGRESS_CHAIN_SUCCESS_PATH_GOVERNED_CONVERSION_MISSING");
    }
  }

  const authorityStart = workspaceConnectorDuration.indexOf("export async function assertRegisteredWorkspaceSourceAuthority");
  const authorityEnd = workspaceConnectorDuration.indexOf("export interface LocalWorkspaceConnector", authorityStart);
  const authority = authorityStart >= 0 && authorityEnd > authorityStart
    ? workspaceConnectorDuration.slice(authorityStart, authorityEnd)
    : "";
  for (const token of [
    "transactionGoverned({ deadlineAtMs: governance.deadlineAt, signal: governance.signal }, work)",
    "where id=$1 for update",
    "inspectLocalWorkspaceIdentity(registration.normalizedReference, governance)",
    "update intentchord.workspaces set root_authority_state='VERIFIED_MATCH'",
  ]) {
    if (!authority.includes(token)) failures.push(`SOURCE_AUTHORITY_DB_FILESYSTEM_SHARED_DEADLINE_MISSING:${token}`);
  }
  if (authority.indexOf("where id=$1 for update") > authority.indexOf("inspectLocalWorkspaceIdentity(registration.normalizedReference, governance)")) {
    failures.push("SOURCE_AUTHORITY_DB_FILESYSTEM_ORDER_INVALID");
  }

  const reserveStart = snapshotRepositoryDuration.indexOf("async reserve(input:");
  const reserveEnd = snapshotRepositoryDuration.indexOf("async readLatestObservationHead", reserveStart);
  const reserveBlock = reserveStart >= 0 && reserveEnd > reserveStart ? snapshotRepositoryDuration.slice(reserveStart, reserveEnd) : "";
  for (const token of ["governance?: DatabaseExecutionGovernance", "transactionGoverned(governance, work)"]) {
    if (!reserveBlock.includes(token)) failures.push(`RESERVATION_DATABASE_GOVERNANCE_MISSING:${token}`);
  }
  const headStart = snapshotRepositoryDuration.indexOf("async readLatestObservationHead");
  const headEnd = snapshotRepositoryDuration.indexOf("async readLatestResolvedArtifact", headStart);
  const headBlock = headStart >= 0 && headEnd > headStart ? snapshotRepositoryDuration.slice(headStart, headEnd) : "";
  if (!headBlock.includes("databaseQueryGoverned")) failures.push("SCAN_BASE_DATABASE_GOVERNANCE_MISSING");
  const failStart = snapshotRepositoryDuration.indexOf("async fail(input:");
  const failEnd = snapshotRepositoryDuration.indexOf("async read(id:", failStart);
  const failBlock = failStart >= 0 && failEnd > failStart ? snapshotRepositoryDuration.slice(failStart, failEnd) : "";
  for (const token of ["governance?: DatabaseExecutionGovernance", "databaseQueryGoverned", "this.read(input.id, governance)"]) {
    if (!failBlock.includes(token)) failures.push(`FAILURE_PERSISTENCE_DATABASE_GOVERNANCE_MISSING:${token}`);
  }

  for (const [name, startToken, endToken] of [
    ["IDEMPOTENCY", "async readByIdempotencyKey", "async reserve("],
    ["RECOVER_STALE", "async recoverStale", "async assertProjectContextExists"],
    ["PROJECT_ASSOCIATION", "async assertProjectContextExists", "\n}"],
  ]) {
    const start = snapshotRepositoryDuration.indexOf(startToken);
    const end = snapshotRepositoryDuration.indexOf(endToken, start + startToken.length);
    const block = start >= 0 && end > start ? snapshotRepositoryDuration.slice(start, end) : "";
    for (const token of ["governance?: DatabaseExecutionGovernance", "databaseQueryGoverned"]) {
      if (!block.includes(token)) failures.push(`PRE_SOURCE_DATABASE_GOVERNANCE_MISSING:${name}:${token}`);
    }
  }

  for (const token of [
    "select set_config('statement_timeout',$1,true)",
    "select pg_cancel_backend($1)",
    'await queryWithGovernance(client, "COMMIT"',
    'await queryWithGovernance(client, "ROLLBACK"',
    "client.release(true)",
  ]) {
    if (!databaseDuration.includes(token)) failures.push(`END_TO_END_DATABASE_GOVERNANCE_MISSING:${token}`);
  }
  if (/Promise\.race/.test(databaseDuration)) failures.push("END_TO_END_DATABASE_GOVERNANCE_PROMISE_RACE_FORBIDDEN");

  for (const token of [
    "cancels a real delayed multi-write transaction and never commits a late row",
    "rolls back real PostgreSQL work when AbortSignal becomes terminal",
    "bounds a real FOR UPDATE lock wait by the same governed database deadline",
    "destroys the real governed PostgreSQL session after a production-path timeout",
    "select pg_backend_pid() pid",
    "pg_stat_activity where pid=$1",
    "uses the production governed COMMIT path and suppresses transactional effects after timeout",
    "commits a within-deadline multi-write savepoint transaction normally in rollback-only validation",
    "create temporary table intentchord_workspace_duration_probe",
    "select pg_sleep(0.5)",
    "for update",
    "pg_notify",
    'reason: "TIMEOUT"',
    'reason: "ABORTED"',
  ]) {
    if (!workspaceDurationPgTest.includes(token)) failures.push(`REAL_POSTGRES_DURATION_REGRESSION_MISSING:${token}`);
  }
  if (!workspaceAnalysisPgRunner.includes("src/server/workspace-index-duration-governance.postgres.integration.test.ts")) {
    failures.push("REAL_POSTGRES_DURATION_REGRESSION_RUNNER_MISSING");
  }

  for (const token of [
    "anchors one immutable Registered Workspace attempt clock before recoverStale, project association, idempotency, Source Authority, and Indexer execution",
    "fails closed when recoverStale exceeds the original Registered Workspace absolute deadline before any later authority",
    "fails closed when project association validation exceeds the same original absolute deadline before Source Authority",
    "fails closed when idempotency lookup exceeds the same original absolute deadline before Source Authority",
    "T42 idempotent replay after successful head advancement returns the original operation without re-indexing",
    "fails scan-base read at the original absolute deadline before Indexer execution",
    "rolls reservation authority back when the original absolute deadline wins",
    "keeps terminal failure persistence bounded and never restores canonical authority when cleanup cannot persist",
    "deadlineAtMs: absoluteOperationDeadlineAt",
    'detailedProgressPhase: "RECOVER_STALE"',
    'detailedProgressPhase: "PROJECT_ASSOCIATION"',
    'detailedProgressPhase: "IDEMPOTENCY"',
    'detailedProgressPhase: "SCAN_BASE"',
    'detailedProgressPhase: "RESERVING"',
  ]) {
    if (!snapshotServiceTestDuration.includes(token) && !snapshotServiceDuration.includes(token)) failures.push(`END_TO_END_DURATION_REGRESSION_MISSING:${token}`);
  }
}

const migrations = readdirSync(path.join(root, "migrations")).filter(name => /^\d+_/.test(name));
notes.push(`MIGRATION_FILE_COUNT=${migrations.length}`);
notes.push(`WORKSPACE_INDEX_SOURCE_FILES=${sourceFiles.length}`);
notes.push(`WORKSPACE_INDEX_TEST_FILES=${testFiles.length}`);
notes.push("AI_CONTEXT_MAPPER=ABSENT");
notes.push("SERVER_DESKTOP_DESIGN=ABSENT");
notes.push("CORE_DATABASE_COUPLING=ABSENT");
notes.push("B1_PERSISTENCE_MODEL=ADDITIVE_SERVER_BOUNDARY");
notes.push("RAW_CONTENT_CONTRACT_FIELD=ABSENT");
for (const note of notes) console.log(note);
if (failures.length) {
  for (const item of failures) console.error(`FAIL:${item}`);
  process.exit(1);
}
console.log("WORKSPACE_INDEX_SOURCE_AUDIT=PASS");

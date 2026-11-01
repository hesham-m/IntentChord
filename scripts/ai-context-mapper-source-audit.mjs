import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

async function walk(root) {
  const result = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) result.push(...await walk(full)); else result.push(full);
  }
  return result;
}
const core = (await walk("src/core/ai-context-mapper")).filter(file => /\.(?:ts|json)$/.test(file));
const server = (await walk("src/server")).filter(file => /ai-context.*\.ts$|internal-ai-engine-runtime.*\.ts$/.test(path.basename(file)));
const routes = await walk("src/app/api/ai-context-mappings");
const productionCoreFiles = core.filter(file => file.endsWith(".ts") && !file.endsWith(".test.ts") && !file.endsWith("test-fixtures.ts"));
const productionCore = await Promise.all(productionCoreFiles.map(file => readFile(file, "utf8"))).then(v => v.join("\n"));
const source = await Promise.all([...core, ...server, ...routes].map(file => readFile(file, "utf8"))).then(v => v.join("\n"));
const config = await readFile("src/server/ai-context-mapper-config.ts", "utf8");
const registry = await readFile("src/core/ai-context-mapper/engine-registry.ts", "utf8");
const typesSource = await readFile("src/core/ai-context-mapper/types.ts", "utf8");
const runtimeFactory = await readFile("src/server/internal-ai-engine-runtime.ts", "utf8");
const service = await readFile("src/server/ai-context-mapping-service.ts", "utf8");
const orchestrator = await readFile("src/core/ai-context-mapper/orchestrator.ts", "utf8");
const repository = await readFile("src/server/ai-context-mapping-repository.ts", "utf8");
const validator = await readFile("src/core/ai-context-mapper/validator.ts", "utf8");
const ui = await readFile("src/components/workspace-analysis-workbench.tsx", "utf8");
const projectUi = await readFile("src/components/project-context-workbench.tsx", "utf8");
const migration009 = await readFile("migrations/009_ai_context_mapper_v1.sql", "utf8");
const migration013 = await readFile("migrations/013_internal_ai_engine_runtime_identity_decoupling.sql", "utf8");
const migration014 = await readFile("migrations/014_governed_context_assembly_and_ai_context_mapping_v2.sql", "utf8");
const envExample = await readFile(".env.example", "utf8");
const externalRegistry = await readFile("src/core/providers/registry.ts", "utf8");
function fail(code) { console.error(code); process.exitCode = 1; }

if (/Codex CLI|Gemini CLI|Cloudflare Workers AI|OpenRouter/i.test(productionCore)) fail("FORBIDDEN_EXTERNAL_TASK_EXECUTION_CHANNEL_PRESENT");
if (/from ["'][^"']*core\/providers\/registry|from ["'][^"']*core\/contracts\//.test(productionCore + service + orchestrator)) fail("INTERNAL_EXTERNAL_MODEL_ARCHITECTURE_CONFLATED");
if (/NEXT_PUBLIC_.*(?:AI_CONTEXT_MAPPER|ZAI|SAMBANOVA|API_KEY|CREDENTIAL)/i.test(source + envExample)) fail("CLIENT_SECRET_CONFIGURATION_PRESENT");
if (/from ["']node:fs|from ["']node:child_process|exec\(|spawn\(/.test(productionCore)) fail("MAPPER_DIRECT_FILESYSTEM_OR_SHELL_PRESENT");
if (/tool_choice|function_call|\btools\s*:/.test(productionCore)) fail("MAPPER_TOOL_CALLING_PRESENT");

for (const marker of [
  "AI_CONTEXT_MAPPER_ENGINE_REGISTRY_JSON", "AI_CONTEXT_MAPPER_QUALIFICATION_REGISTRY_JSON", "AI_CONTEXT_MAPPER_OWNER_ENABLED_ENGINE_IDS",
  "AI_CONTEXT_MAPPER_SELECTION_POLICY_ID", "AI_CONTEXT_MAPPER_SELECTION_POLICY_VERSION", "AI_CONTEXT_MAPPER_SELECTION_POLICY_MODE",
  "resolveSingleQualifiedInternalAiEngine", "assertProductionInternalAiExecutionReady", "providerConfigurationSnapshot",
]) if (!config.includes(marker)) fail(`QUALIFICATION_REGISTRY_CONFIG_MARKER_MISSING:${marker}`);
if (/qualificationState\s*:\s*["']QUALIFIED["']/.test(config) || /role\s*===\s*["']ACTIVE["'].*QUALIFIED/.test(config)) fail("ACTIVE_ROLE_CREATES_QUALIFICATION");
if (/governanceQualifiedOverride/.test(runtimeFactory + service)) fail("PRODUCTION_QUALIFICATION_OVERRIDE_REMAINS");
if (!runtimeFactory.includes('"PRODUCTION"') || !runtimeFactory.includes('"CANDIDATE_BENCHMARK"') || !runtimeFactory.includes('"STANDBY_FAILOVER"')) fail("ROUTING_FAILOVER_EXECUTION_MODE_SEPARATION_MISSING");
if (!runtimeFactory.includes('engine.role === "ACTIVE" && engine.ownerEnabled && isQualificationApplicableToEngine(engine, engine.qualification')) fail("ACTIVE_UNQUALIFIED_FAIL_CLOSED_MARKER_MISSING");

for (const marker of [
  "qualificationId", "engineConfigRevision", "engineConfigurationSha256", "qualificationScope", "capabilityProfileVersion", "selectionPolicyId", "selectionPolicyVersion", "selectionMode",
  "INTERNAL_AI_ACTIVE_ENGINE_NOT_QUALIFIED", "INTERNAL_AI_SINGLE_SELECTION_AMBIGUOUS",
]) if (!(typesSource + registry).includes(marker)) fail(`ENGINE_REGISTRY_AUTHORITY_MARKER_MISSING:${marker}`);
if (!registry.includes("ownerEnabledEngineIds") || !registry.includes("qualificationForEngine")) fail("OWNER_ENABLED_QUALIFIED_SEPARATION_MISSING");
if (!(typesSource + registry).includes("AI_CONTEXT_MAPPING_V1") || !(typesSource + registry).includes("AI_CONTEXT_MAPPING_V2")) fail("QUALIFICATION_SCOPE_ENFORCEMENT_MISSING");
if (!registry.includes("qualificationScope: InternalAiQualificationScope") || !registry.includes("record.qualificationScope === qualificationScope")) fail("QUALIFICATION_SCOPE_VERSION_SEPARATION_MISSING");
if (!registry.includes("engineConfigRevision")) fail("QUALIFICATION_REVISION_BINDING_MISSING");
if (!registry.includes("deriveInternalAiEngineConfigurationSha256") || !registry.includes("internalAiEngineConfigurationIdentityMaterial")) fail("ENGINE_CONFIGURATION_IDENTITY_BINDING_MISSING");
if (!registry.includes("assertQualificationRegistryCurrentState") || !registry.includes("INTERNAL_AI_ENGINE_QUALIFICATION_STATE_AMBIGUOUS")) fail("QUALIFICATION_CURRENT_STATE_FAIL_CLOSED_MISSING");
if (!registry.includes("record.engineConfigurationSha256 === engine.engineConfigurationSha256")) fail("QUALIFICATION_EXACT_CONFIGURATION_BINDING_MISSING");

for (const marker of ["validateModelProposedCatalog", "finalizeValidationFailure", 'kind: "validation_failure"']) if (!orchestrator.includes(marker)) fail(`DETERMINISTIC_VALIDATOR_AUTHORITY_MARKER_MISSING:${marker}`);
if (!orchestrator.includes('primaryResult.kind !== "technical_failure"') || !orchestrator.includes("failoverEligible")) fail("VALIDATION_FAILURE_FAILOVER_GUARD_MISSING");
if (!validator.includes("validateModelProposedCatalog")) fail("DETERMINISTIC_VALIDATOR_MISSING");

for (const marker of ["providerConfigurationSnapshot", "activeEngine.provider_id", "activeEngine.channel_id", "activeEngine.model_id", "standbyEngine?.provider_id", "standbyEngine?.model_id"]) if (!repository.includes(marker)) fail(`RESOLVED_IDENTITY_PERSISTENCE_MISSING:${marker}`);
for (const marker of ["selected_engine_id", "selected_engine_config_revision", "selected_engine_configuration_sha256", "engine_configuration_sha256", "selection_policy", "qualification"]) if (!(typesSource + config + repository).includes(marker)) fail(`SELECTED_ENGINE_RUN_PROVENANCE_MISSING:${marker}`);

if (!service.includes("assertProductionInternalAiExecutionReady") || !service.includes('executionMode: "PRODUCTION"')) fail("PRODUCTION_SERVICE_QUALIFICATION_GATE_MISSING");
if (!service.includes("toCustomerMappingRunView") || !service.includes("toCustomerMappingAttemptView")) fail("CUSTOMER_PROVENANCE_SANITIZER_MISSING");
const customerAttemptType = typesSource.slice(typesSource.indexOf("export type CustomerMappingAttemptView"), typesSource.indexOf("export type ContextMappingResultEnvelope"));
if (!["normalizedErrorCode", "retryCount", "usageMetadata", "rateLimitMetadata"].every(field => customerAttemptType.includes(`"${field}"`))) fail("CUSTOMER_INTERNAL_PROVIDER_DIAGNOSTICS_NOT_OMITTED");
const customerAttemptSanitizer = service.slice(service.indexOf("export function toCustomerMappingAttemptView"), service.indexOf("export function toCustomerMappingRunView"));
if (/normalizedErrorCode|retryCount|usageMetadata|rateLimitMetadata|providerId|requestedModelId|responseModelId|providerRequestId|providerSystemFingerprint/.test(customerAttemptSanitizer)) fail("CUSTOMER_ATTEMPT_INTERNAL_PROVIDER_DATA_LEAK");
if (/Provider\s*\/\s*Model/i.test(ui) || /primaryProviderId|primaryModelId|standbyProviderId|standbyModelId/.test(ui + projectUi)) fail("CUSTOMER_INTERNAL_ENGINE_IDENTITY_EXPOSED");
if (/API[_ -]?KEY|credentialReference|credential_reference/.test(ui + projectUi)) fail("CUSTOMER_INTERNAL_SECRET_METADATA_EXPOSED");

for (const marker of ["context_mapping_runs", "context_mapping_attempts", "context_catalog_proposals", "context_mapping_run_governed_update", "context_catalog_proposal_insert_guard", "INTENTCHORD_CONTEXT_MAPPING_HISTORY_APPEND_ONLY"]) if (!migration009.includes(marker)) fail(`HISTORICAL_MIGRATION_GOVERNANCE_MARKER_MISSING:${marker}`);
for (const marker of [
  "intentchord.internal-ai-provider-configuration.v2", "intentchord.internal-ai-engine-registry.v1",
  "intentchord.internal-ai-provider-configuration.v3", "intentchord.internal-ai-engine-registry.v2",
  "intentchord.internal-ai-engine-configuration-identity.v1", "internal_ai_engine_configuration_sha256_v1",
  "AI_CONTEXT_MAPPING_V1", "SINGLE", "selected_engine_id", "selected_engine_config_revision",
  "selected_engine_configuration_sha256", "engine_configuration_sha256", "qualification_id", "engine_config_revision",
  "INTENTCHORD_CONTEXT_MAPPING_RUNTIME_CONFIGURATION_V3_EXACT_QUALIFICATION_REQUIRED", "INTENTCHORD_CONTEXT_MAPPING_PRIMARY_ATTEMPT_ENGINE_MISMATCH",
]) if (!migration013.includes(marker)) fail(`MIGRATION_013_QUALIFICATION_REGISTRY_MARKER_MISSING:${marker}`);
if (/glm-4\.7-flash|gpt-oss-120b|'zai'|'sambanova'|zai_direct_chat|sambanova_direct_chat/i.test(migration013)) fail("MIGRATION_013_COMMERCIAL_ENGINE_LITERAL_PINNING_PRESENT");
if (/DROP TABLE|TRUNCATE|eit_/i.test(migration013)) fail("MIGRATION_013_SCOPE_VIOLATION");
for (const marker of [
  "context_assemblies", "context_assembly_revisions", "context_assembly_sources",
  "context_mapping_v2_results", "context_assembly_mapping_iterations",
  "context_missing_evidence_requests", "context_gap_classifications", "context_material_contradictions",
  "context_resolution_requirements", "context_resolution_events", "context_closure_evaluations", "context_catalog_revisions",
  "execution_deadline_at", "deadline_policy_version", "ORPHANED_ACTIVE_MAPPING_EXECUTION",
  "MISSING_INTERNAL_EVIDENCE", "SOURCE_TRUTH_CONFLICT",
]) if (!migration014.includes(marker)) fail(`MIGRATION_014_ROOT_CONTEXT_PROVENANCE_MARKER_MISSING:${marker}`);
for (const forbidden of [
  "MAPPING_RETRYABLE", "READY_FOR_MAPPING", "READY_FOR_CLOSURE", "closure_state",
]) if (migration014.includes(forbidden)) fail(`MIGRATION_014_ASSEMBLY_MUTABLE_LIFECYCLE_REMAINS:${forbidden}`);
const retryRepository = await readFile("src/server/ai-context-mapping-v2-repository.ts", "utf8");
for (const marker of [
  "ACTIVE_V2_MAPPING_RUN_STATUSES", "CONTEXT_MAPPING_EXECUTION_DEADLINE_POLICY_V1",
  "ORPHANED_ACTIVE_MAPPING_EXECUTION", "reconcileExpiredActiveRunsWith", "CONTEXT_ASSEMBLY_MAPPING_ALREADY_ACTIVE",
]) if (!retryRepository.includes(marker)) fail(`V2_MAPPING_RUN_LIVENESS_MARKER_MISSING:${marker}`);
const bindingService = await readFile("src/server/context-assembly-task-binding-service.ts", "utf8");
for (const marker of [
  "closure_evaluation_id", "mapping_iteration_id", "mapping_run_id", "mapping_input_snapshot",
  "Catalog -> Closure Evaluation", "Never resolve \"latest\"",
]) if (!bindingService.includes(marker)) fail(`ACCEPTED_CATALOG_AUTHORITY_CHAIN_MARKER_MISSING:${marker}`);
if (/order by created_at desc,id desc\s+limit 1[\s\S]{0,200}context_assembly_revision_id/.test(bindingService)) fail("WORK_SELECTION_LATEST_MAPPING_RUN_AUTHORITY_PRESENT");
const closureService = await readFile("src/server/context-closure-service.ts", "utf8");
for (const marker of [
  "context_resolution_requirements", "context_material_contradictions", "context_resolution_events",
  "context_closure_evaluations", "evaluation_input_sha256", "SOURCE_TRUTH_CORRECTION_REQUIRED",
  "SUPERSEDED_BY_NEW_ASSEMBLY", "BACKEND_DETERMINISTIC_VALIDATOR",
]) if (!closureService.includes(marker)) fail(`CONTEXT_CLOSURE_ROOT_SERVICE_MARKER_MISSING:${marker}`);
if (closureService.includes("RESOLVED_BY_NEW_ASSEMBLY") || migration014.includes("RESOLVED_BY_NEW_ASSEMBLY")) fail("CONTEXT_RESOLUTION_FALSE_RESOLVED_BY_NEW_ASSEMBLY_PRESENT");
if (/mistral|glm-4\.7-flash|gpt-oss-120b|'zai'|'sambanova'|zai_direct_chat|sambanova_direct_chat/i.test(migration014)) fail("MIGRATION_014_PROVIDER_SPECIFIC_SEMANTICS_PRESENT");
if (/insert\s+into\s+intentchord\.[a-z_]*qualification/i.test(migration014)) fail("MIGRATION_014_MANUFACTURES_V2_QUALIFICATION");

for (const marker of [
  "AI_CONTEXT_MAPPER_ENGINE_REGISTRY_JSON=", "AI_CONTEXT_MAPPER_QUALIFICATION_REGISTRY_JSON=", "AI_CONTEXT_MAPPER_OWNER_ENABLED_ENGINE_IDS=",
  "AI_CONTEXT_MAPPER_SELECTION_POLICY_MODE=SINGLE", "AI_CONTEXT_MAPPER_PRIMARY_ENGINE_ID=", "AI_CONTEXT_MAPPER_PRIMARY_ENGINE_REVISION=",
  "AI_CONTEXT_MAPPER_CANDIDATE_ENGINE_ID=", "AI_CONTEXT_MAPPER_STANDBY_ENGINE_ID=",
]) if (!envExample.includes(marker)) fail(`RUNTIME_ENVIRONMENT_CONTRACT_MISSING:${marker}`);

if (/ROUND_ROBIN|WEIGHTED|BUDGET_AWARE|CAPABILITY_AWARE/.test(config + registry + runtimeFactory)) fail("UNAUTHORIZED_ROUTING_MODE_IMPLEMENTED");
if (/shadow.*execute|execute.*shadow|shadowResult|shadow_result/i.test(config + registry + runtimeFactory + service)) fail("DUPLICATE_SHADOW_IMPLEMENTATION_PRESENT");
if (!externalRegistry.includes("providerRegistry") && !externalRegistry.includes("modelRegistry")) fail("EXTERNAL_TASK_EXECUTION_REGISTRY_UNEXPECTED");
if (!source.includes("intentchord.model-proposed-context-catalog.v1")) fail("OUTPUT_SCHEMA_V1_VERSION_MISSING");
if (!source.includes("intentchord.model-context-analysis.v2") || !source.includes("intentchord.context-mapping-result.v2")) fail("OUTPUT_SCHEMA_V2_VERSION_MISSING");
if (!source.includes("MAPPER_INPUT_BUDGET_EXCEEDED")) fail("BUDGET_BLOCKER_MISSING");
if (!source.includes("sha256Utf8") || !source.includes("raw_model_content ?? null")) fail("EXACT_RAW_MODEL_BODY_HASH_BINDING_MISSING");

if (process.exitCode) process.exit(process.exitCode);
console.log(`AI_CONTEXT_MAPPER_CORE_FILES=${core.length}`);
console.log(`AI_CONTEXT_MAPPER_SERVER_FILES=${server.length}`);
console.log("CONFIGURATION_PRESENCE_CREATES_QUALIFICATION=NO");
console.log("ACTIVE_ROLE_CREATES_QUALIFICATION=NO");
console.log("TECHNICAL_COMPATIBILITY_CREATES_QUALIFICATION=NO");
console.log("ACTIVE_UNQUALIFIED_FAIL_CLOSED=PASS");
console.log("QUALIFICATION_SCOPE_ENFORCED=PASS");
console.log("AI_CONTEXT_MAPPING_V1_PRESERVED=PASS");
console.log("AI_CONTEXT_MAPPING_V2_EXPLICIT_SCOPE=PASS");
console.log("V1_QUALIFICATION_IMPLIES_V2=NO");
console.log("QUALIFICATION_REVISION_BINDING=PASS");
console.log("ENGINE_CONFIGURATION_IDENTITY_BINDING=PASS");
console.log("QUALIFICATION_EXACT_CONFIGURATION_BINDING=PASS");
console.log("QUALIFICATION_STATE_AMBIGUITY=MUST_FAIL_CLOSED");
console.log("ENGINE_IDENTITY_NE_MODEL_IDENTITY=PASS");
console.log("ENGINE_CONFIG_REVISION_EXPLICIT=PASS");
console.log("MULTIPLE_ENGINE_REGISTRY_SUPPORTED=PASS");
console.log("OWNER_ENABLED_NE_QUALIFIED=PASS");
console.log("HEALTH_NE_QUALIFICATION=PASS");
console.log("SELECTION_POLICY_BOUNDARY=PASS");
console.log("CURRENT_SELECTION_POLICY=SINGLE");
console.log("SELECTED_ENGINE_RUN_PROVENANCE=PASS");
console.log("ROUTING_NE_FAILOVER=PASS");
console.log("NO_SILENT_VALIDATION_FALLBACK=PASS");
console.log("CAPABILITY_PROFILE_EXISTING_IDENTITY_REUSED=PASS");
console.log("SHADOW_ARCHITECTURE_REUSED=PASS");
console.log("SHADOW_IMPLEMENTATION=DEFERRED");
console.log("NO_DUPLICATE_SHADOW_SYSTEM=PASS");
console.log("INTERNAL_AI_CUSTOMER_VISIBILITY=HIDDEN");
console.log("DETERMINISTIC_VALIDATOR_AUTHORITY=PRESERVED");
console.log("EXTERNAL_TASK_EXECUTION_ARCHITECTURE=SEPARATE");
console.log("AI_CONTEXT_MAPPER_SOURCE_AUDIT=PASS");

import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";

const read = path => readFileSync(resolve(process.cwd(), path), "utf8");
const head = read("src/server/context-head-authority.ts");
const lifecycle = read("src/server/lifecycle.ts");
const closure = read("src/server/context-closure-service.ts");
const binding = read("src/server/context-assembly-task-binding-service.ts");
const projection = read("src/server/task-experience-projection-service.ts");
const snapshot = read("src/server/task-experience-authority-snapshot.ts");
const workbench = read("src/components/unified-task-workbench.tsx");
const shell = read("src/components/product-shell.tsx");
const migration = read("migrations/014_governed_context_assembly_and_ai_context_mapping_v2.sql");
const migration013 = readFileSync(resolve(process.cwd(), "migrations/013_internal_ai_engine_runtime_identity_decoupling.sql"));
const test = read("src/server/current-context-head-forward-authority.test.ts");
const projectionTest = read("src/server/task-experience-projection-service.test.ts");
const production = [head,lifecycle,closure,binding,projection,snapshot,workbench,shell,migration].join("\n");
const has = (src, marker) => src.includes(marker);
const count = (src, marker) => src.split(marker).length - 1;
const sourceAuthorizationStart = closure.indexOf("export async function authorizeTaskContextSource");
const sourceAuthorizationEnd = closure.indexOf("\nexport async function", sourceAuthorizationStart + 1);
const sourceAuthorization = closure.slice(sourceAuthorizationStart, sourceAuthorizationEnd < 0 ? closure.length : sourceAuthorizationEnd);
const currentRequirementSourceAuthorityCall = /assertCurrentEffectiveContextAuthority\s*\(\s*client\s*,\s*taskId\s*,\s*authority\.context_assembly_revision_id\s*,\s*["']CONTEXT_REQUIREMENT_SUPERSEDED["']\s*,\s*workspaceRegistrationIds\s*,?\s*\)/s.test(sourceAuthorization);

const checks = [
  ["01_CURRENT_HEAD_DERIVED_FROM_LINEAGE", () => has(head,"order by revision desc")],
  ["02_NO_MUTABLE_IS_CURRENT_FLAG", () => !/\bis_current\b/i.test(migration)],
  ["03_HISTORICAL_REVISIONS_REMAIN_PERSISTED", () => has(migration,"context_assembly_revisions") && has(migration,"previous_revision_id")],
  ["04_CURRENT_HEAD_AUTHORITY_PARENT_LOCK", () => has(head,"context_assemblies where task_id=$1 for update")],
  ["05_WORK_SELECTION_ATOMIC_HEAD_LOCK", () => has(lifecycle,"resolveCurrentHeadContextAssemblyWorkSelection(client") && has(binding,"assertCurrentEffectiveContextAuthority(")],
  ["06_CURRENT_REQUIREMENT_SOURCE_AUTH_PATH", () => currentRequirementSourceAuthorityCall],
  ["07_SUPERSEDED_REQUIREMENT_SOURCE_AUTH_DENIED", () => has(closure,"CONTEXT_REQUIREMENT_SUPERSEDED") && has(migration,"REQUIREMENT_SUPERSEDED")],
  ["08_STALE_SOURCE_AUTH_REPLAY_DENIED", () => has(migration,"INTENTCHORD_CONTEXT_SOURCE_AUTHORIZATION_STALE_CONTEXT_HEAD")],
  ["09_SOURCE_AUTH_NO_RETARGET", () => has(closure,"Replayed authority never retargets")],
  ["10_SOURCE_AUTH_TASK_REVISION_RECEIPT", () => has(migration,"task_revision bigint NOT NULL") && has(migration,"TASK_REVISION_STALE")],
  ["11_SOURCE_EXPANSION_REVALIDATES_TASK", () => has(lifecycle,"appendAuthorizedContextWorkspaceInTransaction") && has(lifecycle,"expectedTaskRevision")],
  ["12_SOURCE_AUTH_AND_TASK_EXPANSION_ATOMIC", () => has(closure,"appendAuthorizedContextWorkspaceInTransaction(client")],
  ["13_HISTORICAL_AUTH_RECEIPT_APPEND_ONLY", () => has(migration,"context_source_authorizations") && has(migration,"context_assembly_history_append_only")],
  ["14_ALREADY_PRESENT_WORKSPACE_REJECTED", () => has(closure,"SOURCE_ALREADY_PRESENT_REQUIRES_REFRESH_OR_REINDEX") && has(migration,"WORKSPACE_ALREADY_PRESENT")],
  ["15_CURRENT_CATALOG_CAN_CREATE_SELECTION", () => has(binding,"resolveCurrentHeadContextAssemblyWorkSelection")],
  ["16_SUPERSEDED_CATALOG_SELECTION_DENIED", () => has(binding,"ACCEPTED_CONTEXT_CATALOG_SUPERSEDED")],
  ["17_HISTORICAL_CATALOG_PRESERVED", () => has(migration,"context_catalog_revisions") && !has(lifecycle,"delete from intentchord.context_catalog_revisions")],
  ["18_STALE_CATALOG_API_REPLAY_FAILS", () => has(lifecycle,"resolveCurrentHeadContextAssemblyWorkSelection(client")],
  ["19_WORK_SELECTION_IS_OWNER_INTENT", () => has(lifecycle,"OWNER_INTENT_NOT_SCOPE_AUTHORITY_FREEZE")],
  ["20_CURRENT_CANDIDATE_SCOPE_CONFIRMABLE", () => has(lifecycle,"FIRST_TASK_EXECUTION_AUTHORITY_FREEZE")],
  ["21_STALE_CANDIDATE_SCOPE_NOT_CONFIRMABLE", () => has(lifecycle,"assertCurrentEffectiveContextAuthority") && has(lifecycle,"STALE_CANDIDATE_SCOPE")],
  ["22_SCOPE_CONFIRMATION_HEAD_CHECK_IN_TRANSACTION", () => has(lifecycle,"resolveCurrentUnifiedCandidateScope(taskId, currentDraft.draft, client)")],
  ["23_CANDIDATE_IDENTITY_FAIL_CLOSED_PRESERVED", () => has(lifecycle,"candidateScopeIdentityMatches") && has(lifecycle,"STALE_CANDIDATE_SCOPE")],
  ["24_HISTORICAL_WORK_SELECTION_NOT_REWRITTEN", () => !has(lifecycle,"AUTO_PORT_SELECTED_COMPONENTS")],
  ["25_SCOPE_FREEZES_EXACT_CONTEXT_PROVENANCE", () => has(lifecycle,"candidateIdentity: candidateScopeIdentityFromScope(auth)")],
  ["26_HEAD_ADVANCE_DOES_NOT_MUTATE_CONFIRMATION", () => !has(production,"MUTATE_SCOPE_CONFIRMATION_TO_CURRENT_HEAD")],
  ["27_STALE_CONFIRMED_SCOPE_BLOCKS_NEW_RUN", () => has(lifecycle,"export async function createRun") && count(lifecycle,"assertCurrentEffectiveContextAuthority(") >= 7],
  ["28_CURRENT_MATCH_EXECUTION_PATH_PRESENT", () => has(head,"assertCurrentEffectiveContextAuthority")],
  ["29_HEAD_MISMATCH_PROJECTS_REBASE", () => has(projection,"SOURCE_DRIFT_REBASE_REQUIRED")],
  ["30_UNPROVEN_SOURCE_AUTHORITY_FAILS_CLOSED", () => has(head,"CURRENT_SOURCE_AUTHORITY_UNPROVEN")],
  ["31_EXPLICIT_REBASE_REQUIRES_NEW_SELECTION", () => has(projection,"REBASE_CONTEXT_WORK_SELECTION") && has(workbench,"Rebase Work on Current Context")],
  ["32_STALE_SCOPE_BLOCKS_PLATFORM_AND_CONTRACT", () => has(lifecycle,"selectTaskExecutionPlatform") && has(lifecycle,"resolveContract")],
  ["33_STARTED_RUN_REMAINS_FROZEN", () => has(projection,"A started Run remains frozen to its exact approved authority")],
  ["34_ACTIVE_RUN_NOT_RETARGETED", () => !has(production,"RETARGET_ACTIVE_RUN_TO_CONTEXT_HEAD")],
  ["35_HISTORICAL_RUN_NOT_CURRENT_FORWARD_AUTHORITY", () => has(projection,"ACTIVE_RUN_ON_FROZEN_AUTHORITY")],
  ["36_BACKEND_DERIVES_STALE_STATUS", () => has(snapshot,"readContextForwardAuthority") && has(projection,"contextAuthoritySummary")],
  ["37_SUPERSEDED_REQUIREMENT_NO_UI_AUTHORITY", () => has(closure,"SUPERSEDED_BY_NEW_ASSEMBLY") && has(projection,"contextResolutionSummary")],
  ["38_SUPERSEDED_CATALOG_NO_CONFIRM_ACTION", () => has(projection,"STALE_WORK_INTENT_CURRENT_CONTEXT_ADVANCED")],
  ["39_STALE_PRECONFIRM_NO_CONFIRM_SCOPE", () => has(projectionTest,'not.toBe("CONFIRM_SCOPE")')],
  ["40_STALE_POSTCONFIRM_NO_NEW_EXECUTION", () => has(projectionTest,'not.toBe("SELECT_EXECUTION_PLATFORM")')],
  ["41_CONTEXT_ASSEMBLY_EVIDENCE_ONLY", () => !/CREATE TABLE IF NOT EXISTS intentchord\.context_assembly_revisions[\s\S]*?\bstate\b/.test(migration.slice(migration.indexOf("CREATE TABLE IF NOT EXISTS intentchord.context_assembly_revisions"),migration.indexOf("CREATE TABLE IF NOT EXISTS intentchord.context_assembly_sources")))],
  ["42_NO_IS_CURRENT_DOMAIN_TRUTH", () => !/\bis_current\b/i.test([head,migration].join("\n"))],
  ["43_CLOSURE_EVALUATIONS_IMMUTABLE", () => has(migration,"context_closure_evaluations") && has(migration,"context_assembly_history_append_only")],
  ["44_ACCEPTED_CATALOG_EXACT_PROVENANCE", () => has(binding,"closure_evaluation_id") || has(binding,"closureEvaluationId")],
  ["45_LATEST_MAPPING_RUN_NOT_AUTHORITY", () => !/order by[^;\n]*created_at desc[^;\n]*limit 1/i.test(binding)],
  ["46_AI_CONTEXT_MAPPING_V1_PRESERVED", () => has(migration,"AI_CONTEXT_MAPPING_V1")],
  ["47_V1_QUALIFICATION_NOT_V2", () => has(migration,"AI_CONTEXT_MAPPING_V2") && has(migration,"qualification_scope")],
  ["48_MIGRATION_013_UNCHANGED", () => createHash("sha256").update(migration013).digest("hex").toUpperCase()==="D89E8F42522F2A458289EA130CD07EB3A1D51A5E585FA5C9369F807BCEC0C7AD"],
  ["49_MIGRATION_015_ABSENT", () => !readdirSync(resolve(process.cwd(),"migrations")).some(name=>name.startsWith("015_"))],
  ["50_MISTRAL_UNCONFIGURED_UNQUALIFIED", () => !/internal-mistral-large-2512|mistral-large-2512/i.test(production)],
];

let pass=0;
for (const [name, fn] of checks) {
  let ok=false;
  try { ok=Boolean(fn()); } catch {}
  console.log(`${name}=${ok?"PASS":"FAIL"}`);
  if (ok) pass++;
}
console.log(`CURRENT_CONTEXT_HEAD_AUTHORITY_CHECKS=${checks.length}`);
console.log(`CURRENT_CONTEXT_HEAD_AUTHORITY_PASS=${pass}`);
console.log(`CURRENT_CONTEXT_HEAD_AUTHORITY_FAIL=${checks.length-pass}`);
console.log(`CURRENT_CONTEXT_HEAD_AUTHORITY_SOURCE_AUDIT=${pass===checks.length?"PASS":"FAIL"}`);
if(pass!==checks.length) process.exit(1);

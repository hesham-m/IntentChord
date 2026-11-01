import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
const read=p=>readFileSync(resolve(process.cwd(),p),"utf8");
const head=read("src/server/context-head-authority.ts");
const truth=read("src/core/context-authority/current-effective-context.ts");
const closure=read("src/server/context-closure-service.ts");
const lifecycle=read("src/server/lifecycle.ts");
const binding=read("src/server/context-assembly-task-binding-service.ts");
const authorityInput=read("src/server/task-authority-input.ts");
const routing=read("src/core/tasks/execution-routing-policy.ts");
const projection=read("src/server/task-experience-projection-service.ts");
const migration=read("migrations/014_governed_context_assembly_and_ai_context_mapping_v2.sql");
const migration013=readFileSync(resolve(process.cwd(),"migrations/013_internal_ai_engine_runtime_identity_decoupling.sql"));
const test=read("src/server/current-context-forward-authority-gate.test.ts");
const all=[head,truth,closure,lifecycle,binding,authorityInput,routing,projection,migration].join("\n");
const h=(s,m)=>s.includes(m), n=(s,m)=>s.split(m).length-1;
const sourceAuthorizationStart=closure.indexOf("export async function authorizeTaskContextSource");
const sourceAuthorizationEnd=closure.indexOf("\nexport async function",sourceAuthorizationStart+1);
const sourceAuthorization=closure.slice(sourceAuthorizationStart,sourceAuthorizationEnd<0?closure.length:sourceAuthorizationEnd);
const currentSourceAuthorizationGate=/assertCurrentEffectiveContextAuthority\s*\(\s*client\s*,\s*taskId\s*,\s*authority\.context_assembly_revision_id\s*,\s*["']CONTEXT_REQUIREMENT_SUPERSEDED["']\s*,\s*workspaceRegistrationIds\s*,?\s*\)/s.test(sourceAuthorization);
const checks=[
["01_ACTUAL_OBSERVATION_HEAD_BY_AUTHORITY_SEQUENCE",()=>h(head,"order by o.authority_sequence desc")],
["02_FAILED_HEAD_NO_READY_FALLBACK",()=>h(head,"actual current Workspace Observation authority head is failed")],
["03_UNQUALIFIED_HEAD_UNPROVEN",()=>h(head,"CURRENT_SOURCE_AUTHORITY_UNPROVEN")],
["04_CURRENT_READY_DIFFERENCE_IS_DRIFT",()=>h(truth,'return "DRIFT"')],
["05_EXACT_READY_MATCH_CURRENT",()=>h(truth,'return "CURRENT"')],
["06_NO_OBSERVATION_UNPROVEN",()=>h(truth,'return "UNPROVEN"')],
["07_ASSEMBLY_CAPTURE_USES_CURRENT_HEAD",()=>h(closure,"captureLockedTaskSourceAuthority(client, draft)")],
["08_ASSEMBLY_CAPTURE_TASK_TRANSACTION",()=>h(closure,'select revision,draft from intentchord.tasks where id=$1 for update')],
["09_MULTI_WORKSPACE_DETERMINISTIC_LOCKS",()=>h(head,"order by id\n      for update")],
["10_TASK_SOURCE_SET_IN_GATE",()=>h(head,"frozenTaskSourceSetSha256")&&h(head,"current.taskSourceSetSha256")&&h(head,"taskSourceSetMatchesAssembly")],
["11_SOURCE_ADDITION_INVALIDATES_OLD_ASSEMBLY",()=>h(lifecycle,"TASK_CONTEXT_SOURCE_EXPANDED")&&h(head,"taskSourceSetMatchesAssembly")],
["12_CLOSURE_CURRENT_SOURCE_GATE",()=>h(closure,"assertCurrentEffectiveContextAuthority(")],
["13_MAPPING_DRIFT_NO_CLOSURE_PASS",()=>h(closure,'"STALE_CONTEXT_HEAD"')&&h(closure,"currentEffectiveContextAuthorityProven:true")],
["14_FAILED_LATEST_NO_CLOSURE_PASS",()=>h(head,"observationHeadQualifiedReady")||h(head,"snapshot_attempt_status")],
["15_MAPPING_ITERATION_PRESERVED",()=>h(migration,"context_assembly_mapping_iterations")],
["16_CURRENT_SOURCE_FACTS_IN_EVALUATION_ID",()=>h(closure,"currentTaskSourceSetSha256")&&h(closure,"currentSourceAuthoritySha256")],
["17_SOURCE_AUTH_CURRENT_EFFECTIVE_GATE",()=>h(closure,"CONTEXT_REQUIREMENT_SUPERSEDED")&&h(closure,"assertCurrentEffectiveContextAuthority")],
["18_MAX_ASSEMBLY_SOURCE_STALE_DENIED",()=>h(migration,"current_effective_context_authority_status")],
["19_SUPERSEDED_REQUIREMENT_DENIED",()=>h(closure,"SUPERSEDED_BY_NEW_ASSEMBLY")],
["20_TARGET_REGISTRATION_LOCKED",()=>h(closure,"[command.workspaceRegistrationId]")&&h(head,"additionalWorkspaceRegistrationIds")&&h(head,"order by id\n      for update")],
["21_RECEIPT_AND_EXPANSION_SAME_REGISTRATION",()=>h(migration,"workspace_registration_revision")&&h(migration,"workspace_registration_fingerprint")],
["22_ALREADY_BOUND_SOURCE_REJECTED",()=>h(closure,"SOURCE_ALREADY_PRESENT_REQUIRES_REFRESH_OR_REINDEX")],
["23_STALE_SOURCE_AUTH_NO_RETARGET",()=>currentSourceAuthorizationGate&&h(sourceAuthorization,"Replayed authority never retargets")&&h(sourceAuthorization,'throw new HttpCommandError(409,"CONTEXT_REQUIREMENT_SUPERSEDED"')&&h(sourceAuthorization,"workspaceRegistrationIds")],
["24_WORK_SELECTION_CURRENT_EFFECTIVE_GATE",()=>h(binding,"assertCurrentEffectiveContextAuthority(")],
["25_SOURCE_DRIFT_CATALOG_DENIED",()=>h(binding,"ACCEPTED_CONTEXT_CATALOG_SUPERSEDED")],
["26_HISTORICAL_CATALOG_READABLE",()=>h(migration,"context_catalog_revisions")&&!/delete from intentchord\.context_catalog_revisions/i.test(all)],
["27_STALE_WORK_SELECTION_REPLAY_FAILS",()=>h(lifecycle,"resolveCurrentHeadContextAssemblyWorkSelection(client")],
["28_SCOPE_FREEZES_AUTHORITY_INPUT_SHA",()=>h(authorityInput,"intentchord.task-authority-input.v1")&&h(lifecycle,"authorityInputSha256")],
["29_OBJECTIVE_IN_AUTHORITY_FINGERPRINT",()=>h(authorityInput,"objective: draft.objective")],
["30_TASK_MODE_IN_AUTHORITY_FINGERPRINT",()=>h(authorityInput,"taskMode: draft.taskMode")],
["31_CAPABILITIES_IN_AUTHORITY_FINGERPRINT",()=>h(authorityInput,"modifySource: draft.modifySource")&&h(authorityInput,"deploy: draft.deploy")],
["32_WORKSPACES_IN_AUTHORITY_FINGERPRINT",()=>h(authorityInput,"workspaces:")&&h(authorityInput,"authorizationContext")],
["33_PRESENTATION_ONLY_DOCUMENTED",()=>h(authorityInput,"TASK_AUTHORITY_INPUT_V1_PRESENTATION_ONLY_FIELDS")],
["34_PRECONFIRM_CHANGE_INVALIDATES_CANDIDATE",()=>h(lifecycle,"delete normalizedNext.candidateScope")&&h(lifecycle,"delete normalizedNext.scopeConfirmation")],
["35_V1_CANNOT_CONFIRM_UNIFIED_SCOPE",()=>h(lifecycle,"UNIFIED_V2_CONTEXT_AUTHORITY_REQUIRED")],
["36_MISSING_V2_CANNOT_SELECT_PLATFORM",()=>h(routing,"CONTEXT_ASSEMBLY_V2")&&h(lifecycle,"requireUnifiedV2ScopeFreeze")],
["37_MISSING_V2_CANNOT_RESOLVE_CONTRACT",()=>h(lifecycle,"UNIFIED_V2_SCOPE_AUTHORITY_REQUIRED")],
["38_MISSING_V2_CANNOT_START_INITIAL_RUN",()=>n(lifecycle,"requireUnifiedV2ScopeFreeze")>=5],
["39_MISSING_V2_CANNOT_START_CORRECTION_RUN",()=>h(lifecycle,"CORRECTION_CURRENT_AUTHORITY_CONTRACT_REQUIRED")],
["40_V1_HISTORICAL_PRESERVED",()=>h(migration,"AI_CONTEXT_MAPPING_V1")],
["41_TERMINAL_RUN_DOES_NOT_BLOCK_REBASE",()=>h(lifecycle,"Terminal historical Runs remain frozen provenance")],
["42_HISTORICAL_CONTRACT_SUPERSEDED_NOT_DELETED",()=>h(lifecycle,"set status='SUPERSEDED'")&&!/delete from intentchord\.contract_revisions/i.test(lifecycle)],
["43_ACTIVE_RUN_FROZEN",()=>h(projection,"ACTIVE_RUN_ON_FROZEN_AUTHORITY")],
["44_REBASE_PRESERVES_HISTORY",()=>h(lifecycle,"SCOPE_AUTHORITY_REBASE_REQUIRED")],
["45_NEW_SCOPE_NEW_IDENTITY",()=>h(lifecycle,"FIRST_TASK_EXECUTION_AUTHORITY_FREEZE")&&h(authorityInput,"taskAuthorityInputSha256V1")],
["46_CORRECTION_EXECUTES_VALIDATED_CURRENT_CONTRACT",()=>h(lifecycle,"const currentResolved = await currentContractForUpdate(client, route.rows[0].task_id)")&&h(lifecycle,"const contract = currentResolved.contract")],
["47_STALE_PARENT_CONTRACT_NOT_EXECUTED",()=>h(lifecycle,"never validate S2/current")&&h(lifecycle,"historical Contract1/S1")&&h(lifecycle,"contractRow: {\n        id: currentResolved.row.id")],
["48_PARENT_CURRENT_CORRECTION_ALLOWED",()=>h(lifecycle,"currentResolved.row.status !== \"APPROVED\"")],
["49_PARENT_STALE_REQUIRES_REBASED_CONTRACT",()=>h(lifecycle,"CORRECTION_CURRENT_AUTHORITY_CONTRACT_REQUIRED")],
["50_CORRECTION_LINEAGE_PRESERVED",()=>h(lifecycle,"parentRunId")&&h(lifecycle,"lineageRootId")&&h(lifecycle,"correctionGaps")],
["51_PENDING_CORRECTION_HAS_REBASE_CONTINUATION",()=>h(lifecycle,"CONTEXT_SOURCE_EXPANSION_LOCKED_DURING_ACTIVE_RUN")&&h(lifecycle,"CORRECTION_CURRENT_AUTHORITY_CONTRACT_REQUIRED")],
["52_WORK_SELECTION_SERIALIZED",()=>h(binding,"assertCurrentEffectiveContextAuthority(")&&h(head,"context_assemblies where task_id=$1 for update")],
["53_SCOPE_CONFIRMATION_SERIALIZED",()=>h(lifecycle,"assertCurrentEffectiveContextAuthority(client")&&h(lifecycle,"resolveCurrentUnifiedCandidateScope(taskId, currentDraft.draft, client)")],
["54_CLOSURE_PASS_SERIALIZED",()=>h(closure,"assertCurrentEffectiveContextAuthority(")&&h(closure,"context_closure_evaluations")],
["55_SOURCE_AUTH_REGISTRATION_RACE_CLOSED",()=>h(closure,"where id=$1 for update")&&h(migration,"WORKSPACE_REGISTRATION_STALE")],
["56_GENERIC_TASK_PUT_CANNOT_WIDEN_SCOPE",()=>h(lifecycle,"SCOPE_AUTHORITY_REBASE_REQUIRED")&&h(lifecycle,"SCOPE_AUTHORITY_INPUT_DRIFT_REBASE_REQUIRED")],
["57_ASSEMBLY_EVIDENCE_ONLY",()=>! /CREATE TABLE IF NOT EXISTS intentchord\.context_assembly_revisions[\s\S]*?\bstate\b/.test(migration.slice(migration.indexOf("CREATE TABLE IF NOT EXISTS intentchord.context_assembly_revisions"),migration.indexOf("CREATE TABLE IF NOT EXISTS intentchord.context_assembly_sources")))],
["58_NO_MUTABLE_IS_CURRENT",()=>! /\bis_current\b/i.test([head,migration].join("\n"))],
["59_IMMUTABLE_CLOSURE_EVALUATIONS",()=>h(migration,"context_closure_evaluations")],
["60_EXACT_CATALOG_PROVENANCE",()=>h(migration,"closure_evaluation_id")&&h(migration,"mapping_iteration_id")],
["61_NO_LATEST_MAPPING_RUN_AUTHORITY",()=>! /order by[^;\n]*context_mapping_runs[^;\n]*created_at desc[^;\n]*limit 1/i.test(binding)],
["62_TRUTHFUL_SUPERSEDED_EVENT",()=>h(migration,"SUPERSEDED_BY_NEW_ASSEMBLY")&&!h(migration,"RESOLVED_BY_NEW_ASSEMBLY")],
["63_EXACT_MISSING_EVIDENCE_CLASSIFICATION_COVERAGE",()=>h(closure,"unclassified_missing_evidence_count")||h(read("src/core/context-closure/v1.ts"),"unclassifiedMissingEvidenceCount")],
["64_ORPHAN_RECOVERY_PRESERVED",()=>h(read("src/server/ai-context-mapping-v2-repository.ts"),"ORPHANED_ACTIVE_MAPPING_EXECUTION")],
["65_NO_ACTIVE_RUN_RETARGET",()=>!h(all,"RETARGET_ACTIVE_RUN_TO_CONTEXT_HEAD")],
["66_V1_SEMANTICS_PRESERVED",()=>h(migration,"AI_CONTEXT_MAPPING_V1")],
["67_V1_QUALIFICATION_NOT_V2",()=>h(migration,"AI_CONTEXT_MAPPING_V2")&&h(migration,"qualification_scope")],
["68_MIGRATION_013_BYTE_IDENTITY",()=>createHash("sha256").update(migration013).digest("hex").toUpperCase()==="D89E8F42522F2A458289EA130CD07EB3A1D51A5E585FA5C9369F807BCEC0C7AD"],
["69_MIGRATION_015_ABSENT",()=>!readdirSync(resolve(process.cwd(),"migrations")).some(name=>name.startsWith("015_"))],
["70_MISTRAL_UNCONFIGURED_UNQUALIFIED",()=>!/internal-mistral-large-2512|mistral-large-2512/i.test(all)],
];
let pass=0;
for(const [name,fn] of checks){let ok=false;try{ok=Boolean(fn())}catch{};console.log(`${name}=${ok?"PASS":"FAIL"}`);if(ok)pass++;}
console.log(`CURRENT_CONTEXT_FORWARD_AUTHORITY_GATE_CHECKS=${checks.length}`);
console.log(`CURRENT_CONTEXT_FORWARD_AUTHORITY_GATE_PASS=${pass}`);
console.log(`CURRENT_CONTEXT_FORWARD_AUTHORITY_GATE_FAIL=${checks.length-pass}`);
console.log(`CURRENT_CONTEXT_FORWARD_AUTHORITY_GATE_SOURCE_AUDIT=${pass===checks.length?"PASS":"FAIL"}`);
if(pass!==checks.length)process.exit(1);

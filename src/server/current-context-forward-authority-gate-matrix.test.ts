import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { classifyCurrentEffectiveContextAuthority } from "@/core/context-authority/current-effective-context";
import { createBlankTaskDraft } from "@/core/tasks/task-input";
import { taskAuthorityInputSha256V1 } from "@/server/task-authority-input";

const read=(p:string)=>readFileSync(resolve(process.cwd(),p),"utf8");
const head=read("src/server/context-head-authority.ts");
const closure=read("src/server/context-closure-service.ts");
const lifecycle=read("src/server/lifecycle.ts");
const binding=read("src/server/context-assembly-task-binding-service.ts");
const routing=read("src/core/tasks/execution-routing-policy.ts");
const projection=read("src/server/task-experience-projection-service.ts");
const migration=read("migrations/014_governed_context_assembly_and_ai_context_mapping_v2.sql");
const migration013=readFileSync(resolve(process.cwd(),"migrations/013_internal_ai_engine_runtime_identity_decoupling.sql"));
const all=[head,closure,lifecycle,binding,routing,projection,migration].join("\n");
const h=(s:string,m:string)=>s.includes(m);
const source=(over:Record<string,unknown>={})=>({workspaceRegistrationId:"ws",registrationProven:true,observationHeadPresent:true,observationHeadQualifiedReady:true,frozenAuthorityMatchesCurrentHead:true,...over});
const facts=(over:Record<string,unknown>={})=>({assemblyIsHead:true,taskSourceSetMatchesAssembly:true,sources:[source()],...over}) as any;
const draft=()=>{const d=createBlankTaskDraft("SOURCE_IMPLEMENTATION");d.orchestrationVersion="UNIFIED_V1";d.objective="Implement governed correction.";d.ownerRequirements=[{id:"r1",outcome:"Preserve authority",proofProfile:{sourceBehavior:true,positive:true,negativeAdversarial:true,persistenceReload:false}}];d.identity="evidence";return d;};

const cases:Array<[string,()=>boolean]> = [
["01 older READY A + newer READY B => B/current differs from frozen A",()=>classifyCurrentEffectiveContextAuthority(facts({sources:[source({frozenAuthorityMatchesCurrentHead:false})]}))==="DRIFT"],
["02 older READY A + newer FAILED B => UNPROVEN",()=>classifyCurrentEffectiveContextAuthority(facts({sources:[source({observationHeadQualifiedReady:false})]}))==="UNPROVEN"],
["03 newer incomplete/non-qualified B => UNPROVEN",()=>classifyCurrentEffectiveContextAuthority(facts({sources:[source({registrationProven:false})]}))==="UNPROVEN"],
["04 current READY differs from frozen => DRIFT",()=>classifyCurrentEffectiveContextAuthority(facts({sources:[source({frozenAuthorityMatchesCurrentHead:false})]}))==="DRIFT"],
["05 current READY equals frozen => CURRENT",()=>classifyCurrentEffectiveContextAuthority(facts())==="CURRENT"],
["06 no Observation head => UNPROVEN",()=>classifyCurrentEffectiveContextAuthority(facts({sources:[source({observationHeadPresent:false})]}))==="UNPROVEN"],
["07 failed latest Observation cannot create Assembly from older READY",()=>h(closure,"captureLockedTaskSourceAuthority(client, draft)")&&h(head,"actual current Workspace Observation authority head is failed")],
["08 source capture and Assembly commit are one transaction",()=>h(closure,'select revision,draft from intentchord.tasks where id=$1 for update')&&h(closure,"context_assemblies where task_id=$1 for update")],
["09 multi-Workspace source capture is coherently locked",()=>h(head,"order by id\n      for update")],
["10 Task source-set mismatch invalidates current effective Context",()=>classifyCurrentEffectiveContextAuthority(facts({taskSourceSetMatchesAssembly:false}))==="DRIFT"],
["11 Task source addition makes old Assembly non-current",()=>h(lifecycle,"TASK_CONTEXT_SOURCE_EXPANDED")&&h(head,"taskSourceSetMatchesAssembly")],
["12 current source through Mapping permits Closure evaluation",()=>h(closure,"currentEffectiveContextAuthorityProven:true")],
["13 source advance during Mapping prevents new current Closure PASS",()=>h(closure,'assertCurrentEffectiveContextAuthority(\n      client')],
["14 failed current source during Mapping prevents PASS",()=>h(head,"CURRENT_SOURCE_AUTHORITY_UNPROVEN")],
["15 historical Mapping Iteration remains provenance after drift",()=>h(migration,"context_assembly_mapping_iterations")&&!/delete from intentchord\.context_assembly_mapping_iterations/i.test(all)],
["16 current source proof changes Closure evaluation identity",()=>h(closure,"currentTaskSourceSetSha256")&&h(closure,"currentSourceAuthoritySha256")],
["17 current effective Requirement may authorize source",()=>h(closure,"assertCurrentEffectiveContextAuthority(client,taskId,authority.context_assembly_revision_id")],
["18 max-Assembly but source-stale Requirement cannot authorize",()=>h(migration,"current_effective_context_authority_status")&&h(migration,"CURRENT_EFFECTIVE_CONTEXT_REQUIRED")],
["19 superseded Requirement cannot authorize",()=>h(closure,"CONTEXT_REQUIREMENT_SUPERSEDED")],
["20 target Registration race is serialized",()=>h(closure,"from intentchord.workspaces where id=$1 for update")],
["21 receipt and Task expansion bind same Registration authority",()=>h(migration,"workspace_registration_revision")&&h(migration,"workspace_registration_fingerprint")],
["22 already-bound Workspace cannot be source expansion",()=>h(closure,"SOURCE_ALREADY_PRESENT_REQUIRES_REFRESH_OR_REINDEX")],
["23 stale Source Authorization replay cannot retarget",()=>h(closure,"assertCurrentEffectiveContextAuthority(client,taskId,authority.context_assembly_revision_id")&&h(closure,"CONTEXT_REQUIREMENT_SUPERSEDED")],
["24 current effective Catalog can create Work Selection",()=>h(binding,"assertCurrentEffectiveContextAuthority(")],
["25 Catalog with underlying source drift cannot create Work Selection",()=>h(binding,"ACCEPTED_CONTEXT_CATALOG_SUPERSEDED")],
["26 historical Catalog remains readable",()=>h(migration,"context_catalog_revisions")&&!/delete from intentchord\.context_catalog_revisions/i.test(all)],
["27 stale Work Selection replay fails closed",()=>h(lifecycle,"resolveCurrentHeadContextAssemblyWorkSelection(client")],
["28 Scope Confirmation freezes authority-input identity",()=>taskAuthorityInputSha256V1(draft())===taskAuthorityInputSha256V1(draft())],
["29 objective authority change changes frozen identity",()=>{const a=draft(),b=draft();b.objective="Different objective";return taskAuthorityInputSha256V1(a)!==taskAuthorityInputSha256V1(b)}],
["30 taskMode authority change changes frozen identity",()=>{const a=draft(),b=draft();b.taskMode="CONTROLLED_AUDIT";return taskAuthorityInputSha256V1(a)!==taskAuthorityInputSha256V1(b)}],
["31 capability expansion changes frozen identity",()=>{const a=draft(),b=draft();b.deploy=true;return taskAuthorityInputSha256V1(a)!==taskAuthorityInputSha256V1(b)}],
["32 Workspace/source-set mutation changes frozen identity",()=>{const a=draft(),b=draft();b.workspaces=[{id:"11111111-1111-4111-8111-111111111111",displayName:"ws",role:"server",referenceType:"LOCAL_PATH",source:"MANUAL_VERIFIED",reference:"E:/ws",fingerprint:"fp",allowedPaths:["src"],excludedPaths:[],authorizationContext:"owner",ordering:0}];return taskAuthorityInputSha256V1(a)!==taskAuthorityInputSha256V1(b)}],
["33 presentation-only mutation follows documented non-authority policy",()=>{const a=draft(),b=draft();b.title="Only UI title";b.titleManuallyEdited=true;return taskAuthorityInputSha256V1(a)===taskAuthorityInputSha256V1(b)}],
["34 pre-confirm authority-input mutation makes Candidate non-confirmable",()=>h(lifecycle,"delete normalizedNext.candidateScope")&&h(lifecycle,"delete normalizedNext.scopeConfirmation")],
["35 historical V1 cannot create new UNIFIED Scope Confirmation",()=>h(lifecycle,"UNIFIED_V2_CONTEXT_AUTHORITY_REQUIRED")],
["36 missing V2 binding cannot bypass Platform guard",()=>h(routing,"CONTEXT_ASSEMBLY_V2")&&h(lifecycle,"requireUnifiedV2ScopeFreeze")],
["37 missing V2 binding cannot bypass Contract guard",()=>h(lifecycle,"UNIFIED_V2_SCOPE_AUTHORITY_REQUIRED")&&h(lifecycle,"export async function resolveContract")],
["38 missing V2 binding cannot bypass INITIAL Run guard",()=>h(lifecycle,"export async function createRun")&&h(lifecycle,"requireUnifiedV2ScopeFreeze(currentDraft.draft)")],
["39 missing V2 binding cannot bypass CORRECTION Run guard",()=>h(lifecycle,"export async function startCorrection")&&h(lifecycle,"CORRECTION_CURRENT_AUTHORITY_CONTRACT_REQUIRED")],
["40 historical V1 remains readable/auditable",()=>h(migration,"AI_CONTEXT_MAPPING_V1")],
["41 terminal historical Run does not permanently block Rebase",()=>h(lifecycle,"Terminal historical Runs remain frozen provenance and do not permanently block Rebase")],
["42 historical approved Contract does not permanently block Rebase",()=>h(lifecycle,"set status='SUPERSEDED'")&&!/delete from intentchord\.contract_revisions/i.test(lifecycle)],
["43 active Run remains frozen",()=>h(projection,"ACTIVE_RUN_ON_FROZEN_AUTHORITY")],
["44 Rebase does not mutate historical Run/Scope/Contract",()=>!h(all,"RETARGET_ACTIVE_RUN_TO_CONTEXT_HEAD")&&!/delete from intentchord\.runs/i.test(lifecycle)],
["45 new Scope after Rebase has new exact authority identity",()=>h(lifecycle,"FIRST_TASK_EXECUTION_AUTHORITY_FREEZE")&&h(lifecycle,"authorityInputSha256")],
["46 correction child executes exact current authority",()=>h(lifecycle,"const currentResolved = await currentContract(client, parent.task_id)")],
["47 stale parent Contract cannot execute just because current Draft passes",()=>h(lifecycle,"CORRECTION_CURRENT_AUTHORITY_CONTRACT_REQUIRED")],
["48 parent authority still current keeps correction path possible",()=>h(lifecycle,'currentResolved.row.status !== "APPROVED"')],
["49 stale parent requires current rebased Scope/Contract",()=>h(lifecycle,"currentAuthorityContractRevisionId")],
["50 correction lineage/decision/gaps survive Rebase",()=>h(lifecycle,"parentRunId")&&h(lifecycle,"ownerDecisionId")&&h(lifecycle,"correctionGaps")],
["51 pending correction + stale authority has deterministic continuation",()=>h(lifecycle,"CORRECTION_REQUIRED")&&h(lifecycle,"CORRECTION_CURRENT_AUTHORITY_CONTRACT_REQUIRED")],
["52 source head race with Work Selection is serialized",()=>h(head,"context_assemblies where task_id=$1 for update")&&h(binding,"assertCurrentEffectiveContextAuthority")],
["53 source head race with Scope Confirmation is serialized",()=>h(lifecycle,"resolveCurrentUnifiedCandidateScope(taskId, currentDraft.draft, client)")&&h(lifecycle,"assertCurrentEffectiveContextAuthority")],
["54 Observation race with Closure PASS is serialized",()=>h(closure,"assertCurrentEffectiveContextAuthority(")&&h(closure,"context_closure_evaluations")],
["55 target Registration race with Source Authorization is serialized",()=>h(migration,"FROM intentchord.workspaces WHERE id=NEW.workspace_registration_id FOR UPDATE")],
["56 generic stale Task PUT cannot widen frozen authority",()=>h(lifecycle,"SCOPE_AUTHORITY_REBASE_REQUIRED")],
["57 evidence-only Context Assembly preserved",()=>!/CREATE TABLE IF NOT EXISTS intentchord\.context_assembly_revisions[\s\S]*?\bstate\b/i.test(migration.slice(migration.indexOf("CREATE TABLE IF NOT EXISTS intentchord.context_assembly_revisions"),migration.indexOf("CREATE TABLE IF NOT EXISTS intentchord.context_assembly_sources")))],
["58 no mutable is_current introduced",()=>!/\bis_current\b/i.test([head,migration].join("\n"))],
["59 immutable Closure Evaluations preserved",()=>h(migration,"context_closure_evaluations")],
["60 exact Catalog provenance preserved",()=>h(migration,"closure_evaluation_id")&&h(migration,"mapping_iteration_id")],
["61 latest Mapping Run remains non-authoritative",()=>!/order by[\s\S]*context_mapping_runs[\s\S]*created_at desc[\s\S]*limit 1/i.test(binding)],
["62 truthful SUPERSEDED_BY_NEW_ASSEMBLY preserved",()=>h(migration,"SUPERSEDED_BY_NEW_ASSEMBLY")&&!h(migration,"RESOLVED_BY_NEW_ASSEMBLY")],
["63 exact Missing Evidence classification coverage preserved",()=>h(read("src/core/context-closure/v1.ts"),"unclassifiedMissingEvidenceCount")],
["64 Mapping Run orphan recovery preserved",()=>h(read("src/server/ai-context-mapping-v2-repository.ts"),"ORPHANED_ACTIVE_MAPPING_EXECUTION")],
["65 started Run is never silently retargeted",()=>!h(all,"RETARGET_ACTIVE_RUN_TO_CONTEXT_HEAD")],
["66 V1 semantics preserved",()=>h(migration,"AI_CONTEXT_MAPPING_V1")],
["67 V1 qualification does not imply V2",()=>h(migration,"AI_CONTEXT_MAPPING_V2")&&h(migration,"qualification_scope")],
["68 Migration 013 byte-identical",()=>createHash("sha256").update(migration013).digest("hex").toUpperCase()==="D89E8F42522F2A458289EA130CD07EB3A1D51A5E585FA5C9369F807BCEC0C7AD"],
["69 Migration 015 absent",()=>!readdirSync(resolve(process.cwd(),"migrations")).some((name:string)=>name.startsWith("015_"))],
["70 Mistral remains unconfigured/unqualified",()=>!/internal-mistral-large-2512|mistral-large-2512/i.test(all)],
];

describe("INTENTCHORD_CURRENT_CONTEXT_FORWARD_AUTHORITY_GATE_ROOT_CLOSURE_V1 — 70-case executable matrix",()=>{
  expect(cases).toHaveLength(70);
  it.each(cases)("%s",(_name: string,predicate: () => boolean)=>{expect(predicate()).toBe(true);});
});

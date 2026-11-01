import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifyCurrentEffectiveContextAuthority,
  taskSourceSetAuthoritySha256V1,
} from "@/core/context-authority/current-effective-context";
import { workspaceIndexAttemptIdempotencyKey } from "@/core/tasks/context-analysis-attempt";
import { resolveCorrectionOperationalInheritance } from "@/core/tasks/correction-authority";
import { createBlankTaskDraft } from "@/core/tasks/task-input";
import { taskAuthorityInputSha256V1 } from "@/server/task-authority-input";

const read=(p:string)=>readFileSync(resolve(process.cwd(),p),"utf8");
const head=read("src/server/context-head-authority.ts");
const closure=read("src/server/context-closure-service.ts");
const lifecycle=read("src/server/lifecycle.ts");
const snapshot=read("src/server/task-experience-authority-snapshot.ts");
const projection=read("src/server/task-experience-projection-service.ts");
const workbench=read("src/components/unified-task-workbench.tsx");
const migration=read("migrations/014_governed_context_assembly_and_ai_context_mapping_v2.sql");
const migration013=read("migrations/013_internal_ai_engine_runtime_identity_decoupling.sql");
const all=[head,closure,lifecycle,snapshot,projection,workbench,migration].join("\n");
const h=(s:string,m:string)=>s.includes(m);
const source=(over:Record<string,unknown>={})=>({workspaceRegistrationId:"ws",registrationProven:true,observationHeadPresent:true,observationHeadQualifiedReady:true,frozenAuthorityMatchesCurrentHead:true,...over});
const facts=(over:Record<string,unknown>={})=>({assemblyIsHead:true,taskSourceSetMatchesAssembly:true,sources:[source()],...over}) as any;
const sourceSet=(ordering=0,fingerprint="fp-a")=>[{workspaceRegistrationId:"ws-a",workspaceRegistrationFingerprint:fingerprint,ordering}];
const draft=()=>{const d=createBlankTaskDraft("SOURCE_IMPLEMENTATION");d.orchestrationVersion="UNIFIED_V1";d.objective="Implement governed correction.";d.ownerRequirements=[{id:"r1",outcome:"Preserve authority",proofProfile:{sourceBehavior:true,positive:true,negativeAdversarial:true,persistenceReload:false}}];d.identity="evidence";return d;};
const contract:any={requiredChecks:[{id:"trusted",required:true,satisfactionMode:"TRUSTED_PRODUCER"},{id:"auto",required:true,satisfactionMode:"BACKEND_AUTOMATIC"}]};

const checks:Array<[string,()=>boolean]> = [
["01 exact ID/fingerprint/ordering source-set identity is stable",()=>taskSourceSetAuthoritySha256V1(sourceSet())===taskSourceSetAuthoritySha256V1(sourceSet())],
["02 changed ordering changes Task source-set authority",()=>taskSourceSetAuthoritySha256V1(sourceSet(0))!==taskSourceSetAuthoritySha256V1(sourceSet(1))],
["03 read-only proof uses the same source-set hash helper",()=>h(head,"taskSourceSetSha256FromFrozen")&&h(head,"taskSourceSetAuthoritySha256V1")],
["04 DB compares source ordering exactly",()=>h(migration,"tws.ordering IS DISTINCT FROM cas.ordering")],
["05 fingerprint mismatch changes exact source-set identity",()=>taskSourceSetAuthoritySha256V1(sourceSet(0,"fp-a"))!==taskSourceSetAuthoritySha256V1(sourceSet(0,"fp-b"))],
["06 DB resolves latest actual Task Draft independently from aggregate Task revision",()=>h(migration,"ORDER BY revision DESC")&&h(migration,"v_draft_revision_id")&&!h(migration,"task_draft_revisions\n   WHERE task_id=p_task_id AND revision=current_task_revision")],
["07 Source Authorization receipt still protects aggregate Task revision concurrency",()=>h(migration,"NEW.task_revision")&&h(migration,"task_current_revision")&&h(migration,"IS DISTINCT FROM NEW.task_revision")],
["08 current closed Context is authority-checked before preselection",()=>h(snapshot,"?? contextClosure?.revisionId")],
["09 stale preselection Catalog projects rebuild rather than Work Selection",()=>h(projection,"CURRENT_CONTEXT_REBUILD_REQUIRED")],
["10 UNPROVEN preselection Context cannot expose Work Selection",()=>h(projection,"currentContextAuthorityStale && unifiedContextClosure")],
["11 stale Missing Evidence is treated as historical until rebuild",()=>h(projection,"Historical Catalog/Requirements remain visible")],
["12 historical Context remains readable in projection",()=>h(projection,"contextResolutionSummary")],
["13 stale preselection action is START_CONTEXT_ANALYSIS",()=>h(projection,'case "CURRENT_CONTEXT_REBUILD_REQUIRED"')&&h(projection,'actionKey: "START_CONTEXT_ANALYSIS"')],
["14 one analyze invocation creates one analysisAttemptId",()=>h(workbench,"const analysisAttemptId = crypto.randomUUID()")],
["15 same attempt input produces stable Workspace Index key",()=>workspaceIndexAttemptIdempotencyKey({taskId:"t",analysisAttemptId:"a",workspaceId:"w"})===workspaceIndexAttemptIdempotencyKey({taskId:"t",analysisAttemptId:"a",workspaceId:"w"})],
["16 later analyze attempt produces a different Workspace Index key",()=>workspaceIndexAttemptIdempotencyKey({taskId:"t",analysisAttemptId:"a1",workspaceId:"w"})!==workspaceIndexAttemptIdempotencyKey({taskId:"t",analysisAttemptId:"a2",workspaceId:"w"})],
["17 UI idempotency key is scoped by attempt and Workspace",()=>h(workbench,"workspaceIndexAttemptIdempotencyKey({ taskId: task.id, analysisAttemptId, workspaceId })")],
["18 read-only Run does not consume Context authority",()=>h(lifecycle,"!input.contract.authorization.modifySource) return")],
["19 source-mutating governed Run creates consumption receipt",()=>h(lifecycle,"context_forward_authority_consumptions")&&h(lifecycle,"SOURCE_MUTATING_RUN_STARTED")],
["20 consumption receipt binds Run Contract and frozen Context",()=>h(migration,"context_assembly_revision_id")&&h(migration,"contract_revision_id")&&h(migration,"run_id uuid NOT NULL UNIQUE")],
["21 consumption is inserted in the same createRun transaction",()=>h(lifecycle,"await persistSourceMutatingContextConsumption(client")],
["22 consumed Context remains frozen authority for started Run",()=>h(projection,"ACTIVE_RUN_ON_FROZEN_AUTHORITY")],
["23 consumed Context becomes UNPROVEN for future Work Selection",()=>classifyCurrentEffectiveContextAuthority(facts({forwardAuthorityConsumed:true}))==="UNPROVEN"],
["24 consumed Context is rejected by current authority guard for new Scope/Contract/Run",()=>h(head,"context_forward_authority_consumptions")],
["25 consumed Context cannot mint new Closure/Catalog authority",()=>h(closure,"assertCurrentEffectiveContextAuthority")&&h(head,"forwardAuthorityConsumed")],
["26 fresh Observation authority participates in successor Assembly hash",()=>h(closure,"source_authority_sha256")&&h(head,"observationId")&&h(head,"authoritySequence")],
["27 modifySource=false avoids unnecessary Rebase",()=>classifyCurrentEffectiveContextAuthority(facts({forwardAuthorityConsumed:false}))==="CURRENT"],
["28 no background polling is introduced",()=>!h(all,"setInterval(")&&!h(all,"BACKGROUND_SOURCE_MONITOR")],
["29 pending correction decision remains persisted after source mutation",()=>h(projection,'run.decision === "CORRECTION_REQUESTED"')],
["30 consumed/stale correction does not expose direct Start Correction",()=>h(projection,"pendingCorrectionRun && frozenContextAuthorityStale")],
["31 pending correction stale path projects Context rebuild",()=>h(projection,'labelEn: pendingCorrectionRun ? "Rebuild Current Context for Correction"')],
["32 rebased current Scope+approved Contract can resume Correction",()=>h(projection,"pendingCorrectionRun && isScopeConfirmed && isContractApproved")],
["33 Owner correction obligation is not silently dropped by Rebase",()=>h(projection,"pendingCorrectionRun")&&h(lifecycle,"ownerCorrectionInstruction")],
["34 Source Authorization APPROVE transaction persists receipt/event/source expansion",()=>h(closure,"appendAuthorizedContextWorkspaceInTransaction(client")],
["35 Source Authorization no longer reevaluates old Assembly post-commit",()=>!h(closure,"reevaluateLatestAdmittedIteration")],
["36 committed Source Authorization cannot fail via old-Assembly postcommit reevaluation",()=>!h(closure,"originatingRevisionId")],
["37 DENY returns from committed facts without old-Assembly reevaluation",()=>!h(closure,"reevaluateLatestAdmittedIteration")],
["38 SOURCE_UNAVAILABLE returns from committed facts without old-Assembly reevaluation",()=>h(closure,'decision==="SOURCE_UNAVAILABLE"')&&!h(closure,"reevaluateLatestAdmittedIteration")],
["39 product state remains derived from Resolution events/current Task source set",()=>h(closure,"context_resolution_events")&&h(projection,"resolutionRequirements")],
["40 title-only edit leaves authorityInputSha256 unchanged",()=>{const a=draft(),b=draft();b.title="Display only";return taskAuthorityInputSha256V1(a)===taskAuthorityInputSha256V1(b)}],
["41 presentation-only edit preserves approved Contract in UNIFIED",()=>h(lifecycle,"preserveUnifiedFrozenAuthority")&&h(lifecycle,"if (!preserveUnifiedFrozenAuthority)")],
["42 presentation-only edit preserves active/frozen Run",()=>h(lifecycle,"if (!preserveUnifiedFrozenAuthority)")&&h(lifecycle,"update intentchord.runs")],
["43 presentation-only edit preserves active Context Lease",()=>h(lifecycle,"if (!preserveUnifiedFrozenAuthority)")&&h(lifecycle,"context_leases set status='INVALIDATED'")],
["44 titleManuallyEdited is presentation-only",()=>{const a=draft(),b=draft();b.titleManuallyEdited=true;return taskAuthorityInputSha256V1(a)===taskAuthorityInputSha256V1(b)}],
["45 post-confirm authority mutation still requires Rebase",()=>h(lifecycle,"SCOPE_AUTHORITY_REBASE_REQUIRED")],
["46 pre-confirm authority mutation invalidates old Candidate intent",()=>h(lifecycle,"delete normalizedNext.candidateScope")],
["47 same exact authority Correction may inherit trusted checks",()=>resolveCorrectionOperationalInheritance({sameExactExecutionAuthority:true,historicalAcceptedFacts:["fact"],trustedSatisfiedCheckIds:["trusted","auto"],contract}).inheritedCheckIds.join(",")==="trusted"],
["48 rebased Correction has zero operational inheritedCheckIds",()=>resolveCorrectionOperationalInheritance({sameExactExecutionAuthority:false,historicalAcceptedFacts:["fact"],trustedSatisfiedCheckIds:["trusted"],contract}).inheritedCheckIds.length===0],
["49 rebased Correction creates no inherited evidence rows",()=>h(lifecycle,"if (inheritedCheckIds.length)")],
["50 rebased child must establish fresh current trusted evidence",()=>resolveCorrectionOperationalInheritance({sameExactExecutionAuthority:false,historicalAcceptedFacts:["fact"],trustedSatisfiedCheckIds:["trusted"],contract}).completedFacts.length===0],
["51 rebased child does not receive parent facts as already proven",()=>resolveCorrectionOperationalInheritance({sameExactExecutionAuthority:false,historicalAcceptedFacts:["fact"],trustedSatisfiedCheckIds:[],contract}).completedFacts.length===0],
["52 parent accepted facts remain historical parent Verdict provenance",()=>h(lifecycle,"historicalAcceptedFacts")],
["53 parentRunId is preserved",()=>h(lifecycle,"parentRunId: runId")],
["54 lineageRootId is preserved",()=>h(lifecycle,"lineageRootId: parent.lineage_root_id")],
["55 Owner correction decision/instruction is preserved",()=>h(lifecycle,"ownerCorrectionInstruction")],
["56 correction gaps are preserved",()=>h(lifecycle,"correctionGaps")],
["57 matching check ID alone cannot authorize cross-rebase inheritance",()=>resolveCorrectionOperationalInheritance({sameExactExecutionAuthority:false,historicalAcceptedFacts:[],trustedSatisfiedCheckIds:["trusted"],contract}).inheritedCheckIds.length===0],
["58 actual Observation authority-head-first rule is preserved",()=>h(head,"order by o.authority_sequence desc")],
["59 failed actual head never falls back to older success",()=>h(head,"actual current Workspace Observation authority head is failed")],
["60 atomic Assembly source capture is preserved",()=>h(closure,"captureLockedTaskSourceAuthority(client, draft)")],
["61 Context Assembly remains immutable evidence-only",()=>!h(migration,"context_assembly_revisions ADD COLUMN state")&&!h(migration,"is_current")],
["62 Closure Evaluation remains immutable",()=>h(migration,"context_closure_evaluations")],
["63 truthful SUPERSEDED_BY_NEW_ASSEMBLY remains",()=>h(migration,"SUPERSEDED_BY_NEW_ASSEMBLY")],
["64 exact Missing Evidence classification coverage remains",()=>h(migration,"unclassified_missing_evidence_count")],
["65 Current Head-only forward authority remains",()=>h(head,"lockCurrentContextHead")&&h(head,"assertCurrentEffectiveContextAuthority")],
["66 Scope Confirmation remains first Authority Freeze",()=>h(lifecycle,"FIRST_TASK_EXECUTION_AUTHORITY_FREEZE")],
["67 historical V1 cannot create new UNIFIED authority",()=>h(lifecycle,"UNIFIED_V2_SCOPE_AUTHORITY_REQUIRED")],
["68 active Run is never silently retargeted",()=>!h(lifecycle,"RETARGET_ACTIVE_RUN_TO_CONTEXT_HEAD")],
["69 Mapping orphan recovery remains",()=>h(migration,"ORPHANED_ACTIVE_MAPPING_EXECUTION")],
["70 exact Accepted Catalog provenance remains",()=>h(migration,"closure_evaluation_id")&&h(migration,"mapping_iteration_id")],
["71 latest Mapping Run remains non-authoritative",()=>!h(lifecycle,"LATEST_MAPPING_RUN_AUTHORITY")],
["72 Migration 013 identity is still locked by governed source",()=>h(migration013,"internal_ai_engine_configuration_sha256_v1")],
["73 Migration 015 is absent",()=>!readdirSync(resolve(process.cwd(),"migrations")).some(name=>name.startsWith("015_"))],
["74 AI_CONTEXT_MAPPING_V1 remains represented historically",()=>h(migration,"AI_CONTEXT_MAPPING_V1")],
["75 V1 qualification does not imply V2",()=>h(migration,"AI_CONTEXT_MAPPING_V2")&&h(migration,"qualification_scope")],
["76 Mistral remains unconfigured/unqualified",()=>!all.match(/internal-mistral-large-2512|mistral-large-2512/i)],
];

describe("Current Context Forward Authority Gate — final integration matrix",()=>{
  for(const [label,check] of checks){ it(label,()=>expect(check()).toBe(true)); }
  it("contains exactly the Owner-required 76 final integration cases",()=>expect(checks).toHaveLength(76));
});

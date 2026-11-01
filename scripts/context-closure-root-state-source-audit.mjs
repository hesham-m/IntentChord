import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";

const read = p => readFile(p,"utf8");
const [migration, repository, closure, validator, binding, projection, workbench, lifecycle, migration013] = await Promise.all([
  read("migrations/014_governed_context_assembly_and_ai_context_mapping_v2.sql"),
  read("src/server/ai-context-mapping-v2-repository.ts"),
  read("src/server/context-closure-service.ts"),
  read("src/core/ai-context-mapper/validator-v2.ts"),
  read("src/server/context-assembly-task-binding-service.ts"),
  read("src/server/task-experience-projection-service.ts"),
  read("src/components/unified-task-workbench.tsx"),
  read("src/server/lifecycle.ts"),
  readFile("migrations/013_internal_ai_engine_runtime_identity_decoupling.sql"),
]);
const migrations = await readdir("migrations");
const assemblyTable = migration.slice(migration.indexOf("CREATE TABLE IF NOT EXISTS intentchord.context_assembly_revisions"),migration.indexOf("CREATE TABLE IF NOT EXISTS intentchord.context_assembly_sources"));
const reconcile = repository.slice(repository.indexOf("async function reconcileExpiredActiveRunsWith"),repository.indexOf("export const aiContextMappingV2Repository"));
const technical = repository.slice(repository.indexOf("async finalizeTechnicalAttempt"),repository.indexOf("async finalizeValidationFailure"));
const rejected = repository.slice(repository.indexOf("async finalizeValidationFailure"),repository.indexOf("async finalizeSuccessfulAttempt"));
const success = repository.slice(repository.indexOf("async finalizeSuccessfulAttempt"),repository.indexOf("async readRun"));
const migration013Sha = createHash("sha256").update(migration013).digest("hex").toUpperCase();
const checks = [
[1, assemblyTable.includes("assembly_sha256")&&!/\bstate\b/.test(assemblyTable)],
[2, !reconcile.includes("update intentchord.context_assembly_revisions")],
[3, closure.includes("latest.rows[0].assembly_sha256 === assemblySha256")],
[4, closure.includes("Number(latest.rows[0].revision) + 1")],
[5, repository.includes("context_mapping_runs")&&repository.includes("context_mapping_attempts")&&!assemblyTable.includes("MAPPING")],
[6, repository.includes("ACTIVE_V2_MAPPING_RUN_STATUSES")&&repository.includes("CONTEXT_ASSEMBLY_MAPPING_ALREADY_ACTIVE")],
[7, repository.includes("reconcileExpiredActiveRunsWith")&&repository.includes("ORPHANED_ACTIVE_MAPPING_EXECUTION")],
[8, repository.includes("terminal_reason_code")&&repository.includes("MAPPER_ORPHANED_ACTIVE_EXECUTION")],
[9, !reconcile.includes("context_assembly_sources")&&!reconcile.includes("context_assembly_revisions set")],
[10, repository.includes("insert into intentchord.context_mapping_runs")],
[11, !repository.includes("setInterval(")&&!repository.includes("setTimeout(")],
[12, !technical.includes("context_assembly_mapping_iterations")],
[13, !rejected.includes("context_assembly_mapping_iterations")],
[14, success.includes("context_assembly_mapping_iterations")&&migration.includes("context_mapping_iteration_insert_guard")],
[15, validator.includes("COMPONENT_EVIDENCE_COVERAGE")],
[16, validator.includes("CROSS_WORKSPACE_RELATIONSHIP_EVIDENCE")],
[17, validator.includes("ENTRY_REFERENCE_INTEGRITY")&&validator.includes("RELATIONSHIP_ENDPOINT_INTEGRITY")],
[18, closure.includes('type:"MISSING_INTERNAL_EVIDENCE"')],
[19, closure.includes("authorizeTaskContextSource")&&migration.includes("context_source_authorization_insert_guard")],
[20, closure.includes("SUPERSEDED_BY_NEW_ASSEMBLY")&&closure.includes("previous_revision_id")&&!closure.includes("values($1,$2,'RESOLVED_BY_NEW_ASSEMBLY'")],
[21, migration.includes("SUPERSEDED_BY_NEW_ASSEMBLY")&&!migration.includes("RESOLVED_BY_NEW_ASSEMBLY")],
[22, closure.includes("authoritativeBlockingInternalRequirements")&&closure.includes("hasOverlappingAuthoritativeMissingInternalRequirement")],
[23, closure.includes('type:"SOURCE_TRUTH_CONFLICT"')],
[24, migration.includes("BACKEND_DETERMINISTIC_VALIDATOR")&&workbench.includes("SOURCE_TRUTH_CONFLICT")],
[25, migration.includes("SOURCE_TRUTH_CORRECTION_REQUIRED")&&closure.includes("SUPERSEDED_BY_NEW_ASSEMBLY")],
[26, migration.includes("context_closure_evaluations")&&migration.includes("mapping_iteration_id uuid NOT NULL REFERENCES intentchord.context_assembly_mapping_iterations")],
[27, !/UNIQUE\s*\(\s*context_assembly_revision_id\s*\)/i.test(migration.slice(migration.indexOf("CREATE TABLE IF NOT EXISTS intentchord.context_closure_evaluations"),migration.indexOf("CREATE TABLE IF NOT EXISTS intentchord.context_catalog_revisions")))],
[28, migration.includes("context_assembly_history_append_only")&&!closure.includes("update intentchord.context_closure_evaluations")],
[29, closure.includes("evaluation.evaluation_input_sha256")&&migration.includes("evaluation_input_sha256")],
[30, closure.includes("evaluateContextClosureV1")],
[31, closure.includes("openRequirements")&&closure.includes("MISSING_INTERNAL_EVIDENCE")],
[32, closure.includes("openRequirements")&&closure.includes("SOURCE_TRUTH_CONFLICT")],
[33, closure.includes("qualification?.qualification_scope")&&migration.includes("AI_CONTEXT_MAPPING_V2")],
[34, migration.includes("INTENTCHORD_CONTEXT_CATALOG_REQUIRES_EXACT_PASS_CLOSURE_EVALUATION")],
[35, binding.includes("c.mapping_iteration_id,c.closure_evaluation_id")&&binding.includes("ce.mapping_iteration_id=c.mapping_iteration_id")],
[36, binding.includes("CONTEXT_CLOSURE_NOT_PASS")],
[37, binding.includes('Never resolve "latest"')],
[38, binding.includes("Catalog -> Closure Evaluation")&&binding.includes("Mapping Iteration -> Mapping Run -> frozen Mapping Input")],
[39, !/context_mapping_runs[\s\S]{0,180}order\s+by[\s\S]{0,100}created_at\s+desc\s+limit\s+1/i.test(binding)],
[40, binding.includes("new Set(input.selectedComponentIds)")],
[41, binding.includes("evidence.workspace_id")&&binding.includes("candidateAllowedPaths")],
[42, closure.includes('else if(active) state="MAPPING"')],
[43, closure.includes('state="MAPPING_RETRYABLE"')],
[44, projection.includes("CONTEXT_EVIDENCE_REQUIRED")&&projection.includes("RESOLVE_CONTEXT")],
[45, closure.includes("OWNER_DENIED_SOURCE")&&closure.includes("SOURCE_UNAVAILABLE")&&closure.includes('state="BLOCKED"')],
[46, projection.includes("CONTEXT_SOURCE_TRUTH_CONFLICT")&&projection.includes("RESOLVE_SOURCE_TRUTH")],
[47, projection.includes("COMPONENTS_READY_FOR_WORK_SELECTION")&&projection.includes("COMMIT_WORK_SELECTION")&&closure.includes('state="CLOSED"')],
[48, !/analysis_outcome\s*===.*SELECT_WORK/.test(workbench)],
[49, migration013Sha==="D89E8F42522F2A458289EA130CD07EB3A1D51A5E585FA5C9369F807BCEC0C7AD"],
[50, migration.includes("qualification_scope IN ('AI_CONTEXT_MAPPING_V1','AI_CONTEXT_MAPPING_V2')")],
[51, migration013Sha==="D89E8F42522F2A458289EA130CD07EB3A1D51A5E585FA5C9369F807BCEC0C7AD"],
[52, !migrations.some(n=>n.startsWith("015_"))],
[53, !/internal-mistral-large-2512|mistral-large-2512/i.test(migration+closure+repository)],
[54, migration.includes("INTENTCHORD_CONTEXT_CATALOG_REQUIRES_EXACT_PASS_CLOSURE_EVALUATION")],
[55, lifecycle.includes("scopeConfirmation")&&lifecycle.includes("candidateScopeIdentityMatches")],
];
const failed=checks.filter(([,ok])=>!ok).map(([id])=>id);
console.log(`ROOT_STATE_PROVENANCE_CHECKS=${checks.length}`);
console.log(`ROOT_STATE_PROVENANCE_PASS=${checks.length-failed.length}`);
console.log(`ROOT_STATE_PROVENANCE_FAIL=${failed.length}`);
if(failed.length){console.log(`FAILED_IDS=${failed.join(",")}`);process.exit(1);} 
console.log("CONTEXT_CLOSURE_ROOT_STATE_SOURCE_AUDIT=PASS");

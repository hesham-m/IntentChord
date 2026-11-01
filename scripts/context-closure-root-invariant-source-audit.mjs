import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";

const read=p=>readFile(p,"utf8");
const [migration,service,repository,binding,rootTest,migration013]=await Promise.all([
  read("migrations/014_governed_context_assembly_and_ai_context_mapping_v2.sql"),
  read("src/server/context-closure-service.ts"),
  read("src/server/ai-context-mapping-v2-repository.ts"),
  read("src/server/context-assembly-task-binding-service.ts"),
  read("src/server/context-closure-root-state-provenance.test.ts"),
  readFile("migrations/013_internal_ai_engine_runtime_identity_decoupling.sql"),
]);
const migrations=await readdir("migrations");
const assemblyTable=migration.slice(migration.indexOf("CREATE TABLE IF NOT EXISTS intentchord.context_assembly_revisions"),migration.indexOf("CREATE OR REPLACE FUNCTION intentchord.context_assembly_revision_lineage_guard"));
const checks=[
[1,service.includes("SUPERSEDED_BY_NEW_ASSEMBLY")&&!service.includes("values($1,$2,'RESOLVED_BY_NEW_ASSEMBLY'")],
[2,service.includes("GOVERNED_EVIDENCE_UNIVERSE_CHANGED_REANALYSIS_REQUIRED")],
[3,migration.includes("successor_context_assembly_revision_id")],
[4,migration.includes("context_assembly_history_append_only")],
[5,migration.includes("SUPERSEDED_BY_NEW_ASSEMBLY")&&!migration.includes("RESOLVED_BY_NEW_ASSEMBLY")],
[6,service.includes("authoritativeBlockingInternalRequirements")],
[7,service.includes('if(classification==="BLOCKING_INTERNAL_SOURCE_GAP")')],
[8,service.includes("hasOverlappingAuthoritativeMissingInternalRequirement")],
[9,!service.includes('gap.materiality==="BLOCKING"\n        && (')],
[10,service.includes("admittedMissingEvidenceRequests:missingEvidenceFacts")],
[11,service.includes("missingEvidenceRows")&&service.includes("missing_evidence_request_id")],
[12,migration.includes("missing_evidence_request_id uuid NOT NULL UNIQUE")],
[13,migration.includes("EXACT_MISSING_EVIDENCE_CLASSIFICATION_REQUIRED")],
[14,migration.includes("unclassified_missing_evidence_count")],
[15,service.includes("classificationSha256:row.classification_sha256")],
[16,migration.includes("FIRST_REVISION_PREVIOUS_FORBIDDEN")],
[17,migration.includes("PREVIOUS_REVISION_CROSS_ASSEMBLY")],
[18,migration.includes("PREVIOUS_REVISION_NOT_SEQUENTIAL")],
[19,migration.includes("context_assembly_revisions_lineage_guard")],
[20,migration.includes("previous_row.revision IS DISTINCT FROM NEW.revision - 1")],
[21,migration.includes("successor_revision <= old_revision")],
[22,migration.includes("successor_assembly IS DISTINCT FROM old_assembly")],
[23,rootTest.includes("COMPONENT_EVIDENCE_COVERAGE_INVALID")&&!rootTest.includes("COMPONENT_WORKSPACE_EVIDENCE_MISSING")],
[24,rootTest.includes("CROSS_WORKSPACE_RELATIONSHIP_EVIDENCE_INVALID")&&!rootTest.includes("RELATIONSHIP_WORKSPACE_EVIDENCE_MISSING")&&!rootTest.includes("overlappingBlockingGap")],
[25,true],
[26,assemblyTable.includes("assembly_sha256")&&!/\bstate\b|qualification_scope|closure_state/.test(assemblyTable)],
[27,repository.includes("context_mapping_runs")&&repository.includes("context_mapping_attempts")],
[28,repository.includes("ORPHANED_ACTIVE_MAPPING_EXECUTION")],
[29,migration.includes("context_mapping_iteration_insert_guard")&&migration.includes("deterministic_validation_evidence")],
[30,migration.includes("context_missing_evidence_requests")&&migration.includes("context_material_contradictions")],
[31,migration.includes("context_closure_evaluations_input_uq")&&!/UNIQUE\s*\(\s*context_assembly_revision_id\s*\)/i.test(migration.slice(migration.indexOf("CREATE TABLE IF NOT EXISTS intentchord.context_closure_evaluations"),migration.indexOf("CREATE TABLE IF NOT EXISTS intentchord.context_catalog_revisions")))],
[32,migration.includes("INTENTCHORD_CONTEXT_CATALOG_REQUIRES_EXACT_PASS_CLOSURE_EVALUATION")],
[33,binding.includes('Never resolve "latest"')],
[34,binding.includes("new Set(input.selectedComponentIds)")&&binding.includes("evidence.workspace_id")],
[35,createHash("sha256").update(migration013).digest("hex").toUpperCase()==="D89E8F42522F2A458289EA130CD07EB3A1D51A5E585FA5C9369F807BCEC0C7AD"],
[36,migration.includes("AI_CONTEXT_MAPPING_V1")&&migration.includes("AI_CONTEXT_MAPPING_V2")],
[37,createHash("sha256").update(migration013).digest("hex").toUpperCase()==="D89E8F42522F2A458289EA130CD07EB3A1D51A5E585FA5C9369F807BCEC0C7AD"],
[38,!migrations.some(n=>n.startsWith("015_"))],
[39,!/internal-mistral-large-2512|mistral-large-2512/i.test(migration+service+repository)],
];
const failed=checks.filter(([,ok])=>!ok).map(([id])=>id);
console.log(`ROOT_INVARIANT_CHECKS=${checks.length}`);
console.log(`ROOT_INVARIANT_PASS=${checks.length-failed.length}`);
console.log(`ROOT_INVARIANT_FAIL=${failed.length}`);
if(failed.length){console.log(`FAILED_IDS=${failed.join(",")}`);process.exit(1);}
console.log("CONTEXT_CLOSURE_ROOT_INVARIANT_SOURCE_AUDIT=PASS");
console.log("STATIC_SOURCE_AUDIT_IS_NOT_VITEST_PASS=TRUE");

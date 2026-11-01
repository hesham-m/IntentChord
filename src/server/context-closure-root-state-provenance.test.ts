import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildContextClosureEvaluationInputIdentityV1, evaluateContextClosureV1 } from "@/core/context-closure/v1";

const migration = readFileSync("migrations/014_governed_context_assembly_and_ai_context_mapping_v2.sql", "utf8");
const assemblyService = readFileSync("src/server/context-closure-service.ts", "utf8");
const repository = readFileSync("src/server/ai-context-mapping-v2-repository.ts", "utf8");
const validator = readFileSync("src/core/ai-context-mapper/validator-v2.ts", "utf8");
const bindingService = readFileSync("src/server/context-assembly-task-binding-service.ts", "utf8");
const projectionService = readFileSync("src/server/task-experience-projection-service.ts", "utf8");
const workbench = readFileSync("src/components/unified-task-workbench.tsx", "utf8");
const migration013 = readFileSync("migrations/013_internal_ai_engine_runtime_identity_decoupling.sql");
const sha256=(value:Buffer|string)=>createHash("sha256").update(value).digest("hex").toUpperCase();

function assemblyTable() {
  return migration.slice(migration.indexOf("CREATE TABLE IF NOT EXISTS intentchord.context_assembly_revisions"), migration.indexOf("CREATE TABLE IF NOT EXISTS intentchord.context_assembly_sources"));
}
function closureInput(overrides: Record<string, unknown> = {}) {
  return {
    contextAssemblyRevisionId:"11111111-1111-4111-8111-111111111111",
    assemblySha256:`sha256:${"a".repeat(64)}`,
    mappingIterationId:"22222222-2222-4222-8222-222222222222",
    mappingResultSha256:`sha256:${"b".repeat(64)}`,
    persistedSourceCount:2,
    mappingInputSourceCount:2,
    admittedMissingEvidenceRequests:[{id:"gap-request-1",requestSha256:`sha256:${"e".repeat(64)}`}],
    classifications:[{id:"gap-classification-1",requestId:"gap-request-1",classificationSha256:`sha256:${"c".repeat(64)}`}],
    openBlockingRequirements:[],
    resolutionFactHashes:[],
    activeQualificationScope:"AI_CONTEXT_MAPPING_V2",
    qualificationId:"qualification-v2",
    capabilityProfileVersion:"v2-profile",
    engineConfigurationSha256:`sha256:${"d".repeat(64)}`,
    ...overrides,
  } as any;
}

describe("Context Closure V2 root state and provenance contract R1-R25", () => {
  it("01 Assembly identity depends on governed evidence rather than Mapping execution state",()=>{ expect(assemblyService).toContain("assemblySha256"); expect(assemblyTable()).not.toMatch(/\bstate\b/); });
  it("02 failed Mapping Run does not mutate Assembly evidence identity",()=>{ const r=repository.slice(repository.indexOf("async function reconcileExpiredActiveRunsWith"),repository.indexOf("export const aiContextMappingV2Repository")); expect(r).not.toContain("update intentchord.context_assembly_revisions"); });
  it("03 retry against unchanged sources reuses the same Assembly Revision",()=>{ expect(assemblyService).toContain("latest.rows[0].assembly_sha256 === assemblySha256"); });
  it("04 changed Source/Index evidence creates a new Assembly Revision",()=>{ expect(assemblyService).toContain("const revision = latest.rowCount ? Number(latest.rows[0].revision)+1 : 1"); });

  it("05 Mapping execution lifecycle is owned by Mapping Run/Attempt",()=>{ expect(repository).toContain("context_mapping_runs"); expect(repository).toContain("context_mapping_attempts"); expect(assemblyTable()).not.toContain("MAPPING"); });
  it("06 valid non-terminal Run before deadline prevents duplicate Run",()=>{ expect(repository).toContain("ACTIVE_V2_MAPPING_RUN_STATUSES"); expect(repository).toContain("CONTEXT_ASSEMBLY_MAPPING_ALREADY_ACTIVE"); });
  it("07 expired non-terminal Run is atomically reconciled as orphaned",()=>{ expect(repository).toContain("reconcileExpiredActiveRunsWith"); expect(repository).toContain("ORPHANED_ACTIVE_MAPPING_EXECUTION"); });
  it("08 orphaned Run provenance is preserved",()=>{ expect(repository).toContain("terminal_reason_code"); expect(repository).toContain("MAPPER_ORPHANED_ACTIVE_EXECUTION"); });
  it("09 orphan reconciliation does not modify Assembly evidence truth",()=>{ const r=repository.slice(repository.indexOf("async function reconcileExpiredActiveRunsWith"),repository.indexOf("export const aiContextMappingV2Repository")); expect(r).not.toContain("context_assembly_sources"); expect(r).not.toContain("context_assembly_revisions set"); });
  it("10 retry creates a new Mapping Run identity",()=>{ expect(repository).toContain("insert into intentchord.context_mapping_runs"); expect(repository).not.toContain("reuse failed run"); });
  it("11 orphan recovery requires no autonomous/background polling",()=>{ expect(repository).not.toMatch(/setInterval|setTimeout\s*\(/); expect(repository).toContain("reconcileExpiredActiveRunsWith"); });

  it("12 failed technical execution creates no Mapping Iteration",()=>{ const f=repository.slice(repository.indexOf("async finalizeTechnicalAttempt"),repository.indexOf("async finalizeValidationFailure")); expect(f).not.toContain("context_assembly_mapping_iterations"); });
  it("13 rejected V2 result creates no Mapping Iteration",()=>{ const f=repository.slice(repository.indexOf("async finalizeValidationFailure"),repository.indexOf("async finalizeSuccessfulAttempt")); expect(f).not.toContain("context_assembly_mapping_iterations"); });
  it("14 valid V2 result creates exact Assembly-bound Mapping Iteration",()=>{ const s=repository.slice(repository.indexOf("async finalizeSuccessfulAttempt"),repository.indexOf("async readRun")); expect(s).toContain("context_assembly_mapping_iterations"); expect(migration).toContain("context_mapping_iteration_insert_guard"); });
  it("15 insufficient Component evidence is rejected before Mapping Iteration admission",()=>{ expect(validator).toContain("COMPONENT_EVIDENCE_COVERAGE"); expect(validator).toContain("COMPONENT_EVIDENCE_COVERAGE_INVALID"); });
  it("16 insufficient cross-workspace relationship evidence is rejected before Mapping Iteration admission",()=>{ expect(validator).toContain("CROSS_WORKSPACE_RELATIONSHIP_EVIDENCE"); expect(validator).toContain("CROSS_WORKSPACE_RELATIONSHIP_EVIDENCE_INVALID"); });
  it("17 invalid deterministic references are rejected before admission",()=>{ expect(validator).toContain("ENTRY_REFERENCE_INTEGRITY"); expect(validator).toContain("RELATIONSHIP_ENDPOINT_INTEGRITY"); });

  it("18 blocking internal Missing Evidence creates MISSING_INTERNAL_EVIDENCE Requirement",()=>{ expect(assemblyService).toContain('type:"MISSING_INTERNAL_EVIDENCE"'); expect(migration).toContain("MISSING_INTERNAL_EVIDENCE"); });
  it("19 Owner source authorization remains Backend-governed",()=>{ expect(assemblyService).toContain("authorizeTaskContextSource"); expect(migration).toContain("context_source_authorization_insert_guard"); });
  it("20 source expansion produces new Index evidence and a new Assembly Revision without claiming resolution",()=>{ expect(assemblyService).toContain("SUPERSEDED_BY_NEW_ASSEMBLY"); expect(assemblyService).toContain("previous_revision_id"); expect(assemblyService).not.toContain("values($1,$2,'RESOLVED_BY_NEW_ASSEMBLY'"); });
  it("21 old Requirement is preserved and successor provenance does not manufacture resolution",()=>{ expect(migration).toContain("SUPERSEDED_BY_NEW_ASSEMBLY"); expect(migration).not.toContain("RESOLVED_BY_NEW_ASSEMBLY"); });
  it("22 only an overlapping Backend-created Missing Internal Evidence Requirement prevents premature Source Truth Conflict",()=>{ expect(assemblyService).toContain("authoritativeBlockingInternalRequirements"); expect(assemblyService).toContain("hasOverlappingAuthoritativeMissingInternalRequirement"); });
  it("23 grounded material contradiction without resolving evidence creates SOURCE_TRUTH_CONFLICT",()=>{ expect(assemblyService).toContain('type:"SOURCE_TRUTH_CONFLICT"'); expect(migration).toContain("SOURCE_TRUTH_CONFLICT"); });
  it("24 Source Truth Conflict cannot be resolved by AI authority",()=>{ expect(migration).toContain("created_by text NOT NULL DEFAULT 'BACKEND_DETERMINISTIC_VALIDATOR'"); expect(workbench).toContain("SOURCE_TRUTH_CONFLICT"); });
  it("25 source truth correction/new evidence permits complete re-analysis on a successor Assembly without false resolution",()=>{ expect(migration).toContain("SOURCE_TRUTH_CORRECTION_REQUIRED"); expect(assemblyService).toContain("SUPERSEDED_BY_NEW_ASSEMBLY"); });

  it("26 Closure Evaluation binds exact Assembly Revision + Mapping Iteration",()=>{ expect(migration).toContain("context_assembly_revision_id uuid NOT NULL REFERENCES intentchord.context_assembly_revisions"); expect(migration).toContain("mapping_iteration_id uuid NOT NULL REFERENCES intentchord.context_assembly_mapping_iterations"); });
  it("27 multiple Closure Evaluations for one Assembly Revision are representable",()=>{ const t=migration.slice(migration.indexOf("CREATE TABLE IF NOT EXISTS intentchord.context_closure_evaluations"),migration.indexOf("CREATE TABLE IF NOT EXISTS intentchord.context_catalog_revisions")); expect(t).not.toMatch(/UNIQUE\s*\(\s*context_assembly_revision_id\s*\)/i); });
  it("28 previous Closure Evaluation is never overwritten",()=>{ expect(migration).toContain("context_assembly_history_append_only"); expect(assemblyService).toContain("insert into intentchord.context_closure_evaluations"); expect(assemblyService).not.toContain("update intentchord.context_closure_evaluations"); });
  it("29 changed governance facts produce a new evaluation input identity",()=>{ const a=buildContextClosureEvaluationInputIdentityV1(closureInput()); const b=buildContextClosureEvaluationInputIdentityV1(closureInput({resolutionFactHashes:[`sha256:${"e".repeat(64)}`]})); expect(a).not.toBe(b); });
  it("30 model no-known-gap alone cannot establish Closure PASS",()=>{ expect(evaluateContextClosureV1(closureInput({persistedSourceCount:0,mappingInputSourceCount:0})).decision).toBe("BLOCKED"); });
  it("31 open blocking Missing Evidence Requirement prevents Closure PASS",()=>{ expect(evaluateContextClosureV1(closureInput({openBlockingRequirements:[{id:"r1",requirementSha256:`sha256:${"f".repeat(64)}`,requirementType:"MISSING_INTERNAL_EVIDENCE"}]})).decision).toBe("BLOCKED"); });
  it("32 open Source Truth Conflict Requirement prevents Closure PASS",()=>{ expect(evaluateContextClosureV1(closureInput({openBlockingRequirements:[{id:"r2",requirementSha256:`sha256:${"1".repeat(64)}`,requirementType:"SOURCE_TRUTH_CONFLICT"}]})).decision).toBe("BLOCKED"); });
  it("33 exact V2 qualification remains required",()=>{ expect(evaluateContextClosureV1(closureInput({activeQualificationScope:"AI_CONTEXT_MAPPING_V1"})).decision).toBe("BLOCKED"); });

  it("34 Accepted Catalog requires exact PASS Closure Evaluation",()=>{ expect(migration).toContain("INTENTCHORD_CONTEXT_CATALOG_REQUIRES_EXACT_PASS_CLOSURE_EVALUATION"); });
  it("35 Accepted Catalog binds exact Assembly + Mapping Iteration + Closure Evaluation",()=>{ expect(bindingService).toContain("c.mapping_iteration_id,c.closure_evaluation_id"); expect(bindingService).toContain("ce.mapping_iteration_id=c.mapping_iteration_id"); });
  it("36 no Owner-selectable partial Catalog exists before PASS",()=>{ expect(bindingService).toContain("CONTEXT_CLOSURE_NOT_PASS"); expect(projectionService).toContain("acceptedCatalog"); });
  it("37 later unrelated/latest Mapping Run cannot silently replace Catalog provenance",()=>{ expect(bindingService).toContain('Never resolve "latest"'); expect(bindingService).not.toMatch(/order\s+by[\s\S]{0,100}created_at\s+desc\s+limit\s+1/i); });

  it("38 Work Selection resolves evidence from exact Accepted Catalog provenance",()=>{ expect(bindingService).toContain("Catalog -> Closure Evaluation"); expect(bindingService).toContain("Mapping Iteration -> Mapping Run -> frozen Mapping Input"); });
  it("39 authority-critical Work Selection does not use latest Mapping Run lookup",()=>{ expect(bindingService).not.toMatch(/context_mapping_runs[\s\S]{0,180}order\s+by[\s\S]{0,100}created_at\s+desc\s+limit\s+1/i); });
  it("40 multi-component Work Selection remains supported",()=>{ expect(bindingService).toContain("selectedComponentIds"); expect(bindingService).toContain("new Set(input.selectedComponentIds)"); });
  it("41 cross-workspace Candidate Scope remains exact and evidence-backed",()=>{ expect(bindingService).toContain("evidence.workspace_id"); expect(bindingService).toContain("candidateAllowedPaths"); });

  it("42 active valid Run projects Mapping active",()=>{ expect(assemblyService).toContain('else if(active) state="MAPPING"'); });
  it("43 terminal failed/rejected latest relevant Run projects Mapping retry",()=>{ expect(assemblyService).toContain('state="MAPPING_RETRYABLE"'); });
  it("44 Missing Evidence Requirement projects evidence-resolution action",()=>{ expect(projectionService).toContain("CONTEXT_EVIDENCE_REQUIRED"); expect(projectionService).toContain("RESOLVE_CONTEXT"); });
  it("45 denied/unavailable required source projects exact BLOCKED reason",()=>{ expect(assemblyService).toContain("OWNER_DENIED_SOURCE"); expect(assemblyService).toContain("SOURCE_UNAVAILABLE"); expect(assemblyService).toContain('state="BLOCKED"'); });
  it("46 Source Truth Conflict projects source-truth resolution action",()=>{ expect(projectionService).toContain("CONTEXT_SOURCE_TRUTH_CONFLICT"); expect(projectionService).toContain("RESOLVE_SOURCE_TRUTH"); });
  it("47 PASS Closure + Accepted Catalog projects SELECT_WORK",()=>{ expect(projectionService).toContain("COMPONENTS_READY_FOR_WORK_SELECTION"); expect(projectionService).toContain("COMMIT_WORK_SELECTION"); expect(assemblyService).toContain('state="CLOSED"'); });
  it("48 frontend does not infer authority from AI text",()=>{ expect(workbench).not.toMatch(/analysis_outcome\s*===.*SELECT_WORK/); expect(projectionService).toContain("primaryAction"); });

  it("49 AI_CONTEXT_MAPPING_V1 semantics remain unchanged",()=>{ expect(sha256(migration013)).toBe("D89E8F42522F2A458289EA130CD07EB3A1D51A5E585FA5C9369F807BCEC0C7AD"); });
  it("50 V1 qualification does not imply V2",()=>{ expect(migration).toContain("qualification_scope IN ('AI_CONTEXT_MAPPING_V1','AI_CONTEXT_MAPPING_V2')"); expect(migration).toContain("AI_CONTEXT_MAPPING_V2"); });
  it("51 Migration 013 remains unchanged",()=>{ expect(sha256(migration013)).toBe("D89E8F42522F2A458289EA130CD07EB3A1D51A5E585FA5C9369F807BCEC0C7AD"); });
  it("52 no Migration 015 exists",()=>{ expect(readdirSync(resolve(process.cwd(),"migrations")).some(name=>name.startsWith("015_"))).toBe(false); });
  it("53 Mistral remains unconfigured/unqualified by this root correction",()=>{ const combined=migration+assemblyService+repository; expect(combined).not.toMatch(/internal-mistral-large-2512|mistral-large-2512/i); });
  it("54 partial Catalog remains forbidden",()=>{ expect(bindingService).toContain("accepted complete Context Catalog"); expect(migration).toContain("INTENTCHORD_CONTEXT_CATALOG_REQUIRES_EXACT_PASS_CLOSURE_EVALUATION"); });
  it("55 Scope Confirmation authority remains fail-closed",()=>{ const lifecycle=readFileSync("src/server/lifecycle.ts","utf8"); expect(lifecycle).toContain("scopeConfirmation"); expect(lifecycle).toContain("candidateScopeIdentityMatches"); });
});

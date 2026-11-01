import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildContextClosureEvaluationInputIdentityV1,
  evaluateContextClosureV1,
  exactMissingEvidenceClassificationCoverage,
  hasOverlappingAuthoritativeMissingInternalRequirement,
} from "@/core/context-closure/v1";

const migration=readFileSync("migrations/014_governed_context_assembly_and_ai_context_mapping_v2.sql","utf8");
const migration013=readFileSync("migrations/013_internal_ai_engine_runtime_identity_decoupling.sql");
const service=readFileSync("src/server/context-closure-service.ts","utf8");
const rootTest=readFileSync("src/server/context-closure-root-state-provenance.test.ts","utf8");
const repository=readFileSync("src/server/ai-context-mapping-v2-repository.ts","utf8");
const binding=readFileSync("src/server/context-assembly-task-binding-service.ts","utf8");
const sha=(c:string)=>`sha256:${c.repeat(64)}`;
const closureBase=()=>({
  contextAssemblyRevisionId:"11111111-1111-4111-8111-111111111111",
  assemblySha256:sha("a"),
  mappingIterationId:"22222222-2222-4222-8222-222222222222",
  mappingResultSha256:sha("b"),
  persistedSourceCount:1,
  mappingInputSourceCount:1,
  admittedMissingEvidenceRequests:[],
  classifications:[],
  openBlockingRequirements:[],
  resolutionFactHashes:[],
  activeQualificationScope:"AI_CONTEXT_MAPPING_V2",
  qualificationId:"qualification-v2",
  capabilityProfileVersion:"profile-v2",
  engineConfigurationSha256:sha("c"),
  currentEffectiveContextAuthorityProven:true,
  currentTaskSourceSetSha256:sha("d"),
  currentSourceAuthoritySha256:sha("e"),
});

describe("Context Closure V2 root invariant correction",()=>{
  it("01 successor Assembly creation does not automatically emit RESOLVED_BY_NEW_ASSEMBLY",()=>{ expect(service).toContain("SUPERSEDED_BY_NEW_ASSEMBLY"); expect(service).not.toContain("values($1,$2,'RESOLVED_BY_NEW_ASSEMBLY'"); });
  it("02 unrelated evidence change cannot manufacture resolved semantics",()=>{ expect(service).toContain("GOVERNED_EVIDENCE_UNIVERSE_CHANGED_REANALYSIS_REQUIRED"); expect(service).not.toContain("deterministicResolutionProofSha256"); });
  it("03 successor Assembly provenance is explicit and truthful",()=>{ expect(migration).toContain("SUPERSEDED_BY_NEW_ASSEMBLY"); expect(migration).toContain("successor_context_assembly_revision_id"); });
  it("04 historical Requirement remains append-only",()=>{ expect(migration).toContain("context_assembly_history_append_only"); expect(migration).toContain("context_resolution_requirements"); });
  it("05 current model does not manufacture RESOLVED_BY_NEW_ASSEMBLY without an exact proof contract",()=>{ expect(migration).not.toContain("RESOLVED_BY_NEW_ASSEMBLY"); expect(service).toContain("SUPERSEDED_BY_NEW_ASSEMBLY"); });

  it("06 raw model blocking gap alone cannot suppress Source Truth Conflict",()=>{ expect(hasOverlappingAuthoritativeMissingInternalRequirement({affected_component_ids:["c1"],affected_relationship_ids:[]},[])).toBe(false); });
  it("07 Backend EXTERNAL_DEPENDENCY classification does not create internal Requirement precedence",()=>{ expect(service).toContain('if(classification==="BLOCKING_INTERNAL_SOURCE_GAP")'); });
  it("08 exact overlapping Backend-created MISSING_INTERNAL_EVIDENCE Requirement may defer conflict",()=>{ expect(hasOverlappingAuthoritativeMissingInternalRequirement({affected_component_ids:["c1"],affected_relationship_ids:[]},[{requirementId:"r1",affectedComponentIds:["c1"],affectedRelationshipIds:[]}])).toBe(true); });
  it("09 AI fields alone are not governance precedence",()=>{ expect(service).toContain("authoritativeBlockingInternalRequirements"); expect(service).not.toContain('gap.materiality==="BLOCKING"\n        && ('); });

  it("10 one Missing Evidence Request plus zero classifications fails Closure gate",()=>{ const r=evaluateContextClosureV1({...closureBase(),admittedMissingEvidenceRequests:[{id:"m1",requestSha256:sha("d")}]}); expect(r.decision).toBe("BLOCKED"); });
  it("11 every admitted Missing Evidence Request needs exact classification",()=>{ expect(exactMissingEvidenceClassificationCoverage({requests:[{id:"m1",requestSha256:sha("d")}],classifications:[{id:"c1",requestId:"m1",classificationSha256:sha("e")}]}).pass).toBe(true); });
  it("12 classification for wrong Request cannot satisfy gate",()=>{ expect(exactMissingEvidenceClassificationCoverage({requests:[{id:"m1",requestSha256:sha("d")}],classifications:[{id:"c1",requestId:"other",classificationSha256:sha("e")}]}).pass).toBe(false); });
  it("13 duplicate classification facts fail closed",()=>{ expect(exactMissingEvidenceClassificationCoverage({requests:[{id:"m1",requestSha256:sha("d")}],classifications:[{id:"c1",requestId:"m1",classificationSha256:sha("e")},{id:"c2",requestId:"m1",classificationSha256:sha("f")}]}).pass).toBe(false); });
  it("14 complete exact classification coverage may pass that gate",()=>{ expect(evaluateContextClosureV1({...closureBase(),admittedMissingEvidenceRequests:[{id:"m1",requestSha256:sha("d")}],classifications:[{id:"c1",requestId:"m1",classificationSha256:sha("e")}]}).gates.find(g=>g.gate==="ALL_MISSING_EVIDENCE_REQUESTS_BACKEND_CLASSIFIED")?.status).toBe("PASS"); });
  it("15 evaluation input changes when classification governance facts change",()=>{ const q={id:"m1",requestSha256:sha("d")}; const a=buildContextClosureEvaluationInputIdentityV1({...closureBase(),admittedMissingEvidenceRequests:[q],classifications:[{id:"c1",requestId:"m1",classificationSha256:sha("e")}]}); const b=buildContextClosureEvaluationInputIdentityV1({...closureBase(),admittedMissingEvidenceRequests:[q],classifications:[{id:"c1",requestId:"m1",classificationSha256:sha("f")}]}); expect(a).not.toBe(b); });

  it("16 Revision 1 requires previous_revision_id NULL",()=>{ expect(migration).toContain("FIRST_REVISION_PREVIOUS_FORBIDDEN"); });
  it("17 Revision N requires same Assembly lineage",()=>{ expect(migration).toContain("PREVIOUS_REVISION_CROSS_ASSEMBLY"); });
  it("18 Revision N previous must be N-1",()=>{ expect(migration).toContain("PREVIOUS_REVISION_NOT_SEQUENTIAL"); });
  it("19 cross-Assembly previous_revision_id is DB-rejected",()=>{ expect(migration).toContain("context_assembly_revision_lineage_guard"); expect(migration).toContain("CROSS_ASSEMBLY"); });
  it("20 skipped revision lineage is DB-rejected",()=>{ expect(migration).toContain("previous_row.revision IS DISTINCT FROM NEW.revision - 1"); });
  it("21 successor event cannot point backward",()=>{ expect(migration).toContain("successor_revision <= old_revision"); });
  it("22 successor event cannot cross Context Assembly lineage",()=>{ expect(migration).toContain("successor_assembly IS DISTINCT FROM old_assembly"); });

  it("23 root Vitest uses current Component evidence diagnostic",()=>{ expect(rootTest).toContain("COMPONENT_EVIDENCE_COVERAGE_INVALID"); expect(rootTest).not.toContain("COMPONENT_WORKSPACE_EVIDENCE_MISSING"); });
  it("24 root Vitest uses current relationship evidence diagnostic and no stale overlap identifier",()=>{ expect(rootTest).toContain("CROSS_WORKSPACE_RELATIONSHIP_EVIDENCE_INVALID"); expect(rootTest).not.toContain("RELATIONSHIP_WORKSPACE_EVIDENCE_MISSING"); expect(rootTest).not.toContain("overlappingBlockingGap"); });
  it("25 static source audit and executable Vitest remain distinct evidence classes",()=>{ const audit=readFileSync("scripts/context-closure-root-state-source-audit.mjs","utf8"); expect(audit).toContain("SOURCE_AUDIT"); expect(audit).not.toContain("VITEST_PASS"); });

  it("26 Context Assembly remains evidence-only",()=>{ const t=migration.slice(migration.indexOf("CREATE TABLE IF NOT EXISTS intentchord.context_assembly_revisions"),migration.indexOf("CREATE OR REPLACE FUNCTION intentchord.context_assembly_revision_lineage_guard")); expect(t).not.toMatch(/\bstate\b|qualification_scope|closure_state/); });
  it("27 Mapping execution remains Run-owned",()=>{ expect(repository).toContain("context_mapping_runs"); expect(repository).toContain("context_mapping_attempts"); });
  it("28 orphan recovery remains Run-owned",()=>{ expect(repository).toContain("ORPHANED_ACTIVE_MAPPING_EXECUTION"); });
  it("29 Mapping Iteration still requires validated result",()=>{ expect(migration).toContain("context_mapping_iteration_insert_guard"); expect(migration).toContain("deterministic_validation_evidence"); });
  it("30 Missing Evidence and Material Contradiction provenance remain persisted",()=>{ expect(migration).toContain("context_missing_evidence_requests"); expect(migration).toContain("context_material_contradictions"); });
  it("31 Closure remains immutable multi-evaluation",()=>{ expect(migration).toContain("context_closure_evaluations_input_uq"); expect(migration).not.toMatch(/UNIQUE\s*\(\s*context_assembly_revision_id\s*\)/i); });
  it("32 Accepted Catalog exact provenance remains enforced",()=>{ expect(migration).toContain("INTENTCHORD_CONTEXT_CATALOG_REQUIRES_EXACT_PASS_CLOSURE_EVALUATION"); });
  it("33 Work Selection still avoids latest Mapping Run authority",()=>{ expect(binding).toContain('Never resolve "latest"'); });
  it("34 multi-component cross-workspace Work Selection remains supported",()=>{ expect(binding).toContain("new Set(input.selectedComponentIds)"); expect(binding).toContain("evidence.workspace_id"); });
  it("35 AI_CONTEXT_MAPPING_V1 remains preserved",()=>{ expect(createHash("sha256").update(migration013).digest("hex").toUpperCase()).toBe("D89E8F42522F2A458289EA130CD07EB3A1D51A5E585FA5C9369F807BCEC0C7AD"); });
  it("36 V1 qualification does not imply V2",()=>{ expect(migration).toContain("AI_CONTEXT_MAPPING_V1"); expect(migration).toContain("AI_CONTEXT_MAPPING_V2"); });
  it("37 Migration 013 unchanged",()=>{ expect(createHash("sha256").update(migration013).digest("hex").toUpperCase()).toBe("D89E8F42522F2A458289EA130CD07EB3A1D51A5E585FA5C9369F807BCEC0C7AD"); });
  it("38 Migration 015 absent",()=>{ expect(readdirSync("migrations").some(name=>name.startsWith("015_"))).toBe(false); });
  it("39 Mistral remains unconfigured and unqualified",()=>{ expect((migration+service+repository).toLowerCase()).not.toMatch(/internal-mistral-large-2512|mistral-large-2512/); });
});

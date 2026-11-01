import { describe, expect, it } from "vitest";
import {
  buildContextClosureEvaluationInputIdentityV1,
  classifyMissingEvidenceRequestV2,
  evaluateContextClosureV1,
  exactMissingEvidenceClassificationCoverage,
  hasOverlappingAuthoritativeMissingInternalRequirement,
} from "@/core/context-closure/v1";

const sha=(c:string)=>`sha256:${c.repeat(64)}`;
const base=()=>({
  contextAssemblyRevisionId:"11111111-1111-4111-8111-111111111111",
  assemblySha256:sha("a"),
  mappingIterationId:"22222222-2222-4222-8222-222222222222",
  mappingResultSha256:sha("b"),
  persistedSourceCount:2,
  mappingInputSourceCount:2,
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

describe("deterministic Context Closure governance evaluation",()=>{
  it("classifies a model blocking internal-source finding without granting model authority",()=>{
    expect(classifyMissingEvidenceRequestV2({
      gap_id:"gap_client",gap_type:"INTERNAL_SOURCE",affected_component_ids:[],affected_relationship_ids:[],known_evidence_entry_ids:["entry_server"],
      missing_evidence_description:"Client source missing",required_evidence_kind:"client implementation",blocking_reason:"material relation incomplete",materiality:"BLOCKING",confidence:"high",
    })).toBe("BLOCKING_INTERNAL_SOURCE_GAP");
  });

  it("uses Backend-created MISSING_INTERNAL_EVIDENCE Requirement overlap rather than raw AI materiality for conflict precedence",()=>{
    const contradiction={affected_component_ids:["component-a"],affected_relationship_ids:[]};
    expect(hasOverlappingAuthoritativeMissingInternalRequirement(contradiction,[])).toBe(false);
    expect(hasOverlappingAuthoritativeMissingInternalRequirement(contradiction,[{
      requirementId:"requirement-1",affectedComponentIds:["component-a"],affectedRelationshipIds:[],
    }])).toBe(true);
  });

  it("fails exact classification coverage for one admitted request and zero Backend classifications",()=>{
    const coverage=exactMissingEvidenceClassificationCoverage({
      requests:[{id:"request-1",requestSha256:sha("d")}],classifications:[],
    });
    expect(coverage.pass).toBe(false);
    expect(coverage.unclassifiedMissingEvidenceCount).toBe(1);
  });

  it("does not let a classification for the wrong request satisfy coverage",()=>{
    const coverage=exactMissingEvidenceClassificationCoverage({
      requests:[{id:"request-1",requestSha256:sha("d")}],
      classifications:[{id:"classification-1",requestId:"request-2",classificationSha256:sha("e")}],
    });
    expect(coverage.pass).toBe(false);
    expect(coverage.extraneousClassificationCount).toBe(1);
  });

  it("fails closed on duplicate classifications for one request",()=>{
    const coverage=exactMissingEvidenceClassificationCoverage({
      requests:[{id:"request-1",requestSha256:sha("d")}],
      classifications:[
        {id:"classification-1",requestId:"request-1",classificationSha256:sha("e")},
        {id:"classification-2",requestId:"request-1",classificationSha256:sha("f")},
      ],
    });
    expect(coverage.pass).toBe(false);
    expect(coverage.duplicateClassificationRequestCount).toBe(1);
  });

  it("passes exact classification coverage only for one exact classification per admitted request",()=>{
    expect(exactMissingEvidenceClassificationCoverage({
      requests:[{id:"request-1",requestSha256:sha("d")}],
      classifications:[{id:"classification-1",requestId:"request-1",classificationSha256:sha("e")}],
    }).pass).toBe(true);
  });

  it("blocks Closure when an admitted Missing Evidence Request lacks an exact Backend classification",()=>{
    const result=evaluateContextClosureV1({
      ...base(),
      admittedMissingEvidenceRequests:[{id:"request-1",requestSha256:sha("d")}],
    });
    expect(result.decision).toBe("BLOCKED");
    expect(result.gates.find(g=>g.gate==="ALL_MISSING_EVIDENCE_REQUESTS_BACKEND_CLASSIFIED")?.status).toBe("FAIL");
  });

  it("blocks Closure when a persisted blocking Missing Evidence Requirement remains open",()=>{
    const result=evaluateContextClosureV1({...base(),openBlockingRequirements:[{id:"req-1",requirementSha256:sha("d"),requirementType:"MISSING_INTERNAL_EVIDENCE" as const}]});
    expect(result.decision).toBe("BLOCKED");
    expect(result.gates.find(g=>g.gate==="NO_OPEN_BLOCKING_CONTEXT_RESOLUTION_REQUIREMENT")?.status).toBe("FAIL");
  });

  it("blocks Closure when a persisted Source Truth Conflict Requirement remains open",()=>{
    const result=evaluateContextClosureV1({...base(),openBlockingRequirements:[{id:"req-2",requirementSha256:sha("e"),requirementType:"SOURCE_TRUTH_CONFLICT" as const}]});
    expect(result.decision).toBe("BLOCKED");
  });

  it("does not grant Closure merely because the model emitted no known gap",()=>{
    const result=evaluateContextClosureV1({...base(),persistedSourceCount:1,mappingInputSourceCount:2});
    expect(result.decision).toBe("BLOCKED");
    expect(result.gates.find(g=>g.gate==="ALL_SOURCES_READY_CANONICAL_INDEX")?.status).toBe("FAIL");
  });

  it("requires exact V2 qualification identity, not V1 qualification",()=>{
    const result=evaluateContextClosureV1({...base(),activeQualificationScope:"AI_CONTEXT_MAPPING_V1"});
    expect(result.decision).toBe("BLOCKED");
    expect(result.gates.find(g=>g.gate==="AI_CONTEXT_MAPPING_V2_EXACT_QUALIFICATION")?.status).toBe("FAIL");
  });

  it("fails closed when current effective Context authority is explicitly unproven",()=>{
    const result=evaluateContextClosureV1({...base(),currentEffectiveContextAuthorityProven:false});
    expect(result.decision).toBe("BLOCKED");
    expect(result.gates.find(g=>g.gate==="CURRENT_EFFECTIVE_CONTEXT_AUTHORITY")?.status).toBe("FAIL");
  });

  it("passes only when exact Assembly/Iteration governance inputs have no open blocking Requirement",()=>{
    const result=evaluateContextClosureV1(base());
    expect(result.decision).toBe("PASS");
    expect(result.gates.every(g=>g.status==="PASS")).toBe(true);
  });

  it("changes immutable evaluation input identity when governance facts change",()=>{
    const a=buildContextClosureEvaluationInputIdentityV1(base());
    const b=buildContextClosureEvaluationInputIdentityV1({...base(),resolutionFactHashes:[sha("f")]});
    expect(a).not.toBe(b);
  });

  it("changes immutable evaluation input identity when Backend classification facts change",()=>{
    const request={id:"request-1",requestSha256:sha("d")};
    const a=buildContextClosureEvaluationInputIdentityV1({
      ...base(),admittedMissingEvidenceRequests:[request],
      classifications:[{id:"classification-1",requestId:request.id,classificationSha256:sha("e")}],
    });
    const b=buildContextClosureEvaluationInputIdentityV1({
      ...base(),admittedMissingEvidenceRequests:[request],
      classifications:[{id:"classification-1",requestId:request.id,classificationSha256:sha("f")}],
    });
    expect(a).not.toBe(b);
  });

  it("prevents reuse of a Closure PASS when an accepted Catalog already exists",()=>{
    const result=evaluateContextClosureV1({...base(),existingAcceptedCatalogId:"catalog-1"});
    expect(result.decision).toBe("BLOCKED");
    expect(result.gates.find(g=>g.gate==="NO_CONTRADICTORY_ACCEPTED_CATALOG")?.status).toBe("FAIL");
  });
});

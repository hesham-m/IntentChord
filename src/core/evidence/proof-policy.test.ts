import { describe, expect, it } from "vitest";
import { bindFindingEvidence } from "@/core/evidence/evidence-binder";
import {
  evidenceTypeCanProveClaim,
  requiredEvidenceKinds,
} from "@/core/evidence/proof-policy";

const sourceEvidence = {
  kind: "SOURCE_EVIDENCE" as const,
  workspaceId: "11111111-1111-4111-8111-111111111111",
  relativePath: "src/update/version-authority.ts",
  symbol: "resolveUpdateVersion",
  lineStart: 20,
  lineEnd: 42,
  contentSha256: "a".repeat(64),
};

describe("evidence-class proof policy", () => {
  it("accepts a source finding only when exact source evidence is supplied", () => {
    const accepted = bindFindingEvidence({
      requirementId: "REQ-UPD-001",
      claim: "The Backend service resolves the authoritative update version.",
      status: "PROVEN_BY_SOURCE",
      requiredEvidenceTypes: ["SOURCE"],
      evidenceRefs: [sourceEvidence],
    });
    const rejected = bindFindingEvidence({
      requirementId: "REQ-UPD-001",
      claim: "The Backend service resolves the authoritative update version.",
      status: "PROVEN_BY_SOURCE",
      requiredEvidenceTypes: ["SOURCE"],
      evidenceRefs: [],
    });

    expect(accepted.accepted).toBe(true);
    expect(rejected.issues).toContain("PROVEN_STATUS_REQUIRES_SOURCE_EVIDENCE");
  });

  it("does not let source evidence prove runtime behavior", () => {
    expect(evidenceTypeCanProveClaim("SOURCE", "SOURCE")).toBe(true);
    expect(evidenceTypeCanProveClaim("SOURCE", "RUNTIME")).toBe(false);
    expect(evidenceTypeCanProveClaim("RUNTIME", "RUNTIME")).toBe(true);
  });

  it("treats requirement evidence types as minimum closure requirements and permits additional evidence classes", () => {
    expect(requiredEvidenceKinds(["SOURCE", "ARTIFACT"])).toEqual(
      new Set(["SOURCE_EVIDENCE", "ARTIFACT_EVIDENCE"]),
    );
    const result = bindFindingEvidence({
      requirementId: "REQ-UPD-004",
      claim: "The inspected source and release artifact expose the same version.",
      status: "PROVEN_BY_SOURCE",
      requiredEvidenceTypes: ["SOURCE", "ARTIFACT"],
      evidenceRefs: [
        sourceEvidence,
        {
          kind: "ARTIFACT_EVIDENCE",
          artifactId: "client-1.5.3",
          artifactSha256: "b".repeat(64),
        },
      ],
    });
    expect(result.accepted).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import { resolveRequirementProofProfile } from "@/core/contracts/requirement-proof-profile";

describe("requirement proof-profile authority", () => {
  it("keeps planner-inferred SOURCE-only requirements evidence-class aligned", () => {
    expect(resolveRequirementProofProfile(["SOURCE"])).toEqual({
      sourceBehavior: true,
      positive: true,
      negativeAdversarial: false,
      persistenceReload: false,
    });
  });

  it("derives trusted negative and runtime proof only from matching evidence classes", () => {
    expect(resolveRequirementProofProfile(["SOURCE", "VALIDATION"])).toEqual({
      sourceBehavior: true,
      positive: true,
      negativeAdversarial: true,
      persistenceReload: false,
    });
    expect(resolveRequirementProofProfile(["ARTIFACT", "RUNTIME"])).toEqual({
      sourceBehavior: false,
      positive: true,
      negativeAdversarial: true,
      persistenceReload: true,
    });
  });

  it("preserves an Owner-explicit proof profile without planner substitution", () => {
    const explicit = {
      sourceBehavior: true,
      positive: true,
      negativeAdversarial: true,
      persistenceReload: true,
    };
    expect(resolveRequirementProofProfile(["SOURCE", "VALIDATION"], explicit)).toEqual(explicit);
  });
});

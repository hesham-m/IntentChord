import { describe, expect, it } from "vitest";
import { evaluateConfiguration } from "@/core/recommendations/engine";
import { deriveTaskSemanticProfile } from "@/core/tasks/semantic-profile";

const readOnly = {
  readFiles: true,
  modifySource: false,
  runStaticValidation: false,
  runTests: false,
  build: false,
  deploy: false,
  restartServices: false,
  writeDatabase: false,
  changeEnvironment: false,
  useNetwork: false,
};

describe("pre-discovery semantic recommendation", () => {
  it("does not present complexity or cross-file dependency as assessed facts before discovery", () => {
    const profile = deriveTaskSemanticProfile({
      taskMode: "CONTROLLED_AUDIT",
      objective: "Review update channel version 1.5.3.",
      allowedPaths: ["workspace-a:@workspace-root", "workspace-b:@workspace-root"],
      evidenceFiles: [],
      authorization: readOnly,
    });

    expect(profile.assessmentStatus).toBe("PRELIMINARY");
    expect(profile.complexity).toBe("NOT_ASSESSED");
    expect(profile.crossFileDependency).toBe("NOT_ASSESSED");
    expect(profile.crossWorkspaceDependency).toBe("NOT_ASSESSED");
    expect(profile.reasons.join(" ")).toMatch(/bounded discovery/i);
  });

  it("uses a private routing signal without exposing it as a discovered complexity conclusion", () => {
    const profile = deriveTaskSemanticProfile({
      taskMode: "SOURCE_IMPLEMENTATION",
      objective: "Perform a cross-file root cause remediation.",
      allowedPaths: ["a", "b", "c"],
      evidenceFiles: [],
      authorization: {
        ...readOnly,
        modifySource: true,
        runStaticValidation: true,
        runTests: true,
      },
    });
    const recommendation = evaluateConfiguration({
      providerId: "OPENAI",
      modelId: "gpt-5.6-terra",
      reasoningProfile: "Medium",
      runtimeProfileId: "STANDARD",
      task: profile,
      ownerOverrideAccepted: false,
    });

    expect(profile.routingComplexity).toBe("HIGH");
    expect(profile.complexity).toBe("NOT_ASSESSED");
    expect(recommendation.assessmentStatus).toBe("PRELIMINARY");
    expect(recommendation.recommendedModelId).toBe("gpt-5.6-sol");
  });
});

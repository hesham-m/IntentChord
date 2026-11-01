import { describe, expect, it } from "vitest";
import {
  confirmIntentResolution,
  validateIntentResolutionPolicy,
} from "@/core/intelligence/intent-policy";
import {
  intentInputFingerprint,
  resolveIntentDeterministically,
} from "@/core/intelligence/intent-resolver";
import { providerBinding } from "@/core/providers/ai-role-routing";

const workspaceIds = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
];

function plannerInput() {
  return {
    literalObjective: "update channel v 1.5.3.",
    locale: "en" as const,
    taskMode: "CONTROLLED_AUDIT" as const,
    workspaceIds,
    workspaceDisplayNames: ["control-server", "example-client"],
    effectiveCapabilities: ["readFiles"],
    authorityFingerprint: "a".repeat(64),
    providerBinding: providerBinding(
      "INTENT_PLANNER",
      "OPENAI",
      "gpt-5.6-terra",
      "CODEX",
    ),
  };
}

describe("intent resolution", () => {
  it("preserves the complete semantic version and generates update-channel-specific investigation requirements", () => {
    const input = plannerInput();
    const resolution = resolveIntentDeterministically(input);

    expect(resolution.literalObjective).toBe("update channel v 1.5.3.");
    expect(resolution.preservedLiterals).toContain("1.5.3");
    expect(resolution.normalizedTopic).toBe("Update Channel 1.5.3");
    expect(resolution.ownerSummary).toContain("Update Channel 1.5.3");
    expect(resolution.ownerSummary).toContain("read-only discovery");
    expect(resolution.investigationQuestions.map(item => item.question).join(" ")).toMatch(
      /readiness.*artifacts.*native releases.*manifest/i,
    );
    expect(resolution.proposedRequirements.map(item => item.id)).toEqual([
      "REQ-UPD-001",
      "REQ-UPD-002",
      "REQ-UPD-003",
      "REQ-UPD-004",
      "REQ-UPD-005",
    ]);
    expect(resolution.proposedRequirements[0].requiredEvidenceTypes).toEqual(["SOURCE"]);
    expect(resolution.proposedRequirements[3].requiredEvidenceTypes).toEqual(["SOURCE", "ARTIFACT"]);
  });

  it("produces an Arabic owner summary and investigation questions when the owner UI locale is Arabic", () => {
    const resolution = resolveIntentDeterministically({
      ...plannerInput(),
      locale: "ar",
    });
    expect(resolution.locale).toBe("ar");
    expect(resolution.ownerSummary).toMatch(/[؀-ۿ]/);
    expect(resolution.investigationQuestions.every(item => /[؀-ۿ]/.test(item.question))).toBe(true);
    expect(resolution.preservedLiterals).toContain("1.5.3");
  });

  it("rejects any planner output that changes the objective, authority, workspace set, or selected provider binding", () => {
    const input = plannerInput();
    const resolution = resolveIntentDeterministically(input);

    expect(() => validateIntentResolutionPolicy({
      ...resolution,
      literalObjective: "A different objective",
    }, input)).toThrow(/INTENT_LITERAL_OBJECTIVE_CHANGED/);

    expect(() => validateIntentResolutionPolicy({
      ...resolution,
      authorityEcho: {
        ...resolution.authorityEcho,
        effectiveCapabilities: ["readFiles", "modifySource"],
      },
    }, input)).toThrow(/INTENT_CAPABILITY_SET_CHANGED/);
  });

  it("turns inferred questions and requirements into owner-confirmed content without changing the frozen authority", () => {
    const input = plannerInput();
    const resolution = validateIntentResolutionPolicy(
      resolveIntentDeterministically(input),
      input,
    );
    const confirmed = confirmIntentResolution(resolution);

    expect(confirmed.investigationQuestions.every(item => item.origin === "OWNER_CONFIRMED")).toBe(true);
    expect(confirmed.proposedRequirements.every(item => item.origin === "OWNER_CONFIRMED")).toBe(true);
    expect(confirmed.authorityEcho).toEqual(resolution.authorityEcho);
    expect(intentInputFingerprint(input)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("requires one clarification when a read-only audit objective is phrased as an implementation command", () => {
    const input = {
      ...plannerInput(),
      literalObjective: "Fix update channel v1.5.3",
    };
    const resolution = resolveIntentDeterministically(input);
    expect(resolution.needsClarification).toBe(true);
    expect(resolution.clarificationQuestion).toMatch(/audit the problem only/i);
    expect(() => confirmIntentResolution(resolution)).toThrow("INTENT_CLARIFICATION_REQUIRED");
  });
});

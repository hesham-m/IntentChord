import { createHash } from "node:crypto";
import {
  intentResolutionSchema,
  type ConfirmedIntentResolution,
  type IntentPlannerInput,
  type IntentResolution,
} from "@/core/intelligence/intent-schema";
import { assertProviderExecutionBinding } from "@/core/providers/ai-role-routing";

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function authorityFingerprint(input: {
  taskMode: IntentPlannerInput["taskMode"];
  workspaceIds: string[];
  effectiveCapabilities: string[];
}): string {
  return createHash("sha256").update(canonical({
    taskMode: input.taskMode,
    workspaceIds: [...input.workspaceIds],
    effectiveCapabilities: [...input.effectiveCapabilities].sort(),
  })).digest("hex");
}

export function validateIntentResolutionPolicy(
  resolutionInput: IntentResolution,
  plannerInput: IntentPlannerInput,
): IntentResolution {
  const resolution = intentResolutionSchema.parse(resolutionInput);
  assertProviderExecutionBinding(resolution.providerBinding);
  const issues: string[] = [];

  if (resolution.literalObjective !== plannerInput.literalObjective.trim()) {
    issues.push("INTENT_LITERAL_OBJECTIVE_CHANGED");
  }
  if (resolution.locale !== plannerInput.locale) {
    issues.push("INTENT_LOCALE_CHANGED");
  }
  if (resolution.taskMode !== plannerInput.taskMode) {
    issues.push("INTENT_TASK_MODE_ESCALATION");
  }
  if (resolution.authorityEcho.authorityFingerprint !== plannerInput.authorityFingerprint) {
    issues.push("INTENT_AUTHORITY_FINGERPRINT_MISMATCH");
  }
  if (JSON.stringify(resolution.authorityEcho.workspaceIds) !== JSON.stringify(plannerInput.workspaceIds)) {
    issues.push("INTENT_WORKSPACE_SET_CHANGED");
  }
  if (
    JSON.stringify([...resolution.authorityEcho.effectiveCapabilities].sort())
      !== JSON.stringify([...plannerInput.effectiveCapabilities].sort())
  ) {
    issues.push("INTENT_CAPABILITY_SET_CHANGED");
  }
  if (resolution.providerBinding.role !== "INTENT_PLANNER") {
    issues.push("INTENT_PROVIDER_ROLE_INVALID");
  }
  if (resolution.providerBinding.providerId !== plannerInput.providerBinding.providerId
    || resolution.providerBinding.modelId !== plannerInput.providerBinding.modelId
    || resolution.providerBinding.executionChannelId !== plannerInput.providerBinding.executionChannelId) {
    issues.push("INTENT_PROVIDER_BINDING_CHANGED");
  }

  if (issues.length) throw new Error(`INTENT_POLICY_BLOCKED:${issues.join(",")}`);
  return resolution;
}

export function confirmIntentResolution(resolutionInput: IntentResolution): ConfirmedIntentResolution {
  const resolution = intentResolutionSchema.parse(resolutionInput);
  if (resolution.needsClarification) throw new Error("INTENT_CLARIFICATION_REQUIRED");
  return {
    ...resolution,
    investigationQuestions: resolution.investigationQuestions.map(question => ({
      ...question,
      origin: question.origin === "AI_INFERRED" || question.origin === "SYSTEM_INFERRED"
        ? "OWNER_CONFIRMED"
        : question.origin,
    })),
    proposedRequirements: resolution.proposedRequirements.map(requirement => ({
      ...requirement,
      origin: requirement.origin === "AI_INFERRED" || requirement.origin === "SYSTEM_INFERRED"
        ? "OWNER_CONFIRMED"
        : requirement.origin,
    })),
  };
}

export function intentResolutionSha256(resolution: IntentResolution): string {
  return createHash("sha256").update(canonical(resolution)).digest("hex");
}

import {
  defaultModelForProvider,
  modelRegistry,
  runtimeProfileForProvider,
  runtimeProfileSupportsProvider,
  type ModelId,
  type ProviderId,
  type ReasoningProfile,
  type RuntimeProfileId,
  type TaskComplexity,
} from "@/core/providers/registry";
import type { TaskSemanticProfile } from "@/core/tasks/semantic-profile";

export const recommendationStatuses = [
  "RECOMMENDED",
  "SUPPORTED",
  "SUPPORTED_WITH_WARNING",
  "OWNER_DECISION_REQUIRED",
  "BLOCKED",
] as const;
export type RecommendationStatus = typeof recommendationStatuses[number];

export type ConfigurationRecommendation = {
  profileVersion: "0.2";
  assessmentStatus: "PRELIMINARY" | "ASSESSED";
  status: RecommendationStatus;
  selectedModelId: ModelId;
  recommendedModelId: ModelId;
  reasons: string[];
  recommendedActions: string[];
  ownerOverrideAccepted: boolean;
};

const rank: Record<TaskComplexity, number> = { LOW: 1, MEDIUM: 2, HIGH: 3 };
const matrix: Record<ProviderId, Record<TaskSemanticProfile["taskClass"], Record<TaskComplexity, ModelId>>> = {
  OPENAI: {
    REPORT_REVIEW: { LOW: "gpt-5.6-terra", MEDIUM: "gpt-5.6-terra", HIGH: "gpt-5.6-sol" },
    CONTROLLED_AUDIT: { LOW: "gpt-5.6-terra", MEDIUM: "gpt-5.6-terra", HIGH: "gpt-5.6-sol" },
    SOURCE_IMPLEMENTATION: { LOW: "gpt-5.6-terra", MEDIUM: "gpt-5.6-terra", HIGH: "gpt-5.6-sol" },
  },
  ANTHROPIC: {
    REPORT_REVIEW: { LOW: "claude-haiku-4-5-20251001", MEDIUM: "claude-sonnet-5", HIGH: "claude-opus-4-8" },
    CONTROLLED_AUDIT: { LOW: "claude-haiku-4-5-20251001", MEDIUM: "claude-sonnet-5", HIGH: "claude-opus-4-8" },
    SOURCE_IMPLEMENTATION: { LOW: "claude-sonnet-5", MEDIUM: "claude-sonnet-5", HIGH: "claude-opus-4-8" },
  },
  GOOGLE: {
    REPORT_REVIEW: { LOW: "gemini-3.1-flash-lite", MEDIUM: "gemini-3.6-flash", HIGH: "gemini-3.1-pro-preview" },
    CONTROLLED_AUDIT: { LOW: "gemini-3.6-flash", MEDIUM: "gemini-3.6-flash", HIGH: "gemini-3.1-pro-preview" },
    SOURCE_IMPLEMENTATION: { LOW: "gemini-3.6-flash", MEDIUM: "gemini-3.6-flash", HIGH: "gemini-3.1-pro-preview" },
  },
};

function taskReason(task: TaskSemanticProfile): string {
  if (task.assessmentStatus === "PRELIMINARY") {
    return `This is a preliminary routing recommendation based on task mode, authority, and approved scope counts; complexity and cross-file dependency are not assessed until bounded discovery.`;
  }
  if (task.taskClass === "REPORT_REVIEW") {
    return `This report review requires ${task.complexity.toLowerCase()} evidence analysis, identity binding, and claim verification without source modification.`;
  }
  if (task.taskClass === "CONTROLLED_AUDIT") {
    return `This controlled audit requires ${task.validationDepth.toLowerCase()} validation across the approved scope without repair authority.`;
  }
  return `This source implementation requires ${task.complexity.toLowerCase()} root-cause analysis${task.crossFileDependency === "YES" ? " across coupled files" : ""} and coherent regression validation.`;
}

export function evaluateConfiguration(input: {
  providerId: ProviderId;
  modelId: ModelId;
  reasoningProfile: ReasoningProfile;
  runtimeProfileId: RuntimeProfileId;
  task: TaskSemanticProfile;
  ownerOverrideAccepted: boolean;
}): ConfigurationRecommendation {
  const model = modelRegistry[input.modelId];
  const routingComplexity = input.task.routingComplexity;
  const recommendedModelId = matrix[input.providerId]?.[input.task.taskClass]?.[routingComplexity]
    ?? defaultModelForProvider(input.providerId);
  const base = {
    profileVersion: "0.2" as const,
    assessmentStatus: input.task.assessmentStatus,
    selectedModelId: input.modelId,
    recommendedModelId,
    ownerOverrideAccepted: input.ownerOverrideAccepted,
  };

  if (model.providerId !== input.providerId) {
    return {
      ...base,
      status: "BLOCKED",
      reasons: ["The selected model does not belong to the selected provider."],
      recommendedActions: ["Choose a model from the selected provider."],
      ownerOverrideAccepted: false,
    };
  }
  if (!runtimeProfileSupportsProvider(input.runtimeProfileId, input.providerId)) {
    return {
      ...base,
      status: "BLOCKED",
      reasons: ["The runtime profile is not supported by the selected provider."],
      recommendedActions: ["Choose a compatible runtime profile."],
      ownerOverrideAccepted: false,
    };
  }
  if (!model.allowedReasoningProfiles.includes(input.reasoningProfile)) {
    return {
      ...base,
      status: "BLOCKED",
      reasons: ["The selected reasoning profile is not supported by this model."],
      recommendedActions: [`Use ${model.defaultReasoningProfile}.`],
      ownerOverrideAccepted: false,
    };
  }

  const reasons = [taskReason(input.task)];
  const actions: string[] = [];
  const lifecycle = model.lifecycle === "PREVIEW" || model.lifecycle === "RESEARCH_PREVIEW";
  const unsuitable = rank[routingComplexity] > rank[model.maxRecommendedComplexity]
    || !model.recommendedTaskModes.includes(input.task.taskClass);
  const nonRecommended = input.modelId !== recommendedModelId;

  if (nonRecommended) {
    reasons.push(`${model.displayName} is supported, but ${modelRegistry[recommendedModelId].displayName} is the provisional routing fit for this task mode and authority profile.`);
    actions.push(
      `Use ${modelRegistry[recommendedModelId].displayName}.`,
      "Keep the selected model only with explicit owner acceptance.",
    );
  }
  if (unsuitable) {
    reasons.push("The selected model profile is outside the provisional routing range for this task.");
  }

  const runtime = runtimeProfileForProvider(input.runtimeProfileId, input.providerId);
  if (runtime.orchestrated && routingComplexity !== "HIGH") {
    reasons.push(`${runtime.displayName} is oversized for the current preliminary routing signal.`);
    actions.push("Use the Standard runtime profile.");
  }
  if (lifecycle) {
    reasons.push(`${model.displayName} is ${model.lifecycle.replaceAll("_", " ")}.`);
    actions.push("Use a stable model or explicitly approve the preview risk.");
    return {
      ...base,
      status: "OWNER_DECISION_REQUIRED",
      reasons,
      recommendedActions: Array.from(new Set(actions)),
    };
  }
  if (unsuitable || nonRecommended) {
    return {
      ...base,
      status: "SUPPORTED_WITH_WARNING",
      reasons,
      recommendedActions: Array.from(new Set(actions)),
    };
  }
  return {
    ...base,
    status: "RECOMMENDED",
    reasons,
    recommendedActions: ["Continue with the selected configuration."],
  };
}

export const providerIds = ["OPENAI", "ANTHROPIC", "GOOGLE"] as const;
export type ProviderId = (typeof providerIds)[number];

export const executionChannelIds = ["CODEX", "CLAUDE_CODE", "GEMINI_CLI"] as const;
export type ExecutionChannelId = (typeof executionChannelIds)[number];

export const reasoningProfiles = [
  "Auto",
  "Light",
  "Medium",
  "High",
  "Extra High",
  "Max",
  "Low",
  "XHigh",
] as const;
export type ReasoningProfile = (typeof reasoningProfiles)[number];

export const runtimeProfileIds = ["STANDARD", "CODEX_ULTRA", "CLAUDE_ULTRACODE"] as const;
export type RuntimeProfileId = (typeof runtimeProfileIds)[number];

export type RuntimeProfile = {
  id: RuntimeProfileId;
  providerId: ProviderId;
  displayName: string;
  profileVersion: "0.1";
  orchestrated: boolean;
  guidance: string[];
};

export const modelIds = [
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.3-codex-spark",
  "claude-fable-5",
  "claude-opus-4-8",
  "claude-sonnet-5",
  "claude-haiku-4-5-20251001",
  "gemini-3.5-flash",
  "gemini-3.6-flash",
  "gemini-3.1-pro-preview",
  "gemini-3.1-flash-lite",
] as const;
export type ModelId = (typeof modelIds)[number];

export type ModelLifecycle = "STABLE" | "SUPPORTED" | "PREVIEW" | "RESEARCH_PREVIEW";
export type TaskComplexity = "LOW" | "MEDIUM" | "HIGH";

export type ProviderProfile = {
  id: ProviderId;
  displayName: string;
  executionChannelId: ExecutionChannelId;
  executionChannelName: string;
  profileVersion: "0.1";
};

export type ModelProfile = {
  id: ModelId;
  providerId: ProviderId;
  displayName: string;
  lifecycle: ModelLifecycle;
  profileVersion: "0.1";
  catalogUpdatedAt: string;
  maxRecommendedComplexity: TaskComplexity;
  recommendedTaskModes: Array<"CONTROLLED_AUDIT" | "SOURCE_IMPLEMENTATION" | "REPORT_REVIEW">;
  allowedReasoningProfiles: ReasoningProfile[];
  defaultReasoningProfile: ReasoningProfile;
  guidance: string[];
};

export const providerRegistry: Record<ProviderId, ProviderProfile> = {
  OPENAI: {
    id: "OPENAI",
    displayName: "OpenAI",
    executionChannelId: "CODEX",
    executionChannelName: "Codex",
    profileVersion: "0.1",
  },
  ANTHROPIC: {
    id: "ANTHROPIC",
    displayName: "Anthropic",
    executionChannelId: "CLAUDE_CODE",
    executionChannelName: "Claude Code",
    profileVersion: "0.1",
  },
  GOOGLE: {
    id: "GOOGLE",
    displayName: "Google Gemini",
    executionChannelId: "GEMINI_CLI",
    executionChannelName: "Gemini CLI",
    profileVersion: "0.1",
  },
};

export const runtimeProfileRegistry: Record<RuntimeProfileId, RuntimeProfile> = {
  STANDARD: {
    id: "STANDARD",
    providerId: "OPENAI",
    displayName: "Standard",
    profileVersion: "0.1",
    orchestrated: false,
    guidance: ["Keep one primary agent responsible for the bounded outcome."],
  },
  CODEX_ULTRA: {
    id: "CODEX_ULTRA",
    providerId: "OPENAI",
    displayName: "Codex Ultra orchestration",
    profileVersion: "0.1",
    orchestrated: true,
    guidance: [
      "Use subagents only for genuinely independent workstreams.",
      "Keep the main agent responsible for integration, scope, and final validation.",
    ],
  },
  CLAUDE_ULTRACODE: {
    id: "CLAUDE_ULTRACODE",
    providerId: "ANTHROPIC",
    displayName: "Claude Ultracode orchestration",
    profileVersion: "0.1",
    orchestrated: true,
    guidance: [
      "Run with xhigh model effort and Claude Code workflow orchestration.",
      "Use dynamic workflows only when the task has substantive independent workstreams.",
    ],
  },
};

const openAiReasoning: ReasoningProfile[] = ["Light", "Medium", "High", "Extra High", "Max"];
const claudeReasoning: ReasoningProfile[] = ["Low", "Medium", "High", "XHigh", "Max"];

export const modelRegistry: Record<ModelId, ModelProfile> = {
  "gpt-5.6-sol": {
    id: "gpt-5.6-sol",
    providerId: "OPENAI",
    displayName: "GPT-5.6 Sol",
    lifecycle: "STABLE",
    profileVersion: "0.1",
    catalogUpdatedAt: "2026-07-20",
    maxRecommendedComplexity: "HIGH",
    recommendedTaskModes: ["CONTROLLED_AUDIT", "SOURCE_IMPLEMENTATION", "REPORT_REVIEW"],
    allowedReasoningProfiles: openAiReasoning,
    defaultReasoningProfile: "Medium",
    guidance: [
      "Use for ambiguous, high-value, or complex multi-step work.",
      "Define a bounded outcome and explicit done conditions.",
    ],
  },
  "gpt-5.6-terra": {
    id: "gpt-5.6-terra",
    providerId: "OPENAI",
    displayName: "GPT-5.6 Terra",
    lifecycle: "STABLE",
    profileVersion: "0.1",
    catalogUpdatedAt: "2026-07-20",
    maxRecommendedComplexity: "MEDIUM",
    recommendedTaskModes: ["CONTROLLED_AUDIT", "SOURCE_IMPLEMENTATION", "REPORT_REVIEW"],
    allowedReasoningProfiles: openAiReasoning,
    defaultReasoningProfile: "Medium",
    guidance: [
      "Use as the everyday balanced Codex model for bounded implementation and review.",
      "Escalate to Sol when ambiguity or cross-file coupling is high.",
    ],
  },
  "gpt-5.6-luna": {
    id: "gpt-5.6-luna",
    providerId: "OPENAI",
    displayName: "GPT-5.6 Luna",
    lifecycle: "STABLE",
    profileVersion: "0.1",
    catalogUpdatedAt: "2026-07-20",
    maxRecommendedComplexity: "LOW",
    recommendedTaskModes: ["REPORT_REVIEW", "CONTROLLED_AUDIT"],
    allowedReasoningProfiles: openAiReasoning,
    defaultReasoningProfile: "Light",
    guidance: [
      "Use for clear, repeatable, and tightly bounded tasks.",
      "Avoid assigning ambiguous multi-file remediation without reducing scope.",
    ],
  },
  "gpt-5.5": {
    id: "gpt-5.5",
    providerId: "OPENAI",
    displayName: "GPT-5.5",
    lifecycle: "SUPPORTED",
    profileVersion: "0.1",
    catalogUpdatedAt: "2026-07-20",
    maxRecommendedComplexity: "HIGH",
    recommendedTaskModes: ["CONTROLLED_AUDIT", "SOURCE_IMPLEMENTATION", "REPORT_REVIEW"],
    allowedReasoningProfiles: ["Light", "Medium", "High", "Max"],
    defaultReasoningProfile: "Medium",
    guidance: ["Use for pinned compatibility workflows; prefer a current GPT-5.6 model for new tasks."],
  },
  "gpt-5.4": {
    id: "gpt-5.4",
    providerId: "OPENAI",
    displayName: "GPT-5.4",
    lifecycle: "SUPPORTED",
    profileVersion: "0.1",
    catalogUpdatedAt: "2026-07-20",
    maxRecommendedComplexity: "HIGH",
    recommendedTaskModes: ["CONTROLLED_AUDIT", "SOURCE_IMPLEMENTATION", "REPORT_REVIEW"],
    allowedReasoningProfiles: ["Light", "Medium", "High", "Max"],
    defaultReasoningProfile: "Medium",
    guidance: ["Use for strong pinned compatibility workflows; do not silently replace an approved model."],
  },
  "gpt-5.4-mini": {
    id: "gpt-5.4-mini",
    providerId: "OPENAI",
    displayName: "GPT-5.4 Mini",
    lifecycle: "SUPPORTED",
    profileVersion: "0.1",
    catalogUpdatedAt: "2026-07-20",
    maxRecommendedComplexity: "LOW",
    recommendedTaskModes: ["REPORT_REVIEW", "CONTROLLED_AUDIT"],
    allowedReasoningProfiles: ["Light", "Medium", "High"],
    defaultReasoningProfile: "Light",
    guidance: ["Use for responsive coding support and bounded independent subagent work."],
  },
  "gpt-5.3-codex-spark": {
    id: "gpt-5.3-codex-spark",
    providerId: "OPENAI",
    displayName: "GPT-5.3 Codex Spark",
    lifecycle: "RESEARCH_PREVIEW",
    profileVersion: "0.1",
    catalogUpdatedAt: "2026-07-20",
    maxRecommendedComplexity: "LOW",
    recommendedTaskModes: ["REPORT_REVIEW"],
    allowedReasoningProfiles: ["Light", "Medium"],
    defaultReasoningProfile: "Light",
    guidance: ["Research preview for near-instant text-only coding iteration; explicit owner acceptance is required."],
  },
  "claude-fable-5": {
    id: "claude-fable-5",
    providerId: "ANTHROPIC",
    displayName: "Claude Fable 5",
    lifecycle: "STABLE",
    profileVersion: "0.1",
    catalogUpdatedAt: "2026-07-20",
    maxRecommendedComplexity: "HIGH",
    recommendedTaskModes: ["CONTROLLED_AUDIT", "SOURCE_IMPLEMENTATION"],
    allowedReasoningProfiles: claudeReasoning,
    defaultReasoningProfile: "High",
    guidance: [
      "Describe the required outcome rather than prescribing every step.",
      "Use for long-running ambiguous investigations and architecture work.",
    ],
  },
  "claude-opus-4-8": {
    id: "claude-opus-4-8",
    providerId: "ANTHROPIC",
    displayName: "Claude Opus 4.8",
    lifecycle: "STABLE",
    profileVersion: "0.1",
    catalogUpdatedAt: "2026-07-20",
    maxRecommendedComplexity: "HIGH",
    recommendedTaskModes: ["CONTROLLED_AUDIT", "SOURCE_IMPLEMENTATION", "REPORT_REVIEW"],
    allowedReasoningProfiles: claudeReasoning,
    defaultReasoningProfile: "High",
    guidance: ["Use for complex agentic coding and enterprise repository work."],
  },
  "claude-sonnet-5": {
    id: "claude-sonnet-5",
    providerId: "ANTHROPIC",
    displayName: "Claude Sonnet 5",
    lifecycle: "STABLE",
    profileVersion: "0.1",
    catalogUpdatedAt: "2026-07-20",
    maxRecommendedComplexity: "MEDIUM",
    recommendedTaskModes: ["CONTROLLED_AUDIT", "SOURCE_IMPLEMENTATION", "REPORT_REVIEW"],
    allowedReasoningProfiles: claudeReasoning,
    defaultReasoningProfile: "High",
    guidance: ["Use for the best balance of speed and intelligence in routine development work."],
  },
  "claude-haiku-4-5-20251001": {
    id: "claude-haiku-4-5-20251001",
    providerId: "ANTHROPIC",
    displayName: "Claude Haiku 4.5",
    lifecycle: "STABLE",
    profileVersion: "0.1",
    catalogUpdatedAt: "2026-07-20",
    maxRecommendedComplexity: "LOW",
    recommendedTaskModes: ["REPORT_REVIEW", "CONTROLLED_AUDIT"],
    allowedReasoningProfiles: ["Low", "Medium", "High"],
    defaultReasoningProfile: "Medium",
    guidance: ["Use for quick reviews, extraction, formatting, and bounded subagent work."],
  },
  "gemini-3.5-flash": {
    id: "gemini-3.5-flash",
    providerId: "GOOGLE",
    displayName: "Gemini 3.5 Flash",
    lifecycle: "STABLE",
    profileVersion: "0.1",
    catalogUpdatedAt: "2026-07-20",
    maxRecommendedComplexity: "HIGH",
    recommendedTaskModes: ["CONTROLLED_AUDIT", "SOURCE_IMPLEMENTATION", "REPORT_REVIEW"],
    allowedReasoningProfiles: ["Auto"],
    defaultReasoningProfile: "Auto",
    guidance: ["Use for sustained agentic and coding workflows with a concise final instruction."],
  },
  "gemini-3.6-flash": {
    id: "gemini-3.6-flash",
    providerId: "GOOGLE",
    displayName: "Gemini 3.6 Flash",
    lifecycle: "STABLE",
    profileVersion: "0.1",
    catalogUpdatedAt: "2026-07-23",
    maxRecommendedComplexity: "HIGH",
    recommendedTaskModes: ["CONTROLLED_AUDIT", "SOURCE_IMPLEMENTATION", "REPORT_REVIEW"],
    allowedReasoningProfiles: ["Auto"],
    defaultReasoningProfile: "Auto",
    guidance: ["Use for fast agentic, coding, and multimodal tasks when its pinned model ID fits the approved task.", "Do not treat this model as universally superior or silently replace an owner-selected model."],
  },
  "gemini-3.1-pro-preview": {
    id: "gemini-3.1-pro-preview",
    providerId: "GOOGLE",
    displayName: "Gemini 3.1 Pro Preview",
    lifecycle: "PREVIEW",
    profileVersion: "0.1",
    catalogUpdatedAt: "2026-07-20",
    maxRecommendedComplexity: "HIGH",
    recommendedTaskModes: ["CONTROLLED_AUDIT", "SOURCE_IMPLEMENTATION", "REPORT_REVIEW"],
    allowedReasoningProfiles: ["Auto"],
    defaultReasoningProfile: "Auto",
    guidance: ["Advanced reasoning and coding preview; explicit owner acceptance is required before contract approval."],
  },
  "gemini-3.1-flash-lite": {
    id: "gemini-3.1-flash-lite",
    providerId: "GOOGLE",
    displayName: "Gemini 3.1 Flash-Lite",
    lifecycle: "STABLE",
    profileVersion: "0.1",
    catalogUpdatedAt: "2026-07-20",
    maxRecommendedComplexity: "LOW",
    recommendedTaskModes: ["REPORT_REVIEW"],
    allowedReasoningProfiles: ["Auto"],
    defaultReasoningProfile: "Auto",
    guidance: ["Use for lightweight, high-volume, and low-latency tasks with explicit output requirements."],
  },
};

export function modelsForProvider(providerId: ProviderId): ModelProfile[] {
  return modelIds.map(id => modelRegistry[id]).filter(model => model.providerId === providerId);
}

export function providerForModel(modelId: ModelId): ProviderProfile {
  return providerRegistry[modelRegistry[modelId].providerId];
}

export function runtimeProfilesForProvider(providerId: ProviderId): RuntimeProfile[] {
  if (providerId === "OPENAI") return [runtimeProfileRegistry.STANDARD, runtimeProfileRegistry.CODEX_ULTRA];
  if (providerId === "ANTHROPIC") return [
    { ...runtimeProfileRegistry.STANDARD, providerId: "ANTHROPIC" },
    runtimeProfileRegistry.CLAUDE_ULTRACODE,
  ];
  return [{ ...runtimeProfileRegistry.STANDARD, providerId: "GOOGLE" }];
}

export function defaultRuntimeProfileForProvider(_providerId: ProviderId): RuntimeProfileId {
  return "STANDARD";
}

export function runtimeProfileSupportsProvider(profileId: RuntimeProfileId, providerId: ProviderId): boolean {
  if (profileId === "STANDARD") return true;
  return runtimeProfileRegistry[profileId].providerId === providerId;
}

export function runtimeProfileForProvider(profileId: RuntimeProfileId, providerId: ProviderId): RuntimeProfile {
  const profile = runtimeProfileRegistry[profileId];
  return profileId === "STANDARD" ? { ...profile, providerId } : profile;
}

export function defaultModelForProvider(providerId: ProviderId): ModelId {
  if (providerId === "ANTHROPIC") return "claude-sonnet-5";
  if (providerId === "GOOGLE") return "gemini-3.5-flash";
  return "gpt-5.6-terra";
}

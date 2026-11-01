import {
  modelRegistry,
  providerRegistry,
  type ExecutionChannelId,
  type ModelId,
  type ProviderId,
} from "@/core/providers/registry";
import type { AiRole, ProviderExecutionBinding } from "@/core/intelligence/intent-schema";

export const aiRoles: AiRole[] = ["INTENT_PLANNER", "DISCOVERY_INVESTIGATOR"];

/** Exactly one binding may be selected for each AI role. Roles are independent. */
export type AiRoleRouting = Partial<Record<AiRole, ProviderExecutionBinding>>;

export const aiAdapterIds = [
  "DETERMINISTIC_INTENT_BASELINE",
  "DETERMINISTIC_BOUNDED_DISCOVERY",
  "OPENAI_CODEX",
  "ANTHROPIC_CLAUDE_CODE",
  "GOOGLE_GEMINI_CLI",
] as const;
export type AiAdapterId = typeof aiAdapterIds[number];

export type AiAdapterProfile = {
  id: AiAdapterId;
  supportedRoles: AiRole[];
  providerId?: ProviderId;
  executionChannelId?: ExecutionChannelId;
  activation: "BUILT_IN" | "REQUIRES_EXTERNAL_ADAPTER";
};

export const aiAdapterRegistry: Record<AiAdapterId, AiAdapterProfile> = {
  DETERMINISTIC_INTENT_BASELINE: {
    id: "DETERMINISTIC_INTENT_BASELINE",
    supportedRoles: ["INTENT_PLANNER"],
    activation: "BUILT_IN",
  },
  DETERMINISTIC_BOUNDED_DISCOVERY: {
    id: "DETERMINISTIC_BOUNDED_DISCOVERY",
    supportedRoles: ["DISCOVERY_INVESTIGATOR"],
    activation: "BUILT_IN",
  },
  OPENAI_CODEX: {
    id: "OPENAI_CODEX",
    supportedRoles: ["INTENT_PLANNER", "DISCOVERY_INVESTIGATOR"],
    providerId: "OPENAI",
    executionChannelId: "CODEX",
    activation: "REQUIRES_EXTERNAL_ADAPTER",
  },
  ANTHROPIC_CLAUDE_CODE: {
    id: "ANTHROPIC_CLAUDE_CODE",
    supportedRoles: ["INTENT_PLANNER", "DISCOVERY_INVESTIGATOR"],
    providerId: "ANTHROPIC",
    executionChannelId: "CLAUDE_CODE",
    activation: "REQUIRES_EXTERNAL_ADAPTER",
  },
  GOOGLE_GEMINI_CLI: {
    id: "GOOGLE_GEMINI_CLI",
    supportedRoles: ["INTENT_PLANNER", "DISCOVERY_INVESTIGATOR"],
    providerId: "GOOGLE",
    executionChannelId: "GEMINI_CLI",
    activation: "REQUIRES_EXTERNAL_ADAPTER",
  },
};

export function assertProviderExecutionBinding(binding: ProviderExecutionBinding): void {
  const model = modelRegistry[binding.modelId];
  const provider = providerRegistry[binding.providerId];
  if (model.providerId !== binding.providerId) {
    throw new Error("AI_ROLE_MODEL_PROVIDER_MISMATCH");
  }
  if (provider.executionChannelId !== binding.executionChannelId) {
    throw new Error("AI_ROLE_EXECUTION_CHANNEL_MISMATCH");
  }
}

export function assertAdapterBinding(
  adapterId: AiAdapterId,
  binding: ProviderExecutionBinding,
): void {
  const adapter = aiAdapterRegistry[adapterId];
  if (!adapter.supportedRoles.includes(binding.role)) {
    throw new Error("AI_ADAPTER_ROLE_MISMATCH");
  }
  if (adapter.providerId && adapter.providerId !== binding.providerId) {
    throw new Error("AI_ADAPTER_PROVIDER_MISMATCH");
  }
  if (adapter.executionChannelId && adapter.executionChannelId !== binding.executionChannelId) {
    throw new Error("AI_ADAPTER_EXECUTION_CHANNEL_MISMATCH");
  }
  assertProviderExecutionBinding(binding);
}

/**
 * The routing map cannot contain competing providers for the same role because each
 * role is a single keyed slot. This assertion also validates every stored binding.
 */
export function assertSingleProviderPerRole(routing: AiRoleRouting): void {
  for (const role of aiRoles) {
    const binding = routing[role];
    if (!binding) continue;
    if (binding.role !== role) throw new Error("AI_ROLE_ROUTING_KEY_MISMATCH");
    assertProviderExecutionBinding(binding);
  }
}

export function providerBinding(
  role: AiRole,
  providerId: ProviderId,
  modelId: ModelId,
  executionChannelId: ExecutionChannelId,
): ProviderExecutionBinding {
  const binding = {
    role,
    providerId,
    modelId,
    executionChannelId,
  } satisfies ProviderExecutionBinding;
  assertProviderExecutionBinding(binding);
  return binding;
}

export function providerRoutingSummary(routing: AiRoleRouting): string[] {
  assertSingleProviderPerRole(routing);
  return aiRoles.flatMap(role => {
    const binding = routing[role];
    return binding
      ? [`${role}: ${binding.providerId}/${binding.executionChannelId}/${binding.modelId}`]
      : [];
  });
}

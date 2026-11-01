import { ChatCompletionsProviderAdapter } from "@/core/ai-context-mapper/adapters/chat-completions";
import { normalizeGenericChatCompletionsProviderError } from "@/core/ai-context-mapper/adapters/openai-compatible";
import { normalizeSambaNovaProviderError } from "@/core/ai-context-mapper/adapters/sambanova";
import { normalizeZaiProviderError } from "@/core/ai-context-mapper/adapters/zai";
import type { AiContextMapperProviderAdapter, AiContextMapperProviderAdapterV2 } from "@/core/ai-context-mapper/types";
import { isQualificationApplicableToEngine } from "@/core/ai-context-mapper/engine-registry";
import {
  isSupportedProtocolFamilyBehaviorProfile,
  isSupportedProtocolFamilyTransportProfile,
  resolveProtocolFamilyErrorNormalizerId,
} from "@/core/ai-context-mapper/protocol-family";
import {
  resolveInternalAiCredential,
  type ResolvedInternalAiEngineConfig,
} from "@/server/ai-context-mapper-config";
import { HttpCommandError } from "@/server/errors";

/**
 * V2 credential resolution path. When no credentialOverride is provided,
 * V2 MUST use the canonical secret resolver, NOT process.env.
 * V1 callers that still pass credentialOverride bypass the resolver.
 */
function resolveCredentialForAdapter(
  engine: ResolvedInternalAiEngineConfig,
  credentialOverride?: string,
): string {
  if (credentialOverride) {
    return credentialOverride;
  }
  // V1 legacy path: only reachable if caller did NOT provide credentialOverride
  // V2 callers MUST always provide credentialOverride (resolved via canonical resolver)
  return resolveInternalAiCredential(engine) ?? "";
}

export type InternalAiExecutionMode = "PRODUCTION" | "CANDIDATE_BENCHMARK" | "STANDBY_FAILOVER";

export type InternalAiAdapterFactoryOptions = {
  fetchImpl?: typeof fetch;
  credentialOverride?: string;
  executionMode?: InternalAiExecutionMode;
  expectedQualificationScope: import("@/core/ai-context-mapper/types").InternalAiQualificationScope;
};

export function isSupportedBehaviorProfile(profile: string): boolean {
  return isSupportedProtocolFamilyBehaviorProfile(profile);
}

export function isSupportedTransportProfile(profile: string): boolean {
  return isSupportedProtocolFamilyTransportProfile(profile);
}

function errorNormalizer(engine: ResolvedInternalAiEngineConfig) {
  const normalizerId = resolveProtocolFamilyErrorNormalizerId(engine.behaviorProfileId);
  if (normalizerId === "zai") return normalizeZaiProviderError;
  if (normalizerId === "sambanova") return normalizeSambaNovaProviderError;
  if (normalizerId === "generic_chat_completions") return normalizeGenericChatCompletionsProviderError;
  throw new HttpCommandError(503, "UNSUPPORTED_BEHAVIOR_PROFILE", `UNSUPPORTED_BEHAVIOR_PROFILE: Unsupported behavior profile ${engine.behaviorProfileId}.`);
}

function assertSupportedTransportProfile(transportProfileId: string): void {
  if (!isSupportedTransportProfile(transportProfileId)) {
    throw new HttpCommandError(503, "UNSUPPORTED_TRANSPORT_PROFILE", `UNSUPPORTED_TRANSPORT_PROFILE: Unsupported transport profile ${transportProfileId}.`);
  }
}

function executionAuthorization(
  engine: ResolvedInternalAiEngineConfig,
  mode: InternalAiExecutionMode,
  expectedQualificationScope: import("@/core/ai-context-mapper/types").InternalAiQualificationScope,
): { operationalRole: "PRIMARY" | "STANDBY"; authorized: boolean } {
  if (!expectedQualificationScope) {
    throw new HttpCommandError(503, "INTERNAL_AI_QUALIFICATION_SCOPE_REQUIRED", "Expected qualification scope is mandatory for execution authorization.");
  }
  if (mode === "CANDIDATE_BENCHMARK") {
    return { operationalRole: "PRIMARY", authorized: engine.role === "CANDIDATE" };
  }
  if (mode === "STANDBY_FAILOVER") {
    return {
      operationalRole: "STANDBY",
      authorized: engine.role === "STANDBY" && isQualificationApplicableToEngine(engine, engine.qualification, expectedQualificationScope),
    };
  }
  return {
    operationalRole: "PRIMARY",
    authorized: engine.role === "ACTIVE" && engine.ownerEnabled && isQualificationApplicableToEngine(engine, engine.qualification, expectedQualificationScope),
  };
}

export function createInternalAiProviderAdapter(
  engine: ResolvedInternalAiEngineConfig,
  options: InternalAiAdapterFactoryOptions,
): AiContextMapperProviderAdapter & AiContextMapperProviderAdapterV2 {
  if (!options || !options.expectedQualificationScope) {
    throw new HttpCommandError(503, "INTERNAL_AI_QUALIFICATION_SCOPE_REQUIRED", "Expected qualification scope is mandatory for runtime adapter creation.");
  }
  assertSupportedTransportProfile(engine.transportProfileId);
  const normalizer = errorNormalizer(engine);
  const credential = resolveCredentialForAdapter(engine, options.credentialOverride);
  const mode = options.executionMode ?? (engine.role === "CANDIDATE" ? "CANDIDATE_BENCHMARK" : engine.role === "STANDBY" ? "STANDBY_FAILOVER" : "PRODUCTION");
  const authorization = executionAuthorization(engine, mode, options.expectedQualificationScope);
  return new ChatCompletionsProviderAdapter({
    providerId: engine.providerId,
    channelId: engine.channelId,
    modelId: engine.modelId,
    endpoint: engine.endpoint,
    credential,
    transportProfileId: engine.transportProfileId,
    errorNormalizer: normalizer,
    enabled: authorization.authorized,
    executionAuthorized: authorization.authorized,
    operationalRole: authorization.operationalRole,
  }, options.fetchImpl);
}


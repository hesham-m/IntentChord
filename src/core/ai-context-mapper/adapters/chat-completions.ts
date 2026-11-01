import { ProviderTechnicalError } from "@/core/ai-context-mapper/errors";
import {
  type AiContextMapperProviderAdapter,
  type AiContextMapperProviderAdapterV2,
  type InternalAiTransportProfileId,
  type MappingProviderRequest,
  type NormalizedProviderErrorCode,
  type ProviderAttemptResponse,
  type ProviderId,
} from "@/core/ai-context-mapper/types";
import type { MappingProviderRequestV2 } from "@/core/ai-context-mapper/v2";
import { boundedProviderMessage, safeRateLimitHeaders, safeUsage } from "@/core/ai-context-mapper/adapters/provider-utils";

export type ChatCompletionsErrorNormalizer = (status: number, providerCode: string | undefined, operationalRole: "PRIMARY" | "STANDBY") => {
  code: NormalizedProviderErrorCode;
  retryable: boolean;
  failoverEligible: boolean;
};

export type ChatCompletionsAdapterConfig = {
  providerId: ProviderId;
  channelId: string;
  modelId: string;
  endpoint: string;
  credential: string;
  transportProfileId: InternalAiTransportProfileId;
  errorNormalizer: ChatCompletionsErrorNormalizer;
  enabled: boolean;
  executionAuthorized: boolean;
  operationalRole: "PRIMARY" | "STANDBY";
};

type FetchLike = typeof fetch;

function providerCodeFromBody(body: unknown): string | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const record = body as Record<string, unknown>;
  const direct = record.code;
  if (typeof direct === "string" || typeof direct === "number") return String(direct);
  const error = record.error;
  if (error && typeof error === "object" && !Array.isArray(error)) {
    const errorRecord = error as Record<string, unknown>;
    const code = errorRecord.code;
    if (typeof code === "string" || typeof code === "number") return String(code);
    const type = errorRecord.type;
    if (typeof type === "string" || typeof type === "number") return String(type);
  }
  const type = record.type;
  if (typeof type === "string" || typeof type === "number") return String(type);
  return undefined;
}

function responseFormat(profile: InternalAiTransportProfileId, schema: Record<string, unknown>): Record<string, unknown> {
  if (profile === "chat_completions_json_object_v1") return { type: "json_object" };
  return {
    type: "json_schema",
    json_schema: {
      name: "intentchord_context_catalog",
      strict: true,
      schema,
    },
  };
}

export class ChatCompletionsProviderAdapter implements AiContextMapperProviderAdapter, AiContextMapperProviderAdapterV2 {
  readonly provider_id: ProviderId;
  readonly channel_id: string;
  readonly model_id: string;

  constructor(
    private readonly config: ChatCompletionsAdapterConfig,
    private readonly fetchImpl: FetchLike = fetch,
  ) {
    this.provider_id = config.providerId;
    this.channel_id = config.channelId;
    this.model_id = config.modelId;
    if (!config.enabled || !config.executionAuthorized) {
      if (config.operationalRole === "PRIMARY") {
        throw new ProviderTechnicalError("MAPPER_CONFIGURATION_BLOCKED", "The configured Active Internal AI engine is not governance-qualified.", false, false);
      }
      return;
    }
    if (!config.credential.trim()) {
      const code = config.operationalRole === "PRIMARY" ? "PRIMARY_AUTH_MISSING_OR_INVALID" : "STANDBY_AUTH_INVALID";
      throw new ProviderTechnicalError(code, "The configured Internal AI engine credential is unavailable.", false, false);
    }
  }

  async execute(request: MappingProviderRequest | MappingProviderRequestV2): Promise<ProviderAttemptResponse> {
    if (!this.config.enabled || !this.config.executionAuthorized) {
      throw new ProviderTechnicalError("MAPPER_CONFIGURATION_BLOCKED", "This Internal AI engine is not enabled and explicitly authorized for execution.", false, false);
    }
    if (!this.config.credential.trim()) {
      const code = this.config.operationalRole === "PRIMARY" ? "PRIMARY_AUTH_MISSING_OR_INVALID" : "STANDBY_AUTH_INVALID";
      throw new ProviderTechnicalError(code, "The configured Internal AI engine credential is unavailable.", false, false);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), request.timeout_ms);
    let response: Response;
    try {
      response = await this.fetchImpl(this.config.endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.config.credential}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: this.model_id,
          messages: [
            { role: "system", content: request.system_prompt },
            { role: "user", content: request.user_payload },
          ],
          stream: false,
          response_format: responseFormat(this.config.transportProfileId, request.output_json_schema),
        }),
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        const code = this.config.operationalRole === "PRIMARY" ? "PRIMARY_NETWORK_TIMEOUT" : "STANDBY_NETWORK_TIMEOUT";
        throw new ProviderTechnicalError(code, "Internal AI provider request timed out.", this.config.operationalRole === "PRIMARY", this.config.operationalRole === "PRIMARY");
      }
      const code = this.config.operationalRole === "PRIMARY" ? "PRIMARY_PROVIDER_UNAVAILABLE" : "STANDBY_PROVIDER_UNAVAILABLE";
      throw new ProviderTechnicalError(code, "Internal AI provider network request failed.", this.config.operationalRole === "PRIMARY", this.config.operationalRole === "PRIMARY");
    } finally {
      clearTimeout(timeout);
    }

    const rawProviderBody = await response.text();
    let parsed: unknown;
    try { parsed = rawProviderBody ? JSON.parse(rawProviderBody) : {}; } catch { parsed = {}; }
    const providerCode = providerCodeFromBody(parsed);
    if (!response.ok) {
      const normalized = this.config.errorNormalizer(response.status, providerCode, this.config.operationalRole);
      throw new ProviderTechnicalError(
        normalized.code,
        boundedProviderMessage(this.provider_id, response.status, providerCode),
        normalized.retryable,
        normalized.failoverEligible,
        response.status,
        providerCode,
      );
    }

    const record = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    const providerError = record.error && typeof record.error === "object" && !Array.isArray(record.error)
      ? record.error as Record<string, unknown>
      : undefined;
    const safeProviderErrorMessage = typeof providerError?.message === "string"
      ? providerError.message.slice(0, 500)
      : null;
    const choices = Array.isArray(record.choices) ? record.choices : [];
    const first = choices[0] && typeof choices[0] === "object" && !Array.isArray(choices[0]) ? choices[0] as Record<string, unknown> : {};
    const message = first.message && typeof first.message === "object" && !Array.isArray(first.message) ? first.message as Record<string, unknown> : {};
    const rawModelContent = typeof message.content === "string" ? message.content : "";
    const reasoningChars =
      typeof message.reasoning === "string" ? message.reasoning.length
        : typeof message.reasoning_content === "string" ? message.reasoning_content.length
          : 0;
    const refusalChars = typeof message.refusal === "string" ? message.refusal.length : 0;
    const reasoningDetailsCount = Array.isArray(message.reasoning_details) ? message.reasoning_details.length : 0;
    const usageMetadata = {
      ...safeUsage(record.usage),
      diagnostic_choice_count: choices.length,
      diagnostic_finish_reason: typeof first.finish_reason === "string" ? first.finish_reason : null,
      diagnostic_native_finish_reason:
        typeof first.native_finish_reason === "string"
          ? first.native_finish_reason
          : typeof record.native_finish_reason === "string"
            ? record.native_finish_reason
            : null,
      diagnostic_content_chars: rawModelContent.length,
      diagnostic_reasoning_chars: reasoningChars,
      diagnostic_reasoning_details_count: reasoningDetailsCount,
      diagnostic_refusal_chars: refusalChars,
      diagnostic_provider_body_chars: rawProviderBody.length,
      diagnostic_top_level_keys: Object.keys(record).sort().slice(0, 24).map(key => key.slice(0, 64)),
      diagnostic_object: typeof record.object === "string" ? record.object : null,
      diagnostic_provider: typeof record.provider === "string" ? record.provider : null,
      diagnostic_error_present: Boolean(providerError),
      diagnostic_error_code:
        typeof providerError?.code === "string" || typeof providerError?.code === "number"
          ? String(providerError.code)
          : null,
      diagnostic_error_type:
        typeof providerError?.type === "string" || typeof providerError?.type === "number"
          ? String(providerError.type)
          : null,
      diagnostic_error_message: safeProviderErrorMessage,
    };

    return {
      raw_model_content: rawModelContent,
      ...(typeof record.model === "string" ? { response_model_id: record.model } : {}),
      ...(typeof record.id === "string" ? { provider_request_id: record.id } : {}),
      ...(typeof record.system_fingerprint === "string" ? { provider_system_fingerprint: record.system_fingerprint } : {}),
      usage_metadata: usageMetadata,
      rate_limit_metadata: safeRateLimitHeaders(response.headers),
      raw_provider_body: rawProviderBody,
    };
  }
}

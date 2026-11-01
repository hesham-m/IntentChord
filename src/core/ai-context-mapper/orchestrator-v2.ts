import { randomUUID } from "node:crypto";
import { mapperSha256 } from "@/core/ai-context-mapper/canonical";
import { isProviderTechnicalError, ProviderTechnicalError } from "@/core/ai-context-mapper/errors";
import {
  AI_CONTEXT_MAPPER_PROMPT_TEMPLATE_SHA256_V2,
  AI_CONTEXT_MAPPER_SYSTEM_PROMPT_V2,
  buildContextAssemblyMapperUserPayloadV2,
} from "@/core/ai-context-mapper/prompt-v2";
import { modelContextAnalysisV2JsonSchema } from "@/core/ai-context-mapper/schema-v2";
import { validateModelContextAnalysisV2 } from "@/core/ai-context-mapper/validator-v2";
import {
  CONTEXT_MAPPING_PROMPT_TEMPLATE_ID_V2,
  CONTEXT_MAPPING_RESULT_SCHEMA_VERSION_V2,
  CONTEXT_MAPPING_V2_QUALIFICATION_SCOPE,
  type ContextAssemblyMappingInputV2,
  type ContextMappingResultEnvelopeV2,
} from "@/core/ai-context-mapper/v2";
import type {
  AiContextMapperProviderAdapterV2,
  InternalAiProviderConfigurationSnapshotV3,
  NormalizedProviderErrorCode,
  ProviderAttemptResponse,
} from "@/core/ai-context-mapper/types";
import type { PostgresAiContextMappingV2Repository, ContextMappingV2RunView } from "@/server/ai-context-mapping-v2-repository";

export type AiContextMapperV2OrchestratorConfig = {
  providerConfigurationSnapshot: InternalAiProviderConfigurationSnapshotV3;
  standbyEnabled: boolean;
  standbyGovernanceQualified: boolean;
  assemblySha256: string;
  idempotencyKey: string;
  requestFingerprintSha256: string;
  primaryRequestTimeoutMs?: number;
  standbyRequestTimeoutMs?: number;
};

function validationErrorCode(standby: boolean): NormalizedProviderErrorCode {
  return standby ? "STANDBY_SCHEMA_INVALID" : "PRIMARY_SCHEMA_INVALID";
}

export class AiContextMapperV2Orchestrator {
  constructor(
    private readonly repository: PostgresAiContextMappingV2Repository,
    private readonly primary: AiContextMapperProviderAdapterV2,
    private readonly standby: AiContextMapperProviderAdapterV2 | undefined,
    private readonly config: AiContextMapperV2OrchestratorConfig,
  ) {
    const active = config.providerConfigurationSnapshot.active;
    if (active.qualification?.qualification_scope !== CONTEXT_MAPPING_V2_QUALIFICATION_SCOPE) throw new Error("PRIMARY_V2_QUALIFICATION_REQUIRED");
    if (primary.provider_id !== active.provider_id || primary.model_id !== active.model_id || primary.channel_id !== active.channel_id) {
      throw new Error("PRIMARY_ADAPTER_IDENTITY_MISMATCH");
    }
    const standbyIdentity = config.providerConfigurationSnapshot.standby;
    if (standby && (!standbyIdentity || standby.provider_id !== standbyIdentity.provider_id || standby.model_id !== standbyIdentity.model_id || standby.channel_id !== standbyIdentity.channel_id)) {
      throw new Error("STANDBY_ADAPTER_IDENTITY_MISMATCH");
    }
    if (config.standbyEnabled && (!config.standbyGovernanceQualified || !standby || !standbyIdentity || standbyIdentity.qualification?.qualification_scope !== CONTEXT_MAPPING_V2_QUALIFICATION_SCOPE)) {
      throw new Error("STANDBY_V2_CONFIGURATION_MISMATCH");
    }
  }

  async run(input: ContextAssemblyMappingInputV2): Promise<ContextMappingV2RunView> {
    const inputSha256 = mapperSha256(input);
    const existing = await this.repository.findIdempotentRun(this.config.idempotencyKey, this.config.requestFingerprintSha256);
    if (existing) return existing;
    const runId = randomUUID();
    await this.repository.createRun({
      id: runId,
      input,
      inputSha256,
      assemblySha256: this.config.assemblySha256,
      idempotencyKey: this.config.idempotencyKey,
      requestFingerprintSha256: this.config.requestFingerprintSha256,
      providerConfigurationSnapshot: this.config.providerConfigurationSnapshot,
      standbyEnabled: this.config.standbyEnabled,
      standbyGovernanceState: this.config.standbyGovernanceQualified ? "QUALIFIED" : "BLOCKED_BY_GOVERNANCE",
    });
    await this.repository.transitionRunStatus(runId, "INPUT_VALIDATED");
    const primary = await this.executeAttempt({ runId, ordinal: 1, adapter: this.primary, input, standby: false });
    if (primary.kind !== "technical_failure" || !primary.error.failoverEligible) return this.repository.readRun(runId);
    if (!this.config.standbyEnabled || !this.config.standbyGovernanceQualified) {
      await this.repository.transitionRunStatus(runId, "STANDBY_BLOCKED_GOVERNANCE", primary.attemptId);
      return this.repository.readRun(runId);
    }
    if (!this.standby) throw new Error("STANDBY_V2_CONFIGURATION_MISMATCH");
    await this.executeAttempt({ runId, ordinal: 2, adapter: this.standby, input, standby: true });
    return this.repository.readRun(runId);
  }

  private async executeAttempt(input: {
    runId: string; ordinal: number; adapter: AiContextMapperProviderAdapterV2; input: ContextAssemblyMappingInputV2; standby: boolean;
  }): Promise<{ kind: "success"; attemptId: string } | { kind: "validation_failure"; attemptId: string } | { kind: "technical_failure"; attemptId: string; error: ProviderTechnicalError }> {
    const attemptId = randomUUID();
    const startedAt = new Date().toISOString();
    await this.repository.startAttempt({
      id: attemptId, runId: input.runId, ordinal: input.ordinal, providerId: input.adapter.provider_id,
      channelId: input.adapter.channel_id, requestedModelId: input.adapter.model_id, startedAt,
      runStatus: input.standby ? "STANDBY_RUNNING" : "PRIMARY_RUNNING",
    });

    let response: ProviderAttemptResponse;
    let retryCount = 0;
    try {
      response = await this.executeProviderWithBoundedRetry(input.adapter, input.input, input.standby, value => { retryCount = value; });
    } catch (error) {
      const technical = isProviderTechnicalError(error)
        ? error
        : new ProviderTechnicalError("UNKNOWN_PROVIDER_ERROR", "Unexpected V2 provider execution failure.", false, false);
      const nextStatus: "PRIMARY_FAILED_TECHNICAL" | "FAILED" = !input.standby && technical.failoverEligible ? "PRIMARY_FAILED_TECHNICAL" : "FAILED";
      await this.repository.finalizeTechnicalAttempt({ attemptId, status: "FAILED_TECHNICAL", normalizedErrorCode: technical.normalizedCode, retryCount, completedAt: new Date().toISOString() }, nextStatus);
      return { kind: "technical_failure", attemptId, error: technical };
    }

    const validation = validateModelContextAnalysisV2(response.raw_model_content, input.input);
    if (validation.status !== "PASS" || !validation.parsed_analysis || !validation.parsed_analysis_sha256) {
      await this.repository.finalizeValidationFailure({
        attemptId, status: "FAILED_VALIDATION", normalizedErrorCode: validationErrorCode(input.standby),
        response, validation, retryCount, completedAt: new Date().toISOString(),
      });
      return { kind: "validation_failure", attemptId };
    }

    const completedAt = new Date().toISOString();
    const analysis = validation.parsed_analysis;
    const envelope: ContextMappingResultEnvelopeV2 = {
      schema_version: CONTEXT_MAPPING_RESULT_SCHEMA_VERSION_V2,
      qualification_scope: CONTEXT_MAPPING_V2_QUALIFICATION_SCOPE,
      context_assembly_id: input.input.context_assembly_id,
      context_assembly_revision_id: input.input.context_assembly_revision_id,
      mapping_run_id: input.runId,
      attempt_id: attemptId,
      attempt_ordinal: input.ordinal,
      provider_id: input.adapter.provider_id,
      channel_id: input.adapter.channel_id,
      requested_model_id: input.adapter.model_id,
      ...(response.response_model_id ? { response_model_id: response.response_model_id } : {}),
      ...(response.provider_request_id ? { provider_request_id: response.provider_request_id } : {}),
      ...(response.provider_system_fingerprint ? { provider_system_fingerprint_if_available: response.provider_system_fingerprint } : {}),
      provider_configuration_snapshot: this.config.providerConfigurationSnapshot,
      prompt_template_id: CONTEXT_MAPPING_PROMPT_TEMPLATE_ID_V2,
      prompt_template_sha256: AI_CONTEXT_MAPPER_PROMPT_TEMPLATE_SHA256_V2,
      raw_response_sha256: validation.raw_response_sha256,
      parsed_analysis_sha256: validation.parsed_analysis_sha256,
      started_at: startedAt,
      completed_at: completedAt,
      usage_metadata: response.usage_metadata,
      rate_limit_metadata: response.rate_limit_metadata,
      validation_result: validation,
      model_analysis: analysis,
    };
    await this.repository.finalizeSuccessfulAttempt({
      completion: { attemptId, status: "SUCCEEDED", response, validation, retryCount, completedAt },
      resultId: randomUUID(), runId: input.runId, assemblyRevisionId: input.input.context_assembly_revision_id,
      analysis, analysisSha256: validation.parsed_analysis_sha256, envelope, createdAt: completedAt,
    });
    return { kind: "success", attemptId };
  }

  private async executeProviderWithBoundedRetry(
    adapter: AiContextMapperProviderAdapterV2,
    mappingInput: ContextAssemblyMappingInputV2,
    standby: boolean,
    setRetryCount: (value: number) => void,
  ): Promise<ProviderAttemptResponse> {
    for (let invocation = 0; invocation < 2; invocation += 1) {
      try {
        return await adapter.execute({
          mapping_input: mappingInput,
          system_prompt: AI_CONTEXT_MAPPER_SYSTEM_PROMPT_V2,
          user_payload: buildContextAssemblyMapperUserPayloadV2(mappingInput),
          output_json_schema: modelContextAnalysisV2JsonSchema,
          timeout_ms: standby ? this.config.standbyRequestTimeoutMs ?? 60_000 : this.config.primaryRequestTimeoutMs ?? 60_000,
        });
      } catch (error) {
        if (!isProviderTechnicalError(error)) throw error;
        if (invocation === 0 && error.retryable && !standby) { setRetryCount(1); continue; }
        throw error;
      }
    }
    throw new ProviderTechnicalError(standby ? "STANDBY_PROVIDER_UNAVAILABLE" : "PRIMARY_PROVIDER_UNAVAILABLE", "Provider returned no response.", false, !standby);
  }
}

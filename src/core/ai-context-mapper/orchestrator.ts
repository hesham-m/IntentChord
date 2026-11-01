import { randomUUID } from "node:crypto";
import {
  AI_CONTEXT_MAPPER_PROMPT_TEMPLATE_SHA256,
  AI_CONTEXT_MAPPER_SYSTEM_PROMPT_V1,
  buildMapperUserPayload,
} from "@/core/ai-context-mapper/prompt";
import { mapperSha256 } from "@/core/ai-context-mapper/canonical";
import { assertMappingInputSnapshotIntegrity, mappingInputSemanticSha256 } from "@/core/ai-context-mapper/input-builder";
import { isProviderTechnicalError, ProviderTechnicalError } from "@/core/ai-context-mapper/errors";
import { modelProposedContextCatalogJsonSchema } from "@/core/ai-context-mapper/schema";
import { validateModelProposedCatalog } from "@/core/ai-context-mapper/validator";
import {
  MAPPING_RESULT_SCHEMA_VERSION,
  PROMPT_TEMPLATE_ID,
  type AiContextMapperProviderAdapter,
  type CatalogValidationResult,
  type ContextMappingResultEnvelope,
  type InternalAiProviderConfigurationSnapshotV3,
  type MappingAttemptView,
  type MappingInputSnapshot,
  type MappingProposalView,
  type MappingRunStatus,
  type MappingRunView,
  type NormalizedProviderErrorCode,
  type ProviderAttemptResponse,
  type ProviderId,
} from "@/core/ai-context-mapper/types";

export type CreateRunRecord = {
  id: string;
  input: MappingInputSnapshot;
  inputSha256: string;
  providerConfigurationSnapshot: InternalAiProviderConfigurationSnapshotV3;
  standbyEnabled: boolean;
  standbyGovernanceState: "BLOCKED_BY_GOVERNANCE" | "QUALIFIED";
};

export type CompleteAttemptRecord = {
  attemptId: string;
  status: MappingAttemptView["status"];
  normalizedErrorCode?: NormalizedProviderErrorCode;
  response?: ProviderAttemptResponse;
  validation?: CatalogValidationResult;
  retryCount: number;
  completedAt: string;
};

export type SuccessfulAttemptRecord = {
  completion: CompleteAttemptRecord & { status: "SUCCEEDED"; response: ProviderAttemptResponse; validation: CatalogValidationResult };
  proposal: {
    id: string;
    runId: string;
    attemptId: string;
    catalog: NonNullable<CatalogValidationResult["parsed_catalog"]>;
    validation: CatalogValidationResult;
    createdAt: string;
  };
  envelope: ContextMappingResultEnvelope;
};

export interface AiContextMappingRepository {
  createRun(record: CreateRunRecord): Promise<MappingRunView>;
  transitionRunStatus(runId: string, status: MappingRunStatus, finalAttemptId?: string): Promise<void>;
  startAttempt(input: { id: string; runId: string; ordinal: number; providerId: ProviderId; channelId: string; requestedModelId: string; startedAt: string; runStatus: "PRIMARY_RUNNING" | "STANDBY_RUNNING" }): Promise<void>;
  finalizeTechnicalAttempt(record: CompleteAttemptRecord & { status: "FAILED_TECHNICAL" }, runStatus: "PRIMARY_FAILED_TECHNICAL" | "FAILED"): Promise<MappingAttemptView>;
  finalizeValidationFailure(record: CompleteAttemptRecord & { status: "FAILED_VALIDATION" }): Promise<MappingAttemptView>;
  finalizeSuccessfulAttempt(record: SuccessfulAttemptRecord): Promise<MappingProposalView>;
  readRun(runId: string): Promise<MappingRunView>;
  listAttempts(runId: string): Promise<MappingAttemptView[]>;
  recordOwnerVerdict(input: { runId: string; verdict: "ACCEPT" | "REJECT"; note?: string; ownerAuthority: string; createdAt: string }): Promise<MappingRunView>;
}

export type OrchestratorConfig = {
  standbyEnabled: boolean;
  standbyGovernanceQualified: boolean;
  providerConfigurationSnapshot: InternalAiProviderConfigurationSnapshotV3;
  primaryRequestTimeoutMs?: number;
  standbyRequestTimeoutMs?: number;
};

function validationErrorCode(validation: CatalogValidationResult, standby: boolean): NormalizedProviderErrorCode {
  const failedGates = new Set(validation.gates.filter(item => item.status === "FAIL").map(item => item.gate));
  if (failedGates.has("JSON_PARSE")) return standby ? "STANDBY_RESPONSE_NOT_JSON" : "PRIMARY_RESPONSE_NOT_JSON";
  if (failedGates.has("ENTRY_COVERAGE_ACCOUNTING")) return standby ? "STANDBY_COVERAGE_INVALID" : "PRIMARY_COVERAGE_INVALID";
  if (["WORKSPACE_REFERENCE_INTEGRITY", "ENTRY_REFERENCE_INTEGRITY", "RELATIONSHIP_ENDPOINT_INTEGRITY", "NO_SELF_RELATIONSHIP"].some(gate => failedGates.has(gate as never))) {
    return standby ? "STANDBY_REFERENTIAL_INTEGRITY_FAILED" : "PRIMARY_REFERENTIAL_INTEGRITY_FAILED";
  }
  return standby ? "STANDBY_SCHEMA_INVALID" : "PRIMARY_SCHEMA_INVALID";
}

export class AiContextMapperOrchestrator {
  constructor(
    private readonly repository: AiContextMappingRepository,
    private readonly primary: AiContextMapperProviderAdapter,
    private readonly standby: AiContextMapperProviderAdapter | undefined,
    private readonly config: OrchestratorConfig,
  ) {
    const active = config.providerConfigurationSnapshot.active;
    if (primary.provider_id !== active.provider_id || primary.model_id !== active.model_id || primary.channel_id !== active.channel_id) {
      throw new Error("PRIMARY_ADAPTER_IDENTITY_MISMATCH");
    }
    const standbyIdentity = config.providerConfigurationSnapshot.standby;
    if (standby && (!standbyIdentity || standby.provider_id !== standbyIdentity.provider_id || standby.model_id !== standbyIdentity.model_id || standby.channel_id !== standbyIdentity.channel_id)) {
      throw new Error("STANDBY_ADAPTER_IDENTITY_MISMATCH");
    }
    if (config.standbyEnabled && (!config.standbyGovernanceQualified || !standby || !standbyIdentity)) {
      throw new Error("STANDBY_CONFIGURATION_MISMATCH");
    }
  }

  async run(input: MappingInputSnapshot): Promise<MappingRunView> {
    const governedInput = assertMappingInputSnapshotIntegrity(input);
    const runId = randomUUID();
    await this.repository.createRun({
      id: runId,
      input: governedInput,
      inputSha256: mappingInputSemanticSha256(governedInput),
      providerConfigurationSnapshot: this.config.providerConfigurationSnapshot,
      standbyEnabled: this.config.standbyEnabled,
      standbyGovernanceState: this.config.standbyGovernanceQualified ? "QUALIFIED" : "BLOCKED_BY_GOVERNANCE",
    });
    await this.repository.transitionRunStatus(runId, "INPUT_VALIDATED");
    const primaryResult = await this.executeAttempt({ runId, ordinal: 1, adapter: this.primary, input: governedInput, standby: false });
    if (primaryResult.kind !== "technical_failure" || !primaryResult.error.failoverEligible) return this.repository.readRun(runId);
    if (!this.config.standbyEnabled || !this.config.standbyGovernanceQualified) {
      await this.repository.transitionRunStatus(runId, "STANDBY_BLOCKED_GOVERNANCE", primaryResult.attemptId);
      return this.repository.readRun(runId);
    }
    if (!this.standby) throw new Error("STANDBY_CONFIGURATION_MISMATCH");
    await this.executeAttempt({ runId, ordinal: 2, adapter: this.standby, input: governedInput, standby: true });
    return this.repository.readRun(runId);
  }

  private async executeAttempt(input: {
    runId: string;
    ordinal: number;
    adapter: AiContextMapperProviderAdapter;
    input: MappingInputSnapshot;
    standby: boolean;
  }): Promise<{ kind: "success"; attemptId: string } | { kind: "validation_failure"; attemptId: string } | { kind: "technical_failure"; attemptId: string; error: ProviderTechnicalError }> {
    const attemptId = randomUUID();
    const startedAt = new Date().toISOString();
    await this.repository.startAttempt({
      id: attemptId,
      runId: input.runId,
      ordinal: input.ordinal,
      providerId: input.adapter.provider_id,
      channelId: input.adapter.channel_id,
      requestedModelId: input.adapter.model_id,
      startedAt,
      runStatus: input.standby ? "STANDBY_RUNNING" : "PRIMARY_RUNNING",
    });

    let response: ProviderAttemptResponse;
    let retryCount = 0;
    try {
      response = await this.executeProviderWithBoundedRetry(input.adapter, input.input, input.standby, value => { retryCount = value; });
    } catch (error) {
      const technical = isProviderTechnicalError(error)
        ? error
        : new ProviderTechnicalError("UNKNOWN_PROVIDER_ERROR", "Unexpected provider execution failure.", false, false);
      const nextStatus: "PRIMARY_FAILED_TECHNICAL" | "FAILED" = !input.standby && technical.failoverEligible ? "PRIMARY_FAILED_TECHNICAL" : "FAILED";
      await this.repository.finalizeTechnicalAttempt({
        attemptId,
        status: "FAILED_TECHNICAL",
        normalizedErrorCode: technical.normalizedCode,
        retryCount,
        completedAt: new Date().toISOString(),
      }, nextStatus);
      return { kind: "technical_failure", attemptId, error: technical };
    }

    const validation = validateModelProposedCatalog(response.raw_model_content, input.input);
    if (validation.status !== "PASS" || !validation.parsed_catalog || !validation.parsed_catalog_sha256) {
      await this.repository.finalizeValidationFailure({
        attemptId,
        status: "FAILED_VALIDATION",
        normalizedErrorCode: validationErrorCode(validation, input.standby),
        response,
        validation,
        retryCount,
        completedAt: new Date().toISOString(),
      });
      return { kind: "validation_failure", attemptId };
    }

    const completedAt = new Date().toISOString();
    const envelope: ContextMappingResultEnvelope = {
      schema_version: MAPPING_RESULT_SCHEMA_VERSION,
      mapping_run_id: input.runId,
      mapping_input_snapshot_id: input.input.mapping_input_snapshot_id,
      mapping_input_sha256: mappingInputSemanticSha256(input.input),
      attempt_id: attemptId,
      attempt_ordinal: input.ordinal,
      provider_id: input.adapter.provider_id,
      channel_id: input.adapter.channel_id,
      requested_model_id: input.adapter.model_id,
      ...(response.response_model_id ? { response_model_id: response.response_model_id } : {}),
      ...(response.provider_request_id ? { provider_request_id: response.provider_request_id } : {}),
      ...(response.provider_system_fingerprint ? { provider_system_fingerprint_if_available: response.provider_system_fingerprint } : {}),
      prompt_template_id: PROMPT_TEMPLATE_ID,
      prompt_template_sha256: AI_CONTEXT_MAPPER_PROMPT_TEMPLATE_SHA256,
      raw_response_sha256: validation.raw_response_sha256,
      parsed_catalog_sha256: validation.parsed_catalog_sha256,
      started_at: startedAt,
      completed_at: completedAt,
      usage_metadata: response.usage_metadata,
      rate_limit_metadata: response.rate_limit_metadata,
      validation_result: validation,
      model_proposal: validation.parsed_catalog,
    };
    await this.repository.finalizeSuccessfulAttempt({
      completion: { attemptId, status: "SUCCEEDED", response, validation, retryCount, completedAt },
      proposal: { id: randomUUID(), runId: input.runId, attemptId, catalog: validation.parsed_catalog, validation, createdAt: completedAt },
      envelope,
    });
    return { kind: "success", attemptId };
  }

  private async executeProviderWithBoundedRetry(
    adapter: AiContextMapperProviderAdapter,
    mappingInput: MappingInputSnapshot,
    standby: boolean,
    setRetryCount: (value: number) => void,
  ): Promise<ProviderAttemptResponse> {
    for (let invocation = 0; invocation < 2; invocation += 1) {
      try {
        return await adapter.execute({
          mapping_input: mappingInput,
          system_prompt: AI_CONTEXT_MAPPER_SYSTEM_PROMPT_V1,
          user_payload: buildMapperUserPayload(mappingInput),
          output_json_schema: modelProposedContextCatalogJsonSchema,
          timeout_ms: standby
            ? this.config.standbyRequestTimeoutMs ?? 60_000
            : this.config.primaryRequestTimeoutMs ?? 60_000,
        });
      } catch (error) {
        if (!isProviderTechnicalError(error)) throw error;
        if (invocation === 0 && error.retryable && !standby) {
          setRetryCount(1);
          continue;
        }
        throw error;
      }
    }
    throw new ProviderTechnicalError(standby ? "STANDBY_PROVIDER_UNAVAILABLE" : "PRIMARY_PROVIDER_UNAVAILABLE", "Provider returned no response.", false, !standby);
  }
}

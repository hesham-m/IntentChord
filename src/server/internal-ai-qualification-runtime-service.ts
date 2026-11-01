import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { isProviderTechnicalError } from "@/core/ai-context-mapper/errors";
import {
  INTERNAL_AI_QUALIFICATION_SCOPE_V2,
  type InternalAiEngineDefinition,
  type InternalAiQualificationRecord,
} from "@/core/ai-context-mapper/types";
import { createInternalAiProviderAdapter } from "@/server/internal-ai-engine-runtime";
import {
  resolveV2InternalAiCredential,
  type ResolvedInternalAiEngineConfig,
} from "@/server/ai-context-mapper-config";
import { databaseQuery } from "@/server/db";
import { HttpCommandError } from "@/server/errors";
import { internalAiEngineRegistryService } from "@/server/internal-ai-engine-registry-service";

const QUALIFICATION_PROBE_VERSION = "intentchord.internal-ai-runtime-qualification.v1" as const;
const QUALIFICATION_PROBE_TOKEN = "INTENTCHORD_RUNTIME_VALIDATION_V1" as const;

type ValidationOutcome = "PASS" | "FAIL";

type RuntimeValidationEvidence = {
  schemaVersion: typeof QUALIFICATION_PROBE_VERSION;
  outcome: ValidationOutcome;
  observedAt: string;
  actorAuthority: string;
  engine: {
    engineId: string;
    engineConfigRevision: string;
    engineConfigurationSha256: string;
    vendorId: string | null;
    providerId: string;
    channelId: string;
    modelId: string;
    endpoint: string;
    credentialReference: string;
    transportProfileId: string;
    behaviorProfileId: string;
    capabilityProfileVersion: string;
    timeoutMs: number;
  };
  runtime: {
    elapsedMs: number;
    responseModelId?: string;
    providerRequestIdPresent?: boolean;
    usageMetadata?: unknown;
    normalizedErrorCode?: string;
    httpStatus?: number;
    providerCode?: string;
    message?: string;
  };
  probe?: {
    status: string;
    probe: string;
  };
};

export type InternalAiValidateAndQualifyResult = {
  status: "QUALIFIED" | "ALREADY_QUALIFIED";
  engineId: string;
  engineConfigRevision: string;
  engineConfigurationSha256: string;
  elapsedMs: number;
  responseModelId?: string;
  providerRequestIdPresent: boolean;
  evidenceReference: string;
  qualification: InternalAiQualificationRecord;
};

type RuntimeValidationDependencies = {
  fetchImpl?: typeof fetch;
  evidenceRoot?: string;
};

function safeFileSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120) || "unknown";
}

function evidenceDirectory(explicit?: string): string {
  const configured = explicit?.trim() || process.env.INTENTCHORD_RUNTIME_EVIDENCE_DIR?.trim();
  return configured || resolve(process.cwd(), "..", "IntentChord-logs");
}

async function persistEvidence(
  evidence: RuntimeValidationEvidence,
  rootOverride?: string,
): Promise<string> {
  const root = evidenceDirectory(rootOverride);
  await mkdir(root, { recursive: true });
  const timestamp = evidence.observedAt.replace(/[:.]/g, "-");
  const fileName = [
    "INTENTCHORD_INTERNAL_AI_QUALIFICATION",
    safeFileSegment(evidence.engine.engineId),
    `REV-${safeFileSegment(evidence.engine.engineConfigRevision)}`,
    evidence.outcome,
    timestamp,
  ].join("_") + ".json";
  const path = resolve(root, fileName);
  await writeFile(path, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  return path;
}

function validationEngine(revision: InternalAiEngineDefinition): ResolvedInternalAiEngineConfig {
  return {
    ...revision,
    role: "CANDIDATE",
    ownerEnabled: true,
  };
}

function baseEvidence(revision: InternalAiEngineDefinition, actorAuthority: string): Omit<RuntimeValidationEvidence, "outcome" | "observedAt" | "runtime"> {
  return {
    schemaVersion: QUALIFICATION_PROBE_VERSION,
    actorAuthority,
    engine: {
      engineId: revision.engineId,
      engineConfigRevision: revision.engineConfigRevision,
      engineConfigurationSha256: revision.engineConfigurationSha256,
      vendorId: revision.vendorId ?? null,
      providerId: revision.providerId,
      channelId: revision.channelId,
      modelId: revision.modelId,
      endpoint: revision.endpoint,
      credentialReference: revision.credentialReference,
      transportProfileId: revision.transportProfileId,
      behaviorProfileId: revision.behaviorProfileId,
      capabilityProfileVersion: revision.capabilityProfileVersion,
      timeoutMs: revision.timeoutMs,
    },
  };
}

async function assertCurrentVendorModelEligibility(revision: InternalAiEngineDefinition): Promise<void> {
  const vendorId = revision.vendorId ?? revision.providerId;
  const vendor = await databaseQuery<{ vendor_state: string }>(
    `SELECT vendor_state FROM intentchord.internal_ai_vendors WHERE vendor_id = $1`,
    [vendorId],
  );
  if (!vendor.rowCount) {
    throw new HttpCommandError(409, "QUALIFICATION_VENDOR_NOT_FOUND", `Vendor ${vendorId} is not registered.`);
  }
  if (vendor.rows[0].vendor_state !== "ENABLED") {
    throw new HttpCommandError(409, "QUALIFICATION_VENDOR_NOT_ENABLED", `Vendor ${vendorId} is not ENABLED.`);
  }

  const model = await databaseQuery<{ model_state: string }>(
    `SELECT model_state FROM intentchord.internal_ai_models
      WHERE vendor_id = $1 AND (model_id = $2 OR provider_facing_model_id = $2)`,
    [vendorId, revision.modelId],
  );
  if (!model.rowCount) {
    throw new HttpCommandError(409, "QUALIFICATION_MODEL_NOT_FOUND", `Model ${revision.modelId} is not registered under Vendor ${vendorId}.`);
  }
  if (model.rows[0].model_state !== "ENABLED") {
    throw new HttpCommandError(409, "QUALIFICATION_MODEL_NOT_ENABLED", `Model ${revision.modelId} is not ENABLED.`);
  }
}

export function parseQualificationProbe(rawModelContent: string): { status: string; probe: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawModelContent);
  } catch {
    throw new HttpCommandError(422, "QUALIFICATION_RESPONSE_NOT_JSON", "Provider validation response was not valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HttpCommandError(422, "QUALIFICATION_RESPONSE_INVALID", "Provider validation response was not a JSON object.");
  }
  const record = parsed as Record<string, unknown>;
  const status = typeof record.status === "string" ? record.status : "";
  const probe = typeof record.probe === "string" ? record.probe : "";
  if (status !== "PASS" || probe !== QUALIFICATION_PROBE_TOKEN) {
    throw new HttpCommandError(422, "QUALIFICATION_PROBE_MISMATCH", "Provider validation response did not satisfy the governed qualification probe.");
  }
  return { status, probe };
}

export async function validateAndQualifyInternalAiEngine(
  input: { engineId: string; engineConfigRevision: string },
  actorAuthority: string,
  dependencies: RuntimeValidationDependencies = {},
): Promise<InternalAiValidateAndQualifyResult> {
  const engineId = input.engineId?.trim();
  const revisionId = input.engineConfigRevision?.trim();
  if (!engineId || /\s/.test(engineId) || engineId.length > 200) {
    throw new HttpCommandError(400, "INVALID_ENGINE_ID", "engineId must be a non-empty bounded string without whitespace.");
  }
  if (!revisionId || /\s/.test(revisionId) || revisionId.length > 200) {
    throw new HttpCommandError(400, "INVALID_ENGINE_CONFIG_REVISION", "engineConfigRevision must be a non-empty bounded string without whitespace.");
  }

  const detail = await internalAiEngineRegistryService.getEngine(engineId);
  if (!detail) throw new HttpCommandError(404, "ENGINE_NOT_FOUND", `Engine ${engineId} is not registered.`);
  if (detail.state !== "ENABLED") {
    throw new HttpCommandError(409, "QUALIFICATION_ENGINE_NOT_ENABLED", `Engine ${engineId} is not ENABLED.`);
  }

  const revision = detail.revisions.find(item => item.engineConfigRevision === revisionId);
  if (!revision) {
    throw new HttpCommandError(404, "ENGINE_REVISION_NOT_FOUND", `Engine revision ${engineId}@${revisionId} does not exist.`);
  }

  const existing = detail.qualifications.find(item =>
    item.engineConfigRevision === revision.engineConfigRevision
    && item.engineConfigurationSha256 === revision.engineConfigurationSha256
    && item.capabilityProfileVersion === revision.capabilityProfileVersion
    && item.qualificationScope === INTERNAL_AI_QUALIFICATION_SCOPE_V2
    && item.qualificationStatus === "QUALIFIED",
  );
  if (existing) {
    return {
      status: "ALREADY_QUALIFIED",
      engineId,
      engineConfigRevision: revisionId,
      engineConfigurationSha256: revision.engineConfigurationSha256,
      elapsedMs: 0,
      providerRequestIdPresent: false,
      evidenceReference: existing.evidenceReference,
      qualification: existing,
    };
  }

  await assertCurrentVendorModelEligibility(revision);

  const credential = await resolveV2InternalAiCredential(revision.credentialReference);
  if (!credential?.trim()) {
    const observedAt = new Date().toISOString();
    const evidenceReference = await persistEvidence({
      ...baseEvidence(revision, actorAuthority),
      outcome: "FAIL",
      observedAt,
      runtime: {
        elapsedMs: 0,
        normalizedErrorCode: "QUALIFICATION_CREDENTIAL_UNAVAILABLE",
        message: "Credential was unavailable from the canonical secret authority.",
      },
    }, dependencies.evidenceRoot);
    throw new HttpCommandError(422, "QUALIFICATION_CREDENTIAL_UNAVAILABLE", "Credential is unavailable for runtime validation.", { evidenceReference });
  }

  const adapter = createInternalAiProviderAdapter(validationEngine(revision), {
    fetchImpl: dependencies.fetchImpl,
    credentialOverride: credential,
    executionMode: "CANDIDATE_BENCHMARK",
    expectedQualificationScope: INTERNAL_AI_QUALIFICATION_SCOPE_V2,
  });

  const startedAt = Date.now();
  const observedAt = new Date().toISOString();
  try {
    const response = await adapter.execute({
      mapping_input: {} as never,
      system_prompt: "You are an IntentChord qualification probe. Return only JSON that exactly matches the supplied schema. Do not add commentary.",
      user_payload: JSON.stringify({
        instruction: "Return the exact governed validation values.",
        status: "PASS",
        probe: QUALIFICATION_PROBE_TOKEN,
      }),
      output_json_schema: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["PASS"] },
          probe: { type: "string", enum: [QUALIFICATION_PROBE_TOKEN] },
        },
        required: ["status", "probe"],
        additionalProperties: false,
      },
      timeout_ms: revision.timeoutMs,
    } as never);
    const elapsedMs = Date.now() - startedAt;
    const probe = parseQualificationProbe(response.raw_model_content);
    const evidenceReference = await persistEvidence({
      ...baseEvidence(revision, actorAuthority),
      outcome: "PASS",
      observedAt,
      runtime: {
        elapsedMs,
        ...(response.response_model_id ? { responseModelId: response.response_model_id } : {}),
        providerRequestIdPresent: Boolean(response.provider_request_id),
        usageMetadata: response.usage_metadata,
      },
      probe,
    }, dependencies.evidenceRoot);

    const qualification = await internalAiEngineRegistryService.qualifyEngine({
      engineId,
      engineConfigRevision: revision.engineConfigRevision,
      engineConfigurationSha256: revision.engineConfigurationSha256,
      qualificationScope: INTERNAL_AI_QUALIFICATION_SCOPE_V2,
      qualificationStatus: "QUALIFIED",
      evidenceReference,
      capabilityProfileVersion: revision.capabilityProfileVersion,
    }, actorAuthority);

    return {
      status: "QUALIFIED",
      engineId,
      engineConfigRevision: revision.engineConfigRevision,
      engineConfigurationSha256: revision.engineConfigurationSha256,
      elapsedMs,
      ...(response.response_model_id ? { responseModelId: response.response_model_id } : {}),
      providerRequestIdPresent: Boolean(response.provider_request_id),
      evidenceReference,
      qualification,
    };
  } catch (error) {
    if (error instanceof HttpCommandError && ["QUALIFICATION_RESPONSE_NOT_JSON", "QUALIFICATION_RESPONSE_INVALID", "QUALIFICATION_PROBE_MISMATCH"].includes(error.code)) {
      const elapsedMs = Date.now() - startedAt;
      const evidenceReference = await persistEvidence({
        ...baseEvidence(revision, actorAuthority),
        outcome: "FAIL",
        observedAt,
        runtime: {
          elapsedMs,
          normalizedErrorCode: error.code,
          message: error.message,
        },
      }, dependencies.evidenceRoot);
      throw new HttpCommandError(422, error.code, error.message, { evidenceReference });
    }
    if (isProviderTechnicalError(error)) {
      const elapsedMs = Date.now() - startedAt;
      const evidenceReference = await persistEvidence({
        ...baseEvidence(revision, actorAuthority),
        outcome: "FAIL",
        observedAt,
        runtime: {
          elapsedMs,
          normalizedErrorCode: error.normalizedCode,
          ...(error.httpStatus ? { httpStatus: error.httpStatus } : {}),
          ...(error.providerCode ? { providerCode: error.providerCode } : {}),
          message: error.message,
        },
      }, dependencies.evidenceRoot);
      throw new HttpCommandError(422, "QUALIFICATION_EXTERNAL_VALIDATION_FAILED", error.message, {
        evidenceReference,
        normalizedErrorCode: error.normalizedCode,
        httpStatus: error.httpStatus,
        providerCode: error.providerCode,
      });
    }
    throw error;
  } finally {
    // Do not retain the resolved secret beyond the scoped runtime attempt.
  }
}

import { createHash } from "node:crypto";
import {
  INTERNAL_AI_ENGINE_CONFIGURATION_IDENTITY_VERSION,
  INTERNAL_AI_QUALIFICATION_SCOPE,
  type InternalAiQualificationScope,
  INTERNAL_AI_SELECTION_POLICY_MODE,
  type InternalAiEngineConfigurationMaterial,
  type InternalAiEngineDefinition,
  type InternalAiQualificationRecord,
  type InternalAiSelectionPolicy,
} from "@/core/ai-context-mapper/types";

export type ResolvedQualifiedInternalAiEngine = {
  engine: InternalAiEngineDefinition;
  qualification: InternalAiQualificationRecord;
};

export class InternalAiEngineRegistryError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}

function engineKey(engineId: string, engineConfigRevision: string): string {
  return `${engineId}\u0000${engineConfigRevision}`;
}

function qualificationTargetKey(record: Pick<InternalAiQualificationRecord, "engineId" | "engineConfigRevision" | "qualificationScope">): string {
  return `${record.engineId}\u0000${record.engineConfigRevision}\u0000${record.qualificationScope}`;
}

function lengthPrefixed(name: string, value: string): string {
  return `${name}=${Buffer.byteLength(value, "utf8")}:${value}`;
}

/**
 * Deterministic, non-secret identity material for an exact governed Engine configuration.
 * Credential secret VALUES are intentionally absent; only the trusted credential reference participates.
 * Keep this ordered representation in exact sync with Migration 013 SQL recomputation.
 */
export function internalAiEngineConfigurationIdentityMaterial(engine: InternalAiEngineConfigurationMaterial): string {
  return [
    INTERNAL_AI_ENGINE_CONFIGURATION_IDENTITY_VERSION,
    lengthPrefixed("engineId", engine.engineId),
    lengthPrefixed("engineConfigRevision", engine.engineConfigRevision),
    lengthPrefixed("providerId", engine.providerId),
    lengthPrefixed("channelId", engine.channelId),
    lengthPrefixed("modelId", engine.modelId),
    lengthPrefixed("endpoint", engine.endpoint),
    lengthPrefixed("credentialReference", engine.credentialReference),
    lengthPrefixed("transportProfileId", engine.transportProfileId),
    lengthPrefixed("behaviorProfileId", engine.behaviorProfileId),
    lengthPrefixed("capabilityProfileVersion", engine.capabilityProfileVersion),
    lengthPrefixed("timeoutMs", String(engine.timeoutMs)),
  ].join("\n");
}

export function deriveInternalAiEngineConfigurationSha256(engine: InternalAiEngineConfigurationMaterial): string {
  return `sha256:${createHash("sha256").update(internalAiEngineConfigurationIdentityMaterial(engine), "utf8").digest("hex")}`;
}

export function bindInternalAiEngineConfiguration(engine: InternalAiEngineConfigurationMaterial): InternalAiEngineDefinition {
  return { ...engine, engineConfigurationSha256: deriveInternalAiEngineConfigurationSha256(engine) };
}

export function isQualificationApplicableToEngine(
  engine: InternalAiEngineDefinition,
  record: InternalAiQualificationRecord | undefined,
  qualificationScope: InternalAiQualificationScope = INTERNAL_AI_QUALIFICATION_SCOPE,
): record is InternalAiQualificationRecord {
  return Boolean(
    record
    && record.engineId === engine.engineId
    && record.engineConfigRevision === engine.engineConfigRevision
    && record.engineConfigurationSha256 === engine.engineConfigurationSha256
    && record.qualificationStatus === "QUALIFIED"
    && record.qualificationScope === qualificationScope
    && record.capabilityProfileVersion === engine.capabilityProfileVersion,
  );
}

export function assertInternalAiEngineRegistryDefinitions(engines: readonly InternalAiEngineDefinition[]): void {
  const keys = new Set<string>();
  for (const engine of engines) {
    const key = engineKey(engine.engineId, engine.engineConfigRevision);
    if (keys.has(key)) throw new InternalAiEngineRegistryError("INTERNAL_AI_ENGINE_REVISION_DUPLICATE", "Engine ID + configuration revision must be unique.");
    keys.add(key);
    const derived = deriveInternalAiEngineConfigurationSha256(engine);
    if (engine.engineConfigurationSha256 !== derived) {
      throw new InternalAiEngineRegistryError("INTERNAL_AI_ENGINE_CONFIGURATION_IDENTITY_MISMATCH", "Engine configuration fingerprint must be deterministically derived from the exact governed Engine configuration.");
    }
  }
}

/**
 * v1.0.2 intentionally models a CURRENT qualification registry, not a ledger.
 * One governed target may have exactly one current-state record. Any duplicate target,
 * including QUALIFIED+REVOKED or QUALIFIED+EXPIRED, is ambiguous and fails closed.
 */
export function assertQualificationRegistryCurrentState(qualifications: readonly InternalAiQualificationRecord[]): void {
  const targets = new Map<string, InternalAiQualificationRecord>();
  for (const record of qualifications) {
    const key = qualificationTargetKey(record);
    const previous = targets.get(key);
    if (previous) {
      throw new InternalAiEngineRegistryError(
        "INTERNAL_AI_ENGINE_QUALIFICATION_STATE_AMBIGUOUS",
        `Qualification target ${record.engineId}@${record.engineConfigRevision}/${record.qualificationScope} has conflicting or duplicate current-state records (${previous.qualificationStatus}, ${record.qualificationStatus}).`,
      );
    }
    targets.set(key, record);
  }
}

export function qualificationForEngine(
  engine: InternalAiEngineDefinition,
  qualifications: readonly InternalAiQualificationRecord[],
  qualificationScope: InternalAiQualificationScope = INTERNAL_AI_QUALIFICATION_SCOPE,
): InternalAiQualificationRecord | undefined {
  assertQualificationRegistryCurrentState(qualifications);
  const record = qualifications.find(item =>
    item.engineId === engine.engineId
    && item.engineConfigRevision === engine.engineConfigRevision
    && item.qualificationScope === qualificationScope,
  );
  return isQualificationApplicableToEngine(engine, record, qualificationScope) ? record : undefined;
}

export function resolveSingleQualifiedInternalAiEngine(input: {
  engines: readonly InternalAiEngineDefinition[];
  qualifications: readonly InternalAiQualificationRecord[];
  ownerEnabledEngineIds: readonly string[];
  selectionPolicy: InternalAiSelectionPolicy;
  qualificationScope?: InternalAiQualificationScope;
}): ResolvedQualifiedInternalAiEngine {
  assertInternalAiEngineRegistryDefinitions(input.engines);
  assertQualificationRegistryCurrentState(input.qualifications);
  if (input.selectionPolicy.selectionMode !== INTERNAL_AI_SELECTION_POLICY_MODE) {
    throw new InternalAiEngineRegistryError("INTERNAL_AI_SELECTION_POLICY_UNSUPPORTED", "Only the SINGLE selection policy is implemented in this bounded correction.");
  }
  const registeredEngineIds = new Set(input.engines.map(engine => engine.engineId));
  const unknownOwnerEnabled = input.ownerEnabledEngineIds.filter(engineId => !registeredEngineIds.has(engineId));
  if (unknownOwnerEnabled.length) {
    throw new InternalAiEngineRegistryError("INTERNAL_AI_OWNER_ENABLED_ENGINE_NOT_REGISTERED", `Owner-enabled Engine IDs must be registered: ${unknownOwnerEnabled.join(",")}`);
  }
  const ownerEnabled = new Set(input.ownerEnabledEngineIds);
  const qualificationScope = input.qualificationScope ?? INTERNAL_AI_QUALIFICATION_SCOPE;
  const eligible: ResolvedQualifiedInternalAiEngine[] = [];
  for (const engine of input.engines) {
    if (!ownerEnabled.has(engine.engineId)) continue;
    const qualification = qualificationForEngine(engine, input.qualifications, qualificationScope);
    if (!qualification) continue;
    eligible.push({ engine, qualification });
  }
  if (eligible.length === 0) {
    throw new InternalAiEngineRegistryError(
      "INTERNAL_AI_ACTIVE_ENGINE_NOT_QUALIFIED",
      `Selection policy ${input.selectionPolicy.selectionPolicyId}@${input.selectionPolicy.selectionPolicyVersion}: no Owner-enabled Engine is explicitly qualified for ${qualificationScope} at its exact configuration fingerprint.`,
    );
  }
  if (eligible.length !== 1) {
    throw new InternalAiEngineRegistryError(
      "INTERNAL_AI_SINGLE_SELECTION_AMBIGUOUS",
      "SINGLE selection requires exactly one Owner-enabled, explicitly qualified Engine revision.",
    );
  }
  return eligible[0];
}

export function resolveQualifiedEngineById(input: {
  engineId: string;
  engineConfigRevision: string;
  engines: readonly InternalAiEngineDefinition[];
  qualifications: readonly InternalAiQualificationRecord[];
  qualificationScope?: InternalAiQualificationScope;
}): ResolvedQualifiedInternalAiEngine {
  assertQualificationRegistryCurrentState(input.qualifications);
  const engine = input.engines.find(item => item.engineId === input.engineId && item.engineConfigRevision === input.engineConfigRevision);
  if (!engine) throw new InternalAiEngineRegistryError("INTERNAL_AI_ENGINE_NOT_REGISTERED", "The requested Internal Engine revision is not registered.");
  const qualificationScope = input.qualificationScope ?? INTERNAL_AI_QUALIFICATION_SCOPE;
  const qualification = qualificationForEngine(engine, input.qualifications, qualificationScope);
  if (!qualification) throw new InternalAiEngineRegistryError("INTERNAL_AI_ENGINE_NOT_QUALIFIED", `The requested Internal Engine revision is not explicitly qualified for its exact configuration fingerprint and ${qualificationScope}.`);
  return { engine, qualification };
}

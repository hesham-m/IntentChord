import {
  INTERNAL_AI_BEHAVIOR_PROFILE_IDS,
  INTERNAL_AI_ENGINE_REGISTRY_SCHEMA_VERSION,
  INTERNAL_AI_PROVIDER_CONFIGURATION_SCHEMA_VERSION,
  INTERNAL_AI_QUALIFICATION_SCOPE,
  INTERNAL_AI_QUALIFICATION_SCOPE_V1,
  INTERNAL_AI_QUALIFICATION_SCOPE_V2,
  INTERNAL_AI_SELECTION_POLICY_MODE,
  INTERNAL_AI_TRANSPORT_PROFILE_IDS,
  type InternalAiBehaviorProfileId,
  type InternalAiEngineConfigurationMaterial,
  type InternalAiEngineDefinition,
  type InternalAiEngineIdentitySnapshot,
  type InternalAiProviderConfigurationSnapshotV3,
  type InternalAiQualificationRecord,
  type InternalAiQualificationScope,
  type InternalAiSelectionPolicy,
  type InternalAiTransportProfileId,
} from "@/core/ai-context-mapper/types";
import {
  InternalAiEngineRegistryError,
  assertInternalAiEngineRegistryDefinitions,
  assertQualificationRegistryCurrentState,
  bindInternalAiEngineConfiguration,
  qualificationForEngine,
  resolveQualifiedEngineById,
  resolveSingleQualifiedInternalAiEngine,
} from "@/core/ai-context-mapper/engine-registry";
import { HttpCommandError } from "@/server/errors";
import type { InternalAiSecretResolver } from "@/server/ai-secret-resolver";

// ---------------------------------------------------------------------------
// Forward V2 Secret Resolver — singleton injection via globalThis
// ---------------------------------------------------------------------------

/**
 * Canonical V2 secret resolver instance.
 *
 * Stored on globalThis to survive Next.js compilation boundaries:
 * instrumentation.ts and route handlers are bundled into separate chunks
 * (separate module instances), so a module-level `let` would be per-instance
 * and the route handler would never see the resolver set by instrumentation.
 * globalThis is process-wide and shared across all module instances.
 */
const GLOBAL_KEY = "__intentchord_v2_secret_resolver" as const;

export function setInternalAiSecretResolver(resolver: InternalAiSecretResolver): void {
  (globalThis as Record<string, unknown>)[GLOBAL_KEY] = resolver;
}

export function getInternalAiSecretResolver(): InternalAiSecretResolver {
  const resolver = (globalThis as Record<string, unknown>)[GLOBAL_KEY] as InternalAiSecretResolver | undefined;
  if (!resolver) {
    throw new Error(
      "V2_SECRET_RESOLVER_NOT_INITIALIZED: Forward V2 secret resolver must be set before credential resolution. " +
      "Production V2 MUST inject WindowsCredentialResolver at startup via instrumentation.ts.",
    );
  }
  return resolver;
}

/**
 * V2-only credential presence check using the canonical resolver.
 * NOT reachable as silent V1 fallback.
 *
 * Throws V2_SECRET_RESOLVER_NOT_INITIALIZED if resolver is not initialized.
 * This is distinct from credential genuinely missing (which returns false).
 */
export async function checkV2CredentialPresent(credentialReference: string): Promise<boolean> {
  const resolver = getInternalAiSecretResolver();
  const result = resolver.isCredentialPresent(credentialReference);
  return typeof result === "boolean" ? result : await result;
}

/**
 * V2-only credential resolution using the canonical resolver.
 * Returns undefined if not available.
 *
 * Throws V2_SECRET_RESOLVER_NOT_INITIALIZED if resolver is not initialized.
 * This is distinct from credential genuinely missing (which returns undefined).
 */
export async function resolveV2InternalAiCredential(credentialReference: string): Promise<string | undefined> {
  const resolver = getInternalAiSecretResolver();
  const result = resolver.resolveSecret(credentialReference);
  return typeof result === "string" ? result : await result;
}

// LEGACY_SUPERSESSION (Gate 8 / ADR-001 §9): vendor-specific legacy direct channel IDs
// are NOT canonical. V1 env-slot defaults use neutral channel identities only.
// Historical provenance rows keep their original channel_id forever.
const DEFAULT_PRIMARY = {
  engineId: "internal-context-mapper-active-default",
  engineConfigRevision: "1",
  providerId: "zai",
  channelId: "primary_chat_completions_v1",
  modelId: "glm-4.7-flash",
  endpoint: "https://api.z.ai/api/paas/v4/chat/completions",
  credentialReference: "ZAI_API_KEY",
  transportProfileId: "chat_completions_json_object_v1" as const,
  behaviorProfileId: "zai_error_semantics_v1" as const,
  capabilityProfileVersion: "AI_CONTEXT_MAPPING_V1/default",
};

const DEFAULT_STANDBY = {
  engineId: "internal-context-mapper-standby-default",
  engineConfigRevision: "1",
  providerId: "sambanova",
  channelId: "standby_chat_completions_v1",
  modelId: "gpt-oss-120b",
  endpoint: "https://api.sambanova.ai/v1/chat/completions",
  credentialReference: "SAMBANOVA_API_KEY",
  transportProfileId: "chat_completions_json_schema_v1" as const,
  behaviorProfileId: "sambanova_error_semantics_v1" as const,
  capabilityProfileVersion: "AI_CONTEXT_MAPPING_V1/default",
};

import {
  isKnownIncompatibleBehaviorTransportPair,
} from "@/core/ai-context-mapper/protocol-family";

export type ResolvedInternalAiEngineConfig = InternalAiEngineDefinition & {
  role: "ACTIVE" | "CANDIDATE" | "STANDBY";
  ownerEnabled: boolean;
  qualification?: InternalAiQualificationRecord;
};

export type AiContextMapperRuntimeConfig = {
  qualificationScope: InternalAiQualificationScope;
  enabled: boolean;
  engineRegistry: InternalAiEngineDefinition[];
  qualificationRecords: InternalAiQualificationRecord[];
  ownerEnabledEngineIds: string[];
  selectionPolicy: InternalAiSelectionPolicy;
  active?: ResolvedInternalAiEngineConfig;
  candidate?: ResolvedInternalAiEngineConfig;
  standby?: ResolvedInternalAiEngineConfig;
  standbyEnabled: boolean;
  standbyGovernanceQualified: boolean;
  liveProviderTestsEnabled: boolean;
  providerConfigurationSnapshot?: InternalAiProviderConfigurationSnapshotV3;
};

function configured(name: string, fallback?: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || fallback;
}

function requiredIdentity(value: string | undefined, name: string): string {
  if (!value || value.length > 200 || /\s/.test(value)) {
    throw new HttpCommandError(503, "AI_CONTEXT_MAPPER_CONFIGURATION_BLOCKED", `${name} must be a non-empty bounded identity without whitespace.`);
  }
  return value;
}

function requiredSha256(value: string | undefined, name: string): string {
  if (!value || !/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new HttpCommandError(503, "AI_CONTEXT_MAPPER_CONFIGURATION_BLOCKED", `${name} must be a lowercase sha256:<64-hex> Engine configuration fingerprint.`);
  }
  return value;
}

function requiredCredentialReference(value: string | undefined, name: string): string {
  const identity = requiredIdentity(value, name);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identity)) {
    throw new HttpCommandError(503, "AI_CONTEXT_MAPPER_CONFIGURATION_BLOCKED", `${name} must name a trusted server-side environment credential reference.`);
  }
  return identity;
}

function requiredEndpoint(value: string | undefined, name: string): string {
  if (!value || value.length > 2048) {
    throw new HttpCommandError(503, "AI_CONTEXT_MAPPER_CONFIGURATION_BLOCKED", `${name} must be a bounded HTTPS endpoint.`);
  }
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:") throw new Error("HTTPS_REQUIRED");
    if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error("ENDPOINT_SECRET_MATERIAL_FORBIDDEN");
  } catch {
    throw new HttpCommandError(503, "AI_CONTEXT_MAPPER_CONFIGURATION_BLOCKED", `${name} must be a valid HTTPS endpoint.`);
  }
  return value;
}

function transportProfile(value: string | undefined, name: string): InternalAiTransportProfileId {
  if (!value || !(INTERNAL_AI_TRANSPORT_PROFILE_IDS as readonly string[]).includes(value)) {
    throw new HttpCommandError(503, "AI_CONTEXT_MAPPER_CONFIGURATION_BLOCKED", `${name} references an unsupported transport profile.`);
  }
  return value as InternalAiTransportProfileId;
}

function behaviorProfile(value: string | undefined, name: string): InternalAiBehaviorProfileId {
  if (!value || !(INTERNAL_AI_BEHAVIOR_PROFILE_IDS as readonly string[]).includes(value)) {
    throw new HttpCommandError(503, "AI_CONTEXT_MAPPER_CONFIGURATION_BLOCKED", `${name} references an unsupported behavior profile.`);
  }
  return value as InternalAiBehaviorProfileId;
}

function positiveTimeout(value: string | undefined, fallback: number, name: string): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1_000 || parsed > 600_000) {
    throw new HttpCommandError(503, "AI_CONTEXT_MAPPER_CONFIGURATION_BLOCKED", `${name} must be an integer between 1000 and 600000 milliseconds.`);
  }
  return parsed;
}

function readBoolean(name: string, fallback = false): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (value === undefined || value === "") return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new HttpCommandError(503, "AI_CONTEXT_MAPPER_CONFIGURATION_BLOCKED", `${name} must be true or false.`);
}

function assertProfileCompatibility(engine: Pick<InternalAiEngineDefinition, "transportProfileId" | "behaviorProfileId">): void {
  if (isKnownIncompatibleBehaviorTransportPair(engine.behaviorProfileId, engine.transportProfileId)) {
    throw new HttpCommandError(
      503,
      "AI_CONTEXT_MAPPER_CONFIGURATION_BLOCKED",
      `Behavior profile ${engine.behaviorProfileId} is incompatible with transport profile ${engine.transportProfileId}.`,
    );
  }
}

function readLegacySlot(prefix: string, defaults?: typeof DEFAULT_PRIMARY | typeof DEFAULT_STANDBY): InternalAiEngineDefinition {
  const engine: InternalAiEngineConfigurationMaterial = {
    engineId: requiredIdentity(configured(`${prefix}_ENGINE_ID`, defaults?.engineId), `${prefix}_ENGINE_ID`),
    engineConfigRevision: requiredIdentity(configured(`${prefix}_ENGINE_REVISION`, defaults?.engineConfigRevision), `${prefix}_ENGINE_REVISION`),
    providerId: requiredIdentity(configured(`${prefix}_PROVIDER`, defaults?.providerId), `${prefix}_PROVIDER`),
    channelId: requiredIdentity(configured(`${prefix}_CHANNEL`, defaults?.channelId), `${prefix}_CHANNEL`),
    modelId: requiredIdentity(configured(`${prefix}_MODEL`, defaults?.modelId), `${prefix}_MODEL`),
    endpoint: requiredEndpoint(configured(`${prefix}_ENDPOINT`, defaults?.endpoint), `${prefix}_ENDPOINT`),
    credentialReference: requiredCredentialReference(configured(`${prefix}_CREDENTIAL_ENV`, defaults?.credentialReference), `${prefix}_CREDENTIAL_ENV`),
    transportProfileId: transportProfile(configured(`${prefix}_TRANSPORT_PROFILE`, defaults?.transportProfileId), `${prefix}_TRANSPORT_PROFILE`),
    behaviorProfileId: behaviorProfile(configured(`${prefix}_BEHAVIOR_PROFILE`, defaults?.behaviorProfileId), `${prefix}_BEHAVIOR_PROFILE`),
    capabilityProfileVersion: requiredIdentity(configured(`${prefix}_CAPABILITY_PROFILE_VERSION`, defaults?.capabilityProfileVersion), `${prefix}_CAPABILITY_PROFILE_VERSION`),
    timeoutMs: positiveTimeout(configured(`${prefix}_TIMEOUT_MS`), 60_000, `${prefix}_TIMEOUT_MS`),
  };
  assertProfileCompatibility(engine);
  return bindInternalAiEngineConfiguration(engine);
}

function parseJson(name: string): unknown | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  try { return JSON.parse(raw); } catch {
    throw new HttpCommandError(503, "AI_CONTEXT_MAPPER_CONFIGURATION_BLOCKED", `${name} must contain valid JSON.`);
  }
}

function parseEngineDefinition(raw: unknown, label: string): InternalAiEngineDefinition {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new HttpCommandError(503, "AI_CONTEXT_MAPPER_CONFIGURATION_BLOCKED", `${label} must be an object.`);
  const value = raw as Record<string, unknown>;
  const engine: InternalAiEngineConfigurationMaterial = {
    engineId: requiredIdentity(typeof value.engineId === "string" ? value.engineId : undefined, `${label}.engineId`),
    engineConfigRevision: requiredIdentity(typeof value.engineConfigRevision === "string" ? value.engineConfigRevision : undefined, `${label}.engineConfigRevision`),
    providerId: requiredIdentity(typeof value.providerId === "string" ? value.providerId : undefined, `${label}.providerId`),
    channelId: requiredIdentity(typeof value.channelId === "string" ? value.channelId : undefined, `${label}.channelId`),
    modelId: requiredIdentity(typeof value.modelId === "string" ? value.modelId : undefined, `${label}.modelId`),
    endpoint: requiredEndpoint(typeof value.endpoint === "string" ? value.endpoint : undefined, `${label}.endpoint`),
    credentialReference: requiredCredentialReference(typeof value.credentialReference === "string" ? value.credentialReference : undefined, `${label}.credentialReference`),
    transportProfileId: transportProfile(typeof value.transportProfileId === "string" ? value.transportProfileId : undefined, `${label}.transportProfileId`),
    behaviorProfileId: behaviorProfile(typeof value.behaviorProfileId === "string" ? value.behaviorProfileId : undefined, `${label}.behaviorProfileId`),
    capabilityProfileVersion: requiredIdentity(typeof value.capabilityProfileVersion === "string" ? value.capabilityProfileVersion : undefined, `${label}.capabilityProfileVersion`),
    timeoutMs: typeof value.timeoutMs === "number" && Number.isInteger(value.timeoutMs) && value.timeoutMs >= 1_000 && value.timeoutMs <= 600_000
      ? value.timeoutMs
      : positiveTimeout(undefined, 60_000, `${label}.timeoutMs`),
  };
  assertProfileCompatibility(engine);
  return bindInternalAiEngineConfiguration(engine);
}

function readEngineRegistry(qualificationScope?: InternalAiQualificationScope): InternalAiEngineDefinition[] {
  const configuredRegistry = parseJson("AI_CONTEXT_MAPPER_ENGINE_REGISTRY_JSON");
  if (configuredRegistry !== undefined) {
    if (!Array.isArray(configuredRegistry) || configuredRegistry.length < 1) {
      throw new HttpCommandError(503, "AI_CONTEXT_MAPPER_CONFIGURATION_BLOCKED", "AI_CONTEXT_MAPPER_ENGINE_REGISTRY_JSON must be a non-empty array of Engine definitions.");
    }
    return configuredRegistry.map((item, index) => parseEngineDefinition(item, `AI_CONTEXT_MAPPER_ENGINE_REGISTRY_JSON[${index}]`));
  }

  if (qualificationScope === INTERNAL_AI_QUALIFICATION_SCOPE_V2) {
    return [];
  }

  const engines = [readLegacySlot("AI_CONTEXT_MAPPER_PRIMARY", DEFAULT_PRIMARY), readLegacySlot("AI_CONTEXT_MAPPER_STANDBY", DEFAULT_STANDBY)];
  const candidateConfigured = [
    "AI_CONTEXT_MAPPER_CANDIDATE_PROVIDER",
    "AI_CONTEXT_MAPPER_CANDIDATE_CHANNEL",
    "AI_CONTEXT_MAPPER_CANDIDATE_MODEL",
    "AI_CONTEXT_MAPPER_CANDIDATE_ENDPOINT",
    "AI_CONTEXT_MAPPER_CANDIDATE_CREDENTIAL_ENV",
    "AI_CONTEXT_MAPPER_CANDIDATE_TRANSPORT_PROFILE",
    "AI_CONTEXT_MAPPER_CANDIDATE_BEHAVIOR_PROFILE",
    "AI_CONTEXT_MAPPER_CANDIDATE_ENGINE_ID",
  ].some(name => Boolean(process.env[name]?.trim()));
  if (candidateConfigured) engines.push(readLegacySlot("AI_CONTEXT_MAPPER_CANDIDATE"));
  return engines;
}

function readQualificationRecords(): InternalAiQualificationRecord[] {
  const raw = parseJson("AI_CONTEXT_MAPPER_QUALIFICATION_REGISTRY_JSON");
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new HttpCommandError(503, "AI_CONTEXT_MAPPER_CONFIGURATION_BLOCKED", "AI_CONTEXT_MAPPER_QUALIFICATION_REGISTRY_JSON must be an array.");
  return raw.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new HttpCommandError(503, "AI_CONTEXT_MAPPER_CONFIGURATION_BLOCKED", `Qualification[${index}] must be an object.`);
    const value = item as Record<string, unknown>;
    const status = value.qualificationStatus;
    if (!(["QUALIFIED", "REVOKED", "EXPIRED"] as const).includes(status as never)) {
      throw new HttpCommandError(503, "AI_CONTEXT_MAPPER_CONFIGURATION_BLOCKED", `Qualification[${index}].qualificationStatus is invalid.`);
    }
    if (value.qualificationScope !== INTERNAL_AI_QUALIFICATION_SCOPE_V1 && value.qualificationScope !== INTERNAL_AI_QUALIFICATION_SCOPE_V2) {
      throw new HttpCommandError(503, "AI_CONTEXT_MAPPER_CONFIGURATION_BLOCKED", `Qualification[${index}].qualificationScope must be ${INTERNAL_AI_QUALIFICATION_SCOPE_V1} or ${INTERNAL_AI_QUALIFICATION_SCOPE_V2}.`);
    }
    const qualifiedAt = typeof value.qualifiedAt === "string" ? value.qualifiedAt : "";
    if (!qualifiedAt || Number.isNaN(Date.parse(qualifiedAt))) throw new HttpCommandError(503, "AI_CONTEXT_MAPPER_CONFIGURATION_BLOCKED", `Qualification[${index}].qualifiedAt must be an ISO timestamp.`);
    return {
      qualificationId: requiredIdentity(typeof value.qualificationId === "string" ? value.qualificationId : undefined, `Qualification[${index}].qualificationId`),
      engineId: requiredIdentity(typeof value.engineId === "string" ? value.engineId : undefined, `Qualification[${index}].engineId`),
      engineConfigRevision: requiredIdentity(typeof value.engineConfigRevision === "string" ? value.engineConfigRevision : undefined, `Qualification[${index}].engineConfigRevision`),
      engineConfigurationSha256: requiredSha256(typeof value.engineConfigurationSha256 === "string" ? value.engineConfigurationSha256 : undefined, `Qualification[${index}].engineConfigurationSha256`),
      qualificationStatus: status as InternalAiQualificationRecord["qualificationStatus"],
      qualificationScope: value.qualificationScope as InternalAiQualificationScope,
      qualifiedAt,
      qualifiedBy: requiredIdentity(typeof value.qualifiedBy === "string" ? value.qualifiedBy : undefined, `Qualification[${index}].qualifiedBy`),
      evidenceReference: requiredIdentity(typeof value.evidenceReference === "string" ? value.evidenceReference : undefined, `Qualification[${index}].evidenceReference`),
      capabilityProfileVersion: requiredIdentity(typeof value.capabilityProfileVersion === "string" ? value.capabilityProfileVersion : undefined, `Qualification[${index}].capabilityProfileVersion`),
    };
  });
}

function readOwnerEnabledEngineIds(): string[] {
  const value = process.env.AI_CONTEXT_MAPPER_OWNER_ENABLED_ENGINE_IDS?.trim();
  if (!value) return [];
  const ids: string[] = value.split(",").map((item: string) => requiredIdentity(item.trim(), "AI_CONTEXT_MAPPER_OWNER_ENABLED_ENGINE_IDS"));
  return [...new Set<string>(ids)];
}

function readSelectionPolicy(): InternalAiSelectionPolicy {
  const mode = configured("AI_CONTEXT_MAPPER_SELECTION_POLICY_MODE", INTERNAL_AI_SELECTION_POLICY_MODE);
  if (mode !== INTERNAL_AI_SELECTION_POLICY_MODE) {
    throw new HttpCommandError(503, "AI_CONTEXT_MAPPER_CONFIGURATION_BLOCKED", "Only selection mode SINGLE is implemented.");
  }
  return {
    selectionPolicyId: requiredIdentity(configured("AI_CONTEXT_MAPPER_SELECTION_POLICY_ID", "internal-ai-context-mapping-single"), "AI_CONTEXT_MAPPER_SELECTION_POLICY_ID"),
    selectionPolicyVersion: requiredIdentity(configured("AI_CONTEXT_MAPPER_SELECTION_POLICY_VERSION", "1"), "AI_CONTEXT_MAPPER_SELECTION_POLICY_VERSION"),
    selectionMode: INTERNAL_AI_SELECTION_POLICY_MODE,
  };
}

function resolveEngineDefinition(engineId: string | undefined, revision: string | undefined, engines: readonly InternalAiEngineDefinition[], label: string): InternalAiEngineDefinition | undefined {
  if (!engineId) return undefined;
  const resolvedId = requiredIdentity(engineId, `${label}_ENGINE_ID`);
  const candidates = engines.filter(engine => engine.engineId === resolvedId);
  if (!candidates.length) throw new HttpCommandError(503, "AI_CONTEXT_MAPPER_CONFIGURATION_BLOCKED", `${label} Engine is not registered.`);
  if (revision) {
    const exact = candidates.find(engine => engine.engineConfigRevision === revision);
    if (!exact) throw new HttpCommandError(503, "AI_CONTEXT_MAPPER_CONFIGURATION_BLOCKED", `${label} Engine revision is not registered.`);
    return exact;
  }
  if (candidates.length !== 1) throw new HttpCommandError(503, "AI_CONTEXT_MAPPER_CONFIGURATION_BLOCKED", `${label} Engine revision must be explicit when multiple revisions are registered.`);
  return candidates[0];
}

function resolvedEngine(engine: InternalAiEngineDefinition, role: ResolvedInternalAiEngineConfig["role"], ownerEnabled: boolean, qualification?: InternalAiQualificationRecord): ResolvedInternalAiEngineConfig {
  return { ...engine, role, ownerEnabled, ...(qualification ? { qualification } : {}) };
}

function qualificationSnapshot(record: InternalAiQualificationRecord) {
  return {
    qualification_id: record.qualificationId,
    engine_id: record.engineId,
    engine_config_revision: record.engineConfigRevision,
    engine_configuration_sha256: record.engineConfigurationSha256,
    qualification_status: "QUALIFIED" as const,
    qualification_scope: record.qualificationScope,
    qualified_at: record.qualifiedAt,
    qualified_by: record.qualifiedBy,
    evidence_reference: record.evidenceReference,
    capability_profile_version: record.capabilityProfileVersion,
  };
}

function snapshotEngine(engine: ResolvedInternalAiEngineConfig): InternalAiEngineIdentitySnapshot {
  return {
    role: engine.role,
    engine_id: engine.engineId,
    engine_config_revision: engine.engineConfigRevision,
    engine_configuration_sha256: engine.engineConfigurationSha256,
    provider_id: engine.providerId,
    channel_id: engine.channelId,
    model_id: engine.modelId,
    endpoint: engine.endpoint,
    credential_reference: engine.credentialReference,
    transport_profile_id: engine.transportProfileId,
    behavior_profile_id: engine.behaviorProfileId,
    capability_profile_version: engine.capabilityProfileVersion,
    owner_enabled: engine.ownerEnabled,
    ...(engine.qualification ? { qualification: qualificationSnapshot(engine.qualification) } : {}),
    timeout_ms: engine.timeoutMs,
  };
}

function buildSnapshot(input: {
  active: ResolvedInternalAiEngineConfig;
  candidate?: ResolvedInternalAiEngineConfig;
  standby?: ResolvedInternalAiEngineConfig;
  standbyEnabled: boolean;
  standbyGovernanceQualified: boolean;
  selectionPolicy: InternalAiSelectionPolicy;
}): InternalAiProviderConfigurationSnapshotV3 {
  return {
    schema_version: INTERNAL_AI_PROVIDER_CONFIGURATION_SCHEMA_VERSION,
    registry_schema_version: INTERNAL_AI_ENGINE_REGISTRY_SCHEMA_VERSION,
    selected_engine_id: input.active.engineId,
    selected_engine_config_revision: input.active.engineConfigRevision,
    selected_engine_configuration_sha256: input.active.engineConfigurationSha256,
    selection_policy: {
      selection_policy_id: input.selectionPolicy.selectionPolicyId,
      selection_policy_version: input.selectionPolicy.selectionPolicyVersion,
      selection_mode: input.selectionPolicy.selectionMode,
    },
    active: snapshotEngine(input.active),
    ...(input.candidate ? { candidate: snapshotEngine(input.candidate) } : {}),
    ...(input.standby ? { standby: snapshotEngine(input.standby) } : {}),
    failover_policy: {
      enabled: input.standbyEnabled,
      governance_qualified: input.standbyGovernanceQualified,
      technical_failure_only: true,
      validation_failure_failover: false,
    },
  };
}

function registryError(error: unknown): never {
  if (error instanceof InternalAiEngineRegistryError) {
    throw new HttpCommandError(503, error.code, error.message);
  }
  throw error;
}

function readAiContextMapperConfigForScope(qualificationScope: InternalAiQualificationScope): AiContextMapperRuntimeConfig {
  const enabled = readBoolean("AI_CONTEXT_MAPPER_ENABLED", false);
  const engineRegistry = readEngineRegistry(qualificationScope);
  try { assertInternalAiEngineRegistryDefinitions(engineRegistry); } catch (error) { registryError(error); }
  const qualificationRecords = readQualificationRecords();
  try { assertQualificationRegistryCurrentState(qualificationRecords); } catch (error) { registryError(error); }
  const qualificationIds = new Set<string>();
  const registeredRevisions = new Set(engineRegistry.map(engine => `${engine.engineId}\u0000${engine.engineConfigRevision}`));
  for (const qualification of qualificationRecords) {
    if (qualificationIds.has(qualification.qualificationId)) {
      throw new HttpCommandError(503, "INTERNAL_AI_QUALIFICATION_ID_DUPLICATE", "Qualification IDs must be unique within the governed qualification registry.");
    }
    qualificationIds.add(qualification.qualificationId);
    if (!registeredRevisions.has(`${qualification.engineId}\u0000${qualification.engineConfigRevision}`)) {
      throw new HttpCommandError(503, "INTERNAL_AI_QUALIFICATION_ENGINE_NOT_REGISTERED", "Every qualification record must bind to a registered Engine configuration revision.");
    }
  }
  const ownerEnabledEngineIds = readOwnerEnabledEngineIds();
  const selectionPolicy = readSelectionPolicy();
  const candidateDefinition = resolveEngineDefinition(
    process.env.AI_CONTEXT_MAPPER_CANDIDATE_ENGINE_ID?.trim(),
    process.env.AI_CONTEXT_MAPPER_CANDIDATE_ENGINE_REVISION?.trim(),
    engineRegistry,
    "AI_CONTEXT_MAPPER_CANDIDATE",
  );
  let candidate: ResolvedInternalAiEngineConfig | undefined;
  if (candidateDefinition) {
    let candidateQualification: InternalAiQualificationRecord | undefined;
    try { candidateQualification = qualificationForEngine(candidateDefinition, qualificationRecords, qualificationScope); } catch (error) { registryError(error); }
    candidate = resolvedEngine(candidateDefinition, "CANDIDATE", ownerEnabledEngineIds.includes(candidateDefinition.engineId), candidateQualification);
  }

  let active: ResolvedInternalAiEngineConfig | undefined;
  if (enabled) {
    try {
      const selected = resolveSingleQualifiedInternalAiEngine({ engines: engineRegistry, qualifications: qualificationRecords, ownerEnabledEngineIds, selectionPolicy, qualificationScope });
      active = resolvedEngine(selected.engine, "ACTIVE", true, selected.qualification);
    } catch (error) { registryError(error); }
  }
  if (active && candidate && active.engineId === candidate.engineId && active.engineConfigRevision === candidate.engineConfigRevision) {
    throw new HttpCommandError(503, "INTERNAL_AI_CANDIDATE_ACTIVE_IDENTITY_CONFLICT", "Candidate and Active must not reference the same Engine configuration revision.");
  }

  const standbyEnabled = readBoolean("AI_CONTEXT_MAPPER_STANDBY_ENABLED", false);
  let standby: ResolvedInternalAiEngineConfig | undefined;
  if (standbyEnabled) {
    const configuredStandbyId = process.env.AI_CONTEXT_MAPPER_STANDBY_ENGINE_ID?.trim();
    const defaultStandbyPresent = engineRegistry.some(engine => engine.engineId === DEFAULT_STANDBY.engineId && engine.engineConfigRevision === DEFAULT_STANDBY.engineConfigRevision);
    const standbyDefinition = resolveEngineDefinition(
      configuredStandbyId || (defaultStandbyPresent ? DEFAULT_STANDBY.engineId : undefined),
      process.env.AI_CONTEXT_MAPPER_STANDBY_ENGINE_REVISION?.trim() || (defaultStandbyPresent ? DEFAULT_STANDBY.engineConfigRevision : undefined),
      engineRegistry,
      "AI_CONTEXT_MAPPER_STANDBY",
    );
    if (!standbyDefinition) {
      throw new HttpCommandError(503, "AI_CONTEXT_MAPPER_STANDBY_CONFIGURATION_REQUIRED", "Failover is enabled but no Standby Engine revision is configured.");
    }
    let standbyQualification: InternalAiQualificationRecord | undefined;
    try { standbyQualification = qualificationForEngine(standbyDefinition, qualificationRecords, qualificationScope); } catch (error) { registryError(error); }
    if (!standbyQualification) {
      throw new HttpCommandError(503, "AI_CONTEXT_MAPPER_STANDBY_GOVERNANCE_BLOCKED", `Standby execution requires an explicit qualification for the exact Engine revision and ${qualificationScope} scope.`);
    }
    standby = resolvedEngine(standbyDefinition, "STANDBY", false, standbyQualification);
  }
  const standbyGovernanceQualified = Boolean(standbyEnabled && standby?.qualification);

  const providerConfigurationSnapshot = active
    ? buildSnapshot({ active, ...(candidate ? { candidate } : {}), ...(standby ? { standby } : {}), standbyEnabled, standbyGovernanceQualified, selectionPolicy })
    : undefined;

  return {
    qualificationScope,
    enabled,
    engineRegistry,
    qualificationRecords,
    ownerEnabledEngineIds,
    selectionPolicy,
    ...(active ? { active } : {}),
    ...(candidate ? { candidate } : {}),
    ...(standby ? { standby } : {}),
    standbyEnabled,
    standbyGovernanceQualified,
    liveProviderTestsEnabled: readBoolean("AI_CONTEXT_MAPPER_LIVE_PROVIDER_TESTS_ENABLED", false),
    ...(providerConfigurationSnapshot ? { providerConfigurationSnapshot } : {}),
  };
}

export function readAiContextMapperConfig(): AiContextMapperRuntimeConfig {
  return readAiContextMapperConfigForScope(INTERNAL_AI_QUALIFICATION_SCOPE_V1);
}

export function readAiContextMapperV2Config(): AiContextMapperRuntimeConfig {
  return readAiContextMapperConfigForScope(INTERNAL_AI_QUALIFICATION_SCOPE_V2);
}

/**
 * V1 LEGACY credential resolution via process.env.
 * ISOLATED — NOT Forward-V2 authority.
 * V2 callers MUST NOT use this function. Use resolveV2InternalAiCredential() instead.
 */
export function resolveInternalAiCredential(engine: ResolvedInternalAiEngineConfig): string | undefined {
  return process.env[engine.credentialReference]?.trim() || undefined;
}

function assertProductionInternalAiExecutionReadyForScope(config: AiContextMapperRuntimeConfig, qualificationScope: InternalAiQualificationScope): asserts config is AiContextMapperRuntimeConfig & {
  active: ResolvedInternalAiEngineConfig;
  providerConfigurationSnapshot: InternalAiProviderConfigurationSnapshotV3;
} {
  if (!config.enabled) throw new HttpCommandError(503, "AI_CONTEXT_MAPPER_DISABLED", "AI Context Mapper is disabled until AI_CONTEXT_MAPPER_ENABLED=true.");
  if (!config.active || !config.active.qualification || !config.providerConfigurationSnapshot) {
    throw new HttpCommandError(503, "INTERNAL_AI_ACTIVE_ENGINE_NOT_QUALIFIED", `Active Internal AI execution requires an explicit valid qualification for the exact Engine configuration fingerprint and ${qualificationScope} scope.`);
  }
  if (config.active.qualification.engineConfigurationSha256 !== config.active.engineConfigurationSha256
      || config.providerConfigurationSnapshot.selected_engine_configuration_sha256 !== config.active.engineConfigurationSha256) {
    throw new HttpCommandError(503, "INTERNAL_AI_ACTIVE_ENGINE_CONFIGURATION_IDENTITY_MISMATCH", "Active Internal AI execution fingerprint binding is inconsistent.");
  }
  if (config.qualificationScope !== qualificationScope || config.active.qualification.qualificationScope !== qualificationScope) {
    throw new HttpCommandError(503, "INTERNAL_AI_ACTIVE_ENGINE_QUALIFICATION_SCOPE_MISMATCH", `Active Internal AI execution is not qualified for ${qualificationScope}.`);
  }
  if (!config.ownerEnabledEngineIds.includes(config.active.engineId)) {
    throw new HttpCommandError(503, "INTERNAL_AI_ACTIVE_ENGINE_NOT_OWNER_ENABLED", "The selected Internal AI Engine is not in the Owner-enabled set.");
  }
}

export function assertProductionInternalAiExecutionReady(config: AiContextMapperRuntimeConfig): asserts config is AiContextMapperRuntimeConfig & {
  active: ResolvedInternalAiEngineConfig;
  providerConfigurationSnapshot: InternalAiProviderConfigurationSnapshotV3;
} {
  assertProductionInternalAiExecutionReadyForScope(config, INTERNAL_AI_QUALIFICATION_SCOPE_V1);
}

export function assertProductionInternalAiExecutionV2Ready(config: AiContextMapperRuntimeConfig): asserts config is AiContextMapperRuntimeConfig & {
  active: ResolvedInternalAiEngineConfig;
  providerConfigurationSnapshot: InternalAiProviderConfigurationSnapshotV3;
} {
  assertProductionInternalAiExecutionReadyForScope(config, INTERNAL_AI_QUALIFICATION_SCOPE_V2);
}

export function resolveQualifiedStandby(config: AiContextMapperRuntimeConfig): ResolvedInternalAiEngineConfig | undefined {
  if (!config.standbyEnabled) return undefined;
  const standby = config.standby;
  if (!standby?.qualification) throw new HttpCommandError(503, "AI_CONTEXT_MAPPER_STANDBY_GOVERNANCE_BLOCKED", "Standby Engine is not explicitly qualified.");
  try {
    resolveQualifiedEngineById({
      engineId: standby.engineId,
      engineConfigRevision: standby.engineConfigRevision,
      engines: config.engineRegistry,
      qualifications: config.qualificationRecords,
      qualificationScope: config.qualificationScope,
    });
  } catch (error) { registryError(error); }
  return standby;
}

export async function resolveAuthoritativeAiContextMapperV2Config(): Promise<{
  config: AiContextMapperRuntimeConfig;
  frozenExecutionAuthority: import("@/core/ai-context-mapper/types").FrozenAiExecutionAuthority;
}> {
  const { internalAiEngineRegistryService } = await import("@/server/internal-ai-engine-registry-service");
  return internalAiEngineRegistryService.resolveV2RuntimeSelection();
}

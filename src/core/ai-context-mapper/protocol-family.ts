/**
 * Protocol-family registry (ADR-001 §4).
 *
 * Distinguishes:
 * - New Vendor inside an already-supported protocol family → Admin configuration only.
 * - New/incompatible protocol family → new adapter/profile implementation first.
 *
 * Behavior/transport compatibility and error-normalizer selection are data here,
 * not vendor-specific if/else scattered through runtime and registry services.
 */

export const OPENAI_CHAT_COMPLETIONS_PROTOCOL_FAMILY = "openai_chat_completions_v1" as const;

export const SUPPORTED_PROTOCOL_FAMILIES = [OPENAI_CHAT_COMPLETIONS_PROTOCOL_FAMILY] as const;

export type SupportedProtocolFamilyId = (typeof SUPPORTED_PROTOCOL_FAMILIES)[number];

export const CHAT_COMPLETIONS_TRANSPORT_PROFILE_IDS = [
  "chat_completions_json_object_v1",
  "chat_completions_json_schema_v1",
] as const;

export type ProtocolFamilyErrorNormalizerId = "zai" | "sambanova" | "generic_chat_completions";

export type ProtocolFamilyBehaviorProfileDefinition = {
  behaviorProfileId: string;
  protocolFamilyId: SupportedProtocolFamilyId;
  allowedTransportProfileIds: readonly string[];
  errorNormalizerId: ProtocolFamilyErrorNormalizerId;
};

/**
 * Behavior profiles registered under supported protocol families.
 * Adding a behavior profile is a source-level (adapter-required) change.
 * Adding a Vendor that uses an already-registered profile is configuration-only.
 */
export const PROTOCOL_FAMILY_BEHAVIOR_PROFILES: Readonly<Record<string, ProtocolFamilyBehaviorProfileDefinition>> = {
  zai_error_semantics_v1: {
    behaviorProfileId: "zai_error_semantics_v1",
    protocolFamilyId: OPENAI_CHAT_COMPLETIONS_PROTOCOL_FAMILY,
    allowedTransportProfileIds: ["chat_completions_json_object_v1"],
    errorNormalizerId: "zai",
  },
  sambanova_error_semantics_v1: {
    behaviorProfileId: "sambanova_error_semantics_v1",
    protocolFamilyId: OPENAI_CHAT_COMPLETIONS_PROTOCOL_FAMILY,
    allowedTransportProfileIds: ["chat_completions_json_schema_v1"],
    errorNormalizerId: "sambanova",
  },
  openai_chat_completions_error_semantics_v1: {
    behaviorProfileId: "openai_chat_completions_error_semantics_v1",
    protocolFamilyId: OPENAI_CHAT_COMPLETIONS_PROTOCOL_FAMILY,
    allowedTransportProfileIds: [
      "chat_completions_json_object_v1",
      "chat_completions_json_schema_v1",
    ],
    errorNormalizerId: "generic_chat_completions",
  },
};

export function isSupportedProtocolFamily(protocolFamilyId: string): boolean {
  return (SUPPORTED_PROTOCOL_FAMILIES as readonly string[]).includes(protocolFamilyId);
}

export function getProtocolFamilyBehaviorProfile(
  behaviorProfileId: string,
): ProtocolFamilyBehaviorProfileDefinition | undefined {
  return PROTOCOL_FAMILY_BEHAVIOR_PROFILES[behaviorProfileId];
}

export function isSupportedProtocolFamilyBehaviorProfile(behaviorProfileId: string): boolean {
  return Object.prototype.hasOwnProperty.call(PROTOCOL_FAMILY_BEHAVIOR_PROFILES, behaviorProfileId);
}

export function isSupportedProtocolFamilyTransportProfile(transportProfileId: string): boolean {
  return (CHAT_COMPLETIONS_TRANSPORT_PROFILE_IDS as readonly string[]).includes(transportProfileId);
}

export function resolveProtocolFamilyErrorNormalizerId(
  behaviorProfileId: string,
): ProtocolFamilyErrorNormalizerId | undefined {
  return getProtocolFamilyBehaviorProfile(behaviorProfileId)?.errorNormalizerId;
}

export type BehaviorTransportCompatibility =
  | "COMPATIBLE"
  | "INCOMPATIBLE"
  | "UNKNOWN_BEHAVIOR_PROFILE";

/**
 * Compatibility of a behavior profile with a transport profile.
 * UNKNOWN_BEHAVIOR_PROFILE means the behavior is not registered under any
 * supported family yet (adapter-required path); revision persistence may allow it,
 * runtime execution must fail closed.
 */
export function checkBehaviorTransportCompatibility(
  behaviorProfileId: string,
  transportProfileId: string,
): BehaviorTransportCompatibility {
  const definition = getProtocolFamilyBehaviorProfile(behaviorProfileId);
  if (!definition) return "UNKNOWN_BEHAVIOR_PROFILE";
  return definition.allowedTransportProfileIds.includes(transportProfileId)
    ? "COMPATIBLE"
    : "INCOMPATIBLE";
}

export function isKnownIncompatibleBehaviorTransportPair(
  behaviorProfileId: string,
  transportProfileId: string,
): boolean {
  return checkBehaviorTransportCompatibility(behaviorProfileId, transportProfileId) === "INCOMPATIBLE";
}

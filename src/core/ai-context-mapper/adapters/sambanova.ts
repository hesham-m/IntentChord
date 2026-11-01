import type { NormalizedProviderErrorCode } from "@/core/ai-context-mapper/types";

export const SAMBANOVA_ERROR_BEHAVIOR_PROFILE_ID = "sambanova_error_semantics_v1" as const;

function code(role: "PRIMARY" | "STANDBY", primary: NormalizedProviderErrorCode, standby: NormalizedProviderErrorCode): NormalizedProviderErrorCode {
  return role === "PRIMARY" ? primary : standby;
}

export function normalizeSambaNovaProviderError(status: number, providerCode: string | undefined, role: "PRIMARY" | "STANDBY"): {
  code: NormalizedProviderErrorCode;
  retryable: boolean;
  failoverEligible: boolean;
} {
  if (status === 401 || providerCode === "invalid_authentication") return { code: code(role, "PRIMARY_AUTH_MISSING_OR_INVALID", "STANDBY_AUTH_INVALID"), retryable: false, failoverEligible: false };
  if (status === 429 && providerCode === "insufficient_quota") return { code: code(role, "PRIMARY_DAILY_LIMIT_REACHED", "STANDBY_QUOTA_EXHAUSTED"), retryable: false, failoverEligible: role === "PRIMARY" };
  if (status === 429) return { code: code(role, "PRIMARY_RATE_LIMITED", "STANDBY_PROVIDER_BUSY"), retryable: false, failoverEligible: role === "PRIMARY" };
  if (status === 408) return { code: code(role, "PRIMARY_NETWORK_TIMEOUT", "STANDBY_NETWORK_TIMEOUT"), retryable: role === "PRIMARY", failoverEligible: role === "PRIMARY" };
  if (status === 410) return { code: code(role, "PRIMARY_MODEL_UNAVAILABLE_OR_REMOVED", "STANDBY_MODEL_UNAVAILABLE_OR_REMOVED"), retryable: false, failoverEligible: role === "PRIMARY" };
  if (status === 503 || status >= 500) return { code: code(role, "PRIMARY_PROVIDER_UNAVAILABLE", "STANDBY_PROVIDER_UNAVAILABLE"), retryable: role === "PRIMARY", failoverEligible: role === "PRIMARY" };
  if (status === 400 || status === 422) return { code: code(role, "PRIMARY_REQUEST_INVALID", "STANDBY_REQUEST_INVALID"), retryable: false, failoverEligible: false };
  return { code: "UNKNOWN_PROVIDER_ERROR", retryable: false, failoverEligible: false };
}

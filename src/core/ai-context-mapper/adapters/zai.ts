import type { NormalizedProviderErrorCode } from "@/core/ai-context-mapper/types";

export const ZAI_ERROR_BEHAVIOR_PROFILE_ID = "zai_error_semantics_v1" as const;

function code(role: "PRIMARY" | "STANDBY", primary: NormalizedProviderErrorCode, standby: NormalizedProviderErrorCode): NormalizedProviderErrorCode {
  return role === "PRIMARY" ? primary : standby;
}

export function normalizeZaiProviderError(status: number, providerCode: string | undefined, role: "PRIMARY" | "STANDBY"): {
  code: NormalizedProviderErrorCode;
  retryable: boolean;
  failoverEligible: boolean;
} {
  if (status === 401 || ["1000", "1001", "1003"].includes(providerCode ?? "")) return { code: code(role, "PRIMARY_AUTH_MISSING_OR_INVALID", "STANDBY_AUTH_INVALID"), retryable: false, failoverEligible: false };
  if (status === 403) return { code: code(role, "PRIMARY_PERMISSION_DENIED", "STANDBY_AUTH_INVALID"), retryable: false, failoverEligible: false };
  if (providerCode === "1261") return { code: code(role, "PRIMARY_PROMPT_TOO_LONG", "STANDBY_REQUEST_INVALID"), retryable: false, failoverEligible: false };
  if (providerCode === "1302") return { code: code(role, "PRIMARY_RATE_LIMITED", "STANDBY_PROVIDER_BUSY"), retryable: false, failoverEligible: role === "PRIMARY" };
  if (providerCode === "1308") return { code: code(role, "PRIMARY_DAILY_LIMIT_REACHED", "STANDBY_QUOTA_EXHAUSTED"), retryable: false, failoverEligible: role === "PRIMARY" };
  if (providerCode === "1305") return { code: code(role, "PRIMARY_PROVIDER_UNAVAILABLE", "STANDBY_PROVIDER_UNAVAILABLE"), retryable: role === "PRIMARY", failoverEligible: role === "PRIMARY" };
  if (providerCode === "1211") return { code: code(role, "PRIMARY_REQUEST_INVALID", "STANDBY_REQUEST_INVALID"), retryable: false, failoverEligible: false };
  if (status === 429) return { code: code(role, "PRIMARY_RATE_LIMITED", "STANDBY_PROVIDER_BUSY"), retryable: false, failoverEligible: role === "PRIMARY" };
  if (status === 408) return { code: code(role, "PRIMARY_NETWORK_TIMEOUT", "STANDBY_NETWORK_TIMEOUT"), retryable: role === "PRIMARY", failoverEligible: role === "PRIMARY" };
  if (status === 410) return { code: code(role, "PRIMARY_MODEL_UNAVAILABLE_OR_REMOVED", "STANDBY_MODEL_UNAVAILABLE_OR_REMOVED"), retryable: false, failoverEligible: role === "PRIMARY" };
  if (status >= 500) return { code: code(role, "PRIMARY_PROVIDER_UNAVAILABLE", "STANDBY_PROVIDER_UNAVAILABLE"), retryable: role === "PRIMARY", failoverEligible: role === "PRIMARY" };
  if (status === 400 || status === 422) return { code: code(role, "PRIMARY_REQUEST_INVALID", "STANDBY_REQUEST_INVALID"), retryable: false, failoverEligible: false };
  return { code: "UNKNOWN_PROVIDER_ERROR", retryable: false, failoverEligible: false };
}

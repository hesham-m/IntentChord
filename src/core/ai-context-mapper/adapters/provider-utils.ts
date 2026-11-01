import type { SafeRateLimitMetadata, SafeUsageMetadata } from "@/core/ai-context-mapper/types";

export function safeUsage(value: unknown): SafeUsageMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: SafeUsageMetadata = {};
  for (const [key, item] of Object.entries(value)) {
    if (["string", "number", "boolean"].includes(typeof item) || item === null) result[key] = item as string | number | boolean | null;
  }
  return result;
}

export function safeRateLimitHeaders(headers: Headers): SafeRateLimitMetadata {
  const allowed = [
    "retry-after", "x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset",
    "x-ratelimit-limit-requests", "x-ratelimit-remaining-requests", "x-ratelimit-reset-requests",
    "x-ratelimit-limit-tokens", "x-ratelimit-remaining-tokens", "x-ratelimit-reset-tokens",
  ];
  const result: SafeRateLimitMetadata = {};
  for (const name of allowed) {
    const value = headers.get(name);
    if (value !== null) result[name] = value;
  }
  return result;
}

export function boundedProviderMessage(providerId: string, status: number, code?: string): string {
  return `Configured internal AI provider ${providerId} failed with HTTP ${status}${code ? ` and provider code ${code}` : ""}.`;
}

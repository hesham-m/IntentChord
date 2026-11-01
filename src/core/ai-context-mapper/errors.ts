import type { NormalizedProviderErrorCode } from "@/core/ai-context-mapper/types";

export class AiContextMapperError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export class ProviderTechnicalError extends Error {
  constructor(
    public readonly normalizedCode: NormalizedProviderErrorCode,
    message: string,
    public readonly retryable: boolean,
    public readonly failoverEligible: boolean,
    public readonly httpStatus?: number,
    public readonly providerCode?: string,
  ) {
    super(message);
  }
}

export function isProviderTechnicalError(value: unknown): value is ProviderTechnicalError {
  return value instanceof ProviderTechnicalError;
}

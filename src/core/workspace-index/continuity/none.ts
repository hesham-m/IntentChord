import type {
  ClaimType,
  FileContinuityInput,
  FileContinuityVerdict,
  OpenedWindow,
  ProviderClass,
  ProviderId,
} from "@/core/workspace-index/continuity/types";

/**
 * NONE_V1 — NO_CONTINUITY_PROVIDER.
 * Provides no reusable continuity authority; fresh-hash semantics every run.
 * Claim is ROLLING_EXACT_FILE_MANIFEST (SPEC V3 Section 6.2).
 */

export const NONE_PROVIDER_ID = "NONE_V1" as const;

export class NoneProvider {
  readonly providerId: ProviderId = NONE_PROVIDER_ID;
  readonly providerClass: ProviderClass = "NO_CONTINUITY_PROVIDER";
  readonly claimType: ClaimType = "ROLLING_EXACT_FILE_MANIFEST";

  async openWindow(_previousTrustedBoundaryUsn: bigint | null): Promise<OpenedWindow> {
    return {
      journalId: "",
      openedBoundaryUsn: BigInt(0),
      previousTrustedBoundaryUsn: null,
      bootstrap: true,
      status: "HISTORICAL_REHASH_REQUIRED",
      degradationReason: "NO_CONTINUITY_PROVIDER",
    };
  }

  async classify(_input: FileContinuityInput): Promise<FileContinuityVerdict> {
    return {
      state: "REHASH_REQUIRED",
      reuseAuthorized: false,
      evidence: { providerId: this.providerId, providerClass: this.providerClass },
    };
  }
}

import type {
  ClaimType,
  FileContinuityInput,
  FileContinuityVerdict,
  OpenedWindow,
  ProviderClass,
  ProviderId,
} from "@/core/workspace-index/continuity/types";

/**
 * GENERIC_METADATA_V1 — METADATA_ONLY_PROVIDER.
 * May classify metadata/object-identity candidates; MUST NEVER authorize prior
 * content-hash reuse. Ceiling before fresh hash = UNCHANGED_CANDIDATE.
 * Claim is always ROLLING_EXACT_FILE_MANIFEST (SPEC V3 Section 6.2).
 */

export const GENERIC_METADATA_PROVIDER_ID = "GENERIC_METADATA_V1" as const;

export class GenericMetadataProvider {
  readonly providerId: ProviderId = GENERIC_METADATA_PROVIDER_ID;
  readonly providerClass: ProviderClass = "METADATA_ONLY_PROVIDER";
  readonly claimType: ClaimType = "ROLLING_EXACT_FILE_MANIFEST";

  async openWindow(_previousTrustedBoundaryUsn: bigint | null): Promise<OpenedWindow> {
    // No boundary authority may be manufactured (DB CHECK wca_no_false_boundary_ck mirrors this).
    return {
      journalId: "",
      openedBoundaryUsn: BigInt(0),
      previousTrustedBoundaryUsn: null,
      bootstrap: true,
      status: "HISTORICAL_REHASH_REQUIRED",
      degradationReason: "METADATA_ONLY_PROVIDER",
    };
  }

  async classify(input: FileContinuityInput): Promise<FileContinuityVerdict> {
    void input;
    return {
      state: "UNCHANGED_CANDIDATE",
      reuseAuthorized: false,
      evidence: {
        providerId: this.providerId,
        providerClass: this.providerClass,
      },
    };
  }
}

import { GenericMetadataProvider } from "@/core/workspace-index/continuity/metadata-only";
import { NoneProvider } from "@/core/workspace-index/continuity/none";
import { UsnProviderUnavailableError, WindowsNtfsUsnProvider } from "@/core/workspace-index/continuity/windows-ntfs-usn";
import { WindowsUsnJournalPort } from "@/core/workspace-index/continuity/windows-usn-journal-port";
import type {
  ClaimType,
  ProviderClass,
  ProviderId,
  SourceContinuityAuthority,
  UsnCapability,
  UsnJournalPort,
} from "@/core/workspace-index/continuity/types";

/** Accepted vocabulary — closed; no string-surgery normalization. */
export type WorkspaceIndexEngine = "V1" | "V2";

/** Options accepted by the continuity-authority factory. */
export interface FactoryOptions {
  platform?: string;
  volumeRoot: string;
  currentPolicyHash: string;
  usnJournalPort?: UsnJournalPort;
}

/** The authority object returned by the continuity-authority factory. */
export interface ContinuityAuthority {
  readonly providerId: ProviderId;
  readonly providerClass: ProviderClass;
  readonly claimType: ClaimType;
  readonly authority: any;
}

/** Return type of selectContinuityAuthority. */
export interface ProviderSelection {
  selection: ContinuityAuthority;
  degradedFromStrong: boolean;
  degradationReason?: string;
}

/** Valid claim/provider-class pairings. */
const VALID_CLAIM_PROVIDER_PAIRS: ReadonlyArray<[ProviderClass, ClaimType]> = [
  ["STRONG_CONTINUITY_PROVIDER", "SEALED_INTERVAL"],
  ["METADATA_ONLY_PROVIDER", "ROLLING_EXACT_FILE_MANIFEST"],
  ["NO_CONTINUITY_PROVIDER", "ROLLING_EXACT_FILE_MANIFEST"],
];

/*-------------------------------------- V1 PATH (UNCHANGED) ----------*/

/** Existing continuity-authority selection — kept exactly as originally defined. */
export function selectContinuityAuthority(
  options: FactoryOptions & { env?: Record<string, string | undefined> },
): ProviderSelection {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const strongEnabled = env.WORKSPACE_CONTINUITY_STRONG_ENABLED !== "false";

  if (platform === "win32" && strongEnabled) {
    if (!options.usnJournalPort) {
      return {
        selection: {
          providerId: "GENERIC_METADATA_V1",
          providerClass: "METADATA_ONLY_PROVIDER",
          claimType: "ROLLING_EXACT_FILE_MANIFEST",
          authority: new GenericMetadataProvider(),
        },
        degradedFromStrong: true,
        degradationReason: "USN_JOURNAL_PORT_NOT_WIRED_IN_PHASE_3",
      };
    }
    const provider = new WindowsNtfsUsnProvider(options.usnJournalPort, options.volumeRoot, options.currentPolicyHash);
    return {
      selection: {
        providerId: "WINDOWS_NTFS_USN_V1",
        providerClass: "STRONG_CONTINUITY_PROVIDER",
        claimType: "SEALED_INTERVAL",
        authority: provider,
      },
      degradedFromStrong: false,
    };
  }

  if (platform === "win32") {
    return {
      selection: {
        providerId: "GENERIC_METADATA_V1",
        providerClass: "METADATA_ONLY_PROVIDER",
        claimType: "ROLLING_EXACT_FILE_MANIFEST",
        authority: new GenericMetadataProvider(),
      },
      degradedFromStrong: true,
      degradationReason: "WORKSPACE_CONTINUITY_STRONG_DISABLED_BY_CONFIG",
    };
  }

  return {
    selection: {
      providerId: "NONE_V1",
      providerClass: "NO_CONTINUITY_PROVIDER",
      claimType: "ROLLING_EXACT_FILE_MANIFEST",
      authority: new NoneProvider(),
    },
    degradedFromStrong: false,
  };
}

/*-------------------------------------- CAPABILITY PROBE -------*/

/**
 * Phase-3 capability probe: calls selectContinuityAuthority, then if the
 * selected provider is a STRONG provider, probes the journal port's
 * capability. If the probe reports unsupported volume, degrades to
 * METADATA_ONLY without throwing.
 */
export async function resolveWithCapabilityProbe(
  options: FactoryOptions & { env?: Record<string, string | undefined> },
): Promise<ProviderSelection> {
  const initial = selectContinuityAuthority(options);

  // If already degraded or not a strong provider, return as-is.
  if (initial.selection.providerClass !== "STRONG_CONTINUITY_PROVIDER") {
    return initial;
  }

  // Probe the USN journal port capability.
  const port = options.usnJournalPort;
  if (!port) {
    return {
      selection: {
        providerId: "GENERIC_METADATA_V1",
        providerClass: "METADATA_ONLY_PROVIDER",
        claimType: "ROLLING_EXACT_FILE_MANIFEST",
        authority: new GenericMetadataProvider(),
      },
      degradedFromStrong: true,
      degradationReason: "USN_JOURNAL_PORT_NOT_WIRED_IN_PHASE_3",
    };
  }

  try {
    const cap = await port.capability(options.volumeRoot);
    if (!cap.supported) {
      return {
        selection: {
          providerId: "GENERIC_METADATA_V1",
          providerClass: "METADATA_ONLY_PROVIDER",
          claimType: "ROLLING_EXACT_FILE_MANIFEST",
          authority: new GenericMetadataProvider(),
        },
        degradedFromStrong: true,
        degradationReason: `CAPABILITY_PROBE_FAILED:${cap.degradationReason}`,
      };
    }
    return initial;
  } catch {
    return {
      selection: {
        providerId: "GENERIC_METADATA_V1",
        providerClass: "METADATA_ONLY_PROVIDER",
        claimType: "ROLLING_EXACT_FILE_MANIFEST",
        authority: new GenericMetadataProvider(),
      },
      degradedFromStrong: true,
      degradationReason: "CAPABILITY_PROBE_EXCEPTION",
    };
  }
}

/*-------------------------------------- CLAIM VALIDATION -------*/

/** Assert that a provider class and claim type form a valid pairing.
 *  Throws on invalid combinations (fail-closed). */
export function assertClaimMatchesProviderClass(
  providerClass: ProviderClass,
  claimType: ClaimType,
): void {
  const valid = VALID_CLAIM_PROVIDER_PAIRS.some(
    ([pc, ct]) => pc === providerClass && ct === claimType,
  );
  if (!valid) {
    throw new Error(
      `INVALID_CLAIM_PROVIDER_PAIR:${providerClass}/${claimType}`,
    );
  }
}

/* Type re-exports — already exported as interfaces above. */

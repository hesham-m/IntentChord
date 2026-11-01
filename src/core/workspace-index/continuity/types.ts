/**
 * IntentChord Sectioned Evidence — Source Continuity Authority contracts (SPEC V3 Phase 3).
 * Interface-level only. The V2 ingestion engine is NOT wired here (Phase 4 scope).
 *
 * Authority doctrine (frozen):
 *   STRONG_CONTINUITY_PROVIDER  -> claim SEALED_INTERVAL; may authorize prior content-hash
 *                                  reuse ONLY when R1..R7 ALL hold.
 *   METADATA_ONLY_PROVIDER      -> claim ROLLING_EXACT_FILE_MANIFEST; NEVER authorizes
 *                                  prior content-hash reuse; ceiling = UNCHANGED_CANDIDATE.
 *   NO_CONTINUITY_PROVIDER      -> same rolling-manifest ceiling; every-run-first-observation.
 */

export type ProviderClass =
  | "STRONG_CONTINUITY_PROVIDER"
  | "METADATA_ONLY_PROVIDER"
  | "NO_CONTINUITY_PROVIDER";

export type ProviderId = "WINDOWS_NTFS_USN_V1" | "GENERIC_METADATA_V1" | "NONE_V1";

export type ClaimType = "SEALED_INTERVAL" | "ROLLING_EXACT_FILE_MANIFEST";

/** Closed verdict vocabulary surfaced for the later Phase-4 state machine. */
export type ContinuityVerdictState =
  | "UNCHANGED_PROVEN"
  | "UNCHANGED_CANDIDATE"
  | "REHASH_REQUIRED"
  | "MOVE_CANDIDATE"
  | "DELETED"
  | "NEW_OBJECT"
  | "DELETE_RECREATE";

/** Frozen USN reason flag values (Windows USN_RECORD_V2 Reason bitmask). */
export const USN_REASON = {
  DATA_OVERWRITE: 0x00000001,
  DATA_EXTEND: 0x00000002,
  DATA_TRUNCATION: 0x00000004,
  NAMED_DATA_OVERWRITE: 0x00000010,
  NAMED_DATA_EXTEND: 0x00000020,
  NAMED_DATA_TRUNCATION: 0x00000040,
  FILE_CREATE: 0x00000100,
  FILE_DELETE: 0x00000200,
  EA_CHANGE: 0x00000400,
  SECURITY_CHANGE: 0x00000800,
  RENAME_OLD_NAME: 0x00001000,
  RENAME_NEW_NAME: 0x00002000,
  INDEXABLE_CHANGE: 0x00004000,
  HIDDEN_CHANGE: 0x00008000,
  WRITABLE_CHANGE: 0x00010000,
  OBJECT_ID_CHANGE: 0x00020000,
  INTEGRITY_CHANGE: 0x00040000,
  HARD_LINK_CHANGE: 0x00100000,
  CLOSE: 0x80000000,
} as const;

export type UsnReasonCategory =
  | "CONTENT_AFFECTING"
  | "NAMESPACE_PATH_AFFECTING"
  | "NON_CONTENT_AFFECTING"
  | "JOURNAL_CONTROL";

export type ClassifiedUsnReasons = {
  category: UsnReasonCategory;
  /** Highest-priority semantic category present (content > namespace > non-content > close-only). */
  names: string[];
  /** True when any DATA_* / FILE_CREATE / FILE_DELETE / RENAME_* bit is set. */
  contentAffecting: boolean;
  renameOnlyMutation: boolean;
};

const CONTENT_BITS: Array<[number, string]> = [
  [USN_REASON.DATA_OVERWRITE, "DATA_OVERWRITE"],
  [USN_REASON.DATA_EXTEND, "DATA_EXTEND"],
  [USN_REASON.DATA_TRUNCATION, "DATA_TRUNCATION"],
  [USN_REASON.NAMED_DATA_OVERWRITE, "NAMED_DATA_OVERWRITE"],
  [USN_REASON.NAMED_DATA_EXTEND, "NAMED_DATA_EXTEND"],
  [USN_REASON.NAMED_DATA_TRUNCATION, "NAMED_DATA_TRUNCATION"],
];
const NAMESPACE_BITS: Array<[number, string]> = [
  [USN_REASON.FILE_CREATE, "FILE_CREATE"],
  [USN_REASON.FILE_DELETE, "FILE_DELETE"],
  [USN_REASON.RENAME_OLD_NAME, "RENAME_OLD_NAME"],
  [USN_REASON.RENAME_NEW_NAME, "RENAME_NEW_NAME"],
];
const NON_CONTENT_BITS: Array<[number, string]> = [
  [USN_REASON.EA_CHANGE, "EA_CHANGE"],
  [USN_REASON.SECURITY_CHANGE, "SECURITY_CHANGE"],
  [USN_REASON.INDEXABLE_CHANGE, "INDEXABLE_CHANGE"],
  [USN_REASON.HIDDEN_CHANGE, "HIDDEN_CHANGE"],
  [USN_REASON.WRITABLE_CHANGE, "WRITABLE_CHANGE"],
  [USN_REASON.OBJECT_ID_CHANGE, "OBJECT_ID_CHANGE"],
  [USN_REASON.INTEGRITY_CHANGE, "INTEGRITY_CHANGE"],
  [0x00100000, "HARD_LINK_CHANGE"],
];

/** Deterministic taxonomy classification (frozen vectors tested in suite). */
export function classifyUsnReasons(reasonFlags: number): ClassifiedUsnReasons {
  const names: string[] = [];
  let contentAffecting = false;
  let sawRename = false;
  let sawOtherContent = false;
  let sawNamespace = false;
  let sawNonContent = false;
  for (const [bit, name] of CONTENT_BITS) {
    if ((reasonFlags & bit) !== 0) { names.push(name); contentAffecting = true; if (name.startsWith("RENAME")) sawRename = true; else sawOtherContent = true; }
  }
  for (const [bit, name] of NAMESPACE_BITS) {
    if ((reasonFlags & bit) !== 0) { names.push(name); sawNamespace = true; if (name.startsWith("RENAME")) sawRename = true; }
  }
  for (const [bit, name] of NON_CONTENT_BITS) {
    if ((reasonFlags & bit) !== 0) { names.push(name); sawNonContent = true; }
  }
  // Namespace/path-affecting dominates pure non-content; content affects dominate all.
  let category: UsnReasonCategory;
  if (sawOtherContent) category = "CONTENT_AFFECTING";
  else if (sawNamespace || sawRename) category = "NAMESPACE_PATH_AFFECTING";
  else if (sawNonContent) category = "NON_CONTENT_AFFECTING";
  else category = "JOURNAL_CONTROL"; // CLOSE-only / zero-flag bracket events
  return {
    category,
    names: names.sort(),
    contentAffecting,
    renameOnlyMutation: sawRename && !sawOtherContent,
  };
}

export type UsnEvent = {
  usn: bigint;
  /** Stable FileReferenceNumber representation: "<mftRef>:<seq>" lowercase hex parts. */
  fileReferenceNumber: string;
  fileName?: string;
  reasonFlags: number;
  reasons: ClassifiedUsnReasons;
};

export type JournalIdentity = { journalId: string; volumeSerial: string };

export type UsnCapability =
  | { supported: true; journalId: string; volumeSerial: string; firstUsn: bigint; nextUsn: bigint }
  | { supported: false; degradationReason: string };

export type OpenedWindowBase = {
  journalId: string;
  openedBoundaryUsn: bigint;
  previousTrustedBoundaryUsn: bigint | null;
  bootstrap: boolean;
  volumeSerial?: string;
  firstUsn?: bigint;
};

export type OpenedStrongContinuityWindow = OpenedWindowBase & {
  status: "OPENED_STRONG_CONTINUITY";
};

export type HistoricalRehashRequiredWindow = OpenedWindowBase & {
  status: "HISTORICAL_REHASH_REQUIRED";
  degradationReason: string;
};

export type OpenedWindow = OpenedStrongContinuityWindow | HistoricalRehashRequiredWindow;

export type IntervalReadResult =
  | { ok: true; events: UsnEvent[]; truncated: boolean }
  | { ok: false; failure: "GAP_BEFORE_RETAINED" | "TRUNCATED_INTERVAL" | "MALFORMED_EVENT" | "HELPER_TIMEOUT" | "HELPER_CANCELLED" | "HELPER_FAILED" | "JOURNAL_RESET" | "UNSUPPORTED_VOLUME" | "PROVIDER_UNAVAILABLE" };

/** Prior accepted evidence required by R3..R7 evaluation. */
export type PriorContinuityEvidence = {
  attestationId: string;
  attestationSealedAndLinkedToHead: boolean;
  trustedBoundaryUsn: bigint;
  journal: JournalIdentity;
  policyHash: string;
  currentPolicyHash: string;
  contentHash: string;
  sizeBytes: number;
  /** Exact MFT sequence captured with the prior accepted identity (STRONG closure requirement). */
  priorObjectSequence?: number | null;
};

export type FileContinuityInput = {
  relativePath: string;
  deviceId: string;
  objectFileId: string;
  objectSequence: number | null;
  sizeBytes: number;
  prior: PriorContinuityEvidence | null;
};

export type FileContinuityVerdict = {
  state: ContinuityVerdictState;
  /** True ONLY when a STRONG provider proved R1..R7 and no disqualifying event exists. */
  reuseAuthorized: boolean;
  failedCondition?: "R1" | "R2" | "R3_GAP_WRAP_LOSS" | "R3_READ_FAILURE" | "R4" | "R5" | "R6" | "R7";
  evidence: {
    providerId: ProviderId;
    providerClass: ProviderClass;
    volumeOk?: boolean;
    fileIdEqual?: boolean;
    sequenceEqual?: boolean;
    intervalProven?: boolean;
    reasonsSeen?: string[];
    sizeCorroborated?: boolean;
    policyHashEqual?: boolean;
    moveCandidate?: { renameFromPath?: string; proof: "USN_RENAME_PAIR_PROVEN" };
    deleteRecreate?: { priorSequence: number | null; newSequence: number | null };
  };
};

/** Port through which the Windows NTFS provider reaches journal state (helper-backed or fake). */
export interface UsnJournalPort {
  capability(volumeRoot: string): Promise<UsnCapability>;
  readInterval(volumeRoot: string, journal: JournalIdentity, startUsnExclusive: bigint, endUsnInclusive: bigint): Promise<IntervalReadResult>;
}

export interface SourceContinuityAuthority {
  readonly providerId: ProviderId;
  readonly providerClass: ProviderClass;
  readonly claimType: ClaimType;
  openWindow(previousTrustedBoundaryUsn: bigint | null): Promise<OpenedWindow>;
  classify(input: FileContinuityInput): Promise<FileContinuityVerdict>;
  closeWindow?(): void;
}

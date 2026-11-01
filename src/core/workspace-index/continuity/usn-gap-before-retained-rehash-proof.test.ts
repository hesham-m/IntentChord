import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { WindowsNtfsUsnProvider, UsnProviderUnavailableError } from "@/core/workspace-index/continuity/windows-ntfs-usn";
import { IngestionEngineV2, type DiscoveredFile, type DiscoveryPort, type HashPort, type PriorHead, type UsnEventSource } from "@/core/workspace-index/ingestion/engine-v2";
import { MAX_RECONCILE_PASSES } from "@/core/workspace-index/ingestion/state-machine";
import type {
  UsnCapability,
  UsnJournalPort,
  IntervalReadResult,
  JournalIdentity,
  OpenedWindow,
  OpenedStrongContinuityWindow,
  HistoricalRehashRequiredWindow,
  UsnEvent,
} from "@/core/workspace-index/continuity/types";
import { USN_REASON, classifyUsnReasons } from "@/core/workspace-index/continuity/types";

const VOLUME = "E:\\";
const JOURNAL: JournalIdentity = { journalId: "0x01dc66d184ce1a80", volumeSerial: "a2f99630" };
const POLICY = "sha256:0000000000000000000000000000000000000000000000000000000000000001";
const WS_ID = "00000000-0000-0000-0000-000000000001";

// RETAINED JOURNAL RANGE ON DISK: [100000 .. 200000]
const FIRST_USN = BigInt(100000);
const OPENED_USN = BigInt(200000);
// ANCIENT BOUNDARY FALLING BEFORE RETAINED RANGE: 50000 < FIRST_USN
const ANCIENT_PRIOR_USN = BigInt(50000);

function makeDiscoveredFiles(count: number): DiscoveredFile[] {
  const files: DiscoveredFile[] = [];
  for (let i = 0; i < count; i++) {
    const hex = i.toString(16).padStart(8, "0");
    files.push({
      relativePath: `file-${i}.ts`,
      deviceId: "dev_vol_e",
      objectFileId: `0x${hex}`,
      objectSequence: 1,
      sizeBytes: 1024,
      priorFileId: `wfi_prior_${hex}`,
    });
  }
  return files;
}

function makePriorHead(overrides?: Partial<PriorHead>): PriorHead {
  return {
    attestationId: "wca_prior_test",
    attestationSealedAndLinkedToHead: true,
    trustedBoundaryUsn: ANCIENT_PRIOR_USN,
    journalId: JOURNAL.journalId,
    volumeSerial: JOURNAL.volumeSerial,
    policyHash: POLICY,
    ...overrides,
  };
}

class GapTrackingUsnPort implements UsnJournalPort {
  public capabilityCalls = 0;
  public readIntervalCalls = 0;
  public injectedCapability?: UsnCapability;
  public injectedReadResult?: IntervalReadResult;

  async capability(_volumeRoot: string): Promise<UsnCapability> {
    this.capabilityCalls++;
    if (this.injectedCapability) return this.injectedCapability;
    return {
      supported: true,
      journalId: JOURNAL.journalId,
      volumeSerial: JOURNAL.volumeSerial,
      firstUsn: FIRST_USN,
      nextUsn: OPENED_USN,
    };
  }

  async readInterval(
    _volumeRoot: string,
    _journal: JournalIdentity,
    startUsnExclusive: bigint,
    _endUsnInclusive: bigint,
  ): Promise<IntervalReadResult> {
    this.readIntervalCalls++;
    if (this.injectedReadResult) return this.injectedReadResult;
    // Real Win32 / Native NTFS USN behavior: if start < firstUsn on disk, GAP_BEFORE_RETAINED
    if (startUsnExclusive < FIRST_USN) {
      return { ok: false, failure: "GAP_BEFORE_RETAINED" };
    }
    return {
      ok: true,
      events: [],
      truncated: false,
    };
  }
}

function makeEngineDependencies(params: {
  port: GapTrackingUsnPort;
  files: DiscoveredFile[];
  priorHead: PriorHead | null;
  closingEvents?: UsnEvent[];
}) {
  const authority = new WindowsNtfsUsnProvider(params.port, VOLUME, POLICY);

  const discovery: DiscoveryPort = {
    discover: async () => ({
      files: params.files,
      excludedBoundaries: 0,
      skipped: [],
      stats: { totalFiles: params.files.length, totalBytes: params.files.length * 1024, durationMs: 5 },
    }),
  };

  const hash: HashPort = {
    freshHash: async (file) => `sha256:${createHash("sha256").update(file.relativePath).digest("hex")}`,
  };

  let closingReadCount = 0;
  const usnEvents: UsnEventSource = {
    currentUsn: async () => {
      return OPENED_USN + BigInt(50);
    },
    readInterval: async (startExclusive: bigint, endInclusive: bigint) => {
      closingReadCount++;
      if (params.closingEvents && closingReadCount === 1) {
        return {
          ok: true,
          truncated: false,
          events: params.closingEvents.map(e => ({
            usn: String(e.usn),
            fileReferenceNumber: e.fileReferenceNumber,
            fileName: e.fileName,
            reasonFlags: e.reasonFlags,
          })),
        };
      }
      const raw = await params.port.readInterval(VOLUME, JOURNAL, startExclusive, endInclusive);
      if (!raw.ok) return raw;
      return {
        ok: true,
        truncated: raw.truncated,
        events: raw.events.map(e => ({
          usn: String(e.usn),
          fileReferenceNumber: e.fileReferenceNumber,
          fileName: e.fileName,
          reasonFlags: e.reasonFlags,
        })),
      };
    },
  };

  const engine = new IngestionEngineV2({
    authority,
    usnEvents,
    discovery,
    hash,
    workspaceInstanceId: WS_ID,
    snapshotOperationId: "snap_proof_gap_01",
    registrationId: WS_ID,
    configSha256: `sha256:0000000000000000000000000000000000000000000000000000000000000002`,
    currentPolicyHash: POLICY,
    priorHead: params.priorHead,
  });

  return { engine, authority, port: params.port };
}

describe("INTENTCHORD_V2_USN_GAP_BEFORE_RETAINED_GOVERNED_REHASH_FALLBACK_CORRECTION_V1", () => {

  // --------------------------------------------------------------------------
  // T01 — Current Owner regression:
  // Non-bootstrap prior trusted USN boundary is older than retained journal history.
  // READ_USN_INTERVAL returns GAP_BEFORE_RETAINED.
  // Expected: Workspace Index does NOT fail, prior authority becomes REHASH_REQUIRED,
  // files receive fresh governed hashing, no historical reuse occurs.
  // --------------------------------------------------------------------------
  it("T01: Non-bootstrap prior boundary older than retained history does not fail and triggers governed fresh rehash", async () => {
    const port = new GapTrackingUsnPort();
    const files = makeDiscoveredFiles(50);
    const priorHead = makePriorHead({ trustedBoundaryUsn: ANCIENT_PRIOR_USN });

    const { engine } = makeEngineDependencies({ port, files, priorHead });

    const outcome = await engine.runObservation();

    expect(outcome.outcome).toBe("SEALED");
    if (outcome.outcome !== "SEALED") return;

    // Must NOT fail with WORKSPACE_CONTINUITY_UNAVAILABLE
    expect(outcome.files.length).toBe(50);

    // All files must be fresh-hashed (no historical reuse)
    expect(outcome.files.every(f => f.contentHashSource === "FRESH")).toBe(true);
    expect(outcome.files.every(f => f.state !== "UNCHANGED_PROVEN")).toBe(true);

    // Historical continuity was broken and recorded
    expect(outcome.historicalContinuityBroken).toBe(true);
    expect(outcome.historicalContinuityBrokenReason).toBe("GAP_BEFORE_RETAINED");
  });

  // --------------------------------------------------------------------------
  // T02 — No false reuse:
  // With GAP_BEFORE_RETAINED: a file whose prior hash/metadata exists MUST NOT
  // be reused solely from historical persisted state.
  // --------------------------------------------------------------------------
  it("T02: With GAP_BEFORE_RETAINED, files with existing prior metadata are never reused", async () => {
    const port = new GapTrackingUsnPort();
    const files = makeDiscoveredFiles(10);
    const priorHead = makePriorHead({ trustedBoundaryUsn: ANCIENT_PRIOR_USN });

    const { engine } = makeEngineDependencies({ port, files, priorHead });
    const outcome = await engine.runObservation();

    expect(outcome.outcome).toBe("SEALED");
    if (outcome.outcome !== "SEALED") return;

    for (const f of outcome.files) {
      // Content hash must be fresh, not reused formula
      expect(f.contentHashSource).toBe("FRESH");
      expect(f.contentHash.startsWith("sha256:")).toBe(true);
      expect(f.contentHash).not.toContain("reused:");
    }
  });

  // --------------------------------------------------------------------------
  // T03 — Attempt-scoped transport preserved:
  // 100 / 1,000 / 10,000 files under identical conditions:
  // USN transport count remains independent of file count.
  // --------------------------------------------------------------------------
  it("T03: Transport count remains independent of file count under GAP_BEFORE_RETAINED", async () => {
    const counts = [100, 1000, 10000];
    const measuredCalls: number[] = [];

    for (const count of counts) {
      const port = new GapTrackingUsnPort();
      const files = makeDiscoveredFiles(count);
      const priorHead = makePriorHead({ trustedBoundaryUsn: ANCIENT_PRIOR_USN });

      const { engine } = makeEngineDependencies({ port, files, priorHead });
      const outcome = await engine.runObservation();

      expect(outcome.outcome).toBe("SEALED");
      // capability (1 opening) + readInterval (P6 close reconcile)
      const totalCalls = port.capabilityCalls + port.readIntervalCalls;
      measuredCalls.push(totalCalls);
    }

    const [c100, c1000, c10000] = measuredCalls;
    expect(c100).toBe(c1000);
    expect(c1000).toBe(c10000);
    // Transport calls are strictly O(1)
    expect(c100).toBeLessThanOrEqual(3);
  });

  // --------------------------------------------------------------------------
  // T04 — SERVICE_UNAVAILABLE remains fatal:
  // Actual Named Pipe/provider unavailability fails closed with UsnProviderUnavailableError.
  // --------------------------------------------------------------------------
  it("T04: Actual SERVICE_UNAVAILABLE remains strictly fatal (fail-closed, never rehash)", async () => {
    const port = new GapTrackingUsnPort();
    port.injectedCapability = { supported: false, degradationReason: "SERVICE_UNAVAILABLE" };

    const files = makeDiscoveredFiles(10);
    const priorHead = makePriorHead({ trustedBoundaryUsn: ANCIENT_PRIOR_USN });

    const { engine } = makeEngineDependencies({ port, files, priorHead });

    await expect(engine.runObservation()).rejects.toThrow(UsnProviderUnavailableError);
    await expect(engine.runObservation()).rejects.toThrow("SERVICE_UNAVAILABLE");
  });

  // --------------------------------------------------------------------------
  // T05 — ACCESS_DENIED / protocol transport failures preserved:
  // Relevant non-rehashable provider/transport failures remain fail-closed.
  // --------------------------------------------------------------------------
  it("T05: ACCESS_DENIED and PROVIDER_UNAVAILABLE transport failures remain fail-closed", async () => {
    // 1. ACCESS_DENIED on capability probe
    const port1 = new GapTrackingUsnPort();
    port1.injectedCapability = { supported: false, degradationReason: "ACCESS_DENIED" };
    const { engine: engine1 } = makeEngineDependencies({ port: port1, files: makeDiscoveredFiles(5), priorHead: makePriorHead() });
    await expect(engine1.runObservation()).rejects.toThrow(UsnProviderUnavailableError);
    await expect(engine1.runObservation()).rejects.toThrow("ACCESS_DENIED");

    // 2. PROVIDER_UNAVAILABLE during readInterval
    const port2 = new GapTrackingUsnPort();
    port2.injectedReadResult = { ok: false, failure: "PROVIDER_UNAVAILABLE" };
    const authority2 = new WindowsNtfsUsnProvider(port2, VOLUME, POLICY);
    await expect(authority2.openWindow(FIRST_USN + BigInt(10))).rejects.toThrow(UsnProviderUnavailableError);
  });

  // --------------------------------------------------------------------------
  // T06 — Journal identity/reset semantics preserved:
  // Exercise CURRENT journal reset / journal identity mismatch behavior.
  // --------------------------------------------------------------------------
  it("T06: Journal reset and volume identity mismatch follow frozen contract semantics", async () => {
    // 1. Journal ID mismatch -> R1 failure in classification
    const port = new GapTrackingUsnPort();
    const authority = new WindowsNtfsUsnProvider(port, VOLUME, POLICY);
    const mismatchPrior = makePriorHead({ journalId: "0xMISMATCH_JOURNAL" });
    const verdictR1 = await authority.classify({
      relativePath: "file-0.ts",
      deviceId: "dev_vol_e",
      objectFileId: "0x00000001",
      objectSequence: 1,
      sizeBytes: 1024,
      prior: {
        attestationId: "wca_prior",
        attestationSealedAndLinkedToHead: true,
        trustedBoundaryUsn: FIRST_USN + BigInt(50),
        journal: { journalId: "0xMISMATCH_JOURNAL", volumeSerial: JOURNAL.volumeSerial },
        policyHash: POLICY,
        currentPolicyHash: POLICY,
        contentHash: "sha256:abc",
        sizeBytes: 1024,
      },
    });
    expect(verdictR1.state).toBe("REHASH_REQUIRED");
    expect(verdictR1.failedCondition).toBe("R1");

    // 2. Historical JOURNAL_RESET -> R3_GAP_WRAP_LOSS -> REHASH_REQUIRED
    const portReset = new GapTrackingUsnPort();
    portReset.injectedReadResult = { ok: false, failure: "JOURNAL_RESET" };
    const authorityReset = new WindowsNtfsUsnProvider(portReset, VOLUME, POLICY);
    const openedReset = await authorityReset.openWindow(FIRST_USN + BigInt(50));
    expect(openedReset.status).toBe("HISTORICAL_REHASH_REQUIRED");
    if (openedReset.status === "HISTORICAL_REHASH_REQUIRED") {
      expect(openedReset.degradationReason).toBe("JOURNAL_RESET");
    }
  });

  // --------------------------------------------------------------------------
  // T07 — Opening boundary rebuilt truthfully:
  // After historical gap fallback: prove the attempt establishes current
  // continuity authority suitable for the newly hashed state.
  // --------------------------------------------------------------------------
  it("T07: After historical gap fallback, current continuity authority establishes truthful new baseline", async () => {
    const port = new GapTrackingUsnPort();
    const files = makeDiscoveredFiles(20);
    const priorHead = makePriorHead({ trustedBoundaryUsn: ANCIENT_PRIOR_USN });

    const { engine } = makeEngineDependencies({ port, files, priorHead });
    const outcome = await engine.runObservation();

    expect(outcome.outcome).toBe("SEALED");
    if (outcome.outcome !== "SEALED") return;

    // Truthful opening boundary is B_open (current attempt opening boundary), NOT the ancient dead boundary
    expect(outcome.openedBoundaryUsn).toBe(OPENED_USN);
    expect(outcome.openedBoundaryUsn).not.toBe(ANCIENT_PRIOR_USN);
    expect(outcome.closedBoundaryUsn >= outcome.openedBoundaryUsn).toBe(true);

    // Explicit invariant assertions:
    // PREDECESSOR_CONTINUITY_CLAIM_BROKEN_ON_HISTORICAL_GAP=YES
    expect(outcome.historicalContinuityBroken).toBe(true);
    // NEW_TRUSTED_CHAIN_STARTS_FROM_CURRENT_ATTEMPT_BOUNDARY=YES
    expect(outcome.openedBoundaryUsn).toBe(OPENED_USN);
  });

  // --------------------------------------------------------------------------
  // T08 — Closing reconciliation still works:
  // File mutates after opening/current boundary but before close.
  // -> close reconciliation detects it -> fresh source truth wins -> no false seal.
  // --------------------------------------------------------------------------
  it("T08: Closing reconciliation detects file mutation occurring during the attempt", async () => {
    const port = new GapTrackingUsnPort();
    const files = makeDiscoveredFiles(10);
    const priorHead = makePriorHead({ trustedBoundaryUsn: ANCIENT_PRIOR_USN });

    // Inject a content-affecting event for file-2.ts during reconciliation
    const closingEvents: UsnEvent[] = [{
      usn: OPENED_USN + BigInt(25),
      fileReferenceNumber: "2:1", // matches file-2.ts (objectFileId 0x00000002, objectSequence 1)
      fileName: "file-2.ts",
      reasonFlags: USN_REASON.DATA_OVERWRITE,
      reasons: classifyUsnReasons(USN_REASON.DATA_OVERWRITE),
    }];

    const { engine } = makeEngineDependencies({ port, files, priorHead, closingEvents });
    const outcome = await engine.runObservation();

    expect(outcome.outcome).toBe("SEALED");
    if (outcome.outcome !== "SEALED") return;

    // file-2.ts must be recaptured and marked CHANGED_PROVEN
    const f2 = outcome.files.find(f => f.relativePath === "file-2.ts");
    expect(f2).toBeDefined();
    expect(f2!.state).toBe("CHANGED_PROVEN");
    expect(f2!.contentHashSource).toBe("FRESH");

    // Reconciliation pass captured the mutation
    expect(outcome.reconciliationPasses).toBe(1);
    expect(outcome.reconciliationPassSummary[0].recapturedCount).toBe(1);
    expect(outcome.reconciliationPassSummary[0].terminalDisposition).toBe("RESOLVED");
  });

  // --------------------------------------------------------------------------
  // T09 — >4096 event handling preserved:
  // No silent interval truncation. Existing governed truncation behavior remains correct.
  // --------------------------------------------------------------------------
  it("T09: >4096 event truncation is explicitly marked and fails closed to REHASH_REQUIRED", async () => {
    const port = new GapTrackingUsnPort();
    port.injectedReadResult = { ok: true, events: [], truncated: true };

    const authority = new WindowsNtfsUsnProvider(port, VOLUME, POLICY);
    const opened = await authority.openWindow(FIRST_USN + BigInt(10));

    expect(opened.status).toBe("HISTORICAL_REHASH_REQUIRED");
    if (opened.status === "HISTORICAL_REHASH_REQUIRED") {
      expect(opened.degradationReason).toBe("TRUNCATED_INTERVAL");
    }
  });

  // --------------------------------------------------------------------------
  // T10 — Two attempts lifecycle isolation:
  // No activeWindow/context leakage across consecutive attempts.
  // --------------------------------------------------------------------------
  it("T10: Two consecutive index attempts maintain strict window isolation without context leakage", async () => {
    const port = new GapTrackingUsnPort();
    const files1 = makeDiscoveredFiles(10);
    const priorHead = makePriorHead({ trustedBoundaryUsn: ANCIENT_PRIOR_USN });

    const { engine: engine1, authority } = makeEngineDependencies({ port, files: files1, priorHead });

    const outcome1 = await engine1.runObservation();
    expect(outcome1.outcome).toBe("SEALED");
    expect(authority.getActiveWindow()).toBeNull(); // Cleaned up!

    // Second attempt with same provider instance
    const files2 = makeDiscoveredFiles(10);
    const { engine: engine2 } = makeEngineDependencies({ port, files: files2, priorHead });

    const outcome2 = await engine2.runObservation();
    expect(outcome2.outcome).toBe("SEALED");
    expect(authority.getActiveWindow()).toBeNull(); // Cleaned up again!
  });

  // --------------------------------------------------------------------------
  // T11 — Workspace Index V2 service regression:
  // Uses isolated fixture equivalent to the current Owner case.
  // Service proceeds beyond historical continuity qualification, fresh hashing occurs,
  // attempt seals, no WORKSPACE_CONTINUITY_UNAVAILABLE solely from GAP_BEFORE_RETAINED.
  // --------------------------------------------------------------------------
  it("T11: V2 observation proceeds beyond historical continuity gap without WORKSPACE_CONTINUITY_UNAVAILABLE", async () => {
    const port = new GapTrackingUsnPort();
    const files = makeDiscoveredFiles(100);
    const priorHead = makePriorHead({ trustedBoundaryUsn: ANCIENT_PRIOR_USN });

    const { engine } = makeEngineDependencies({ port, files, priorHead });
    const outcome = await engine.runObservation();

    expect(outcome.outcome).toBe("SEALED");
    if (outcome.outcome !== "SEALED") return;

    expect(outcome.files.length).toBe(100);
    expect(outcome.files.every(f => f.contentHashSource === "FRESH")).toBe(true);
    expect(outcome.historicalContinuityBroken).toBe(true);
  });

  // --------------------------------------------------------------------------
  // T12 — Previous fixes preserved + Invariants:
  // - MAX_RECONCILE_PASSES = 2 strictly preserved (RECONCILIATION_PASS_BOUND_CHANGED=NO)
  // - OpenedWindow is a type-safe discriminated union
  // - PREDECESSOR_CONTINUITY_CLAIM_BROKEN_ON_HISTORICAL_GAP=YES
  // - PREVIOUS_BOUNDARY_RETAINED_ONLY_AS_PROVENANCE_IF_PRESENT=YES
  // - NEW_TRUSTED_CHAIN_STARTS_FROM_CURRENT_ATTEMPT_BOUNDARY=YES
  // - FALSE_CONTINUITY_ATTESTATION_POSSIBLE=NO
  // --------------------------------------------------------------------------
  it("T12: Invariants and previous architectural fixes preserved", async () => {
    // 1. Reconciliation pass bound preserved
    expect(MAX_RECONCILE_PASSES).toBe(2);

    // 2. OpenedWindow type-safe discriminated union check
    const port = new GapTrackingUsnPort();
    const authority = new WindowsNtfsUsnProvider(port, VOLUME, POLICY);

    // Bootstrap -> OPENED_STRONG_CONTINUITY
    const boot = await authority.openWindow(null);
    expect(boot.status).toBe("OPENED_STRONG_CONTINUITY");
    authority.closeWindow();

    // Gap -> HISTORICAL_REHASH_REQUIRED
    const gap = await authority.openWindow(ANCIENT_PRIOR_USN);
    expect(gap.status).toBe("HISTORICAL_REHASH_REQUIRED");
    if (gap.status === "HISTORICAL_REHASH_REQUIRED") {
      expect(gap.degradationReason).toBe("GAP_BEFORE_RETAINED");
    }
    authority.closeWindow();

    // 3. Chain start verification:
    // When gap occurs, opening boundary is current attempt's nextUsn
    expect(gap.openedBoundaryUsn).toBe(OPENED_USN);
    expect(gap.previousTrustedBoundaryUsn).toBe(ANCIENT_PRIOR_USN); // Retained as provenance
  });
});

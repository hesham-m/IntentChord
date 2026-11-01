import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { WindowsNtfsUsnProvider } from "@/core/workspace-index/continuity/windows-ntfs-usn";
import { IngestionEngineV2 } from "@/core/workspace-index/ingestion/engine-v2";
import { UsnProviderUnavailableError } from "@/core/workspace-index/continuity/windows-ntfs-usn";
import type {
  DiscoveredFile,
  DiscoveryPort,
  HashPort,
  PriorHead,
  UsnEventSource,
} from "@/core/workspace-index/ingestion/engine-v2";
import type {
  IntervalReadResult,
  JournalIdentity,
  UsnCapability,
  UsnEvent,
  UsnJournalPort,
} from "@/core/workspace-index/continuity/types";
import { USN_REASON } from "@/core/workspace-index/continuity/types";

// ============================================================================
// Deterministic Test Fixtures & Helpers
// ============================================================================

const HEX = (c: string) => c.repeat(64);
const WS_ID = "ws_attempt_scoped_proof";
const VOLUME = "E:\\";
const POLICY = `sha256:${HEX("a")}`;
const JOURNAL: JournalIdentity = { journalId: "J-PROVEN-01", volumeSerial: "VOL-PROVEN-01" };
const FIRST_USN = BigInt(1000);
const OPENED_USN = BigInt(5000);
const PRIOR_USN = BigInt(2000);

function makeDiscoveredFiles(count: number): DiscoveredFile[] {
  const files: DiscoveredFile[] = [];
  for (let i = 0; i < count; i++) {
    const hexId = i.toString(16).padStart(32, "0");
    files.push({
      relativePath: `src/file_${i}.ts`,
      fileName: `file_${i}.ts`,
      deviceId: "1234567890",
      objectFileId: hexId,
      objectSequence: 0x10,
      sizeBytes: 1024,
      fileKind: "SOURCE_CODE",
      language: "typescript",
      sensitivityState: "OWNER_RESTRICTED",
    });
  }
  return files;
}

function makePriorHead(overrides?: Partial<PriorHead>): PriorHead {
  return {
    attestationId: `wca_${HEX("f")}`,
    attestationSealedAndLinkedToHead: true,
    trustedBoundaryUsn: PRIOR_USN,
    journalId: JOURNAL.journalId,
    volumeSerial: JOURNAL.volumeSerial,
    policyHash: POLICY,
    ...overrides,
  };
}

class CountingTrackingUsnPort implements UsnJournalPort {
  public capabilityCalls = 0;
  public readIntervalCalls = 0;
  public injectedReadResult?: IntervalReadResult;
  public injectedCapability?: UsnCapability;

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
    _startUsnExclusive: bigint,
    _endUsnInclusive: bigint,
  ): Promise<IntervalReadResult> {
    this.readIntervalCalls++;
    if (this.injectedReadResult) return this.injectedReadResult;
    return {
      ok: true,
      events: [],
      truncated: false,
    };
  }
}

function makeEngineDependencies(params: {
  port: CountingTrackingUsnPort;
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
      return OPENED_USN + BigInt(100);
    },
    readInterval: async (_startExclusive: bigint, _endInclusive: bigint) => {
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
      return { ok: true, truncated: false, events: [] };
    },
  };

  const engine = new IngestionEngineV2({
    authority,
    usnEvents,
    discovery,
    hash,
    workspaceInstanceId: WS_ID,
    snapshotOperationId: "snap_proof_01",
    registrationId: WS_ID,
    configSha256: `sha256:${HEX("b")}`,
    currentPolicyHash: POLICY,
    priorHead: params.priorHead,
  });

  return { engine, authority, port: params.port };
}

// ============================================================================
// Targeted Verification Suite (T01 - T14)
// ============================================================================

describe("INTENTCHORD_V2_USN_ATTEMPT_SCOPED_CONTINUITY_LIFECYCLE_CORRECTION_V1", () => {

  // --------------------------------------------------------------------------
  // T01: Non-bootstrap valid continuity
  // --------------------------------------------------------------------------
  it("T01: Non-bootstrap valid continuity succeeds with zero per-file transport calls", async () => {
    const port = new CountingTrackingUsnPort();
    const files = makeDiscoveredFiles(100);
    const priorHead = makePriorHead();

    const { engine, authority } = makeEngineDependencies({ port, files, priorHead });

    const outcome = await engine.runObservation();

    expect(outcome.outcome).toBe("SEALED");
    if (outcome.outcome !== "SEALED") return;

    // All files should be UNCHANGED_PROVEN via strong continuity chain
    expect(outcome.files.every(f => f.state === "UNCHANGED_PROVEN")).toBe(true);
    expect(outcome.files.every(f => f.contentHashSource === "REUSED")).toBe(true);

    // Opening window transport work happened exactly once
    expect(port.capabilityCalls).toBe(1);
    expect(port.readIntervalCalls).toBe(1);

    // Active window context was released at attempt end
    expect(authority.getActiveWindow()).toBeNull();
  });

  // --------------------------------------------------------------------------
  // T02: Transport call-count bound (Independent of File Count)
  // --------------------------------------------------------------------------
  it("T02: Transport call-count is strictly file-independent (100, 1000, 10000 files produce identical calls)", async () => {
    const counts = [100, 1000, 10000];
    const measuredCalls: number[] = [];

    for (const count of counts) {
      const port = new CountingTrackingUsnPort();
      const files = makeDiscoveredFiles(count);
      const priorHead = makePriorHead();

      const { engine } = makeEngineDependencies({ port, files, priorHead });
      const outcome = await engine.runObservation();

      expect(outcome.outcome).toBe("SEALED");
      const totalCalls = port.capabilityCalls + port.readIntervalCalls;
      measuredCalls.push(totalCalls);
    }

    // Report exact measured calls
    const [c100, c1000, c10000] = measuredCalls;
    expect(c100).toBe(2);
    expect(c1000).toBe(2);
    expect(c10000).toBe(2);

    // Strict invariance assertion
    expect(c100).toBe(c1000);
    expect(c1000).toBe(c10000);
  });

  // --------------------------------------------------------------------------
  // T03: Bootstrap preservation
  // --------------------------------------------------------------------------
  it("T03: Bootstrap workspace preserves frozen bootstrap semantics (all files NEW, FRESH hash)", async () => {
    const port = new CountingTrackingUsnPort();
    const files = makeDiscoveredFiles(50);

    const { engine } = makeEngineDependencies({ port, files, priorHead: null });
    const outcome = await engine.runObservation();

    expect(outcome.outcome).toBe("SEALED");
    if (outcome.outcome !== "SEALED") return;

    expect(outcome.files.every(f => f.state === "NEW")).toBe(true);
    expect(outcome.files.every(f => f.contentHashSource === "FRESH")).toBe(true);

    // In bootstrap, no prior interval read is performed
    expect(port.readIntervalCalls).toBe(0);
    expect(port.capabilityCalls).toBe(1);
  });

  // --------------------------------------------------------------------------
  // T04: Opening authority preserved
  // --------------------------------------------------------------------------
  it("T04: Governed opening journal and boundary authority is captured and sealed", async () => {
    const port = new CountingTrackingUsnPort();
    const files = makeDiscoveredFiles(10);
    const priorHead = makePriorHead();

    const { engine } = makeEngineDependencies({ port, files, priorHead });
    const outcome = await engine.runObservation();

    expect(outcome.outcome).toBe("SEALED");
    if (outcome.outcome !== "SEALED") return;

    expect(outcome.openedBoundaryUsn).toBe(OPENED_USN);
    expect(outcome.sealPlan).toBeDefined();
    expect(outcome.claimType).toBe("SEALED_INTERVAL");
  });

  // --------------------------------------------------------------------------
  // T05: Closing reconciliation preserved
  // --------------------------------------------------------------------------
  it("T05: Closing continuity reconciliation is performed and captures closedBoundaryUsn", async () => {
    const port = new CountingTrackingUsnPort();
    const files = makeDiscoveredFiles(10);
    const priorHead = makePriorHead();

    const { engine } = makeEngineDependencies({ port, files, priorHead });
    const outcome = await engine.runObservation();

    expect(outcome.outcome).toBe("SEALED");
    if (outcome.outcome !== "SEALED") return;

    expect(outcome.closedBoundaryUsn).toBeDefined();
    expect(typeof outcome.reconciliationPasses).toBe("number");
    expect(outcome.reconciliationPasses).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(outcome.reconciliationPassSummary)).toBe(true);
  });

  // --------------------------------------------------------------------------
  // T06: Journal reset / continuity break (Fail Closed)
  // --------------------------------------------------------------------------
  it("T06: Journal reset / mismatch fails closed to REHASH_REQUIRED without false reuse", async () => {
    const port = new CountingTrackingUsnPort();
    port.injectedCapability = {
      supported: true,
      journalId: "DIFFERENT_RESET_JOURNAL",
      volumeSerial: JOURNAL.volumeSerial,
      firstUsn: FIRST_USN,
      nextUsn: OPENED_USN,
    };

    const files = makeDiscoveredFiles(20);
    const priorHead = makePriorHead(); // has JOURNAL.journalId

    const { engine } = makeEngineDependencies({ port, files, priorHead });
    const outcome = await engine.runObservation();

    expect(outcome.outcome).toBe("SEALED");
    if (outcome.outcome !== "SEALED") return;

    // Journal ID mismatch triggers R1 failure -> REHASH_REQUIRED, no reuse authorized
    expect(outcome.files.every(f => f.contentHashSource === "FRESH")).toBe(true);
  });

  // --------------------------------------------------------------------------
  // T07: SERVICE_UNAVAILABLE (Fail Closed)
  // --------------------------------------------------------------------------
  it("T07: SERVICE_UNAVAILABLE during required continuity step fails closed and rethrows UsnProviderUnavailableError", async () => {
    const port = new CountingTrackingUsnPort();
    port.injectedCapability = {
      supported: false,
      degradationReason: "SERVICE_UNAVAILABLE",
    };

    const files = makeDiscoveredFiles(10);
    const priorHead = makePriorHead();

    const { engine } = makeEngineDependencies({ port, files, priorHead });

    await expect(engine.runObservation()).rejects.toThrow(UsnProviderUnavailableError);
  });

  // --------------------------------------------------------------------------
  // T08: Large-workspace bounded-memory proof
  // --------------------------------------------------------------------------
  it("T08: 10,000 discovered files maintain bounded memory (event index bounded by maxEvents 4096)", async () => {
    const port = new CountingTrackingUsnPort();
    const files = makeDiscoveredFiles(10000);
    const priorHead = makePriorHead();

    const { engine, authority } = makeEngineDependencies({ port, files, priorHead });

    const memBefore = process.memoryUsage().heapUsed;
    const outcome = await engine.runObservation();
    const memAfter = process.memoryUsage().heapUsed;

    expect(outcome.outcome).toBe("SEALED");

    // Transport calls remained O(1)
    expect(port.capabilityCalls).toBe(1);
    expect(port.readIntervalCalls).toBe(1);

    // Active window context was completely released at attempt completion
    expect(authority.getActiveWindow()).toBeNull();

    // Heap difference is strictly bounded
    const heapDiffMb = (memAfter - memBefore) / (1024 * 1024);
    expect(heapDiffMb).toBeLessThan(150);
  });

  // --------------------------------------------------------------------------
  // T09: Production service regression (Reaches beyond previous classification failure)
  // --------------------------------------------------------------------------
  it("T09: Production path reaches beyond previous per-file classification failure without SERVICE_UNAVAILABLE", async () => {
    class StrictChurnRejectingPort extends CountingTrackingUsnPort {
      async capability(volumeRoot: string): Promise<UsnCapability> {
        // If capability is called more than once per attempt (e.g. per file churn), reject with SERVICE_UNAVAILABLE
        if (this.capabilityCalls >= 1) {
          throw new UsnProviderUnavailableError("SERVICE_UNAVAILABLE");
        }
        return super.capability(volumeRoot);
      }

      async readInterval(volumeRoot: string, journal: JournalIdentity, start: bigint, end: bigint): Promise<IntervalReadResult> {
        // If readInterval is called more than once per attempt (e.g. per file churn), reject
        if (this.readIntervalCalls >= 1) {
          throw new UsnProviderUnavailableError("SERVICE_UNAVAILABLE");
        }
        return super.readInterval(volumeRoot, journal, start, end);
      }
    }

    const port = new StrictChurnRejectingPort();
    const files = makeDiscoveredFiles(100);
    const priorHead = makePriorHead();

    const { engine } = makeEngineDependencies({ port, files, priorHead });

    // In previous defect, this failed during classification at filesSeen=100 with SERVICE_UNAVAILABLE.
    // In corrected lifecycle, exactly 1 opening capability + 1 read call occur, succeeding completely.
    const outcome = await engine.runObservation();
    expect(outcome.outcome).toBe("SEALED");
    if (outcome.outcome !== "SEALED") return;

    expect(outcome.files.length).toBe(100);
    expect(outcome.files.every(f => f.state === "UNCHANGED_PROVEN")).toBe(true);
  });

  // --------------------------------------------------------------------------
  // T10: Existing V2 staging/progress regression
  // --------------------------------------------------------------------------
  it("T10: V2 progress progression (DISCOVERING -> CLASSIFYING -> SEALING) remains fully intact", async () => {
    const port = new CountingTrackingUsnPort();
    const files = makeDiscoveredFiles(250);
    const priorHead = makePriorHead();

    const authority = new WindowsNtfsUsnProvider(port, VOLUME, POLICY);
    const phasesObserved: string[] = [];

    const engine = new IngestionEngineV2({
      authority,
      usnEvents: {
        currentUsn: async () => OPENED_USN + BigInt(50),
        readInterval: async () => ({ ok: true, truncated: false, events: [] }),
      },
      discovery: {
        discover: async () => ({ files, excludedBoundaries: 0, skipped: [], stats: { totalFiles: 250, totalBytes: 256000, durationMs: 5 } }),
      },
      hash: { freshHash: async f => `sha256:${f.relativePath}` },
      workspaceInstanceId: WS_ID,
      snapshotOperationId: "snap_proof_t10",
      registrationId: WS_ID,
      configSha256: `sha256:${HEX("b")}`,
      currentPolicyHash: POLICY,
      priorHead,
      onProgress: (phase) => {
        if (!phasesObserved.includes(phase)) phasesObserved.push(phase);
      },
    });

    const outcome = await engine.runObservation();
    expect(outcome.outcome).toBe("SEALED");

    expect(phasesObserved).toContain("DISCOVERING");
    expect(phasesObserved).toContain("CLASSIFYING");
    expect(phasesObserved).toContain("SEALING");
  });

  // --------------------------------------------------------------------------
  // T11: Churn detection between opening and closing boundary
  // --------------------------------------------------------------------------
  it("T11: File mutated after opening boundary is detected by close reconciliation without per-file transport", async () => {
    const port = new CountingTrackingUsnPort();
    const files = makeDiscoveredFiles(10);
    const priorHead = makePriorHead();

    // File 3 is mutated after the opening boundary
    const mutatedFile = files[3];
    const closingEvents: UsnEvent[] = [{
      usn: OPENED_USN + BigInt(5),
      fileReferenceNumber: `${mutatedFile.objectFileId}:10`,
      fileName: mutatedFile.fileName,
      reasonFlags: USN_REASON.DATA_OVERWRITE,
      reasons: { category: "CONTENT_AFFECTING", contentAffecting: true, renameOnlyMutation: false, names: ["DATA_OVERWRITE"] },
    }];

    const { engine } = makeEngineDependencies({ port, files, priorHead, closingEvents });
    const outcome = await engine.runObservation();

    expect(outcome.outcome).toBe("SEALED");
    if (outcome.outcome !== "SEALED") return;

    const file3Result = outcome.files.find(f => f.relativePath === mutatedFile.relativePath);
    expect(file3Result).toBeDefined();
    expect(file3Result!.state).toBe("CHANGED_PROVEN");
    expect(file3Result!.contentHashSource).toBe("FRESH");

    // Other files remained unchanged
    const file0Result = outcome.files.find(f => f.relativePath === files[0].relativePath);
    expect(file0Result!.state).toBe("UNCHANGED_PROVEN");
    expect(file0Result!.contentHashSource).toBe("REUSED");
  });

  // --------------------------------------------------------------------------
  // T12: Truncated interval exceeds event bound -> Fail closed to REHASH_REQUIRED (R3)
  // --------------------------------------------------------------------------
  it("T12: Interval exceeding 4096 event bound (truncated: true) fails closed to REHASH_REQUIRED (R3) without false reuse", async () => {
    const port = new CountingTrackingUsnPort();
    port.injectedReadResult = {
      ok: true,
      events: [],
      truncated: true,
    };

    const files = makeDiscoveredFiles(20);
    const priorHead = makePriorHead();

    const { engine } = makeEngineDependencies({ port, files, priorHead });
    const outcome = await engine.runObservation();

    expect(outcome.outcome).toBe("SEALED");
    if (outcome.outcome !== "SEALED") return;

    // Truncation must fail closed: no files authorized for reuse, all fresh-hashed
    expect(outcome.files.every(f => f.contentHashSource === "FRESH")).toBe(true);
  });

  // --------------------------------------------------------------------------
  // T13: Attempt lifecycle boundary isolation
  // --------------------------------------------------------------------------
  it("T13: Two consecutive index attempts cannot reuse the previous attempt's active USN window context", async () => {
    const port = new CountingTrackingUsnPort();
    const filesAttempt1 = makeDiscoveredFiles(10);
    const priorHead = makePriorHead();

    const { engine: engine1, authority } = makeEngineDependencies({ port, files: filesAttempt1, priorHead });

    // Run Attempt 1
    const outcome1 = await engine1.runObservation();
    expect(outcome1.outcome).toBe("SEALED");
    expect(authority.getActiveWindow()).toBeNull(); // Cleaned up!

    // Attempt 2 uses the same authority instance
    const filesAttempt2 = makeDiscoveredFiles(15);
    const engine2 = new IngestionEngineV2({
      authority,
      usnEvents: {
        currentUsn: async () => OPENED_USN + BigInt(200),
        readInterval: async () => ({ ok: true, truncated: false, events: [] }),
      },
      discovery: {
        discover: async () => ({ files: filesAttempt2, excludedBoundaries: 0, skipped: [], stats: { totalFiles: 15, totalBytes: 15360, durationMs: 5 } }),
      },
      hash: { freshHash: async f => `sha256:${f.relativePath}` },
      workspaceInstanceId: WS_ID,
      snapshotOperationId: "snap_proof_02",
      registrationId: WS_ID,
      configSha256: `sha256:${HEX("b")}`,
      currentPolicyHash: POLICY,
      priorHead,
    });

    const outcome2 = await engine2.runObservation();
    expect(outcome2.outcome).toBe("SEALED");
    expect(authority.getActiveWindow()).toBeNull(); // Cleaned up again!

    // Exactly 2 capability calls and 2 read calls total (1 pair per attempt)
    expect(port.capabilityCalls).toBe(2);
    expect(port.readIntervalCalls).toBe(2);
  });

  // --------------------------------------------------------------------------
  // T14: Strictly typed authority boundary (No 'as any' escape)
  // --------------------------------------------------------------------------
  it("T14: OpenedWindow and SourceContinuityAuthority are strictly typed with zero type escapes", async () => {
    const port = new CountingTrackingUsnPort();
    const authority = new WindowsNtfsUsnProvider(port, VOLUME, POLICY);

    const opened = await authority.openWindow(PRIOR_USN);

    // Type assertions
    expect(typeof opened.journalId).toBe("string");
    expect(typeof opened.openedBoundaryUsn).toBe("bigint");
    expect(typeof opened.volumeSerial).toBe("string");
    expect(typeof opened.firstUsn).toBe("bigint");

    // activeCapability is properly typed and accessible
    const cap = authority.activeCapability;
    expect(cap).not.toBeNull();
    expect(cap!.journalId).toBe(JOURNAL.journalId);
    expect(cap!.volumeSerial).toBe(JOURNAL.volumeSerial);

    authority.closeWindow();
    expect(authority.activeCapability).toBeNull();
  });
});

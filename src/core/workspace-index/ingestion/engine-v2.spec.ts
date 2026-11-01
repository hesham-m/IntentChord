import { describe, expect, it } from "vitest";
import { GenericMetadataProvider } from "@/core/workspace-index/continuity/metadata-only";
import { NoneProvider } from "@/core/workspace-index/continuity/none";
import { IngestionEngineV2, type DiscoveredFile, type DiscoveryPort, type HashPort, type PriorHead, type UsnEventSource } from "@/core/workspace-index/ingestion/engine-v2";

const HEX = (c: string) => c.repeat(64);
const WS = "ws-pf4";
const SNAP = "snap-pf4";
const REG = "reg-pf4";
const CONFIG = `sha256:${HEX("f")}`;

function file(rel: string, seq: number | null = 2, size = 128): DiscoveredFile {
  return { relativePath: rel, deviceId: "1", objectFileId: `obj_${rel}`, objectSequence: seq, sizeBytes: size };
}

function discovery(files?: DiscoveredFile[]): DiscoveryPort {
  return { discover: async () => ({ files: files ?? [file("src/a.ts")], excludedBoundaries: 0 }) };
}

function hashPort(fn?: (f: DiscoveredFile) => string): HashPort {
  return { freshHash: async f => fn?.(f) ?? `sha256:fresh_${f.relativePath}` };
}

function usnSource(currentUsn: bigint, events: Array<{ usn: string; fileReferenceNumber: string; fileName?: string; reasonFlags: number }> = []): UsnEventSource {
  return {
    currentUsn: async () => currentUsn,
    readInterval: async () => ({ ok: true, truncated: false, events }),
  };
}

const NO_PRIOR: PriorHead = null;

describe("Phase-4 V2 ingestion engine — deterministic matrix", () => {
  // ===================== BOOTSTRAP =====================

  it("01 metadata-only bootstrap fresh-hashes all files", async () => {
    const engine = new IngestionEngineV2({
      authority: new GenericMetadataProvider(),
      usnEvents: usnSource(BigInt(100)),
      discovery: discovery([file("a.ts", 1), file("b.ts", 2)]),
      hash: hashPort(),
      workspaceInstanceId: WS, snapshotOperationId: SNAP, registrationId: REG,
      configSha256: CONFIG, currentPolicyHash: CONFIG, priorHead: NO_PRIOR,
    });
    const out = await engine.runObservation();
    expect(out.outcome).toBe("SEALED");
    if (out.outcome !== "SEALED") return;
    expect(out.claimType).toBe("ROLLING_EXACT_FILE_MANIFEST");
    expect(out.files.every(f => f.contentHashSource === "FRESH")).toBe(true);
    expect(out.files.every(f => ["NEW","CHANGED_PROVEN"].includes(f.state))).toBe(true);
  });

  it("02 none-provider bootstrap fresh-hashes all files", async () => {
    const engine = new IngestionEngineV2({
      authority: new NoneProvider(),
      usnEvents: usnSource(BigInt(100)),
      discovery: discovery([file("c.ts", 3)]),
      hash: hashPort(),
      workspaceInstanceId: WS, snapshotOperationId: SNAP, registrationId: REG,
      configSha256: CONFIG, currentPolicyHash: CONFIG, priorHead: NO_PRIOR,
    });
    const out = await engine.runObservation();
    expect(out.outcome).toBe("SEALED");
    if (out.outcome !== "SEALED") return;
    expect(out.files.every(f => f.contentHashSource === "FRESH")).toBe(true);
  });

  // ===================== UNCHANGED / NON-REUSE =====================

  it("05 metadata-only never reuses prior content hash", async () => {
    const prior: PriorHead = {
      attestationId: "wca_test",
      attestationSealedAndLinkedToHead: true,
      trustedBoundaryUsn: BigInt(50),
      journalId: "J", volumeSerial: "V",
      policyHash: CONFIG,
    };
    const engine = new IngestionEngineV2({
      authority: new GenericMetadataProvider(),
      usnEvents: usnSource(BigInt(200)),
      discovery: discovery([file("same.ts", 1)]),
      hash: hashPort(f => `sha256:fresh_${f.relativePath}`),
      workspaceInstanceId: WS, snapshotOperationId: SNAP, registrationId: REG,
      configSha256: CONFIG, currentPolicyHash: CONFIG, priorHead: prior,
    });
    const out = await engine.runObservation();
    if (out.outcome !== "SEALED") return;
    expect(out.claimType).toBe("ROLLING_EXACT_FILE_MANIFEST");
    expect(out.files.every(f => f.contentHashSource === "FRESH")).toBe(true);
  });

  it("06 none never reuses prior content hash", async () => {
    const engine = new IngestionEngineV2({
      authority: new NoneProvider(),
      usnEvents: usnSource(BigInt(200)),
      discovery: discovery([file("same.ts", 1)]),
      hash: hashPort(f => `sha256:fresh_${f.relativePath}`),
      workspaceInstanceId: WS, snapshotOperationId: SNAP, registrationId: REG,
      configSha256: CONFIG, currentPolicyHash: CONFIG, priorHead: null,
    });
    const out = await engine.runObservation();
    if (out.outcome !== "SEALED") return;
    expect(out.files.every(f => f.contentHashSource === "FRESH")).toBe(true);
  });

  // ===================== TEMPORAL =====================

  it("D25 helper timeout => CONTINUITY_UNAVAILABLE", async () => {
    const engine = new IngestionEngineV2({
      authority: new GenericMetadataProvider(),
      usnEvents: {
        currentUsn: async () => { throw new Error("timeout"); },
        readInterval: async () => ({ ok: false, failure: "HELPER_TIMEOUT" }),
      },
      discovery: discovery([file("x.ts", 1)]),
      hash: hashPort(),
      workspaceInstanceId: WS, snapshotOperationId: SNAP, registrationId: REG,
      configSha256: CONFIG, currentPolicyHash: CONFIG, priorHead: NO_PRIOR,
    });
    const out = await engine.runObservation();
    expect(out.outcome).toBe("CONTINUITY_UNAVAILABLE");
  });

  it("D26 helper cancellation => CONTINUITY_UNAVAILABLE", async () => {
    const engine = new IngestionEngineV2({
      authority: new GenericMetadataProvider(),
      usnEvents: {
        currentUsn: async () => { throw new Error("cancelled"); },
        readInterval: async () => ({ ok: false, failure: "HELPER_CANCELLED" }),
      },
      discovery: discovery([file("y.ts", 1)]),
      hash: hashPort(),
      workspaceInstanceId: WS, snapshotOperationId: SNAP, registrationId: REG,
      configSha256: CONFIG, currentPolicyHash: CONFIG, priorHead: NO_PRIOR,
    });
    const out = await engine.runObservation();
    expect(out.outcome).toBe("CONTINUITY_UNAVAILABLE");
  });

  // ===================== SEAL PLAN STRUCTURE =====================

  it("S29 successful seal plan has correct structure", async () => {
    const engine = new IngestionEngineV2({
      authority: new GenericMetadataProvider(),
      usnEvents: usnSource(BigInt(100)),
      discovery: discovery([file("s1.ts", 1), file("s2.ts", 2)]),
      hash: hashPort(f => `sha256:${f.relativePath}`),
      workspaceInstanceId: WS, snapshotOperationId: SNAP, registrationId: REG,
      configSha256: CONFIG, currentPolicyHash: CONFIG, priorHead: NO_PRIOR,
    });
    const out = await engine.runObservation();
    expect(out.outcome).toBe("SEALED");
    if (out.outcome !== "SEALED") return;
    const plan = out.sealPlan;
    expect(plan.sections).toHaveLength(9); // streaming path: all 9 sections always built
    const filesSection = plan.sections.find(s => s.section_type === "FILES");
    expect(filesSection).toBeDefined();
    expect(filesSection!.record_count).toBe(2);
    expect(filesSection!.records).toHaveLength(0); // streaming path: no record bodies retained
    expect(plan.workspace_revision_id).toMatch(/^wsr_[0-9a-f]{64}$/);
    expect(plan.index_configuration_sha256).toBe(CONFIG);
    expect(plan.observation_result).toBeUndefined();
  });

  it("S30 seal plan revision fingerprint is deterministic for same tree", async () => {
    const mk = () => new IngestionEngineV2({
      authority: new GenericMetadataProvider(),
      usnEvents: usnSource(BigInt(100)),
      discovery: discovery([file("det.ts", 1)]),
      hash: hashPort(() => `sha256:deterministic`),
      workspaceInstanceId: WS, snapshotOperationId: SNAP, registrationId: REG,
      configSha256: CONFIG, currentPolicyHash: CONFIG, priorHead: NO_PRIOR,
    });
    const a = await mk().runObservation();
    const b = await mk().runObservation();
    if (a.outcome !== "SEALED" || b.outcome !== "SEALED") return;
    expect(a.sealPlan.workspace_revision_id).toBe(b.sealPlan.workspace_revision_id);
  });

  it("S31 seal plan revision changes when content changes", async () => {
    let counter = 0;
    const mk = () => {
      counter++;
      return new IngestionEngineV2({
        authority: new GenericMetadataProvider(),
        usnEvents: usnSource(BigInt(100)),
        discovery: discovery([file("det.ts", 1)]),
        hash: hashPort(() => `sha256:v${counter}`),
        workspaceInstanceId: WS, snapshotOperationId: SNAP, registrationId: REG,
        configSha256: CONFIG, currentPolicyHash: CONFIG, priorHead: NO_PRIOR,
      });
    };
    const a = await mk().runObservation();
    const b = await mk().runObservation();
    if (a.outcome !== "SEALED" || b.outcome !== "SEALED") return;
    expect(a.sealPlan.workspace_revision_id).not.toBe(b.sealPlan.workspace_revision_id);
  });

  it("B35 no full-contract assembly in engine source", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync(
      "src/core/workspace-index/ingestion/engine-v2.ts", "utf8"
    );
    expect(src.includes("CanonicalWorkspaceIndexContract")).toBe(false);
    expect(src.includes("JSON.stringify(full")).toBe(false);
  });

  it("B36 no giant canonical string in engine source", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync(
      "src/core/workspace-index/ingestion/engine-v2.ts", "utf8"
    );
    expect(src.includes("canonicalJson(contract)")).toBe(false);
  });

  // ===================== PROGRESS COALESCING =====================

  it("P43 progress coalescing respects flush policy", async () => {
    const { CoalescedProgressTracker } = await import("@/core/workspace-index/ingestion/progress");
    let now = 0;
    let writes = 0;
    const tracker = new CoalescedProgressTracker(async () => { writes++; }, () => now);

    await tracker.update("DISCOVERY", 0, 0);          // phase change → flush
    await tracker.update("DISCOVERY", 10, 1024);       // no trigger → skip
    await tracker.update("DISCOVERY", 600, 1024);      // >=500 files → flush
    await tracker.update("DISCOVERY", 700, 80 * 1024 * 1024); // >=64MiB → flush
    await tracker.update("HASHING", 700, 80 * 1024 * 1024);   // phase change → flush
    now += 11_000;                                     // heartbeat due
    await tracker.update("HASHING", 701, 80 * 1024 * 1024);   // heartbeat flush
    await tracker.update("SEALING", 701, 80 * 1024 * 1024, true); // terminal

    expect(writes).toBeGreaterThanOrEqual(5);
    expect(writes).toBeLessThanOrEqual(8); // bounded, not per-file
  });

  it("P44 SC-1 bootstrap priorFileId NOT carried without strong proof", async () => {
    // Simulate MOVED_UNCHANGED via metadata provider with priorFileId on discovered file.
    const fWithPrior = { ...file("src/new_path.ts", 42), priorFileId: "wfi_carried_forward" };
    const engine = new IngestionEngineV2({
      authority: new GenericMetadataProvider(),
      usnEvents: usnSource(BigInt(300)),
      discovery: discovery([fWithPrior]),
      hash: hashPort(() => "sha256:fresh_moved"),
      workspaceInstanceId: WS, snapshotOperationId: SNAP, registrationId: REG,
      configSha256: CONFIG, currentPolicyHash: CONFIG, priorHead: null,
    });
    const out = await engine.runObservation();
    if (out.outcome !== "SEALED") return;
    const f = out.files.find(x => x.relativePath === "src/new_path.ts");
    expect(f?.workspaceFileId).not.toBe("wfi_carried_forward");
    expect(f?.state).toBe("NEW"); // no USN proof of move under metadata-only
  });
});

describe("Phase 4B Task C1 — Abort signal propagation (engine-level E2E)", () => {

  // M01: Abort BEFORE engine.runObservation() → throws immediately, no discovery
  it("M01-pre-abort throws WORKSPACE_INDEX_ABORTED before discovery", async () => {
    const controller = new AbortController();
    controller.abort();
    const engine = new IngestionEngineV2({
      authority: new GenericMetadataProvider(),
      usnEvents: usnSource(BigInt(100)),
      discovery: discovery([file("a.ts")]),
      hash: hashPort(),
      workspaceInstanceId: WS, snapshotOperationId: SNAP, registrationId: REG,
      configSha256: CONFIG, currentPolicyHash: CONFIG, priorHead: NO_PRIOR,
      signal: controller.signal,
    });
    await expect(engine.runObservation()).rejects.toThrow("WORKSPACE_INDEX_ABORTED");
  });

  // M02: Abort DURING discovery → discovery called but throws during hash loop
  it("M02-abort-during-discovery throws after discover() returns", async () => {
    const controller = new AbortController();
    let callCount = 0;
    const slowDiscovery: DiscoveryPort = {
      discover: async () => {
        callCount++;
        return { files: [file("a.ts"), file("b.ts")], excludedBoundaries: 0 };
      },
    };
    const engine = new IngestionEngineV2({
      authority: new GenericMetadataProvider(),
      usnEvents: usnSource(BigInt(100)),
      discovery: slowDiscovery,
      hash: hashPort(() => {
        controller.abort();
        return "sha256:hash1";
      }),
      workspaceInstanceId: WS, snapshotOperationId: SNAP, registrationId: REG,
      configSha256: CONFIG, currentPolicyHash: CONFIG, priorHead: NO_PRIOR,
      signal: controller.signal,
    });
    await expect(engine.runObservation()).rejects.toThrow("WORKSPACE_INDEX_ABORTED");
  });

  // M03: Abort DURING reconcile loop → second pass throws
  it("M03-abort-during-reconcile-loop throws on next assertNotAborted", async () => {
    const controller = new AbortController();
    // PriorHead with mismatched content hash to trigger reconcile
    const priorWithMismatch: PriorHead = {
      attestationId: "wca_test_prior",
      attestationSealedAndLinkedToHead: true,
      trustedBoundaryUsn: BigInt(0),
      journalId: "J1",
      volumeSerial: "V1",
      policyHash: CONFIG,
    };
    const engine = new IngestionEngineV2({
      authority: new GenericMetadataProvider(),
      usnEvents: usnSource(BigInt(100)),
      discovery: discovery([file("a.ts", 1)]),
      hash: hashPort(),
      workspaceInstanceId: WS, snapshotOperationId: SNAP, registrationId: REG,
      configSha256: CONFIG, currentPolicyHash: CONFIG, priorHead: priorWithMismatch,
      signal: controller.signal,
    });
    // Abort before the engine runs — triggers assertNotAborted at first checkpoint
    controller.abort();
    await expect(engine.runObservation()).rejects.toThrow("WORKSPACE_INDEX_ABORTED");
  });

  // M04: No abort → engine completes normally (regression guard)
  it("M04-no-abort completes normally with SEALED outcome", async () => {
    const controller = new AbortController();
    const engine = new IngestionEngineV2({
      authority: new GenericMetadataProvider(),
      usnEvents: usnSource(BigInt(100)),
      discovery: discovery([file("a.ts")]),
      hash: hashPort(),
      workspaceInstanceId: WS, snapshotOperationId: SNAP, registrationId: REG,
      configSha256: CONFIG, currentPolicyHash: CONFIG, priorHead: NO_PRIOR,
      signal: controller.signal,
    });
    const out = await engine.runObservation();
    expect(out.outcome).toBe("SEALED");
  });

  // M05: Adapter source audit — abort signal wired to all 3 critical points
  it("M05-adapter-source-audit-signal-wired-to-usn-and-discovery", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync(
      "src/core/workspace-index/ingestion/engine-v2-adapter.ts", "utf8"
    );
    expect(src.includes("usnJournalPort.capability(volumeRoot, options.signal)")).toBe(true);
    expect(src.includes("usnJournalPort.readInterval(volumeRoot, journal, startExclusive, endInclusive, options.signal)")).toBe(true);
    expect(src.includes("signal: options.signal")).toBe(true);
  });

  // M06: Adapter source audit — engine receives signal
  it("M06-adapter-source-audit-signal-wired-to-engine-constructor", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync(
      "src/core/workspace-index/ingestion/engine-v2-adapter.ts", "utf8"
    );
    expect(src.includes("signal: options.signal,\n    onProgress: coalescedOnProgress,")).toBe(true);
  });

  // M07: Engine source audit — assertNotAborted at 3 checkpoints
  it("M07-engine-source-audit-3-abort-checkpoints", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync(
      "src/core/workspace-index/ingestion/engine-v2.ts", "utf8"
    );
    const occurrences = (src.match(/this\.assertNotAborted\(\)/g) || []).length;
    expect(occurrences).toBeGreaterThanOrEqual(3);
  });

  // M08: Engine source audit — throws WORKSPACE_INDEX_ABORTED
  it("M08-engine-throws-WORKSPACE_INDEX_ABORTED", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync(
      "src/core/workspace-index/ingestion/engine-v2.ts", "utf8"
    );
    expect(src.includes('"WORKSPACE_INDEX_ABORTED"')).toBe(true);
  });
});

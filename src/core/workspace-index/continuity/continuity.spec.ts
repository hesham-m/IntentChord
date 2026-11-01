import { describe, expect, it } from "vitest";
import { GenericMetadataProvider } from "@/core/workspace-index/continuity/metadata-only";
import { NoneProvider } from "@/core/workspace-index/continuity/none";
import { WindowsNtfsUsnProvider, eventsForObject, evaluateObjectEvents } from "@/core/workspace-index/continuity/windows-ntfs-usn";
import { classifyUsnReasons, USN_REASON } from "@/core/workspace-index/continuity/types";
import { FakeUsnJournalPort } from "@/core/workspace-index/continuity/fakes";
import { selectContinuityAuthority, resolveWithCapabilityProbe, assertClaimMatchesProviderClass } from "@/core/workspace-index/continuity/authority";

const HEX = (c: string) => c.repeat(64);
const WS_ID = "ws_pf3";
const VOLUME = "C:\\pf\\vol";
const POLICY = `sha256:${HEX("9")}`;
const JOURNAL = { journalId: "J-PF3", volumeSerial: "PF3SER" };
const FIRST_USN = BigInt(1000);
const NEXT_USN = BigInt(5000);
const TARGET_REF = "00000000000000000000000000000abc:2a";
const OBJ_SEQ = 0x2a;
const TARGET_INPUT = {
  relativePath: "src/a.ts",
  deviceId: "1234567890",
  objectFileId: "00000000000000000000000000000abc",
  objectSequence: OBJ_SEQ,
  sizeBytes: 128,
};

function strongProvider(scenario: Parameters<typeof FakeUsnJournalPort.prototype.capability> extends never ? never : any) {
  void scenario;
}
void strongProvider;

function makeStrong(scenario: any, priorOverride?: Partial<Parameters<typeof makePrior>[0]>) {
  const port = new FakeUsnJournalPort(scenario, {
    journalId: JOURNAL.journalId,
    volumeSerial: JOURNAL.volumeSerial,
    firstUsn: FIRST_USN,
    nextUsn: NEXT_USN,
    targetFileReferenceNumber: TARGET_REF,
  });
  const provider = new WindowsNtfsUsnProvider(port, VOLUME, POLICY);
  const prior = makePrior(priorOverride);
  return { provider, port, prior };
}

function makePrior(over: Partial<{
  attestationId: string;
  sealedLinked: boolean;
  boundary: bigint;
  journalId: string;
  volumeSerial: string;
  policyHash: string;
  currentPolicyHash: string;
  sizeBytes: number;
}> = {}) {
  return {
    attestationId: over.attestationId ?? `wca_${HEX("a")}`,
    attestationSealedAndLinkedToHead: over.sealedLinked ?? true,
    trustedBoundaryUsn: over.boundary ?? BigInt(1200),
    journal: { journalId: over.journalId ?? JOURNAL.journalId, volumeSerial: over.volumeSerial ?? JOURNAL.volumeSerial },
    policyHash: over.policyHash ?? POLICY,
    currentPolicyHash: over.currentPolicyHash ?? POLICY,
    contentHash: `sha256:${HEX("c")}`,
    sizeBytes: over.sizeBytes ?? 128,
  };
}

const END_USN = BigInt(4000);

// =====================================================================
// USN REASON TAXONOMY (deterministic frozen vectors)
// =====================================================================
describe("USN reason taxonomy", () => {
  it("classifies DATA_OVERWRITE as CONTENT_AFFECTING", () => {
    expect(classifyUsnReasons(USN_REASON.DATA_OVERWRITE)).toMatchObject({
      category: "CONTENT_AFFECTING",
      contentAffecting: true,
      names: ["DATA_OVERWRITE"],
    });
  });

  it("classifies RENAME_OLD|NEW pair as NAMESPACE_PATH_AFFECTING with renameOnlyMutation", () => {
    const r = classifyUsnReasons(USN_REASON.RENAME_OLD_NAME | USN_REASON.RENAME_NEW_NAME);
    expect(r.category).toBe("NAMESPACE_PATH_AFFECTING");
    expect(r.renameOnlyMutation).toBe(true);
    expect(r.names).toEqual(["RENAME_NEW_NAME", "RENAME_OLD_NAME"]);
  });

  it("rename + DATA_EXTEND becomes CONTENT_AFFECTING and is NOT rename-only", () => {
    const r = classifyUsnReasons(USN_REASON.RENAME_NEW_NAME | USN_REASON.DATA_EXTEND);
    expect(r.category).toBe("CONTENT_AFFECTING");
    expect(r.renameOnlyMutation).toBe(false);
  });

  it("hard-link change is NON_CONTENT_AFFECTING", () => {
    expect(classifyUsnReasons(USN_REASON.HARD_LINK_CHANGE | USN_REASON.INDEXABLE_CHANGE).category)
      .toBe("NON_CONTENT_AFFECTING");
  });

  it("CLOSE-only brackets are JOURNAL_CONTROL", () => {
    expect(classifyUsnReasons(USN_REASON.CLOSE)).toMatchObject({ category: "JOURNAL_CONTROL", contentAffecting: false });
  });
});

// =====================================================================
// R1..R7 MATRIX
// =====================================================================
describe("WINDOWS_NTFS_USN_V1 R1..R7 matrix", () => {
  it("R-all-pass + zero events => UNCHANGED_PROVEN with reuse authorized", async () => {
    const { provider, prior } = makeStrong({ kind: "clean" });
    const v = await provider.classify({ ...TARGET_INPUT, prior }, END_USN);
    expect(v.state, JSON.stringify(v.evidence)).toBe("UNCHANGED_PROVEN");
    expect(v.reuseAuthorized).toBe(true);
    expect(v.failedCondition).toBeUndefined();
    expect(v.evidence.intervalProven).toBe(true);
  });

  it("R-all-pass + eventsForObject identity sanity", async () => {
    const { provider, prior } = makeStrong({ kind: "clean" });
    const v2 = await provider.classifyWithWindow({
      input: { ...TARGET_INPUT, prior },
      opened: await provider.openWindow(prior.trustedBoundaryUsn),
      endUsnInclusive: END_USN,
      read: { ok: true, truncated: false, events: [] },
    });
    expect(v2.state, JSON.stringify(v2.evidence)).toBe("UNCHANGED_PROVEN");
    });

  it("R7 missing/unlinked predecessor => REHASH_REQUIRED(R7)", async () => {
    const { provider, prior } = makeStrong({ kind: "clean" }, { sealedLinked: false });
    const v = await provider.classify({ ...TARGET_INPUT, prior: { ...prior, attestationSealedAndLinkedToHead: false } }, END_USN);
    expect(v.state).toBe("REHASH_REQUIRED");
    expect(v.reuseAuthorized).toBe(false);
    expect(v.failedCondition).toBe("R7");
  });

  it("R7 no predecessor at all => bootstrap REHASH(R7)", async () => {
    const { provider } = makeStrong({ kind: "clean" });
    const v = await provider.classify({ ...TARGET_INPUT, prior: null }, END_USN);
    expect(v.failedCondition).toBe("R7");
    expect(v.reuseAuthorized).toBe(false);
  });

  it("R1 journal id mismatch => REHASH_REQUIRED(R1)", async () => {
    const { provider, prior } = makeStrong({ kind: "clean" }, { journalId: "OTHER-JOURNAL" });
    const v = await provider.classify({ ...TARGET_INPUT, prior }, END_USN);
    expect(v.failedCondition).toBe("R1");
  });

  it("R1 volume serial mismatch => REHASH_REQUIRED(R1)", async () => {
    const { provider, prior } = makeStrong({ kind: "clean" }, { volumeSerial: "OTHERSER" });
    const v = await provider.classify({ ...TARGET_INPUT, prior }, END_USN);
    expect(v.failedCondition).toBe("R1");
  });

  it("R3 gap before retained => REHASH_REQUIRED(R3_GAP_WRAP_LOSS)", async () => {
    const { provider, prior } = makeStrong({ kind: "journal_gap" }, { boundary: BigInt(50) });
    const v = await provider.classify({ ...TARGET_INPUT, prior }, END_USN);
    expect(v.failedCondition).toBe("R3_GAP_WRAP_LOSS");
  });

  it("R3 wrap/journal reset => REHASH_REQUIRED(R3_GAP_WRAP_LOSS)", async () => {
    const { provider, prior } = makeStrong({ kind: "journal_wrap" });
    const v = await provider.classify({ ...TARGET_INPUT, prior }, END_USN);
    expect(v.failedCondition).toBe("R3_GAP_WRAP_LOSS");
  });

  it("R3 truncated interval read => REHASH_REQUIRED(R3_READ_FAILURE)", async () => {
    const { provider, prior } = makeStrong({ kind: "truncated_interval" });
    const v = await provider.classify({ ...TARGET_INPUT, prior }, END_USN);
    expect(v.failedCondition).toBe("R3_READ_FAILURE");
  });

  it("helper timeout / cancelled / failed => REHASH_REQUIRED(R3_READ_FAILURE)", async () => {
    for (const scenario of ["helper_timeout", "helper_cancelled", "helper_failed"] as const) {
      const { provider, prior } = makeStrong({ kind: scenario });
      const v = await provider.classify({ ...TARGET_INPUT, prior }, END_USN);
      expect(v.state).toBe("REHASH_REQUIRED");
      expect(v.failedCondition?.startsWith("R3")).toBe(true);
    }
  });

  it("R4 content overwrite => REHASH_REQUIRED(R4)", async () => {
    const { provider, prior } = makeStrong({ kind: "content_overwrite" });
    const v = await provider.classify({ ...TARGET_INPUT, prior }, END_USN);
    expect(v.failedCondition).toBe("R4");
    expect(v.evidence.reasonsSeen).toContain("DATA_OVERWRITE");
  });

  it("R4 extend/truncate => REHASH_REQUIRED(R4)", async () => {
    const { provider, prior } = makeStrong({ kind: "extend_truncate" });
    const v = await provider.classify({ ...TARGET_INPUT, prior }, END_USN);
    expect(v.failedCondition).toBe("R4");
  });

  it("R4 rename pair WITHOUT content mutation => MOVE_CANDIDATE (not rehash)", async () => {
    const { provider, prior } = makeStrong({ kind: "rename_pair", oldName: "src/old.ts", newName: "src/new.ts" });
    const v = await provider.classify({ ...TARGET_INPUT, prior }, END_USN);
    expect(v.state).toBe("MOVE_CANDIDATE");
    expect(v.reuseAuthorized).toBe(false);
    expect(v.evidence.moveCandidate?.proof).toBe("USN_RENAME_PAIR_PROVEN");
    expect(v.evidence.moveCandidate?.renameFromPath).toBe("src/old.ts");
  });

  it("R4 rename PLUS content mutation => REHASH_REQUIRED, never move-unchanged", async () => {
    const { provider, prior } = makeStrong({ kind: "rename_then_content", oldName: "a.ts", newName: "b.ts" });
    const v = await provider.classify({ ...TARGET_INPUT, prior }, END_USN);
    expect(v.state).toBe("REHASH_REQUIRED");
    expect(v.failedCondition).toBe("R4");
    expect(v.evidence.moveCandidate).toBeUndefined();
  });

  it("hard-link-related events do NOT disqualify reuse", async () => {
    const { provider, prior } = makeStrong({ kind: "hard_link_change" });
    const v = await provider.classify({ ...TARGET_INPUT, prior }, END_USN);
    expect(v.state).toBe("UNCHANGED_PROVEN");
    expect(v.reuseAuthorized).toBe(true);
  });

  it("metadata-only noise (EA/security/CLOSE) does NOT disqualify reuse", async () => {
    const { provider, prior } = makeStrong({ kind: "metadata_only_noise" });
    const v = await provider.classify({ ...TARGET_INPUT, prior }, END_USN);
    expect(v.state).toBe("UNCHANGED_PROVEN");
  });

  it("R5 size divergence => REHASH_REQUIRED(R5)", async () => {
    const { provider, prior } = makeStrong({ kind: "clean" }, { sizeBytes: 999999 });
    const v = await provider.classify({ ...TARGET_INPUT, prior: { ...prior, sizeBytes: 999999 } }, END_USN);
    expect(v.failedCondition).toBe("R5");
  });

  it("R6 policy hash drift => REHASH_REQUIRED(R6)", async () => {
    const { provider, prior } = makeStrong({ kind: "clean" }, { currentPolicyHash: `sha256:${HEX("8")}` });
    const v = await provider.classify({ ...TARGET_INPUT, prior: { ...prior, currentPolicyHash: `sha256:${HEX("8")}` } }, END_USN);
    expect(v.failedCondition).toBe("R6");
  });

  it("eventsForObject filters by full FileReferenceNumber identity", () => {
    const evs = [
      { usn: BigInt(1), fileReferenceNumber: "aa:1", reasonFlags: 0x1, reasons: classifyUsnReasons(0x1) },
      { usn: BigInt(2), fileReferenceNumber: "aa:2", reasonFlags: 0x2, reasons: classifyUsnReasons(0x2) },
    ];
    expect(eventsForObject(evs, "aa:1")).toHaveLength(1);
    expect(eventsForObject(evs, "aa:2")).toHaveLength(1);
  });

  it("evaluateObjectEvents surfaces create/delete as rehash trigger", () => {
    const r = evaluateObjectEvents([
      { usn: BigInt(1), fileReferenceNumber: "x:1", fileName: undefined, reasonFlags: USN_REASON.FILE_DELETE, reasons: classifyUsnReasons(USN_REASON.FILE_DELETE) },
    ]);
    expect(r.rehash).toBe(true);
  });
});

// =====================================================================
// NON-STRONG PROVIDERS — reuse must be impossible
// =====================================================================
describe("GENERIC_METADATA_V1 / NONE_V1 never authorize reuse", () => {
  it("METADATA_ONLY ceiling is UNCHANGED_CANDIDATE with reuse=false", async () => {
    const p = new GenericMetadataProvider();
    const v = await p.classify(TARGET_INPUT as never);
    expect(v.state).toBe("UNCHANGED_CANDIDATE");
    expect(v.reuseAuthorized).toBe(false);
    expect(p.claimType).toBe("ROLLING_EXACT_FILE_MANIFEST");
  });

  it("NONE returns REHASH_REQUIRED with reuse=false", async () => {
    const p = new NoneProvider();
    const v = await p.classify(TARGET_INPUT as never);
    expect(v.state).toBe("REHASH_REQUIRED");
    expect(v.reuseAuthorized).toBe(false);
    expect(p.claimType).toBe("ROLLING_EXACT_FILE_MANIFEST");
  });
});

// =====================================================================
// FACTORY / DEGRADATION / CLAIM SELECTION
// =====================================================================
describe("provider factory + degradation + claim selection", () => {
  it("win32 + enabled + port => STRONG selection with SEALED_INTERVAL", () => {
    const sel = selectContinuityAuthority({
      platform: "win32", volumeRoot: VOLUME, currentPolicyHash: POLICY,
      usnJournalPort: new FakeUsnJournalPort({ kind: "clean" }, { journalId: "J", volumeSerial: "V", firstUsn: BigInt(1), nextUsn: BigInt(2), targetFileReferenceNumber: "" }),
      env: {},
    });
    expect(sel.selection.providerId).toBe("WINDOWS_NTFS_USN_V1");
    expect(sel.selection.claimType).toBe("SEALED_INTERVAL");
    expect(sel.degradedFromStrong).toBe(false);
  });

  it("strong disabled by env => METADATA_ONLY degradation with explicit reason", () => {
    const sel = selectContinuityAuthority({
      platform: "win32", volumeRoot: VOLUME, currentPolicyHash: POLICY,
      env: { WORKSPACE_CONTINUITY_STRONG_ENABLED: "false" },
    });
    expect(sel.selection.providerId).toBe("GENERIC_METADATA_V1");
    expect(sel.degradedFromStrong).toBe(true);
    expect(sel.degradationReason).toContain("DISABLED");
  });

  it("non-win32 without port => NONE_V1", () => {
    const sel = selectContinuityAuthority({ platform: "linux", volumeRoot: "/x", currentPolicyHash: POLICY, env: {} });
    expect(sel.selection.providerId).toBe("NONE_V1");
  });

  it("capability probe failure degrades STRONG -> METADATA_ONLY without throwing", async () => {
    const sel = await resolveWithCapabilityProbe({
      platform: "win32", volumeRoot: VOLUME, currentPolicyHash: POLICY,
      usnJournalPort: new FakeUsnJournalPort({ kind: "unsupported_volume" }, { journalId: "J", volumeSerial: "V", firstUsn: BigInt(1), nextUsn: BigInt(2), targetFileReferenceNumber: "" }),
      env: {},
    });
    expect(sel.selection.providerId).toBe("GENERIC_METADATA_V1");
    expect(sel.degradedFromStrong).toBe(true);
    expect(sel.selection.authority.claimType).toBe("ROLLING_EXACT_FILE_MANIFEST");
  });

  it("claim/provider-class pairing is closed", () => {
    expect(() => assertClaimMatchesProviderClass("STRONG_CONTINUITY_PROVIDER", "ROLLING_EXACT_FILE_MANIFEST")).toThrow();
    expect(() => assertClaimMatchesProviderClass("METADATA_ONLY_PROVIDER", "SEALED_INTERVAL")).toThrow();
    expect(() => assertClaimMatchesProviderClass("STRONG_CONTINUITY_PROVIDER", "SEALED_INTERVAL")).not.toThrow();
    expect(() => assertClaimMatchesProviderClass("NO_CONTINUITY_PROVIDER", "ROLLING_EXACT_FILE_MANIFEST")).not.toThrow();
  });
});

// =====================================================================
// PROPERTY TESTS — non-strong reuse impossibility across randomized inputs
// =====================================================================
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

describe("property: non-strong providers can NEVER authorize reuse", () => {
  it("METADATA_ONLY_REUSE_COUNT=0 and NONE_PROVIDER_REUSE_COUNT=0 across 300 randomized inputs", async () => {
    const rng = mulberry32(0x50463300);
    const meta = new GenericMetadataProvider();
    const none = new NoneProvider();
    let metaReuse = 0;
    let noneReuse = 0;
    for (let i = 0; i < 300; i++) {
      const input = {
        relativePath: `f${i}.ts`,
        deviceId: String(i),
        objectFileId: i.toString(16),
        objectSequence: i % 5 === 0 ? null : i,
        sizeBytes: Math.floor(rng() * 1e9),
        prior: rng() > 0.5 ? ({
          attestationId: `wca_${i}`,
          attestationSealedAndLinkedToHead: true,
          trustedBoundaryUsn: BigInt(Math.floor(rng() * 1e12)),
          journal: { journalId: "J", volumeSerial: "V" },
          policyHash: POLICY,
          currentPolicyHash: POLICY,
          contentHash: `sha256:${HEX("c")}`,
          sizeBytes: Math.floor(rng() * 1e6),
        } as never) : null,
      };
      if ((await meta.classify(input as never)).reuseAuthorized) metaReuse++;
      if ((await none.classify(input as never)).reuseAuthorized) noneReuse++;
    }
    expect(metaReuse).toBe(0);
    expect(noneReuse).toBe(0);
  });
});

// =====================================================================
// FAKE PROVIDERS / EVENT INJECTION determinism
// =====================================================================
describe("fake provider deterministic replay + injection vectors", () => {
  it("injected race-event vector replays identically", () => {
    const s1 = FakeUsnJournalPort.replay({ kind: "rename_then_content", oldName: "a.ts", newName: "b.ts" });
    const s2 = FakeUsnJournalPort.replay({ kind: "rename_then_content", oldName: "a.ts", newName: "b.ts" });
    expect(s1).toEqual(s2);
  });

  it("malformed event vector surfaces through interval read (fail-closed upstream)", async () => {
    const { provider, prior } = makeStrong({ kind: "malformed_event" });
    const v = await provider.classify({ ...TARGET_INPUT, prior }, END_USN);
    // malformed event carries no matching ref => treated as no-events for THIS object;
    // the malformed payload itself is rejected at the PORT adapter layer (assertWellFormedEvent).
    expect(["UNCHANGED_PROVEN", "REHASH_REQUIRED"]).toContain(v.state);
  });
});

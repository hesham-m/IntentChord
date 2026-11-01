import type { IntervalReadResult, JournalIdentity, UsnCapability, UsnEvent, UsnJournalPort } from "@/core/workspace-index/continuity/types";
import { classifyUsnReasons } from "@/core/workspace-index/continuity/types";

/**
 * Deterministic fake providers + USN event-injection test infrastructure (SPEC V3 Phase 3).
 * These are TEST-ONLY surfaces consumed exclusively by the continuity suites.
 */

export type InjectedUsnScenario =
  | { kind: "clean" }
  | { kind: "content_overwrite" }
  | { kind: "extend_truncate" }
  | { kind: "rename_pair"; oldName: string; newName: string }
  | { kind: "rename_then_content" ; oldName: string; newName: string }
  | { kind: "hard_link_change" }
  | { kind: "metadata_only_noise" }
  | { kind: "journal_gap" }
  | { kind: "journal_wrap" }
  | { kind: "journal_reset" }
  | { kind: "malformed_event" }
  | { kind: "helper_timeout" }
  | { kind: "helper_cancelled" }
  | { kind: "helper_failed" }
  | { kind: "unsupported_volume" }
  | { kind: "truncated_interval" };

export class FakeUsnJournalPort implements UsnJournalPort {
  public capabilityCalls = 0;
  public readCalls = 0;

  constructor(
    private readonly scenario: InjectedUsnScenario,
    private readonly fixture: {
      journalId: string;
      volumeSerial: string;
      firstUsn: bigint;
      nextUsn: bigint;
      targetFileReferenceNumber: string;
    },
  ) {}

  private event(usn: bigint, reasonFlags: number, name?: string): UsnEvent {
    return {
      usn,
      fileReferenceNumber: this.fixture.targetFileReferenceNumber,
      fileName: name,
      reasonFlags,
      reasons: classifyUsnReasons(reasonFlags),
    };
  }

  async capability(): Promise<UsnCapability> {
    this.capabilityCalls += 1;
    switch (this.scenario.kind) {
      case "unsupported_volume":
        return { supported: false, degradationReason: "VOLUME_NOT_NTFS_OR_USN_UNSUPPORTED" };
      case "journal_reset":
        return { supported: true, journalId: this.fixture.journalId + "-RESET", volumeSerial: this.fixture.volumeSerial, firstUsn: this.fixture.firstUsn, nextUsn: this.fixture.nextUsn };
      default:
        return { supported: true, journalId: this.fixture.journalId, volumeSerial: this.fixture.volumeSerial, firstUsn: this.fixture.firstUsn, nextUsn: this.fixture.nextUsn };
    }
  }

  async readInterval(
    _volumeRoot: string,
    _journal: JournalIdentity,
    startUsnExclusive: bigint,
    endUsnInclusive: bigint,
  ): Promise<IntervalReadResult> {
    this.readCalls += 1;
    switch (this.scenario.kind) {
      case "journal_gap":
        return { ok: false, failure: "GAP_BEFORE_RETAINED" };
      case "journal_wrap":
        return { ok: false, failure: "JOURNAL_RESET" };
      case "journal_reset":
        return { ok: false, failure: "JOURNAL_RESET" };
      case "truncated_interval":
        return { ok: true, events: [], truncated: true };
      case "malformed_event":
        return { ok: true, events: [{ usn: startUsnExclusive + BigInt(1), fileReferenceNumber: "", reasonFlags: 0 } as unknown as UsnEvent], truncated: false };
      case "helper_timeout":
        return { ok: false, failure: "HELPER_TIMEOUT" };
      case "helper_cancelled":
        return { ok: false, failure: "HELPER_CANCELLED" };
      case "helper_failed":
        return { ok: false, failure: "HELPER_FAILED" };
      case "content_overwrite":
        return { ok: true, truncated: false, events: [this.event(startUsnExclusive + BigInt(1), 0x1)] };
      case "extend_truncate":
        return { ok: true, truncated: false, events: [this.event(startUsnExclusive + BigInt(1), 0x2), this.event(startUsnExclusive + BigInt(2), 0x4)] };
      case "rename_pair":
        return { ok: true, truncated: false, events: [
          this.event(startUsnExclusive + BigInt(1), 0x1000, this.scenario.oldName),
          this.event(startUsnExclusive + BigInt(2), 0x2000, this.scenario.newName),
        ] };
      case "rename_then_content":
        return { ok: true, truncated: false, events: [
          this.event(startUsnExclusive + BigInt(1), 0x1000, this.scenario.oldName),
          this.event(startUsnExclusive + BigInt(2), 0x2000, this.scenario.newName),
          this.event(startUsnExclusive + BigInt(3), 0x1),
        ] };
      case "hard_link_change":
        return { ok: true, truncated: false, events: [this.event(startUsnExclusive + BigInt(1), 0x10000)] };
      case "metadata_only_noise":
        return { ok: true, truncated: false, events: [this.event(startUsnExclusive + BigInt(1), 0x400), this.event(startUsnExclusive + BigInt(2), 0x80000000)] };
      default:
        return { ok: true, truncated: false, events: [] };
    }
  }

  /** Deterministic replay of the injected vector (used by fake-provider property tests). */
  static replay(scenario: InjectedUsnScenario): InjectedUsnScenario {
    return structuredClone(scenario);
  }
}

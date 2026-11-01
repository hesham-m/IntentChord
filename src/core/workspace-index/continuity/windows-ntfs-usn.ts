import {
  classifyUsnReasons,
  type FileContinuityInput,
  type FileContinuityVerdict,
  type IntervalReadResult,
  type OpenedWindow,
  type UsnCapability,
  type UsnEvent,
  type UsnJournalPort,
} from "@/core/workspace-index/continuity/types";
import { hasExactSequence } from "@/core/workspace-index/continuity/usn-record-v2";

export const WINDOWS_NTFS_USN_PROVIDER_ID = "WINDOWS_NTFS_USN_V1" as const;

type RehashEvidence = NonNullable<FileContinuityVerdict["evidence"]>;

export class UsnProviderUnavailableError extends Error {
  readonly code = "WORKSPACE_CONTINUITY_UNAVAILABLE";
  constructor(public readonly degradationReason: string) {
    super(degradationReason);
    this.name = "UsnProviderUnavailableError";
  }
}

export function eventsForObject(events: ReadonlyArray<UsnEvent>, fileReferenceNumber: string): UsnEvent[] {
  return events.filter(e => e.fileReferenceNumber === fileReferenceNumber);
}

export function evaluateObjectEvents(objectEvents: ReadonlyArray<UsnEvent>): {
  rehash: boolean;
  moveCandidate?: { renameFromPath?: string };
  reasonsSeen: string[];
} {
  const reasonsSeen: string[] = [];
  let sawRenameOld = false;
  let sawRenameNew = false;
  let sawPureContent = false;
  let sawCreateOrDelete = false;
  let lastOldName: string | undefined;
  for (const ev of objectEvents) {
    reasonsSeen.push(...ev.reasons.names);
    if (ev.reasons.names.includes("RENAME_OLD_NAME")) { sawRenameOld = true; lastOldName = ev.fileName; }
    if (ev.reasons.names.includes("RENAME_NEW_NAME")) sawRenameNew = true;
    if (ev.reasons.category === "CONTENT_AFFECTING") sawPureContent = true;
    if (ev.reasons.names.includes("FILE_CREATE") || ev.reasons.names.includes("FILE_DELETE")) sawCreateOrDelete = true;
  }
  const unique = [...new Set(reasonsSeen)].sort();
  if (sawPureContent) return { rehash: true, reasonsSeen: unique };
  if (sawCreateOrDelete && !sawRenameOld && !sawRenameNew) return { rehash: true, reasonsSeen: unique };
  if (sawRenameOld && sawRenameNew && !sawPureContent) {
    return { rehash: false, moveCandidate: { renameFromPath: lastOldName }, reasonsSeen: unique };
  }
  return { rehash: false, reasonsSeen: unique };
}

export interface ActiveWindowContext {
  opened: OpenedWindow;
  capability: UsnCapability;
  read: IntervalReadResult;
  eventIndex: Map<string, UsnEvent[]>;
}

export class WindowsNtfsUsnProvider {
  readonly providerId = WINDOWS_NTFS_USN_PROVIDER_ID;
  readonly providerClass = "STRONG_CONTINUITY_PROVIDER" as const;
  readonly claimType = "SEALED_INTERVAL" as const;

  private activeWindow: ActiveWindowContext | null = null;

  constructor(
    private readonly port: UsnJournalPort,
    private readonly volumeRoot: string,
    private readonly currentPolicyHash: string,
  ) {}

  async capability(): Promise<UsnCapability> {
    return this.port.capability(this.volumeRoot);
  }

  /**
   * Release any attempt-scoped window context.
   * Ensures no USN window context survives between distinct indexing attempts.
   */
  closeWindow(): void {
    this.activeWindow = null;
  }

  getActiveWindow(): ActiveWindowContext | null {
    return this.activeWindow;
  }

  get activeCapability(): { journalId: string; volumeSerial: string } | null {
    if (!this.activeWindow || !this.activeWindow.capability.supported) return null;
    return {
      journalId: this.activeWindow.capability.journalId,
      volumeSerial: this.activeWindow.capability.volumeSerial,
    };
  }

  async openWindow(previousTrustedBoundaryUsn: bigint | null): Promise<OpenedWindow> {
    const cap = await this.capability();
    if (!cap.supported) throw new UsnProviderUnavailableError(cap.degradationReason);

    let read: IntervalReadResult = { ok: true, events: [], truncated: false };
    const eventIndex = new Map<string, UsnEvent[]>();

    if (previousTrustedBoundaryUsn === null) {
      const opened: OpenedWindow = {
        journalId: cap.journalId,
        openedBoundaryUsn: cap.nextUsn,
        previousTrustedBoundaryUsn: null,
        bootstrap: true,
        volumeSerial: cap.volumeSerial,
        firstUsn: cap.firstUsn,
        status: "OPENED_STRONG_CONTINUITY",
      };
      this.activeWindow = {
        opened,
        capability: cap,
        read,
        eventIndex,
      };
      return opened;
    }

    // Non-bootstrap: evaluate historical continuity across [previousTrustedBoundaryUsn, cap.nextUsn]
    if (cap.firstUsn !== undefined && previousTrustedBoundaryUsn < cap.firstUsn) {
      // Historical gap: previous boundary was deleted / rotated out by NTFS
      read = { ok: false, failure: "GAP_BEFORE_RETAINED" };
      const opened: OpenedWindow = {
        journalId: cap.journalId,
        openedBoundaryUsn: cap.nextUsn,
        previousTrustedBoundaryUsn,
        bootstrap: false,
        volumeSerial: cap.volumeSerial,
        firstUsn: cap.firstUsn,
        status: "HISTORICAL_REHASH_REQUIRED",
        degradationReason: "GAP_BEFORE_RETAINED",
      };
      this.activeWindow = {
        opened,
        capability: cap,
        read,
        eventIndex,
      };
      return opened;
    }

    try {
      read = await this.port.readInterval(
        this.volumeRoot,
        { journalId: cap.journalId, volumeSerial: cap.volumeSerial },
        previousTrustedBoundaryUsn,
        cap.nextUsn,
      );
    } catch (e) {
      const msg = String((e as Error)?.message ?? "");
      read = msg.includes("cancel") || msg.includes("abort")
        ? { ok: false, failure: "HELPER_CANCELLED" }
        : msg.includes("timeout")
          ? { ok: false, failure: "HELPER_TIMEOUT" }
          : { ok: false, failure: "HELPER_FAILED" };
    }

    // Fail-closed transport/service unavailability (never convert transport failures to rehash)
    if (!read.ok) {
      if (read.failure === "PROVIDER_UNAVAILABLE") {
        throw new UsnProviderUnavailableError(read.failure);
      }
    }

    if (!read.ok) {
      const opened: OpenedWindow = {
        journalId: cap.journalId,
        openedBoundaryUsn: cap.nextUsn,
        previousTrustedBoundaryUsn,
        bootstrap: false,
        volumeSerial: cap.volumeSerial,
        firstUsn: cap.firstUsn,
        status: "HISTORICAL_REHASH_REQUIRED",
        degradationReason: read.failure,
      };
      this.activeWindow = {
        opened,
        capability: cap,
        read,
        eventIndex,
      };
      return opened;
    }

    if (read.truncated) {
      const opened: OpenedWindow = {
        journalId: cap.journalId,
        openedBoundaryUsn: cap.nextUsn,
        previousTrustedBoundaryUsn,
        bootstrap: false,
        volumeSerial: cap.volumeSerial,
        firstUsn: cap.firstUsn,
        status: "HISTORICAL_REHASH_REQUIRED",
        degradationReason: "TRUNCATED_INTERVAL",
      };
      this.activeWindow = {
        opened,
        capability: cap,
        read,
        eventIndex,
      };
      return opened;
    }

    for (const ev of read.events) {
      let list = eventIndex.get(ev.fileReferenceNumber);
      if (!list) {
        list = [];
        eventIndex.set(ev.fileReferenceNumber, list);
      }
      list.push(ev);
    }

    const opened: OpenedWindow = {
      journalId: cap.journalId,
      openedBoundaryUsn: cap.nextUsn,
      previousTrustedBoundaryUsn,
      bootstrap: false,
      volumeSerial: cap.volumeSerial,
      firstUsn: cap.firstUsn,
      status: "OPENED_STRONG_CONTINUITY",
    };

    this.activeWindow = {
      opened,
      capability: cap,
      read,
      eventIndex,
    };

    return opened;
  }

  async classifyWithWindow(input: {
    input: FileContinuityInput;
    opened: OpenedWindow;
    endUsnInclusive: bigint;
    read: IntervalReadResult;
    capability?: UsnCapability;
    eventIndex?: Map<string, UsnEvent[]>;
  }): Promise<FileContinuityVerdict> {
    const base = (p: {
      failedCondition?: FileContinuityVerdict["failedCondition"];
      evidence?: Partial<Omit<RehashEvidence, "providerId" | "providerClass">>;
    }): FileContinuityVerdict => ({
      state: "REHASH_REQUIRED",
      reuseAuthorized: false,
      ...(p.failedCondition ? { failedCondition: p.failedCondition } : {}),
      evidence: {
        providerId: this.providerId,
        providerClass: this.providerClass,
        ...(p.evidence ?? {}),
      },
    });

    const prior = input.input.prior;
    if (!prior || !prior.attestationSealedAndLinkedToHead) {
      return base({ failedCondition: "R7" });
    }

    const capProbe = input.capability ?? (
      input.opened.volumeSerial && input.opened.firstUsn !== undefined
        ? {
            supported: true as const,
            volumeSerial: input.opened.volumeSerial,
            journalId: input.opened.journalId,
            firstUsn: input.opened.firstUsn,
            nextUsn: input.opened.openedBoundaryUsn,
          }
        : await this.capability()
    );
    if (!capProbe.supported) return base({ failedCondition: "R1" });

    const volumeOk =
      capProbe.volumeSerial === prior.journal.volumeSerial &&
      capProbe.journalId === prior.journal.journalId &&
      input.opened.journalId === prior.journal.journalId;
    if (!volumeOk) return base({ failedCondition: "R1", evidence: { volumeOk: false } });

    if (input.opened.status === "HISTORICAL_REHASH_REQUIRED") {
      const cond =
        input.opened.degradationReason === "GAP_BEFORE_RETAINED" || input.opened.degradationReason === "JOURNAL_RESET"
          ? "R3_GAP_WRAP_LOSS"
          : "R3_READ_FAILURE";
      return base({ failedCondition: cond, evidence: { volumeOk: true } });
    }

    if (prior.trustedBoundaryUsn < capProbe.firstUsn) {
      return base({ failedCondition: "R3_GAP_WRAP_LOSS", evidence: { volumeOk: true } });
    }
    const read = input.read;
    if (!read.ok) {
      const cond =
        read.failure === "GAP_BEFORE_RETAINED" || read.failure === "JOURNAL_RESET"
          ? "R3_GAP_WRAP_LOSS"
          : "R3_READ_FAILURE";
      return base({ failedCondition: cond, evidence: { volumeOk: true } });
    }
    if (read.truncated) {
      return base({ failedCondition: "R3_READ_FAILURE", evidence: { volumeOk: true, intervalProven: false } });
    }

    // R2 - EXACT object identity INCLUDING MFT sequence semantics.
    const fi = input.input;
    const curRefExact = `${fi.objectFileId}:${fi.objectSequence === null ? "" : fi.objectSequence.toString(16)}`;
    if (
      fi.objectSequence === null ||
      fi.objectSequence <= 0 ||
      !hasExactSequence(curRefExact)
    ) {
      return base({ failedCondition: "R2", evidence: { volumeOk: true, fileIdEqual: false } });
    }
    const allEvents = read.events;

    // Delete/recreate detection: FILE_CREATE on the PRIOR slot within the proven interval.
    const priorSeq = prior.priorObjectSequence ?? null;
    if (priorSeq !== null && priorSeq > 0) {
      const priorRefExact = `${fi.objectFileId}:${priorSeq.toString(16)}`;
      const priorSlotEvents = input.eventIndex
        ? (input.eventIndex.get(priorRefExact) ?? [])
        : allEvents.filter(e => e.fileReferenceNumber === priorRefExact);
      if (priorSlotEvents.some(e => e.reasons.names.includes("FILE_CREATE"))) {
        return {
          state: "DELETE_RECREATE",
          reuseAuthorized: false,
          evidence: {
            providerId: this.providerId,
            providerClass: this.providerClass,
            volumeOk: true,
            intervalProven: true,
            sizeCorroborated: true,
            policyHashEqual: true,
            deleteRecreate: { priorSequence: priorSeq, newSequence: fi.objectSequence },
          },
        };
      }
    }

    const objectEvents = input.eventIndex
      ? (input.eventIndex.get(curRefExact) ?? [])
      : eventsForObject(allEvents, curRefExact);

    const sizeCorroborated = fi.sizeBytes === prior.sizeBytes;
    const policyHashEqual = prior.policyHash === prior.currentPolicyHash;
    const evalResult = evaluateObjectEvents(objectEvents);
    const intervalProven = true;

    if (!sizeCorroborated) {
      return base({
        failedCondition: "R5",
        evidence: { volumeOk: true, intervalProven, sizeCorroborated: false, reasonsSeen: evalResult.reasonsSeen },
      });
    }
    if (!policyHashEqual) {
      return base({
        failedCondition: "R6",
        evidence: { volumeOk: true, intervalProven, sizeCorroborated: true, policyHashEqual: false },
      });
    }
    if (evalResult.rehash) {
      return base({
        failedCondition: "R4",
        evidence: { volumeOk: true, intervalProven, sizeCorroborated: true, policyHashEqual: true, reasonsSeen: evalResult.reasonsSeen },
      });
    }
    if (evalResult.moveCandidate) {
      return {
        state: "MOVE_CANDIDATE",
        reuseAuthorized: false,
        evidence: {
          providerId: this.providerId,
          providerClass: this.providerClass,
          volumeOk: true,
          intervalProven: true,
          sizeCorroborated: true,
          policyHashEqual: true,
          reasonsSeen: evalResult.reasonsSeen,
          moveCandidate: { renameFromPath: evalResult.moveCandidate.renameFromPath, proof: "USN_RENAME_PAIR_PROVEN" },
        },
      };
    }

    return {
      state: "UNCHANGED_PROVEN",
      reuseAuthorized: true,
      evidence: {
        providerId: this.providerId,
        providerClass: this.providerClass,
        volumeOk: true,
        fileIdEqual: true,
        sequenceEqual: fi.objectSequence !== null && fi.objectSequence > 0,
        intervalProven: true,
        sizeCorroborated: true,
        policyHashEqual: true,
        reasonsSeen: evalResult.reasonsSeen,
      },
    };
  }

  async classify(input: FileContinuityInput, endUsnInclusive?: bigint): Promise<FileContinuityVerdict> {
    const prior = input.prior;
    if (!prior) {
      return {
        state: "REHASH_REQUIRED",
        reuseAuthorized: false,
        failedCondition: "R7",
        evidence: { providerId: this.providerId, providerClass: this.providerClass },
      };
    }

    // Reuse active attempt-scoped window if already opened for this prior boundary:
    if (this.activeWindow && this.activeWindow.opened.previousTrustedBoundaryUsn === prior.trustedBoundaryUsn) {
      return this.classifyWithWindow({
        input,
        opened: this.activeWindow.opened,
        endUsnInclusive: endUsnInclusive ?? this.activeWindow.opened.openedBoundaryUsn,
        read: this.activeWindow.read,
        capability: this.activeWindow.capability,
        eventIndex: this.activeWindow.eventIndex,
      });
    }

    // Standalone fallback (e.g. isolated unit tests calling provider.classify without openWindow):
    const opened = await this.openWindow(prior.trustedBoundaryUsn);
    return this.classifyWithWindow({
      input,
      opened,
      endUsnInclusive: endUsnInclusive ?? opened.openedBoundaryUsn,
      read: this.activeWindow!.read,
      capability: this.activeWindow!.capability,
      eventIndex: this.activeWindow!.eventIndex,
    });
  }
}

/** Malformed-event guard used by the production port adapter (fails closed). */
export function assertWellFormedEvent(raw: {
  usn: string | number | bigint;
  fileReferenceNumber: unknown;
  reasonFlags: unknown;
}): UsnEvent {
  const usn = typeof raw.usn === "bigint" ? raw.usn : BigInt(raw.usn as string | number);
  if (typeof raw.fileReferenceNumber !== "string" || raw.fileReferenceNumber.length === 0) {
    throw new TypeError("MALFORMED_USN_EVENT_FILE_REFERENCE");
  }
  if (!hasExactSequence(raw.fileReferenceNumber)) {
    throw new TypeError("USN_EVENT_SEQUENCE_NOT_EXACT");
  }
  if (typeof raw.reasonFlags !== "number" || !Number.isInteger(raw.reasonFlags) || raw.reasonFlags < 0) {
    throw new TypeError("MALFORMED_USN_EVENT_REASON_FLAGS");
  }
  return {
    usn,
    fileReferenceNumber: raw.fileReferenceNumber,
    fileName: typeof (raw as { fileName?: unknown }).fileName === "string" ? String((raw as { fileName?: unknown }).fileName) : undefined,
    reasonFlags: raw.reasonFlags,
    reasons: classifyUsnReasons(raw.reasonFlags),
  };
}

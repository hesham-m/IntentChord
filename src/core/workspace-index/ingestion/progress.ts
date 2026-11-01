/**
 * Coalesced progress persistence (SPEC V3 Section 15).
 * Flush policy: phase change OR >=10s heartbeat OR >=500 files OR >=64MiB delta OR terminal.
 */

export type ProgressFlushReason =
  | "PHASE_CHANGE"
  | "HEARTBEAT"
  | "FILE_DELTA"
  | "BYTE_DELTA"
  | "TERMINAL";

export type ProgressSnapshot = {
  phase: string;
  filesSeen: number;
  bytesSeen: number;
};

export type ProgressSink = (snapshot: ProgressSnapshot, reason: ProgressFlushReason) => Promise<void> | void;

export class CoalescedProgressTracker {
  private lastFlushAt: number;
  private lastFiles = 0;
  private lastBytes = 0;
  private lastPhase = "";
  public flushCount = 0;

  constructor(
    private readonly sink: ProgressSink,
    private readonly nowMs: () => number = () => Date.now(),
    private readonly heartbeatIntervalMs = 10_000,
  ) {
    this.lastFlushAt = this.nowMs();
  }

  async update(phase: string, filesSeen: number, bytesSeen: number, terminal = false): Promise<void> {
    const now = this.nowMs();
    const phaseChanged = phase !== this.lastPhase;
    const heartbeatDue = now - this.lastFlushAt >= this.heartbeatIntervalMs;
    const fileDelta = filesSeen - this.lastFiles >= 500;
    const byteDelta = bytesSeen - this.lastBytes >= 64 * 1024 * 1024;

    if (!phaseChanged && !heartbeatDue && !fileDelta && !byteDelta && !terminal) return;

    await this.sink({ phase, filesSeen, bytesSeen }, terminal ? "TERMINAL" : phaseChanged ? "PHASE_CHANGE" : heartbeatDue ? "HEARTBEAT" : fileDelta ? "FILE_DELTA" : "BYTE_DELTA");
    this.flushCount += 1;
    this.lastPhase = phase;
    this.lastFiles = filesSeen;
    this.lastBytes = bytesSeen;
    this.lastFlushAt = now;
  }
}

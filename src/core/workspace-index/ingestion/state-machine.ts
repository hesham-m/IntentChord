/**
 * Phase-4 file state machine (SPEC V3 Section 8).
 * UNCHANGED_PROVISIONAL is internal-only; never persisted as terminal.
 */

export const MAX_RECONCILE_PASSES = 2;
export const PER_FILE_RECAPTURE_LIMIT = 1;

export type FileState =
  | "NEW"
  | "UNCHANGED_CANDIDATE"
  | "UNCHANGED_PROVISIONAL"
  | "UNCHANGED_PROVEN"
  | "REHASH_REQUIRED"
  | "CHANGED_PROVEN"
  | "DELETED"
  | "MOVED_UNCHANGED";

/** States that may appear in a sealed revision's evidence. */
export function isTerminalEvidenceState(s: FileState): boolean {
  return (
    s === "NEW" ||
    s === "CHANGED_PROVEN" ||
    s === "UNCHANGED_PROVEN" ||
    s === "MOVED_UNCHANGED" ||
    s === "DELETED"
  );
}

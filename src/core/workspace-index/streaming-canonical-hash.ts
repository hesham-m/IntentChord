import { createHash } from "node:crypto";
import { canonicalJson } from "@/core/truth/project-truth-hash";
import { CANONICAL_SNAPSHOT_FAMILY_ORDER, type CanonicalSnapshotFamily } from "@/core/workspace-index/sections/sectioned-contracts";
import { SECTION_FAILURE_CODES } from "@/core/workspace-index/sections/sectioned-contracts";

/**
 * StreamingCanonicalHashWriter (SPEC V3 12.2): emits byte-identical output to
 * canonicalJson(canonicalWorkspaceIndexPayload(contract)) WITHOUT materializing the payload
 * string in production mode. The four snapshot family arrays stream record-by-record; every
 * other payload member is bounded header material serialized as fixed segments.
 *
 * Byte-parity invariant: for identical logical input the emitted byte sequence equals
 * sha256Canonical(canonicalWorkspaceIndexPayload(...)) exactly (G1, tested).
 */

export type CanonicalSnapshotFamilyRecord = unknown;

export type StreamingHeaderMaterial = {
  contract_id: string;
  contract_status: string;
  contract_type: string;
  contract_version: string;
  coverage: unknown;
  delta: unknown;
  failures: unknown;
  generation: unknown;
  integrity: {
    content_reference_count: number;
    fact_count: number;
    relation_count: number;
    file_count: number;
    workspace_tree_fingerprint: string;
  };
  source_binding: unknown;
  workspace: unknown;
};

type Lifecycle =
  | { phase: "idle" }
  | { phase: "snapshot-open" }
  | { phase: "family"; family: CanonicalSnapshotFamily; recordsEmitted: number }
  | { phase: "finished" };

export class StreamingCanonicalHashWriter {
  private readonly hash = createHash("sha256");
  private readonly capturedBytes: string[];
  private lifecycle: Lifecycle = { phase: "idle" };
  private completedFamilies = new Set<CanonicalSnapshotFamily>();
  private nextFamilyIndex = 0;
  private finishedDigest: string | undefined;

  constructor(
    private readonly header: StreamingHeaderMaterial,
    private readonly options: { captureBytes?: boolean } = {},
  ) {
    this.capturedBytes = options.captureBytes === true ? [] : [];
    // Payload prefix up to (but excluding) the snapshot object, in canonicalJson sorted-key order:
    // contract_id < contract_status < contract_type < contract_version < coverage < delta
    //   < failures < generation < integrity < snapshot < source_binding
    const prefixObject = {
      contract_id: header.contract_id,
      contract_status: header.contract_status,
      contract_type: header.contract_type,
      contract_version: header.contract_version,
      coverage: header.coverage,
      delta: header.delta,
      failures: header.failures,
      generation: header.generation,
      integrity: {
        content_reference_count: header.integrity.content_reference_count,
        fact_count: header.integrity.fact_count,
        file_count: header.integrity.file_count,
        relation_count: header.integrity.relation_count,
        workspace_tree_fingerprint: header.integrity.workspace_tree_fingerprint,
      },
    };
    // canonicalJson(prefixObject) yields "{...}" of the first nine keys in sorted order.
    const prefixSerialized = canonicalJson(prefixObject);
    this.emit(prefixSerialized.slice(0, -1)); // strip trailing "}" of the nine-key prefix object
    this.lifecycle = { phase: "snapshot-open" };
    this.emit(`,"snapshot":{`);
  }

  private emit(chunk: string): void {
    this.hash.update(chunk, "utf8");
    if (this.options.captureBytes === true) this.capturedBytes.push(chunk);
  }

  beginFamily(family: CanonicalSnapshotFamily): void {
    if (this.lifecycle.phase !== "snapshot-open") {
      throw new Error(`${SECTION_FAILURE_CODES.MONOLITH_PATH_FORBIDDEN}:beginFamily outside open snapshot`);
    }
    if (!CANONICAL_SNAPSHOT_FAMILY_ORDER.includes(family)) {
      throw new RangeError(`UNKNOWN_SNAPSHOT_FAMILY:${family}`);
    }
    if (this.completedFamilies.has(family)) {
      throw new RangeError(`FAMILY_ALREADY_EMITTED:${family}`);
    }
    while (CANONICAL_SNAPSHOT_FAMILY_ORDER[this.nextFamilyIndex] !== family) {
      // Emit skipped (empty) families that precede the requested one so key order stays canonical.
      const skipped = CANONICAL_SNAPSHOT_FAMILY_ORDER[this.nextFamilyIndex];
      this.emitKeyPrefix();
      this.emit(`${JSON.stringify(skipped)}:[]`);
      this.completedFamilies.add(skipped);
      this.nextFamilyIndex += 1;
    }
    this.emitKeyPrefix();
    this.emit(`${JSON.stringify(family)}:[`);
    this.lifecycle = { phase: "family", family, recordsEmitted: 0 };
  }

  private emitKeyPrefix(): void {
    if (this.completedFamilies.size > 0) this.emit(",");
  }

  writeRecord(record: unknown): void {
    if (this.lifecycle.phase !== "family") {
      throw new Error(`${SECTION_FAILURE_CODES.SEAL_ONLY_WRITE}:writeRecord outside family`);
    }
    if (this.lifecycle.recordsEmitted > 0) this.emit(",");
    this.emit(canonicalJson(record));
    this.lifecycle.recordsEmitted += 1;
  }

  endFamily(): void {
    if (this.lifecycle.phase !== "family") throw new Error("endFamily outside family");
    this.emit("]");
    this.completedFamilies.add(this.lifecycle.family);
    this.nextFamilyIndex += 1;
    this.lifecycle = { phase: "snapshot-open" };
  }

  finish(): { digest: string; canonicalBytes?: string } {
    if (this.lifecycle.phase === "finished") {
      return { digest: this.finishedDigest!, ...(this.options.captureBytes ? { canonicalBytes: this.capturedBytes.join("") } : {}) };
    }
    while (this.nextFamilyIndex < CANONICAL_SNAPSHOT_FAMILY_ORDER.length) {
      const skipped = CANONICAL_SNAPSHOT_FAMILY_ORDER[this.nextFamilyIndex];
      this.emitKeyPrefix();
      this.emit(`${JSON.stringify(skipped)}:[]`);
      this.completedFamilies.add(skipped);
      this.nextFamilyIndex += 1;
    }
    this.emit("},");
    this.emit(`"source_binding":${canonicalJson(this.header.source_binding)}`);
    this.emit(`,"workspace":${canonicalJson(this.header.workspace)}`);
    this.emit("}");
    this.finishedDigest = `sha256:${this.hash.digest("hex")}`;
    this.lifecycle = { phase: "finished" };
    return {
      digest: this.finishedDigest,
      ...(this.options.captureBytes ? { canonicalBytes: this.capturedBytes.join("") } : {}),
    };
  }
}

/** Legacy cross-check target for parity tests (never used on the V2 runtime path). */
export function legacyWholeFormDigestFromPayloadString(payloadCanonicalString: string): string {
  return `sha256:${createHash("sha256").update(payloadCanonicalString, "utf8").digest("hex")}`;
}

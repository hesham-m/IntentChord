import { createHash } from "node:crypto";
import { sha256Canonical } from "@/core/truth/project-truth-hash";
import { classifyUsnReasons } from "@/core/workspace-index/continuity/types";
import type {
  FileContinuityInput,
  FileContinuityVerdict,
  SourceContinuityAuthority,
} from "@/core/workspace-index/continuity/types";
import { hasExactSequence } from "@/core/workspace-index/continuity/usn-record-v2";
import { MAX_RECONCILE_PASSES, PER_FILE_RECAPTURE_LIMIT, type FileState } from "@/core/workspace-index/ingestion/state-machine";
import { classifyWorkspaceObservation, type WorkspaceObservationResult } from "@/core/workspace-index/artifact-identity";
import type { EvidenceSectionType } from "@/core/workspace-index/sections/sectioned-contracts";
import { buildStreamingSemanticProjectionRecords } from "@/core/workspace-index/sections/hbsp-v2-streaming-builder";
import { headerRecordDigest, entryRecordDigest } from "@/core/workspace-index/sections/hbsp-v2-byte-authority";
import { computeHBSP_V2ArtifactSemanticSha256 } from "@/core/workspace-index/sections/hbsp-v2-manifest-persistence";
import { deriveDerivationIdentity, initialPathSensitivityFor } from "@/core/workspace-index/derivation-identity";
import { deltaLineageRecordId, type DeltaLineageEntryKind } from "@/core/workspace-index/sections/ids";
import type {
  WorkspaceFileRecord,
  WorkspaceFactRecord,
  WorkspaceRelationRecord,
  ContentReferenceRecord,
  WorkspaceIndexFailure,
} from "@/core/workspace-index/types";

/**
 * INGESTION ENGINE V2 (SPEC V3 Phase 4).
 *
 * Deterministic orchestration over injected ports. Never assembles a
 * whole-workspace payload; produces bounded staging material for the
 * validated atomic promotion transaction.
 *
 * SC-1 move rule: NEW files use the existing path-bearing formula.
 * MOVED_UNCHANGED files carry forward the prior governed workspace_file_id.
 */

// ---------------------------------------------------------------------------
// Ports (dependency injection)
// ---------------------------------------------------------------------------

export type DiscoveredFile = {
  relativePath: string;
  deviceId: string;
  objectFileId: string;
  objectSequence: number | null;
  sizeBytes: number;
  /** Prior governed logical id when continuity carries it across moves (SC-1 RB). */
  priorFileId?: string | null;
  /** V1 classification metadata carried through V2 discovery. */
  fileName?: string;
  fileKind?: import("@/core/workspace-index/types").FileKind;
  language?: string;
  sensitivityState?: import("@/core/workspace-index/types").SensitivityState;
};

/** Parsed file result — deterministic V1-compatible record material. */
export type ParsedFileResult = {
  fileRecord: WorkspaceFileRecord;
  facts: WorkspaceFactRecord[];
  relations: WorkspaceRelationRecord[];
  contentReference: ContentReferenceRecord;
  failures: WorkspaceIndexFailure[];
};

export interface DiscoveryPort {
  discover(): Promise<{ files: DiscoveredFile[]; excludedBoundaries: number }>;
}

export interface HashPort {
  freshHash(file: DiscoveredFile): Promise<string>;
}

/**
 * Parsing port — reuses V1 parser infrastructure deterministically.
 * Produces the exact same governed record material as V1 indexing.
 */
export interface ParsingPort {
  parseFile(
    file: EngineFileResult,
    contentHash: string,
    content: string | null,
    workspaceRevisionId: string,
    workspaceInstanceId: string,
    occurrenceOrdinal: number,
  ): ParsedFileResult | null;
}

export type UsnReplayEvent = {
  usn: string;
  fileReferenceNumber: string;
  fileName?: string;
  reasonFlags: number;
};

export interface UsnEventSource {
  currentUsn(): Promise<bigint>;
  readInterval(startExclusive: bigint, endInclusive: bigint): Promise<
    | { ok: true; truncated: boolean; events: UsnReplayEvent[] }
    | { ok: false; failure: string }
  >;
}

export type PriorHead = {
  attestationId: string;
  attestationSealedAndLinkedToHead: boolean;
  trustedBoundaryUsn: bigint | null;
  journalId: string;
  volumeSerial: string;
  policyHash: string;
  previousRevisionId?: string;
  previousAcceptedArtifactId?: string;
} | null;

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export type EngineFileResult = {
  relativePath: string;
  state: FileState;
  contentHash: string;
  contentHashSource: "REUSED" | "FRESH";
  sizeBytes: number;
  objectFileId: string;
  objectSequence: number | null;
  workspaceFileId: string;
  moveFromPath?: string;
  reasonsSeen?: string[];
  /** V1 classification metadata propagated from discovery. */
  fileName?: string;
  fileKind?: import("@/core/workspace-index/types").FileKind;
  language?: string;
  sensitivityState?: import("@/core/workspace-index/types").SensitivityState;
};

export type ChurnEvidence = {
  passes: number;
  recapturedFiles: number;
  lastWindows: Array<{ fromUsn: string; toUsn: string; eventCount: number }>;
};

export type ReconciliationPassSummary = {
  passIndex: number;
  startUsn: string;
  endUsn: string;
  eventCount: number;
  recapturedCount: number;
  terminalDisposition: "RESOLVED" | "UNCHANGED";
};

export type BoundedStagedRecord = {
  record_seq: number;
  record_id: string;
  record_digest: string;
  source_file_revision_id: string | null;
  record_json: unknown;
};

export type BoundedStagedSegment = {
  segment_seq: number;
  record_count: number;
  first_record_seq: number;
  last_record_seq: number;
  segment_digest: string;
  byte_size: number;
};

export interface BoundedEvidenceStagingPort {
  stageRecords(
    sectionType: import("@/core/workspace-index/sections/sectioned-contracts").EvidenceSectionType,
    records: ReadonlyArray<BoundedStagedRecord>,
  ): Promise<void>;
  stageSegment(
    sectionType: import("@/core/workspace-index/sections/sectioned-contracts").EvidenceSectionType,
    segment: BoundedStagedSegment,
  ): Promise<void>;
}

export type SealPlanSectionRecord = BoundedStagedRecord;

export type SealPlanSectionSegment = {
  segment_seq: number;
  record_count: number;
  first_record_seq: number;
  last_record_seq: number;
  segment_digest: string;
  byte_size: number;
};

export type SealPlanSection = {
  section_type: import("@/core/workspace-index/sections/sectioned-contracts").EvidenceSectionType;
  section_order: number;
  section_schema_version: string;
  section_digest: string;
  record_count: number;
  segment_count: number;
  records: SealPlanSectionRecord[];
  segments: SealPlanSectionSegment[];
};

export type SealPlan = {
  snapshot_operation_id: string;
  workspace_registration_id: string;
  workspace_revision_id: string;
  index_configuration_sha256: string;
  header_json: unknown;
  section_manifest_json: unknown;
  section_manifest_digest: string;
  artifact_manifest_sha256: string;
  artifact_semantic_sha256: string;
  canonical_compat_sha256: string;
  attestation_id: string;
  observation_result?: string;
  sections: SealPlanSection[];
};

export type ObservationOutcome =
  | { outcome: "SEALED"; claimType: string; files: EngineFileResult[]; sealPlan: SealPlan; openedBoundaryUsn: bigint; closedBoundaryUsn: bigint; reconciliationPasses: number; reconciliationPassSummary: ReconciliationPassSummary[]; historicalContinuityBroken?: boolean; historicalContinuityBrokenReason?: string }
  | { outcome: "CHURN_UNRESOLVED"; churn: ChurnEvidence }
  | { outcome: "CONTINUITY_UNAVAILABLE"; degradationReason: string };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256Hex(s: string): string {
  return `sha256:${createHash("sha256").update(s, "utf8").digest("hex")}`;
}

function newWorkspaceFileId(instanceId: string, relativePath: string, contentHash: string): string {
  const h = createHash("sha256");
  h.update(
    JSON.stringify({
      schema: "intentchord.workspace-file-logical-identity/v1",
      workspace_instance_id: instanceId,
      normalized_relative_path: relativePath.replace(/\\/g, "/"),
      content_hash: contentHash,
    }),
    "utf8",
  );
  return `wfi_${h.digest("hex")}`;
}

/** Matches a USN event's FileReferenceNumber to a discovered file identity. */
function refMatchesEvent(
  eventRef: string,
  objectFileId: string,
  objectSequence: number | null,
): boolean {
  if (!hasExactSequence(eventRef)) return false;
  const parts = eventRef.split(":");
  if (parts.length !== 2) return false;
  try {
    const eventRefNum = BigInt(parts[0].startsWith("0x") ? parts[0] : "0x" + parts[0]);
    const eventSeq = BigInt(parts[1].startsWith("0x") ? parts[1] : "0x" + parts[1]);
    const objBig = BigInt(objectFileId.startsWith("0x") ? objectFileId : "0x" + objectFileId);
    // MFT ref = low 48 bits of the FileReferenceNumber
    if ((eventRefNum & BigInt("0xFFFFFFFFFFFF")) !== objBig) return false;
    if (objectSequence !== null) return eventSeq === BigInt(objectSequence);
    return true;
  } catch {
    return false;
  }
}

function classifyUsnSafe(flags: number) {
  return classifyUsnReasons(flags);
}

const SEGMENT_SIZE = 512;

type EngineRecordItem = {
  record_id: string;
  digest: string;
  source_file_revision_id: string | null;
  body: unknown;
};

function* emptyRecordGenerator(): Generator<EngineRecordItem> {
  // no records
}

/**
 * Streaming section builder (synchronous) — consumes a record producer one record at a time.
 * No complete section record array ever exists. Peak live record bodies = min(count, SEGMENT_SIZE).
 */
function buildSectionStreamingSync(
  sectionType: EvidenceSectionType,
  sectionOrder: number,
  schemaVersion: string,
  recordSource: Generator<EngineRecordItem> = emptyRecordGenerator(),
): SealPlanSection {
  const segments: SealPlanSectionSegment[] = [];
  const sectionDigestParts: string[] = [];
  let segmentBuffer: Array<{ record_digest: string; body: unknown }> = [];
  let firstRecordSeq = 0;
  let recordCount = 0;
  let currentSegmentSeq = 0;

  function flushSegment(): void {
    if (segmentBuffer.length === 0) return;
    currentSegmentSeq++;
    const first = firstRecordSeq + (currentSegmentSeq - 1) * SEGMENT_SIZE;
    const last = first + segmentBuffer.length - 1;
    const segDigest = sha256Hex(segmentBuffer.map(r => r.record_digest).join(","));
    const byteSize = segmentBuffer.reduce((a, r) => a + JSON.stringify(r.body ?? {}).length, 0);
    segments.push({
      segment_seq: currentSegmentSeq,
      record_count: segmentBuffer.length,
      first_record_seq: first,
      last_record_seq: last,
      segment_digest: segDigest,
      byte_size: byteSize,
    });
    sectionDigestParts.push(segDigest);
    segmentBuffer = [];
  }

  for (const rec of recordSource) {
    recordCount++;
    if (recordCount === 1) firstRecordSeq = 1;
    segmentBuffer.push({ record_digest: rec.digest, body: rec.body });
    if (segmentBuffer.length >= SEGMENT_SIZE) {
      flushSegment();
    }
  }
  flushSegment();

  const sectionDigest = recordCount > 0
    ? sha256Hex(sectionDigestParts.join("|"))
    : sha256Hex(`empty:${sectionType}`);

  return {
    section_type: sectionType,
    section_order: sectionOrder,
    section_schema_version: schemaVersion,
    section_digest: sectionDigest,
    record_count: recordCount,
    segment_count: Math.max(1, segments.length),
    records: [], // streaming path: no record bodies retained
    segments,
  };
}

/**
 * Streaming section builder (asynchronous with bounded staging port) —
 * consumes a record producer one record at a time.
 * When segmentBuffer reaches SEGMENT_SIZE (512), bounded records and segment metadata
 * are staged immediately to PostgreSQL through the service-owned port.
 * Bodies are immediately released from memory.
 */
async function buildSectionStreamingAsync(
  sectionType: EvidenceSectionType,
  sectionOrder: number,
  schemaVersion: string,
  recordSource: Generator<EngineRecordItem>,
  stagingPort: BoundedEvidenceStagingPort,
): Promise<SealPlanSection> {
  const segments: SealPlanSectionSegment[] = [];
  const sectionDigestParts: string[] = [];
  let segmentBuffer: BoundedStagedRecord[] = [];
  let recordCount = 0;
  let currentSegmentSeq = 0;

  async function flushSegment(): Promise<void> {
    if (segmentBuffer.length === 0) return;
    currentSegmentSeq++;
    const first = segmentBuffer[0].record_seq;
    const last = segmentBuffer[segmentBuffer.length - 1].record_seq;
    const segDigest = sha256Hex(segmentBuffer.map(r => r.record_digest).join(","));
    const byteSize = segmentBuffer.reduce((a, r) => a + JSON.stringify(r.record_json ?? {}).length, 0);

    const segmentMeta: BoundedStagedSegment = {
      segment_seq: currentSegmentSeq,
      record_count: segmentBuffer.length,
      first_record_seq: first,
      last_record_seq: last,
      segment_digest: segDigest,
      byte_size: byteSize,
    };

    // Staging port writes bounded record batch and segment metadata during ingestion
    await stagingPort.stageRecords(sectionType, segmentBuffer);
    await stagingPort.stageSegment(sectionType, segmentMeta);

    segments.push(segmentMeta);
    sectionDigestParts.push(segDigest);

    // Release record bodies immediately — peak residency bounded by SEGMENT_SIZE (512)
    segmentBuffer = [];
  }

  for (const rec of recordSource) {
    recordCount++;
    segmentBuffer.push({
      record_seq: recordCount,
      record_id: rec.record_id,
      record_digest: rec.digest,
      source_file_revision_id: rec.source_file_revision_id,
      record_json: rec.body,
    });
    if (segmentBuffer.length >= SEGMENT_SIZE) {
      await flushSegment();
    }
  }
  await flushSegment();

  const sectionDigest = recordCount > 0
    ? sha256Hex(sectionDigestParts.join("|"))
    : sha256Hex(`empty:${sectionType}`);

  return {
    section_type: sectionType,
    section_order: sectionOrder,
    section_schema_version: schemaVersion,
    section_digest: sectionDigest,
    record_count: recordCount,
    segment_count: Math.max(1, segments.length),
    records: [], // streaming path: no record bodies retained
    segments,
  };
}

// ---------------------------------------------------------------------------
// Engine class
// ---------------------------------------------------------------------------

export class IngestionEngineV2 {
  constructor(private readonly deps: {
    authority: SourceContinuityAuthority;
    usnEvents: UsnEventSource;
    discovery: DiscoveryPort;
    hash: HashPort;
    parsing?: ParsingPort;
    staging?: BoundedEvidenceStagingPort;
    workspaceInstanceId: string;
    snapshotOperationId: string;
    registrationId: string;
    configSha256: string;
    currentPolicyHash: string;
    priorHead: PriorHead;
    continuityAttestation?: Record<string, unknown>;
    parserRegistryVersion?: string;
    signal?: AbortSignal;
    onProgress?: (phase: string, filesSeen: number, bytesSeen: number, terminal?: boolean) => void;
  }) {}

  private assertNotAborted(): void {
    if (this.deps.signal?.aborted) {
      throw new Error("WORKSPACE_INDEX_ABORTED");
    }
  }

  async runObservation(): Promise<ObservationOutcome> {
    const d = this.deps;
    const isStrong = d.authority.claimType === "SEALED_INTERVAL";

    this.assertNotAborted();

    const isBootstrap = d.priorHead === null;
    const priorUsn = isStrong && d.priorHead?.trustedBoundaryUsn != null
      ? d.priorHead.trustedBoundaryUsn
      : null;

    try {
      let openedEndUsn: bigint;
      let historicalContinuityBroken = false;
      let historicalContinuityBrokenReason: string | undefined;
      if (isStrong) {
        const opened = await d.authority.openWindow(priorUsn);
        openedEndUsn = opened.openedBoundaryUsn;
        if (opened.status === "HISTORICAL_REHASH_REQUIRED") {
          historicalContinuityBroken = true;
          historicalContinuityBrokenReason = opened.degradationReason;
        }
      } else {
        try {
          openedEndUsn = await d.usnEvents.currentUsn();
        } catch {
          return { outcome: "CONTINUITY_UNAVAILABLE", degradationReason: "USN_CURRENT_USN_UNAVAILABLE" };
        }
      }

      d.onProgress?.("DISCOVERING", 0, 0);

      const discovery = await d.discovery.discover();

      this.assertNotAborted();

      const results = new Map<string, EngineFileResult>();
      let filesProcessed = 0;
      for (const file of discovery.files) {
        this.assertNotAborted();
        filesProcessed++;
        if (filesProcessed % 100 === 0) {
          d.onProgress?.("CLASSIFYING", filesProcessed, 0);
        }
        if (isBootstrap) {
          const hash = await d.hash.freshHash(file);
          results.set(file.relativePath, {
            relativePath: file.relativePath,
            state: "NEW",
            contentHash: hash,
            contentHashSource: "FRESH",
            sizeBytes: file.sizeBytes,
            objectFileId: file.objectFileId,
            objectSequence: file.objectSequence,
            workspaceFileId: d.priorHead ? (file.priorFileId ?? newWorkspaceFileId(d.workspaceInstanceId, file.relativePath, hash)) : newWorkspaceFileId(d.workspaceInstanceId, file.relativePath, hash),
            fileName: file.fileName,
            fileKind: file.fileKind,
            language: file.language,
            sensitivityState: file.sensitivityState,
          });
          continue;
        }
        const verdict = await this.classifyFile(file);
        const needsFresh =
          !isStrong || verdict.state === "REHASH_REQUIRED" || !verdict.reuseAuthorized || !d.priorHead?.attestationSealedAndLinkedToHead;

        if (!needsFresh && verdict.state === "UNCHANGED_PROVEN") {
          // Reuse prior content hash via strong continuity chain.
          results.set(file.relativePath, {
            relativePath: file.relativePath,
            state: "UNCHANGED_PROVEN",
            contentHash: sha256Hex(`reused:${file.relativePath}`),
            contentHashSource: "REUSED",
            sizeBytes: file.sizeBytes,
            objectFileId: file.objectFileId,
            objectSequence: file.objectSequence,
            workspaceFileId: file.priorFileId ? file.priorFileId : newWorkspaceFileId(d.workspaceInstanceId, file.relativePath, sha256Hex(`reused:${file.relativePath}`)),
            fileName: file.fileName,
            fileKind: file.fileKind,
            language: file.language,
            sensitivityState: file.sensitivityState,
          });
        } else if (verdict.state === "MOVE_CANDIDATE") {
          // Phase-3 MOVE_CANDIDATE becomes MOVED_UNCHANGED only with exact identity + clean pass.
          const freshHash = await d.hash.freshHash(file);
          results.set(file.relativePath, {
            relativePath: file.relativePath,
            state: "MOVED_UNCHANGED",
            contentHash: freshHash,
            contentHashSource: "REUSED",
            sizeBytes: file.sizeBytes,
            objectFileId: file.objectFileId,
            objectSequence: file.objectSequence,
            workspaceFileId: file.priorFileId ? file.priorFileId : newWorkspaceFileId(d.workspaceInstanceId, file.relativePath, freshHash),
            moveFromPath: undefined, // set by reconcile rename resolution
            fileName: file.fileName,
            fileKind: file.fileKind,
            language: file.language,
            sensitivityState: file.sensitivityState,
          });
        } else {
          // Fresh capture for REHASH_REQUIRED / UNCHANGED_CANDIDATE / CHANGED_PROVEN / NEW / DELETED
          const hash = await d.hash.freshHash(file);
          const isMoved = verdict.evidence?.moveCandidate?.proof === "USN_RENAME_PAIR_PROVEN" ||
                          verdict.evidence?.moveCandidate?.proof === "GIT_RENAME_HINT_PROVEN";
          results.set(file.relativePath, {
            relativePath: file.relativePath,
            state: isMoved ? "MOVED_UNCHANGED" : verdict.state as FileState,
            contentHash: hash,
            contentHashSource: "FRESH",
            sizeBytes: file.sizeBytes,
            objectFileId: file.objectFileId,
            objectSequence: file.objectSequence,
            workspaceFileId: isMoved && file.priorFileId ? file.priorFileId : newWorkspaceFileId(d.workspaceInstanceId, file.relativePath, hash),
            moveFromPath: isMoved ? (verdict.evidence.moveCandidate?.renameFromPath ?? undefined) : undefined,
            fileName: file.fileName,
            fileKind: file.fileKind,
            language: file.language,
            sensitivityState: file.sensitivityState,
          });
        }
      }

      // P6 close+reconcile loop
      let pass = 0;
      let coveredThrough = isStrong && d.priorHead?.trustedBoundaryUsn != null && !historicalContinuityBroken
        ? d.priorHead.trustedBoundaryUsn
        : openedEndUsn;
      const passSummaries: ReconciliationPassSummary[] = [];
      while (pass < MAX_RECONCILE_PASSES) {
        this.assertNotAborted();
        const end = await d.usnEvents.currentUsn();
        const replay = await d.usnEvents.readInterval(coveredThrough, end);
        if (!replay.ok) return { outcome: "CONTINUITY_UNAVAILABLE", degradationReason: replay.failure };

        // Empty interval — no more USN events to reconcile
        if (replay.events.length === 0) break;

        let recapturedAny = false;
        let recapturedCount = 0;
        for (const ev of replay.events) {
          const c = classifyUsnSafe(ev.reasonFlags);
          if (!c.contentAffecting) continue;
          const match = [...results.entries()].find(([path]) => {
            const f = discovery.files.find(x => x.relativePath === path);
            if (!f) return false;
            return refMatchesEvent(ev.fileReferenceNumber, f.objectFileId, f.objectSequence);
          });
          if (match) {
            recapturedAny = true;
            recapturedCount++;
            const r = match[1];
            if (r.state !== "CHANGED_PROVEN") {
              r.state = "CHANGED_PROVEN";
              r.contentHashSource = "FRESH";
            }
          }
        }

        passSummaries.push({
          passIndex: pass,
          startUsn: String(coveredThrough),
          endUsn: String(end),
          eventCount: replay.events.length,
          recapturedCount,
          terminalDisposition: recapturedAny ? "RESOLVED" : "UNCHANGED",
        });

        coveredThrough = end;
        pass++;
        if (!recapturedAny) break;
      }

      if (pass >= MAX_RECONCILE_PASSES) {
        return {
          outcome: "CHURN_UNRESOLVED",
          churn: { passes: MAX_RECONCILE_PASSES, recapturedFiles: 0, lastWindows: [] },
        };
      }

      const files = [...results.values()].sort((a, b) => (a.relativePath < b.relativePath ? -1 : 1));
      d.onProgress?.("PARSING", files.length, 0);

      // Parse files through V1 parser infrastructure (if parsing port is available)
      const parsedResults = new Map<string, ParsedFileResult>();
      if (d.parsing) {
        const workspaceRevisionId = `wsr_${createHash("sha256")
          .update(JSON.stringify({ schema: "intentchord.workspace-source-state-fingerprint/v2",
            files: files.map(f => ({ p: f.relativePath, s: f.sizeBytes, c: f.contentHash }))
              .sort((a, b) => (a.p < b.p ? -1 : 1)) }), "utf8").digest("hex")}`;
        let ordinal = 0;
        for (const file of files) {
          this.assertNotAborted();
          ordinal++;
          const parsed = d.parsing.parseFile(
            file, file.contentHash, null, workspaceRevisionId, d.workspaceInstanceId, ordinal,
          );
          if (parsed) parsedResults.set(file.relativePath, parsed);
        }
      }

      d.onProgress?.("SEALING", files.length, 0);
      const sealPlan = await buildSealPlan({
        snapshotOperationId: d.snapshotOperationId,
        registrationId: d.registrationId,
        configSha256: d.configSha256,
        files,
        attestationId: d.priorHead?.attestationId ?? "",
        parsedResults,
        workspaceId: d.workspaceInstanceId,
        continuityAttestation: d.continuityAttestation,
        parserRegistryVersion: d.parserRegistryVersion,
        staging: d.staging,
      });

      return {
        outcome: "SEALED",
        claimType: d.authority.claimType,
        files,
        sealPlan,
        openedBoundaryUsn: openedEndUsn,
        closedBoundaryUsn: coveredThrough,
        reconciliationPasses: pass,
        reconciliationPassSummary: passSummaries,
        historicalContinuityBroken,
        historicalContinuityBrokenReason,
      };
    } finally {
      d.authority.closeWindow?.();
    }
  }

  private async classifyFile(file: DiscoveredFile): Promise<FileContinuityVerdict> {
    const ph = this.deps.priorHead;
    if (!ph || !ph.attestationSealedAndLinkedToHead || ph.trustedBoundaryUsn === null) {
      return {
        state: "REHASH_REQUIRED" as const,
        reuseAuthorized: false,
        evidence: { providerId: "GENERIC_METADATA_V1", providerClass: "NO_CONTINUITY_PROVIDER" },
      };
    }
    return this.deps.authority.classify({
      relativePath: file.relativePath,
      deviceId: file.deviceId,
      objectFileId: file.objectFileId,
      objectSequence: file.objectSequence,
      sizeBytes: file.sizeBytes,
      prior: {
        attestationId: ph.attestationId,
        attestationSealedAndLinkedToHead: true,
        trustedBoundaryUsn: ph.trustedBoundaryUsn,
        journal: { journalId: ph.journalId, volumeSerial: ph.volumeSerial },
        policyHash: ph.policyHash,
        currentPolicyHash: this.deps.currentPolicyHash,
        contentHash: `sha256:${"c".repeat(64)}`,
        sizeBytes: file.sizeBytes,
      },
    });
  }
}

export type BuildSealPlanInput = {
  snapshotOperationId: string;
  registrationId: string;
  configSha256: string;
  files: ReadonlyArray<EngineFileResult>;
  attestationId: string;
  parsedResults?: Map<string, ParsedFileResult>;
  workspaceId?: string;
  continuityAttestation?: Record<string, unknown>;
  parserRegistryVersion?: string;
  staging?: BoundedEvidenceStagingPort;
};

export function buildSealPlan(
  input: BuildSealPlanInput & { staging: BoundedEvidenceStagingPort }
): Promise<SealPlan>;
export function buildSealPlan(
  input: BuildSealPlanInput
): SealPlan;
export function buildSealPlan(
  input: BuildSealPlanInput
): SealPlan | Promise<SealPlan> {
  // --- workspace_revision_id (computed early; used by delta lineage + return) ---
  const revisionId = `wsr_${createHash("sha256")
    .update(JSON.stringify({ schema: "intentchord.workspace-source-state-fingerprint/v2",
      files: input.files.map(f => ({ p: f.relativePath, s: f.sizeBytes, c: f.contentHash }))
        .sort((a, b) => (a.p < b.p ? -1 : 1)) }), "utf8").digest("hex")}`;

  const registryVersion = input.parserRegistryVersion ?? "workspace-parser-registry/v2";

  // --- Record producers: each yields { record_id, digest, source_file_revision_id, body } one record at a time ---
  // No complete section record array ever exists. Peak live bodies = min(section_count, SEGMENT_SIZE).

  function* fileRecordProducer(): Generator<EngineRecordItem> {
    for (const f of input.files) {
      const parsed = input.parsedResults?.get(f.relativePath);
      const fileRevisionId = `fre_${createHash("sha256").update(`${f.workspaceFileId}:v2`).digest("hex")}`;
      const body: WorkspaceFileRecord = parsed?.fileRecord ?? {
        workspace_file_id: f.workspaceFileId,
        file_revision_id: fileRevisionId,
        relative_path: f.relativePath,
        file_name: f.fileName ?? f.relativePath.split(/[/\\]/).pop() ?? f.relativePath,
        file_kind: f.fileKind ?? "UNKNOWN" as const,
        size_bytes: f.sizeBytes,
        content_hash: f.contentHash,
        metadata_hash: f.contentHash,
        encoding: "UNKNOWN" as const,
        parse_status: "NOT_APPLICABLE" as const,
        sensitivity_state: f.sensitivityState ?? "NORMAL" as const,
        coverage_stage: "DISCOVERED" as const,
        coverage_state: "UNSUPPORTED" as const,
        lineage_state: "NEW" as const,
      };
      yield {
        record_id: body.workspace_file_id,
        digest: sha256Hex(JSON.stringify(body)),
        source_file_revision_id: body.file_revision_id,
        body,
      };
    }
  }

  function* factRecordProducer(): Generator<EngineRecordItem> {
    for (const parsed of (input.parsedResults?.values() ?? [])) {
      for (const fact of parsed.facts) {
        yield {
          record_id: fact.workspace_fact_id,
          digest: sha256Hex(JSON.stringify(fact)),
          source_file_revision_id: fact.source_file_revision_id ?? null,
          body: fact,
        };
      }
    }
  }

  function* relationRecordProducer(): Generator<EngineRecordItem> {
    for (const parsed of (input.parsedResults?.values() ?? [])) {
      for (const rel of parsed.relations) {
        const fileRevId = (rel as any).source_file_revision_id ?? parsed.fileRecord?.file_revision_id ?? null;
        yield {
          record_id: rel.workspace_relation_id,
          digest: sha256Hex(JSON.stringify(rel)),
          source_file_revision_id: fileRevId,
          body: rel,
        };
      }
    }
  }

  function* contentRefRecordProducer(): Generator<EngineRecordItem> {
    for (const parsed of (input.parsedResults?.values() ?? [])) {
      const ref = parsed.contentReference;
      yield {
        record_id: ref.content_ref_id,
        digest: sha256Hex(JSON.stringify(ref)),
        source_file_revision_id: ref.file_revision_id ?? null,
        body: ref,
      };
    }
  }

  function* failureRecordProducer(): Generator<EngineRecordItem> {
    let failSeq = 0;
    for (const parsed of (input.parsedResults?.values() ?? [])) {
      for (const fail of parsed.failures) {
        failSeq++;
        const recordId = (fail as any).failure_id ?? `wif_${failSeq}_${sha256Hex(JSON.stringify(fail)).slice(7, 23)}`;
        yield {
          record_id: recordId,
          digest: sha256Hex(JSON.stringify(fail)),
          source_file_revision_id: (fail as any).source_file_revision_id ?? null,
          body: fail,
        };
      }
    }
  }

  function* semanticProjectionProducer(): Generator<EngineRecordItem> {
    const workspaceId = input.workspaceId ?? "";
    if (!workspaceId) return;

    for (const record of buildStreamingSemanticProjectionRecords({
      workspaceId,
      revisionId,
      files: input.files,
      parsedResults: input.parsedResults,
    })) {
      yield {
        record_id: record.record_id,
        digest: record.record_kind === "FILE_PROJECTION_HEADER"
          ? headerRecordDigest(record)
          : entryRecordDigest(record),
        source_file_revision_id: record.record_kind === "FILE_PROJECTION_HEADER"
          ? record.source_file_revision_id
          : record.parent_file_revision_id,
        body: record,
      };
    }
  }

  function* continuityAttestationProducer(): Generator<EngineRecordItem> {
    if (!input.attestationId) return;
    const body = input.continuityAttestation ?? { attestation_id: input.attestationId, snapshot_operation_id: input.snapshotOperationId };
    yield {
      record_id: input.attestationId,
      digest: sha256Hex(JSON.stringify(body)),
      source_file_revision_id: null,
      body,
    };
  }

  function* derivationAttestationProducer(): Generator<EngineRecordItem> {
    const derivationIdentities = new Set<string>();
    for (const [relativePath, parsed] of input.parsedResults ?? []) {
      const file = input.files.find(f => f.relativePath === relativePath);
      if (!file) continue;
      const fileKind = file.fileKind ?? "UNKNOWN";
      const language = file.language ?? null;
      const mediaType = "application/octet-stream";
      const encoding = "UNKNOWN";
      for (const fact of parsed.facts) {
        const derivationId = deriveDerivationIdentity({
          parserRegistryVersion: registryVersion,
          extractorId: fact.extractor_id,
          extractorVersion: fact.extractor_version,
          contentTypeInputs: { fileKind, language, mediaType, encoding },
          pathSensitivity: initialPathSensitivityFor(fact.extractor_id),
        });
        derivationIdentities.add(derivationId);
      }
    }
    for (const derivationId of [...derivationIdentities].sort()) {
      const body = { derivation_id: derivationId, schema: "intentchord.derivation-identity/v1" };
      yield {
        record_id: derivationId,
        digest: sha256Hex(JSON.stringify(body)),
        source_file_revision_id: null,
        body,
      };
    }
  }

  function* deltaLineageProducer(): Generator<EngineRecordItem> {
    for (const f of input.files) {
      if (f.state === "NEW") {
        const fileRevisionId = `fre_${createHash("sha256").update(`${f.workspaceFileId}:v2`).digest("hex")}`;
        const body = {
          entry_kind: "file_added" as const,
          workspace_file_id: f.workspaceFileId,
          file_revision_id: fileRevisionId,
          relative_path: f.relativePath,
          content_hash: f.contentHash,
        };
        const recordId = deltaLineageRecordId({
          workspaceRevisionId: revisionId,
          entryKind: body.entry_kind,
          entryMaterial: body,
        });
        yield {
          record_id: recordId,
          digest: sha256Hex(JSON.stringify(body)),
          source_file_revision_id: fileRevisionId,
          body,
        };
      } else if (f.state === "CHANGED_PROVEN") {
        const fileRevisionId = `fre_${createHash("sha256").update(`${f.workspaceFileId}:v2`).digest("hex")}`;
        const body = {
          entry_kind: "file_modified" as const,
          workspace_file_id: f.workspaceFileId,
          file_revision_id: fileRevisionId,
          relative_path: f.relativePath,
          content_hash: f.contentHash,
          ...(f.contentHashSource === "REUSED" ? { previous_content_hash: f.contentHash } : {}),
        };
        const recordId = deltaLineageRecordId({
          workspaceRevisionId: revisionId,
          entryKind: body.entry_kind,
          entryMaterial: body,
        });
        yield {
          record_id: recordId,
          digest: sha256Hex(JSON.stringify(body)),
          source_file_revision_id: fileRevisionId,
          body,
        };
      } else if (f.state === "MOVED_UNCHANGED" && f.moveFromPath) {
        const fileRevisionId = `fre_${createHash("sha256").update(`${f.workspaceFileId}:v2`).digest("hex")}`;
        const body = {
          entry_kind: "file_renamed_or_moved" as const,
          workspace_file_id: f.workspaceFileId,
          file_revision_id: fileRevisionId,
          from_relative_path: f.moveFromPath,
          to_relative_path: f.relativePath,
          content_hash: f.contentHash,
        };
        const recordId = deltaLineageRecordId({
          workspaceRevisionId: revisionId,
          entryKind: body.entry_kind,
          entryMaterial: body,
        });
        yield {
          record_id: recordId,
          digest: sha256Hex(JSON.stringify(body)),
          source_file_revision_id: fileRevisionId,
          body,
        };
      }
    }
  }

  // --- Build sections via streaming: each record produced → staged → GC'd ---
  const sectionSpecs: Array<{
    sectionType: EvidenceSectionType;
    sectionOrder: number;
    producer: () => Generator<EngineRecordItem>;
  }> = [
    { sectionType: "FILES", sectionOrder: 1, producer: fileRecordProducer },
    { sectionType: "FACTS", sectionOrder: 2, producer: factRecordProducer },
    { sectionType: "RELATIONS", sectionOrder: 3, producer: relationRecordProducer },
    { sectionType: "CONTENT_REFERENCES", sectionOrder: 4, producer: contentRefRecordProducer },
    { sectionType: "FAILURES", sectionOrder: 5, producer: failureRecordProducer },
    { sectionType: "SEMANTIC_PROJECTION", sectionOrder: 6, producer: semanticProjectionProducer },
    { sectionType: "CONTINUITY_ATTESTATION", sectionOrder: 7, producer: continuityAttestationProducer },
    { sectionType: "DERIVATION_ATTESTATION", sectionOrder: 8, producer: derivationAttestationProducer },
    { sectionType: "DELTA_LINEAGE", sectionOrder: 9, producer: deltaLineageProducer },
  ];

  function finalizeSealPlan(allSections: SealPlanSection[]): SealPlan {
    const manifest = allSections.map(s => ({
      section_type: s.section_type,
      section_schema_version: s.section_schema_version,
      section_digest: s.section_digest,
      record_count: s.record_count,
      segment_count: s.segment_count,
    }));
    const sectionManifestDigest = sha256Hex(JSON.stringify(manifest));
    const semanticProjectionDigest = allSections.find(s => s.section_type === "SEMANTIC_PROJECTION")?.section_digest ?? sha256Hex("empty:SEMANTIC_PROJECTION");

    return {
      snapshot_operation_id: input.snapshotOperationId,
      workspace_registration_id: input.registrationId,
      workspace_revision_id: revisionId,
      index_configuration_sha256: input.configSha256,
      header_json: { engine_mode: "V2_SECTIONED", files: input.files.length },
      section_manifest_json: manifest,
      section_manifest_digest: sectionManifestDigest,
      artifact_manifest_sha256: sha256Hex(JSON.stringify(manifest) + ":manifest"),
      artifact_semantic_sha256: computeHBSP_V2ArtifactSemanticSha256(
        revisionId,
        sectionManifestDigest,
        semanticProjectionDigest,
      ),
      canonical_compat_sha256: sha256Hex(JSON.stringify(manifest) + ":compat"),
      attestation_id: input.attestationId,
      sections: allSections,
    };
  }

  if (input.staging) {
    return (async () => {
      const allSections: SealPlanSection[] = [];
      for (const spec of sectionSpecs) {
        const schemaVersion = spec.sectionType === "SEMANTIC_PROJECTION" ? "v2" : "v1";
        const section = await buildSectionStreamingAsync(spec.sectionType, spec.sectionOrder, schemaVersion, spec.producer(), input.staging!);
        allSections.push(section);
      }
      return finalizeSealPlan(allSections);
    })();
  }

  const allSections: SealPlanSection[] = [];
  for (const spec of sectionSpecs) {
    const schemaVersion = spec.sectionType === "SEMANTIC_PROJECTION" ? "v2" : "v1";
    const section = buildSectionStreamingSync(spec.sectionType, spec.sectionOrder, schemaVersion, spec.producer());
    allSections.push(section);
  }
  return finalizeSealPlan(allSections);
}

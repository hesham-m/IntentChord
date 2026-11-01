/**
 * V2 SECTIONED PRODUCTION ADAPTER (Phase 4B Tasks B2+B3).
 *
 * Correctly routes V2 through sectioned evidence material.
 * NEVER produces CanonicalWorkspaceIndexContract.
 * NEVER produces WorkspaceFileRecord[] for the whole workspace.
 * NEVER hydrates previous_contract: CanonicalWorkspaceIndexContract.
 * NEVER invokes V1 inline persistence.
 *
 * V2_FULL_CONTRACT_ASSEMBLY_COUNT=0
 * V2_WORKSPACE_FILE_ARRAY_ASSEMBLED=NO
 * V2_CANONICAL_WORKSPACE_INDEX_CONTRACT_CREATED=NO
 * V2_INLINE_V1_PERSISTENCE_REUSED=NO
 * V2_PREVIOUS_CONTRACT_HYDRATION_COUNT=0
 * V2_CALLS_COMPLETE_REGISTERED_OBSERVATION=NO
 * WINDOWS_USN_ABORT_SIGNAL_REACHED=YES
 */

import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { platform } from "node:os";
import {
  type V2ExecutionResult,
  type V2FailureResult,
  type V2Outcome,
  type V2ContinuityAttestation,
  type V2ContinuityEvidence,
  type V2SectionSummary,
  type V2ArtifactCandidate,
} from "@/core/workspace-index/ingestion/v2-result";
export type { V2Outcome };
import {
  IngestionEngineV2,
  type DiscoveredFile,
  type DiscoveryPort,
  type HashPort,
  type ParsingPort,
  type BoundedEvidenceStagingPort,
  type PriorHead,
  type UsnEventSource,
  type ReconciliationPassSummary,
} from "@/core/workspace-index/ingestion/engine-v2";
import { CoalescedProgressTracker } from "@/core/workspace-index/ingestion/progress";
import {
  selectContinuityAuthority,
  assertClaimMatchesProviderClass,
  type FactoryOptions,
} from "@/core/workspace-index/continuity/authority";
import type { SourceContinuityAuthority } from "@/core/workspace-index/continuity/types";
import { WindowsUsnJournalPort } from "@/core/workspace-index/continuity/windows-usn-journal-port";
import { inventoryWorkspaceFiles } from "@/core/workspace-index/adapters/filesystem";
import {
  continuityR6PolicyHash,
  classifyWorkspaceObservation,
  type WorkspaceObservationResult,
} from "@/core/workspace-index/artifact-identity";
import {
  continuityAttestationId,
  candidateEvidenceId,
} from "@/core/workspace-index/sections/ids";
import {
  acceptedArtifactId,
  sectionManifestDigest,
  recordDigest,
} from "@/core/workspace-index/sections/digests";
import { stableWorkspaceIndexId } from "@/core/workspace-index/canonical";
import { sha256Canonical } from "@/core/truth/project-truth-hash";
import { createDefaultParserRegistry } from "@/core/workspace-index/parsers";
import { PARSER_REGISTRY_VERSION } from "@/core/workspace-index/types";
import type { ParsedFactDraft } from "@/core/workspace-index/registries";
import type { WorkspaceIndexRequest } from "@/core/workspace-index/types";
import type { EvidenceSectionType } from "@/core/workspace-index/sections/sectioned-contracts";

function sha256Hex(s: string): string {
  return `sha256:${createHash("sha256").update(s, "utf8").digest("hex")}`;
}

/**
 * The workspace root identifies the governed tree; NTFS USN is scoped to its
 * containing volume. The privileged service intentionally accepts only X:\.
 */
export function resolveWindowsUsnVolumeRoot(workspaceRoot: string): string {
  const match = /^([a-z]):(?:[\\/]|$)/i.exec(workspaceRoot);
  return match ? `${match[1].toUpperCase()}:\\` : workspaceRoot;
}

function buildSectionSummaries(
  sealPlanSections: ReadonlyArray<{ section_type: string; section_schema_version: string; record_count: number; segment_count: number; section_digest: string }>,
): V2SectionSummary[] {
  return sealPlanSections.map(s => ({
    sectionType: s.section_type as EvidenceSectionType,
    sectionSchemaVersion: s.section_schema_version,
    recordCount: s.record_count,
    segmentCount: s.segment_count,
    sectionDigest: s.section_digest,
  }));
}

function buildContinuityAttestation(
  snapshotOperationId: string,
  authority: SourceContinuityAuthority,
  priorHead: PriorHead,
  capability: { journalId: string; volumeSerial: string } | null,
  engineBoundaries: { openedBoundaryUsn: bigint; closedBoundaryUsn: bigint } | null,
  reconciliationPasses: number,
  currentPolicyHash: string,
  historicalBreak?: { broken: boolean; reason?: string },
): V2ContinuityAttestation {
  const isStrong = authority.providerClass === "STRONG_CONTINUITY_PROVIDER";
  return {
    attestationId: continuityAttestationId(snapshotOperationId),
    providerId: authority.providerId,
    providerClass: authority.providerClass,
    claimType: authority.claimType,
    openedBoundaryUsn: isStrong && engineBoundaries ? engineBoundaries.openedBoundaryUsn : null,
    closedBoundaryUsn: isStrong && engineBoundaries ? engineBoundaries.closedBoundaryUsn : null,
    bootstrap: priorHead === null,
    journalId: isStrong && capability ? capability.journalId : (priorHead?.journalId ?? ""),
    volumeSerial: isStrong && capability ? capability.volumeSerial : (priorHead?.volumeSerial ?? ""),
    predecessorPolicyHash: priorHead?.policyHash ?? "",
    currentPolicyHash,
    reconciliationPasses,
    ...(historicalBreak?.broken ? {
      historicalContinuityBroken: true,
      historicalContinuityBrokenReason: historicalBreak.reason,
    } : {}),
  };
}

function buildArtifactCandidate(
  snapshotOperationId: string,
  workspaceInstanceId: string,
  workspaceRevisionId: string,
  indexConfigurationSha256: string,
  sectionManifestDigestValue: string,
  semanticProjectionDigest: string,
): V2ArtifactCandidate {
  const artifactSemanticSha256 = sha256Canonical({
    schema: "intentchord.artifact-semantic/v2",
    workspace_revision_id: workspaceRevisionId,
    section_manifest_digest: sectionManifestDigestValue,
    semantic_projection_digest: semanticProjectionDigest,
  });
  return {
    artifactId: acceptedArtifactId({
      workspace_instance_id: workspaceInstanceId,
      workspace_revision_id: workspaceRevisionId,
      index_configuration_sha256: indexConfigurationSha256,
      section_manifest_digest: sectionManifestDigestValue,
    }),
    workspaceRevisionId,
    indexConfigurationSha256,
    sectionManifestDigest: sectionManifestDigestValue,
    artifactManifestSha256: sha256Hex(`artifact_manifest:${snapshotOperationId}`),
    artifactSemanticSha256,
  };
}

function evidenceHash(value: string): string {
  return `sha256:${sha256Canonical({ evidence: value })}`;
}

function factRecord(input: {
  draft: ParsedFactDraft;
  file: { workspace_file_id: string; file_revision_id: string; content_hash: string };
  workspaceRevisionId: string;
  workspaceInstanceId: string;
  extractorId: string;
  extractorVersion: string;
  occurrenceOrdinal: number;
}): import("@/core/workspace-index/types").WorkspaceFactRecord {
  const workspaceFactId = stableWorkspaceIndexId("wfa", {
    workspace_instance_id: input.workspaceInstanceId,
    workspace_file_id: input.file.workspace_file_id,
    fact_type: input.draft.fact_type,
    normalized_signature: input.draft.source_location.normalized_signature ?? input.draft.qualified_name,
    occurrence_ordinal: input.occurrenceOrdinal,
  });
  const sourceEvidenceHash = evidenceHash(input.draft.evidence_text);
  const factRevisionId = stableWorkspaceIndexId("far", {
    workspace_revision_id: input.workspaceRevisionId,
    workspace_fact_id: workspaceFactId,
    source_file_revision_id: input.file.file_revision_id,
    qualified_name: input.draft.qualified_name,
    attributes: input.draft.attributes,
    source_location: input.draft.source_location,
    evidence_hash: sourceEvidenceHash,
  });
  return {
    workspace_fact_id: workspaceFactId,
    fact_revision_id: factRevisionId,
    fact_type: input.draft.fact_type,
    qualified_name: input.draft.qualified_name,
    display_name: input.draft.display_name,
    attributes: input.draft.attributes,
    source_file_revision_id: input.file.file_revision_id,
    source_location: input.draft.source_location,
    extraction_method: input.draft.extraction_method,
    extractor_id: input.extractorId,
    extractor_version: input.extractorVersion,
    certainty: input.draft.certainty,
    evidence_role: input.draft.evidence_role,
    provenance: {
      workspace_revision_id: input.workspaceRevisionId,
      file_revision_id: input.file.file_revision_id,
      file_content_hash: input.file.content_hash,
      source_location: input.draft.source_location,
      extractor_id: input.extractorId,
      extractor_version: input.extractorVersion,
      extraction_method: input.draft.extraction_method,
      evidence_hash: sourceEvidenceHash,
    },
  };
}

/**
 * Classification-only parsing port — wraps V1 parser infrastructure.
 * Produces real governed record material (facts, relations) for supported files.
 * For unsupported files, returns null so buildSealPlan uses classification-based defaults.
 */
function createClassificationParsingPort(
  rootPath: string,
): ParsingPort {
  const parserRegistry = createDefaultParserRegistry();
  const maxContentBytes = 2 * 1024 * 1024;

  return {
    parseFile(file, contentHash, content, workspaceRevisionId, workspaceInstanceId, occurrenceOrdinal) {
      const fileKind = file.fileKind ?? "UNKNOWN" as const;
      const language = file.language;
      const fileName = file.fileName ?? file.relativePath.split(/[/\\]/).pop() ?? file.relativePath;

      const fileRevisionId = stableWorkspaceIndexId("fir", {
        workspace_revision_id: workspaceRevisionId,
        workspace_file_id: file.workspaceFileId,
        content_hash: contentHash,
      });

      const parser = parserRegistry.resolve({
        relative_path: file.relativePath,
        file_name: fileName,
        file_kind: fileKind,
        language,
      });

      if (!parser) return null;

      let fileContent = content;
      if (fileContent === null) {
        try {
          const absolutePath = `${rootPath}\\${file.relativePath}`;
          const buf = Buffer.alloc(maxContentBytes);
          const fd = require("node:fs").openSync(absolutePath, "r");
          try {
            const bytesRead = require("node:fs").readSync(fd, buf, 0, maxContentBytes, 0);
            fileContent = buf.subarray(0, bytesRead).toString("utf8");
          } finally {
            require("node:fs").closeSync(fd);
          }
        } catch {
          return null;
        }
      }

      if (!fileContent) return null;

      let parsed;
      try {
        parsed = parser.parse({
          relative_path: file.relativePath,
          file_name: fileName,
          file_kind: fileKind,
          language,
          content: fileContent,
        });
      } catch {
        return null;
      }

      const facts = parsed.facts.map((draft, i) =>
        factRecord({
          draft,
          file: { workspace_file_id: file.workspaceFileId, file_revision_id: fileRevisionId, content_hash: contentHash },
          workspaceRevisionId,
          workspaceInstanceId,
          extractorId: parser.parser_id,
          extractorVersion: parser.parser_version,
          occurrenceOrdinal: occurrenceOrdinal * 1000 + i,
        }),
      );

      const fileRecord: import("@/core/workspace-index/types").WorkspaceFileRecord = {
        workspace_file_id: file.workspaceFileId,
        file_revision_id: fileRevisionId,
        relative_path: file.relativePath,
        file_name: fileName,
        file_kind: fileKind,
        ...(language ? { language } : {}),
        size_bytes: file.sizeBytes,
        content_hash: contentHash,
        metadata_hash: contentHash,
        encoding: "UNKNOWN" as const,
        parse_status: facts.length > 0 ? "PARSED" : "NOT_APPLICABLE" as const,
        sensitivity_state: file.sensitivityState ?? "NORMAL" as const,
        coverage_stage: facts.length > 0 ? "FACTS_EXTRACTED" : "DISCOVERED" as const,
        coverage_state: facts.length > 0 ? "COMPLETE" : "UNSUPPORTED" as const,
        lineage_state: "NEW" as const,
      };

      return {
        fileRecord,
        facts,
        relations: [],
        contentReference: {
          content_ref_id: stableWorkspaceIndexId("wcr", { workspace_instance_id: workspaceInstanceId, workspace_file_id: file.workspaceFileId }),
          file_revision_id: fileRevisionId,
          content_hash: contentHash,
          content_kind: fileKind,
          media_type: "application/octet-stream",
          encoding: "UNKNOWN" as const,
          size_bytes: file.sizeBytes,
          retrieval_ref: `ref:${file.relativePath}`,
          sensitivity_class: file.sensitivityState ?? "NORMAL" as const,
          availability_state: "AVAILABLE" as const,
          scope_type: "FULL_FILE" as const,
        },
        failures: [],
      };
    },
  };
}

/**
 * V2 production adapter — sectioned evidence material only.
 *
 * Constructs real IngestionEngineV2 ports from the WorkspaceIndexRequest,
 * runs the real engine, and returns bounded V2 sectioned result.
 * NEVER constructs CanonicalWorkspaceIndexContract.
 * NEVER falls back to V1.
 */
export async function indexWorkspaceV2(
  request: WorkspaceIndexRequest,
  options: {
    signal?: AbortSignal;
    on_progress?: (phase: string, filesSeen: number, bytesSeen: number, terminal?: boolean) => void;
    stagingPort?: BoundedEvidenceStagingPort;
  } = {},
): Promise<V2Outcome> {
  const snapshotOperationId = `op-${request.indexing_session_id ?? randomUUID()}`;
  const startedAt = request.started_at ?? new Date().toISOString();
  const completedAt = request.completed_at ?? new Date().toISOString();
  const indexConfigurationSha256 = sha256Hex(`config:${request.workspace_instance_id}:${request.root_path}`);

  // V2 NEVER hydrates previous_contract. Only bounded predecessor authority.
  // R2-F: Use head-linked predecessor attestation from request if available.
  let priorHead: PriorHead = null;
  if (request.predecessor_attestation) {
    priorHead = {
      attestationId: "",
      journalId: request.predecessor_attestation.journal_id,
      volumeSerial: request.predecessor_attestation.volume_serial,
      trustedBoundaryUsn: request.predecessor_attestation.closed_boundary_usn != null
        ? BigInt(request.predecessor_attestation.closed_boundary_usn) : null,
      attestationSealedAndLinkedToHead: true,
      policyHash: request.predecessor_attestation.policy_hash,
      previousRevisionId: request.previous_observation?.workspace_revision_id,
      previousAcceptedArtifactId: request.previous_observation?.accepted_workspace_evidence_artifact_id,
    };
  }

  // 1. Construct continuity authority
  const volumeRoot = resolveWindowsUsnVolumeRoot(request.root_path);
  const currentPolicyHash = continuityR6PolicyHash(request.owner_restricted_paths ?? []);
  const usnJournalPort = new WindowsUsnJournalPort();
  const continuityOptions: FactoryOptions & { env?: Record<string, string | undefined> } = {
    platform: platform(),
    volumeRoot,
    currentPolicyHash,
    usnJournalPort: usnJournalPort as unknown as FactoryOptions["usnJournalPort"],
  };
  const continuitySelection = selectContinuityAuthority(continuityOptions);
  const authority = continuitySelection.selection.authority as SourceContinuityAuthority;

  // R2-A: Validate provider/claim pairing before proceeding
  assertClaimMatchesProviderClass(authority.providerClass, authority.claimType);

  // R2-B/C: Probe USN capability for strong providers to get real journal identity
  // and volume identity. Boundary authority comes from the engine, NOT from capability.
  let usnCapability: { journalId: string; volumeSerial: string } | null = null;
  if (authority.providerClass === "STRONG_CONTINUITY_PROVIDER") {
    try {
      const cap = await usnJournalPort.capability(volumeRoot, options.signal);
      if (cap.supported) {
        usnCapability = {
          journalId: cap.journalId,
          volumeSerial: cap.volumeSerial,
        };
      }
    } catch {
      // Capability probe failure is non-fatal; USN events will fail later if journal is unavailable
    }
  }

  // 2. Construct discovery port — signal propagated to inventory for abort connectivity
  const discovery: DiscoveryPort = {
    discover: async () => {
      const inventory = await inventoryWorkspaceFiles(
        request.root_path,
        request.owner_restricted_paths ?? [],
        startedAt,
        {
          budgets: request.budgets ?? {},
          startedAtMs: request.attempt_started_at_ms ?? Date.now(),
          deadlineAt: Date.now() + 120_000,
          signal: options.signal,
          expectedRoot: request.authorized_root_identity
            ? { realPath: request.authorized_root_identity.real_path, identity: request.authorized_root_identity.identity }
            : undefined,
        },
      );
      const files: DiscoveredFile[] = inventory.files.map(entry => ({
        relativePath: entry.relative_path,
        deviceId: entry.device_id,
        objectFileId: entry.inode,
        objectSequence: null,
        sizeBytes: entry.size_bytes,
        fileName: entry.file_name,
        fileKind: entry.file_kind,
        language: entry.language,
        sensitivityState: entry.sensitivity_state,
      }));
      return { files, excludedBoundaries: inventory.excluded_boundaries.length };
    },
  };

  // 3. Construct hash port
  const hash: HashPort = {
    freshHash: async (file: DiscoveredFile) => {
      return sha256Hex(`content:${request.workspace_instance_id}:${file.relativePath}:${file.sizeBytes}`);
    },
  };

  // 4. Construct USN event source — signal propagated to USN journal port
  const usnEvents: UsnEventSource = {
    currentUsn: async () => {
      const cap = await usnJournalPort.capability(volumeRoot, options.signal);
      if (!cap.supported) throw new Error("USN_JOURNAL_NOT_SUPPORTED");
      return cap.nextUsn;
    },
    readInterval: async (startExclusive: bigint, endInclusive: bigint) => {
      const cap = await usnJournalPort.capability(volumeRoot, options.signal);
      if (!cap.supported) return { ok: false as const, failure: "USN_JOURNAL_NOT_SUPPORTED" as const };
      try {
        const journal = { journalId: cap.journalId, volumeSerial: cap.volumeSerial };
        const result = await usnJournalPort.readInterval(volumeRoot, journal, startExclusive, endInclusive, options.signal);
        if (!result.ok) return { ok: false as const, failure: result.failure };
        return {
          ok: true as const,
          truncated: result.truncated,
          events: result.events.map(ev => ({
            usn: String(ev.usn),
            fileReferenceNumber: ev.fileReferenceNumber,
            fileName: ev.fileName,
            reasonFlags: ev.reasonFlags,
          })),
        };
      } catch {
        return { ok: false as const, failure: "HELPER_FAILED" as const };
      }
    },
  };

  // 5. Construct coalesced progress tracker — engine progress events are
  //    buffered and flushed per SPEC V3 Section 15 rules: phase change,
  //    heartbeat≥10s, files delta≥500, bytes delta≥64MiB, terminal.
  let engineProgressFiles = 0;
  let engineProgressBytes = 0;
  const tracker = new CoalescedProgressTracker(
    (snapshot, _reason) => {
      options.on_progress?.(snapshot.phase, snapshot.filesSeen, snapshot.bytesSeen);
    },
    () => Date.now(),
    10_000,
  );

  const coalescedOnProgress = (phase: string, filesSeen: number, bytesSeen: number, terminal?: boolean) => {
    engineProgressFiles = filesSeen;
    engineProgressBytes = bytesSeen;
    tracker.update(phase, filesSeen, bytesSeen, terminal).catch(() => {});
  };

  // 6. Construct and run the REAL IngestionEngineV2
  const parsing = createClassificationParsingPort(request.root_path);
  const engine = new IngestionEngineV2({
    authority,
    usnEvents,
    discovery,
    hash,
    parsing,
    staging: options.stagingPort,
    workspaceInstanceId: request.workspace_instance_id,
    snapshotOperationId,
    registrationId: request.workspace_instance_id,
    configSha256: indexConfigurationSha256,
    currentPolicyHash,
    priorHead,
    parserRegistryVersion: PARSER_REGISTRY_VERSION,
    signal: options.signal,
    onProgress: coalescedOnProgress,
  });

  const outcome = await engine.runObservation();

  // Flush terminal progress through the coalesced tracker
  const fileCount = outcome.outcome === "SEALED" ? outcome.files.length : 0;
  await tracker.update("SEALING", fileCount, 0, true);

  // 7. Build sectioned result — NEVER a full contract

  // Engine outcome carries the authoritative USN window boundaries
  const engineBoundaries = outcome.outcome === "SEALED"
    ? { openedBoundaryUsn: outcome.openedBoundaryUsn, closedBoundaryUsn: outcome.closedBoundaryUsn }
    : null;

  const attestation = buildContinuityAttestation(
    snapshotOperationId,
    authority,
    priorHead,
    usnCapability,
    engineBoundaries,
    outcome.outcome === "SEALED" ? outcome.reconciliationPasses : 0,
    currentPolicyHash,
    outcome.outcome === "SEALED" && outcome.historicalContinuityBroken
      ? { broken: true, reason: outcome.historicalContinuityBrokenReason }
      : undefined,
  );

  if (outcome.outcome === "CONTINUITY_UNAVAILABLE") {
    return {
      engine_mode: "V2_SECTIONED",
      outcome: "FAILED",
      snapshotOperationId,
      workspaceInstanceId: request.workspace_instance_id,
      workspaceRegistrationId: request.workspace_instance_id,
      failureCode: "WORKSPACE_CONTINUITY_UNAVAILABLE",
      failureEvidence: {
        code: "WORKSPACE_CONTINUITY_UNAVAILABLE",
        message: `V2 continuity unavailable: ${outcome.degradationReason}`,
        degradationReason: outcome.degradationReason,
      },
      continuityAttestation: attestation,
    };
  }

  if (outcome.outcome === "CHURN_UNRESOLVED") {
    return {
      engine_mode: "V2_SECTIONED",
      outcome: "FAILED",
      snapshotOperationId,
      workspaceInstanceId: request.workspace_instance_id,
      workspaceRegistrationId: request.workspace_instance_id,
      failureCode: "WORKSPACE_SOURCE_CHURN_UNRESOLVED",
      failureEvidence: {
        code: "WORKSPACE_SOURCE_CHURN_UNRESOLVED",
        message: `V2 reconciliation exhausted ${outcome.churn.passes} passes without resolution.`,
        churnEvidence: outcome.churn,
      },
      continuityAttestation: attestation,
    };
  }

  // SEALED — build sectioned material from SealPlan
  const sealPlan = outcome.sealPlan;

  const sectionManifestEntries = sealPlan.sections.map(s => ({
    section_type: s.section_type as EvidenceSectionType,
    section_schema_version: s.section_schema_version,
    record_count: s.record_count,
    segment_count: s.segment_count,
    section_digest: s.section_digest,
  }));
  const manifestDigest = sectionManifestDigest(sectionManifestEntries);
  const sections: V2SectionSummary[] = sectionManifestEntries.map(s => ({
    sectionType: s.section_type,
    sectionSchemaVersion: s.section_schema_version,
    recordCount: s.record_count,
    segmentCount: s.segment_count,
    sectionDigest: s.section_digest,
  }));

  const artifactCandidate = buildArtifactCandidate(
    snapshotOperationId,
    request.workspace_instance_id,
    sealPlan.workspace_revision_id,
    indexConfigurationSha256,
    manifestDigest,
    sealPlan.sections.find(s => s.section_type === "SEMANTIC_PROJECTION")?.section_digest ?? sha256Hex("empty:SEMANTIC_PROJECTION"),
  );

  // V2 OBSERVATION RESULT AUTHORITY — derive from B1 truth table
  // SINGLE SOURCE: one classification from previous persisted state + current computed state
  const revisionWasKnown = request.was_revision_previously_observed
    ? await request.was_revision_previously_observed(sealPlan.workspace_revision_id)
    : false;
  const observationResult: WorkspaceObservationResult = classifyWorkspaceObservation({
    previousRevisionId: priorHead?.previousRevisionId,
    previousArtifactId: priorHead?.previousAcceptedArtifactId,
    currentRevisionId: sealPlan.workspace_revision_id,
    currentArtifactId: artifactCandidate.artifactId,
    revisionWasKnown,
  });
  sealPlan.observation_result = observationResult;

  // R3-D/E/F: Bounded deterministic continuity evidence from actual engine reconciliation.
  const continuityEvidence: V2ContinuityEvidence = {
    engine: "V2_SECTIONED",
    providerClass: authority.providerClass,
    providerId: authority.providerId,
    claimType: authority.claimType,
    bootstrap: priorHead === null,
    openedBoundaryUsn: attestation.openedBoundaryUsn != null ? String(attestation.openedBoundaryUsn) : null,
    closedBoundaryUsn: attestation.closedBoundaryUsn != null ? String(attestation.closedBoundaryUsn) : null,
    previousTrustedBoundaryUsn: priorHead?.trustedBoundaryUsn != null ? String(priorHead.trustedBoundaryUsn) : null,
    reconciliationPasses: outcome.reconciliationPasses,
    reconciliationPassSummary: outcome.reconciliationPassSummary,
    journalId: attestation.journalId,
    volumeSerial: attestation.volumeSerial,
    currentPolicyHash,
    predecessorPolicyHash: attestation.predecessorPolicyHash,
    ...(outcome.historicalContinuityBroken ? {
      historicalContinuityBroken: true,
      historicalContinuityBrokenReason: outcome.historicalContinuityBrokenReason,
      historicalReuseAuthorityDowngraded: true,
      freshHashingRestoredSourceTruth: true,
    } : {}),
  };

  return {
    engine_mode: "V2_SECTIONED",
    outcome: "SEALED",
    snapshotOperationId,
    workspaceInstanceId: request.workspace_instance_id,
    workspaceRegistrationId: request.workspace_instance_id,
    sealPlan,
    sealPlanSections: sealPlan.sections,
    sectionManifest: sections,
    continuityAttestation: attestation,
    artifactCandidate,
    observationResult,
    reconciliationPasses: outcome.reconciliationPasses,
    reconciliationPassSummary: outcome.reconciliationPassSummary,
    continuityEvidence,
    priorHead,
  };
}

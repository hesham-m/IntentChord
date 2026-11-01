import { randomUUID } from "node:crypto";
import { hostname, platform } from "node:os";
import path from "node:path";
import {
  finalizeWorkspaceIndexContract,
  sha256Canonical,
  stableWorkspaceIndexId,
  workspaceSourceStateFingerprintFromFiles,
} from "@/core/workspace-index/canonical";
import { deriveWorkspaceIndexDelta } from "@/core/workspace-index/delta";
import {
  DEFAULT_WORKSPACE_INDEX_BUDGETS,
  captureWorkspaceFile,
  decodeCapturedTextForIndexing,
  inventoryWorkspaceFiles,
  WorkspaceIndexBoundedError,
  WORKSPACE_TRAVERSAL_POLICY_ID,
  type FilesystemInventoryEntry,
  type WorkspaceProgressEvidence,
} from "@/core/workspace-index/adapters/filesystem";
import {
  DEFAULT_WORKSPACE_DURATION_GOVERNANCE,
  deriveWorkspaceProcessingDurationBudget,
  workspaceAbsoluteOperationDeadlineAt,
  workspaceDurationConfigurationIdentity,
  workspacePhaseDeadlineAt,
  type WorkspaceDurationGovernancePhase,
  type WorkspaceDurationPhaseAuthority,
  type WorkspaceProcessingDurationDecision,
} from "@/core/workspace-index/duration-governance";
import { createDefaultParserRegistry, resolveRelativeImportCandidate } from "@/core/workspace-index/parsers";
import { reportBoundedSecondaryDiagnostic } from "@/core/workspace-index/failure-diagnostics";
import { createWorkspaceFilesystemObjectAuthority } from "@/core/workspace-index/filesystem-object-authority";
import {
  CSV_BOUNDED_PROFILE_PARSER_ID,
  CSV_BOUNDED_PROFILE_PARSER_VERSION,
  profileCsvCapturedBytes,
  type CsvBoundedProfile,
} from "@/core/workspace-index/csv-profile";
import type { ParsedFactDraft } from "@/core/workspace-index/registries";
import {
  CANONICAL_WORKSPACE_INDEX_CONTRACT_TYPE,
  CANONICAL_WORKSPACE_INDEX_CONTRACT_VERSION,
  PARSER_REGISTRY_VERSION,
  RELATION_REGISTRY_VERSION,
  WORKSPACE_INDEXER_NAME,
  WORKSPACE_INDEXER_VERSION,
  type CanonicalWorkspaceIndexContract,
  type ContentReferenceRecord,
  type EvidenceRole,
  type ExtractionMethod,
  type FactType,
  type FileEncoding,
  type GitWorkspaceEnrichment,
  type SourceLocation,
  type WorkspaceFactRecord,
  type WorkspaceFileRecord,
  type WorkspaceIndexFailure,
  type WorkspaceIndexRequest,
  type WorkspaceIndexSnapshot,
  type WorkspaceRelationRecord,
} from "@/core/workspace-index/types";
import { deriveCoverageSummary, validateCanonicalWorkspaceIndexContract } from "@/core/workspace-index/validator";

const EMPTY_SNAPSHOT: WorkspaceIndexSnapshot = { files: [], facts: [], relations: [], content_references: [] };

type IndexedFileDraft = {
  inventory: FilesystemInventoryEntry;
  content_hash: string;
  metadata_hash: string;
  workspace_file_id: string;
  lineage_state: WorkspaceFileRecord["lineage_state"];
  previous_file_revision_id?: string;
  text?: string;
  encoding: FileEncoding;
  parse_status: WorkspaceFileRecord["parse_status"];
  coverage_stage: WorkspaceFileRecord["coverage_stage"];
  coverage_state: WorkspaceFileRecord["coverage_state"];
  parser_id?: string;
  parser_version?: string;
  parsed_facts: ParsedFactDraft[];
  captured_prefix: Buffer;
  captured_complete_file: boolean;
};

export class WorkspaceIndexingError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly diagnostics: string[] = [],
    public readonly evidence: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

function normalizedPath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//, "");
}

function evidenceHash(value: string): string {
  return `sha256:${sha256Canonical({ evidence: value })}`;
}

function fileMetadataHash(entry: FilesystemInventoryEntry): string {
  return `sha256:${sha256Canonical({
    relative_path: entry.relative_path,
    file_name: entry.file_name,
    file_kind: entry.file_kind,
    language: entry.language ?? null,
    size_bytes: entry.size_bytes,
    sensitivity_state: entry.sensitivity_state,
  })}`;
}

function nonBlockingFailure(input: {
  now: string;
  fileRevisionId?: string;
  stage: WorkspaceIndexFailure["stage"];
  type: string;
  code: string;
  message: string;
  extractorId?: string;
  extractorVersion?: string;
  recoverability?: WorkspaceIndexFailure["recoverability"];
  impact?: WorkspaceIndexFailure["impact"];
}): WorkspaceIndexFailure {
  return {
    failure_id: stableWorkspaceIndexId("wif", {
      fileRevisionId: input.fileRevisionId ?? null,
      stage: input.stage,
      code: input.code,
      message: input.message,
      now: input.now,
    }),
    ...(input.fileRevisionId ? { file_revision_id: input.fileRevisionId } : {}),
    stage: input.stage,
    failure_type: input.type,
    error_code: input.code,
    sanitized_message: input.message,
    ...(input.extractorId ? { extractor_id: input.extractorId } : {}),
    ...(input.extractorVersion ? { extractor_version: input.extractorVersion } : {}),
    occurred_at: input.now,
    recoverability: input.recoverability ?? "REQUIRES_PARSER_SUPPORT",
    impact: input.impact ?? "LOCAL",
  };
}

function boundedError(error: unknown, timeoutEvidence?: () => Record<string, unknown>): WorkspaceIndexingError | undefined {
  if (!(error instanceof WorkspaceIndexBoundedError)) return undefined;
  const evidence = error.code === "WORKSPACE_INDEX_TIMEOUT" && timeoutEvidence ? timeoutEvidence() : error.evidence;
  return new WorkspaceIndexingError(
    error.code,
    error.code,
    Object.entries(evidence).map(([key, value]) => `${key}=${String(value)}`),
    evidence,
  );
}

function csvProfileFact(entry: FilesystemInventoryEntry, profile: CsvBoundedProfile): ParsedFactDraft {
  return {
    fact_type: "DOCUMENTATION",
    qualified_name: `${entry.relative_path}#bounded-csv-profile`,
    display_name: `${entry.file_name} bounded CSV profile`,
    attributes: {
      profile_scope: profile.sample_complete_file ? "FULL_FILE" : "BOUNDED_PREFIX_SAMPLE",
      file_size_bytes: profile.file_size_bytes,
      sample_limit_bytes: profile.sample_limit_bytes,
      sample_bytes_read: profile.sample_bytes_read,
      sample_complete_file: profile.sample_complete_file,
      sample_complete_record_count: profile.sample_complete_record_count,
      ...(profile.exact_record_count !== undefined ? { exact_record_count: profile.exact_record_count } : {}),
      ...(profile.header_column_count !== undefined ? { header_column_count: profile.header_column_count } : {}),
      ...(profile.header_columns ? { header_columns_json: JSON.stringify(profile.header_columns) } : {}),
      quoted_fields_observed: profile.quoted_fields_observed,
      quoted_commas_observed: profile.quoted_commas_observed,
      embedded_newlines_observed: profile.embedded_newlines_observed,
      malformed_quote_observed: profile.malformed_quote_observed,
      record_exceeds_sample_limit: profile.record_exceeds_sample_limit,
      row_count_scope: profile.sample_complete_file ? "EXACT_FULL_FILE" : "SAMPLE_COMPLETE_RECORDS_ONLY",
    },
    source_location: {
      byte_range: { start: 0, end: profile.sample_bytes_read },
      normalized_signature: `bounded-csv-profile:${entry.relative_path}:${profile.sample_bytes_read}`,
    },
    extraction_method: "PARSER_EXACT",
    certainty: "EXACT",
    evidence_role: "SIGNAL_ONLY",
    evidence_text: `csv-profile:${entry.relative_path}:sample-bytes=${profile.sample_bytes_read}:complete-records=${profile.sample_complete_record_count}`,
  };
}

function previousFileContinuity(input: {
  entry: FilesystemInventoryEntry;
  contentHash: string;
  metadataHash: string;
  request: WorkspaceIndexRequest;
}): Pick<IndexedFileDraft, "workspace_file_id" | "lineage_state" | "previous_file_revision_id"> {
  const previous = input.request.previous_contract;
  const relative = normalizedPath(input.entry.relative_path);
  if (previous) {
    const samePath = previous.snapshot.files.find(file => file.relative_path === relative);
    if (samePath) {
      return { workspace_file_id: samePath.workspace_file_id, lineage_state: "CONTINUED", previous_file_revision_id: samePath.file_revision_id };
    }
    const provenRename = input.request.git_enrichment?.rename_hints.find(hint => hint.confidence === "PROVEN" && normalizedPath(hint.to_relative_path) === relative);
    if (provenRename) {
      const prior = previous.snapshot.files.find(file => file.relative_path === normalizedPath(provenRename.from_relative_path));
      if (prior) return { workspace_file_id: prior.workspace_file_id, lineage_state: "RENAMED_OR_MOVED", previous_file_revision_id: prior.file_revision_id };
    }
  }
  return {
    workspace_file_id: stableWorkspaceIndexId("wfi", {
      workspace_instance_id: input.request.workspace_instance_id,
      relative_path: relative,
      content_hash: input.contentHash,
      metadata_hash: input.metadataHash,
    }),
    lineage_state: "NEW",
  };
}

function contentAvailability(file: IndexedFileDraft): ContentReferenceRecord["availability_state"] {
  if (file.inventory.sensitivity_state !== "NORMAL") return "RESTRICTED";
  if (file.encoding === "BINARY") return "BINARY";
  if (file.parse_status === "METADATA_ONLY") return "METADATA_ONLY";
  if (file.parse_status === "FAILED") return "UNREADABLE";
  return "AVAILABLE";
}

function previousFactIdentity(input: {
  previous?: CanonicalWorkspaceIndexContract;
  currentWorkspaceFileId: string;
  draft: ParsedFactDraft;
  occurrenceOrdinal: number;
}): string | undefined {
  if (!input.previous) return undefined;
  const previousFiles = new Map(input.previous.snapshot.files.map(file => [file.file_revision_id, file]));
  const signature = input.draft.source_location.normalized_signature ?? input.draft.qualified_name;
  const candidates = input.previous.snapshot.facts
    .filter(fact => {
      const source = previousFiles.get(fact.source_file_revision_id);
      const previousSignature = fact.source_location.normalized_signature ?? fact.qualified_name;
      return source?.workspace_file_id === input.currentWorkspaceFileId
        && fact.fact_type === input.draft.fact_type
        && previousSignature === signature;
    })
    .sort((left, right) => {
      const leftOffset = left.source_location.byte_range?.start ?? left.source_location.line_range?.start ?? Number.MAX_SAFE_INTEGER;
      const rightOffset = right.source_location.byte_range?.start ?? right.source_location.line_range?.start ?? Number.MAX_SAFE_INTEGER;
      return leftOffset - rightOffset || left.fact_revision_id.localeCompare(right.fact_revision_id);
    });
  return candidates[input.occurrenceOrdinal]?.workspace_fact_id;
}

function createFactRecord(input: {
  draft: ParsedFactDraft;
  file: WorkspaceFileRecord;
  workspaceRevisionId: string;
  workspaceInstanceId: string;
  extractorId: string;
  extractorVersion: string;
  occurrenceOrdinal: number;
  previous?: CanonicalWorkspaceIndexContract;
}): WorkspaceFactRecord {
  const workspaceFactId = previousFactIdentity({
    previous: input.previous,
    currentWorkspaceFileId: input.file.workspace_file_id,
    draft: input.draft,
    occurrenceOrdinal: input.occurrenceOrdinal,
  })
    ?? stableWorkspaceIndexId("wfa", {
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

function relationRecord(input: {
  workspaceInstanceId: string;
  workspaceRevisionId: string;
  relationType: WorkspaceRelationRecord["relation_type"];
  sourceLogicalId: string;
  targetLogicalId: string;
  sourceRevisionId: string;
  targetRevisionId: string;
  sourceType: "FILE" | "FACT";
  targetType: "FILE" | "FACT";
  evidenceFileRevisionId: string;
  sourceLocation: SourceLocation;
  evidenceText: string;
  extractorId: string;
  extractorVersion: string;
  extractionMethod: ExtractionMethod;
  evidenceRole: EvidenceRole;
  certainty: WorkspaceRelationRecord["certainty"];
  attributes?: Record<string, string | number | boolean | null>;
}): WorkspaceRelationRecord {
  const relationId = stableWorkspaceIndexId("wre", {
    workspace_instance_id: input.workspaceInstanceId,
    relation_type: input.relationType,
    source_logical_id: input.sourceLogicalId,
    target_logical_id: input.targetLogicalId,
  });
  const relationRevisionId = stableWorkspaceIndexId("rer", {
    workspace_revision_id: input.workspaceRevisionId,
    workspace_relation_id: relationId,
    source_revision_id: input.sourceRevisionId,
    target_revision_id: input.targetRevisionId,
    attributes: input.attributes ?? {},
  });
  return {
    workspace_relation_id: relationId,
    relation_revision_id: relationRevisionId,
    relation_type: input.relationType,
    source: { entity_type: input.sourceType, entity_revision_id: input.sourceRevisionId },
    target: { entity_type: input.targetType, entity_revision_id: input.targetRevisionId },
    direction: "DIRECTED",
    attributes: input.attributes ?? {},
    evidence_refs: [{
      file_revision_id: input.evidenceFileRevisionId,
      source_location: input.sourceLocation,
      evidence_hash: evidenceHash(input.evidenceText),
      extractor_id: input.extractorId,
      extractor_version: input.extractorVersion,
    }],
    extraction_method: input.extractionMethod,
    extractor_id: input.extractorId,
    extractor_version: input.extractorVersion,
    certainty: input.certainty,
    evidence_role: input.evidenceRole,
  };
}

function mergeDuplicateRelations(relations: WorkspaceRelationRecord[], workspaceRevisionId: string): WorkspaceRelationRecord[] {
  const map = new Map<string, WorkspaceRelationRecord>();
  for (const relation of relations) {
    const existing = map.get(relation.workspace_relation_id);
    if (!existing) {
      map.set(relation.workspace_relation_id, relation);
      continue;
    }
    const refs = [...existing.evidence_refs, ...relation.evidence_refs];
    const unique = new Map(refs.map(ref => [`${ref.file_revision_id}|${ref.evidence_hash}|${JSON.stringify(ref.source_location)}`, ref]));
    map.set(relation.workspace_relation_id, {
      ...existing,
      evidence_refs: [...unique.values()],
      relation_revision_id: stableWorkspaceIndexId("rer", {
        workspace_revision_id: workspaceRevisionId,
        workspace_relation_id: relation.workspace_relation_id,
        evidence_hashes: [...unique.values()].map(ref => ref.evidence_hash).sort(),
      }),
    });
  }
  return [...map.values()];
}

function factTypeCounts(facts: WorkspaceFactRecord[]): Partial<Record<FactType, number>> {
  const counts: Partial<Record<FactType, number>> = {};
  for (const fact of facts) counts[fact.fact_type] = (counts[fact.fact_type] ?? 0) + 1;
  return counts;
}

export async function indexWorkspace(request: WorkspaceIndexRequest): Promise<CanonicalWorkspaceIndexContract> {
  if (!request.workspace_instance_id.trim()) throw new WorkspaceIndexingError("WORKSPACE_INSTANCE_ID_REQUIRED", "A governing Workspace instance ID is required.");
  if (request.previous_contract && request.previous_contract.workspace.workspace_instance_id !== request.workspace_instance_id) {
    throw new WorkspaceIndexingError("PREVIOUS_WORKSPACE_INSTANCE_MISMATCH", "The previous Contract belongs to another Workspace instance.");
  }
  const wallClock = () => new Date().toISOString();
  const terminalNow = request.now ?? wallClock;
  const startedAt = request.started_at ?? wallClock();
  const failureOccurredAt = request.failure_now ?? (request.completed_at ? () => request.completed_at! : wallClock);
  const indexingSessionId = request.indexing_session_id ?? `wis_${randomUUID()}`;
  const maxParseBytes = request.max_parse_bytes ?? 2 * 1024 * 1024;
  const budgets = { ...DEFAULT_WORKSPACE_INDEX_BUDGETS, ...request.budgets };
  const durationGovernance = request.duration_policy ?? DEFAULT_WORKSPACE_DURATION_GOVERNANCE;
  const attemptStartedAtMs = request.attempt_started_at_ms ?? Date.now();
  const absoluteOperationDeadlineAt = workspaceAbsoluteOperationDeadlineAt(attemptStartedAtMs, durationGovernance);
  let governancePhase: WorkspaceDurationGovernancePhase = "DISCOVERY";
  let phaseStartedAtMs = Date.now();
  let phaseBudgetMs = durationGovernance.discoveryMaxMs;
  let phaseDeadlineAt = workspacePhaseDeadlineAt({ phaseStartedAtMs, phaseBudgetMs, absoluteOperationDeadlineAt });
  let processingDurationDecision: WorkspaceProcessingDurationDecision | undefined;
  let currentProcessingRelativePath: string | undefined;
  const progress: WorkspaceProgressEvidence = { phase: "DISCOVERING", discoveredFiles: 0, discoveredBytes: 0, hashedFiles: 0, hashedBytes: 0, parsedFiles: 0, aggregateRetainedTextBytes: 0, csvSampledBytes: 0, excludedTrees: 0, elapsedMs: 0 };
  const durationEvidence = (now = Date.now()) => ({
    durationPolicyId: durationGovernance.durationPolicyId,
    governancePhase,
    ...(processingDurationDecision ? {
      byteAllowanceMs: processingDurationDecision.byteAllowanceMs,
      fileAllowanceMs: processingDurationDecision.fileAllowanceMs,
      rawProcessingBudgetMs: processingDurationDecision.rawProcessingBudgetMs,
      derivedProcessingBudgetMs: processingDurationDecision.derivedProcessingBudgetMs,
    } : {}),
    phaseElapsedMs: Math.max(0, now - phaseStartedAtMs),
    phaseBudgetMs,
    absoluteOperationMaxMs: durationGovernance.absoluteOperationMaxMs,
    absoluteElapsedMs: Math.max(0, now - attemptStartedAtMs),
  });
  const timeoutEvidence = (detailedPhase: WorkspaceProgressEvidence["phase"], now = Date.now()): Record<string, unknown> => ({
    durationPolicyId: durationGovernance.durationPolicyId,
    currentGovernancePhase: governancePhase,
    detailedProgressPhase: detailedPhase,
    elapsedAttemptDurationMs: Math.max(0, now - attemptStartedAtMs),
    phaseElapsedDurationMs: Math.max(0, now - phaseStartedAtMs),
    phaseBudgetMs,
    absoluteElapsedDurationMs: Math.max(0, now - attemptStartedAtMs),
    absoluteOperationMaxMs: durationGovernance.absoluteOperationMaxMs,
    ...(processingDurationDecision ? {
      discoveredFiles: processingDurationDecision.discoveredFiles,
      discoveredBytes: processingDurationDecision.discoveredBytes,
      hashedFiles: progress.hashedFiles,
      hashedBytes: progress.hashedBytes,
      parsedFiles: progress.parsedFiles,
      remainingFilesAtTimeout: Math.max(0, processingDurationDecision.discoveredFiles - progress.hashedFiles),
      remainingBytesAtTimeout: Math.max(0, processingDurationDecision.discoveredBytes - progress.hashedBytes),
      byteAllowanceMs: processingDurationDecision.byteAllowanceMs,
      fileAllowanceMs: processingDurationDecision.fileAllowanceMs,
      rawProcessingBudgetMs: processingDurationDecision.rawProcessingBudgetMs,
      derivedProcessingBudgetMs: processingDurationDecision.derivedProcessingBudgetMs,
      aggregateRetainedTextBytes: progress.aggregateRetainedTextBytes,
      csvSampledBytes: progress.csvSampledBytes,
      ...(currentProcessingRelativePath ? { currentProcessingRelativePath } : {}),
    } : {}),
  });
  const timeoutDiagnostics = (detailedPhase: WorkspaceProgressEvidence["phase"], now = Date.now()) =>
    Object.entries(timeoutEvidence(detailedPhase, now)).map(([key, value]) => `${key}=${String(value)}`);
  const reportProgress = (next: WorkspaceProgressEvidence) => {
    const now = Date.now();
    Object.assign(progress, next, { elapsedMs: Math.max(0, now - attemptStartedAtMs) }, durationEvidence(now));
    request.on_progress?.({ ...progress });
  };
  const currentPhaseAuthority = (): WorkspaceDurationPhaseAuthority => ({
    durationPolicyId: durationGovernance.durationPolicyId,
    governancePhase,
    phaseStartedAtMs,
    phaseBudgetMs,
    phaseDeadlineAt,
    absoluteOperationDeadlineAt,
  });
  const publishPhaseAuthority = () => request.on_duration_phase_authority?.(currentPhaseAuthority());
  const beginGovernancePhase = (phase: WorkspaceDurationGovernancePhase, budgetMs: number) => {
    governancePhase = phase;
    phaseStartedAtMs = Date.now();
    phaseBudgetMs = budgetMs;
    phaseDeadlineAt = workspacePhaseDeadlineAt({ phaseStartedAtMs, phaseBudgetMs, absoluteOperationDeadlineAt });
    publishPhaseAuthority();
    const now = Date.now();
    Object.assign(progress, { elapsedMs: Math.max(0, now - attemptStartedAtMs) }, durationEvidence(now));
    request.on_progress?.({ ...progress });
  };
  const terminalGovernanceError = (phase: WorkspaceProgressEvidence["phase"], now = Date.now()): WorkspaceIndexingError | undefined => {
    if (request.signal?.aborted) {
      return new WorkspaceIndexingError(
        "WORKSPACE_INDEX_ABORTED",
        "The Workspace Index operation was aborted.",
        [`governancePhase=${governancePhase}`, `detailedProgressPhase=${phase}`],
      );
    }
    if (now >= phaseDeadlineAt || now >= absoluteOperationDeadlineAt) {
      return new WorkspaceIndexingError(
        "WORKSPACE_INDEX_TIMEOUT",
        "The Workspace Index operation exceeded its governed duration budget.",
        timeoutDiagnostics(phase, now),
        timeoutEvidence(phase, now),
      );
    }
    return undefined;
  };
  const checkpoint = (phase: WorkspaceProgressEvidence["phase"]) => {
    const now = Date.now();
    progress.phase = phase;
    progress.elapsedMs = Math.max(0, now - attemptStartedAtMs);
    Object.assign(progress, durationEvidence(now));
    const terminal = terminalGovernanceError(phase, now);
    if (terminal) throw terminal;
    request.on_progress?.({ ...progress });
  };
  const retainAggregateText = (bytes: number, relativePath: string, source: "FULL_TEXT" | "CSV_SAMPLE") => {
    const next = progress.aggregateRetainedTextBytes + bytes;
    if (next > budgets.maxAggregateRetainedTextBytes) {
      throw new WorkspaceIndexingError(
        "WORKSPACE_INDEX_AGGREGATE_TEXT_BUDGET_EXCEEDED",
        "The governed aggregate retained-text budget was exceeded.",
        [
          `file=${relativePath}`,
          `source=${source}`,
          `retainedTextBytesBefore=${progress.aggregateRetainedTextBytes}`,
          `nextRetainedTextBytes=${bytes}`,
          `maxAggregateRetainedTextBytes=${budgets.maxAggregateRetainedTextBytes}`,
        ],
      );
    }
    progress.aggregateRetainedTextBytes = next;
    if (source === "CSV_SAMPLE") progress.csvSampledBytes += bytes;
    request.on_progress?.({ ...progress, elapsedMs: Math.max(0, Date.now() - attemptStartedAtMs), ...durationEvidence() });
  };
  const objectAuthority = request.filesystem_object_authority_factory?.() ?? createWorkspaceFilesystemObjectAuthority();
  publishPhaseAuthority();
  let indexWorkspaceResult: CanonicalWorkspaceIndexContract | undefined;
  let indexWorkspacePrimaryError: unknown;
  try {
  let inventory;
  try {
    checkpoint("DISCOVERING");
    inventory = await inventoryWorkspaceFiles(request.root_path, request.owner_restricted_paths, failureOccurredAt, { budgets, signal: request.signal, onProgress: reportProgress, startedAtMs: phaseStartedAtMs, deadlineAt: phaseDeadlineAt, beforeDirectoryOpen: request.inventory_before_directory_open, objectAuthority, expectedRoot: request.authorized_root_identity ? { realPath: request.authorized_root_identity.real_path, identity: request.authorized_root_identity.identity } : undefined });
  } catch (error) {
    const bounded = boundedError(error, () => timeoutEvidence(progress.phase));
    if (bounded) throw bounded;
    throw error;
  }
  progress.discoveredFiles = inventory.totals.discovered_files; progress.discoveredBytes = inventory.totals.discovered_bytes; progress.excludedTrees = inventory.excluded_boundaries.length;
  const parserRegistry = createDefaultParserRegistry();
  const failures: WorkspaceIndexFailure[] = [...inventory.failures];
  const incompleteInventoryFailures = inventory.failures.filter(failure => failure.impact === "REVISION_INCOMPLETE");
  if (incompleteInventoryFailures.length) {
    throw new WorkspaceIndexingError(
      "WORKSPACE_SOURCE_STATE_INCOMPLETE",
      "The governed Workspace Source State could not be completely enumerated; no canonical Workspace Revision may be minted from a partial subset.",
      incompleteInventoryFailures.map(failure => failure.error_code),
    );
  }
  processingDurationDecision = deriveWorkspaceProcessingDurationBudget({ discoveredBytes: progress.discoveredBytes, discoveredFiles: progress.discoveredFiles }, durationGovernance);
  beginGovernancePhase("PROCESSING", processingDurationDecision.derivedProcessingBudgetMs);
  const drafts: IndexedFileDraft[] = [];

  checkpoint("HASHING");
  for (const entry of inventory.files) {
    currentProcessingRelativePath = Array.from(entry.relative_path).slice(0, 512).join("");
    checkpoint("HASHING");
    if (progress.hashedFiles + 1 > budgets.maxHashedFiles || progress.hashedBytes + entry.size_bytes > budgets.maxHashedBytes) {
      throw new WorkspaceIndexingError("WORKSPACE_INDEX_HASH_BUDGET_EXCEEDED", "The Workspace Index hashing budget was exceeded.", [`hashedFiles=${progress.hashedFiles}`, `hashedBytes=${progress.hashedBytes}`, `nextFileBytes=${entry.size_bytes}`]);
    }
    let captured;
    try {
      let streamedBytes = 0;
      const maxPrefixBytes = entry.sensitivity_state !== "NORMAL" || entry.file_kind === "BINARY"
        ? 0
        : entry.file_kind === "CSV"
          ? budgets.maxCsvSampleBytes
          : Math.min(maxParseBytes + 1, budgets.maxRetainedTextBytesPerFile + 1);
      captured = await captureWorkspaceFile(entry.absolute_path, {
        maxPrefixBytes,
        signal: request.signal,
        deadlineAt: phaseDeadlineAt,
        maxBytes: budgets.maxHashedBytes - progress.hashedBytes,
        byteBudgetCode: "WORKSPACE_INDEX_HASH_BUDGET_EXCEEDED",
        streamFactory: request.capture_stream_factory,
        authorizedRootPath: entry.authorized_root_reference_path,
        authorizedRootRealPath: entry.authorized_root_real_path,
        authorizedRootIdentity: entry.authorized_root_identity,
        relativePath: entry.relative_path,
        expectedDeviceId: entry.device_id,
        expectedInode: entry.inode,
        expectedProofMethod: entry.object_identity_proof_method,
        expectedSizeBytes: entry.size_bytes,
        beforeOpen: request.capture_before_open,
        objectAuthority,
        onBytes: bytes => {
          streamedBytes += bytes;
          if (progress.hashedBytes + streamedBytes > budgets.maxHashedBytes) {
            throw new WorkspaceIndexBoundedError("WORKSPACE_INDEX_HASH_BUDGET_EXCEEDED", { hashedBytes: progress.hashedBytes + streamedBytes, maxHashedBytes: budgets.maxHashedBytes });
          }
        },
      });
      progress.hashedFiles += 1; progress.hashedBytes += streamedBytes; request.on_progress?.({ ...progress, elapsedMs: Math.max(0, Date.now() - attemptStartedAtMs), ...durationEvidence() });
    } catch (error) {
      // Terminal runtime governance is authoritative over helper/pipe/source classification.
      // A transport failure observed at the governed deadline edge must persist as TIMEOUT,
      // while a caller AbortSignal remains terminal even if source evidence also changed.
      const terminal = terminalGovernanceError(progress.phase, Date.now());
      if (terminal) throw terminal;
      if (error instanceof WorkspaceIndexBoundedError && (error.evidence.phase === "SOURCE_BOUNDARY" || error.evidence.phase === "SOURCE_AUTHORITY")) {
        throw new WorkspaceIndexingError(
          "WORKSPACE_SOURCE_STATE_INCOMPLETE",
          `Governed Source boundary changed while ${entry.relative_path} was being captured; no canonical Workspace Revision may be minted from a compromised source read.`,
          ["SOURCE_CAPTURE_FAILED", entry.relative_path, error.code],
        );
      }
      const bounded = boundedError(error, () => timeoutEvidence(progress.phase));
      if (bounded) throw bounded;
      throw new WorkspaceIndexingError(
        "WORKSPACE_SOURCE_STATE_INCOMPLETE",
        `Governed capture failed for ${entry.relative_path}; no canonical Workspace Revision may be minted from a partial source subset.`,
        ["FILE_CAPTURE_FAILED", entry.relative_path],
      );
    }
    if (captured.bytes_read !== entry.size_bytes) {
      throw new WorkspaceIndexingError(
        "WORKSPACE_SOURCE_STATE_CHANGED_DURING_CAPTURE",
        `Governed Source State changed while ${entry.relative_path} was being captured.`,
        [`inventory_bytes=${entry.size_bytes}`, `captured_bytes=${captured.bytes_read}`],
      );
    }
    const capturedEntry = entry;
    const contentHash = captured.content_hash;
    const metadataHash = fileMetadataHash(capturedEntry);
    const continuity = previousFileContinuity({ entry: capturedEntry, contentHash, metadataHash, request });
    const draft: IndexedFileDraft = {
      inventory: capturedEntry,
      content_hash: contentHash,
      metadata_hash: metadataHash,
      ...continuity,
      encoding: "UNKNOWN",
      parse_status: "UNSUPPORTED",
      coverage_stage: "METADATA_INDEXED",
      coverage_state: "UNSUPPORTED",
      parsed_facts: [],
      captured_prefix: captured.prefix_bytes,
      captured_complete_file: captured.prefix_complete_file,
    };

    if (entry.sensitivity_state !== "NORMAL") {
      draft.parse_status = "RESTRICTED";
      draft.coverage_state = "RESTRICTED";
      failures.push(nonBlockingFailure({ now: failureOccurredAt(), stage: "CONTENT_READ", type: "SENSITIVITY_BOUNDARY", code: "SENSITIVE_CONTENT_RESTRICTED", message: `Content parsing was denied by default for ${entry.relative_path}.`, impact: "LOCAL", recoverability: "REQUIRES_OWNER_PERMISSION" }));
      drafts.push(draft);
      continue;
    }

    checkpoint("PARSING");

    if (draft.inventory.file_kind === "CSV") {
      const exceedsPerFileLimit = draft.inventory.size_bytes > budgets.maxRetainedTextBytesPerFile;
      let profile: CsvBoundedProfile;
      try {
        profile = profileCsvCapturedBytes({
          bytes: draft.captured_prefix,
          fileSizeBytes: draft.inventory.size_bytes,
          maxSampleBytes: budgets.maxCsvSampleBytes,
          completeFile: draft.captured_complete_file,
        });
      } catch (error) {
        const bounded = boundedError(error, () => timeoutEvidence(progress.phase));
        if (bounded) throw bounded;
        draft.parse_status = "METADATA_ONLY";
        draft.coverage_state = "METADATA_ONLY";
        failures.push(nonBlockingFailure({
          now: failureOccurredAt(),
          stage: "CONTENT_READ",
          type: "CSV_PROFILE_READ",
          code: "CSV_PROFILE_READ_FAILED",
          message: `The bounded CSV profile could not be read for ${entry.relative_path}; the file remains represented by its full-file hash and metadata.`,
          impact: "CONTEXT_DEGRADING",
          recoverability: "RETRYABLE",
        }));
        drafts.push(draft);
        continue;
      }

      retainAggregateText(profile.sample_bytes_read, entry.relative_path, "CSV_SAMPLE");
      draft.encoding = profile.encoding;
      draft.parser_id = CSV_BOUNDED_PROFILE_PARSER_ID;
      draft.parser_version = CSV_BOUNDED_PROFILE_PARSER_VERSION;
      draft.parsed_facts = [csvProfileFact(entry, profile)];
      draft.coverage_stage = "FACTS_EXTRACTED";
      progress.parsedFiles += 1;

      if (exceedsPerFileLimit) {
        draft.parse_status = "METADATA_ONLY";
        draft.coverage_state = "PARTIAL";
        failures.push(nonBlockingFailure({
          now: failureOccurredAt(),
          stage: "CONTENT_READ",
          type: "PER_FILE_RETAINED_TEXT_BOUNDARY",
          code: "FILE_EXCEEDS_PER_FILE_RETAINED_TEXT_LIMIT",
          message: `File ${entry.relative_path} exceeded the per-file retained-text limit; its full SHA-256 and metadata were retained with bounded CSV sample evidence.`,
          impact: "LOCAL",
          recoverability: "PERMANENT_FOR_THIS_REVISION",
        }));
      } else if (profile.sample_complete_file && !profile.malformed_quote_observed) {
        draft.parse_status = "PARSED";
        draft.coverage_state = "COMPLETE";
      } else {
        draft.parse_status = "PARSED";
        draft.coverage_state = "PARTIAL";
      }

      for (const diagnostic of profile.diagnostics) {
        failures.push(nonBlockingFailure({
          now: failureOccurredAt(),
          stage: "PARSING",
          type: "CSV_PROFILE_DIAGNOSTIC",
          code: diagnostic.code,
          message: `${entry.relative_path}: ${diagnostic.message}`,
          extractorId: CSV_BOUNDED_PROFILE_PARSER_ID,
          extractorVersion: CSV_BOUNDED_PROFILE_PARSER_VERSION,
          impact: diagnostic.code === "CSV_MALFORMED_QUOTE" ? "CONTEXT_DEGRADING" : "LOCAL",
          recoverability: "PERMANENT_FOR_THIS_REVISION",
        }));
      }
      drafts.push(draft);
      continue;
    }

    if (draft.inventory.size_bytes > budgets.maxRetainedTextBytesPerFile) {
      draft.parse_status = "METADATA_ONLY";
      draft.coverage_state = "METADATA_ONLY";
      failures.push(nonBlockingFailure({
        now: failureOccurredAt(),
        stage: "CONTENT_READ",
        type: "PER_FILE_RETAINED_TEXT_BOUNDARY",
        code: "FILE_EXCEEDS_PER_FILE_RETAINED_TEXT_LIMIT",
        message: `File ${entry.relative_path} exceeded the per-file retained-text limit and remains represented by its full-file hash and metadata.`,
        impact: "LOCAL",
        recoverability: "PERMANENT_FOR_THIS_REVISION",
      }));
      drafts.push(draft);
      continue;
    }

    let read;
    try {
      read = decodeCapturedTextForIndexing(draft.inventory, {
        content_hash: draft.content_hash,
        bytes_read: draft.inventory.size_bytes,
        prefix_bytes: draft.captured_prefix,
        prefix_complete_file: draft.captured_complete_file,
      }, maxParseBytes);
    } catch (error) {
      const bounded = boundedError(error, () => timeoutEvidence(progress.phase));
      if (bounded) throw bounded;
      draft.parse_status = "FAILED";
      draft.coverage_state = "FAILED";
      failures.push(nonBlockingFailure({ now: failureOccurredAt(), stage: "CONTENT_READ", type: "CONTENT_READ", code: "FILE_CONTENT_READ_FAILED", message: `Content could not be read for ${entry.relative_path}.`, impact: "CONTEXT_DEGRADING", recoverability: "RETRYABLE" }));
      drafts.push(draft);
      continue;
    }
    draft.encoding = read.encoding;
    if (read.binary) {
      draft.parse_status = "UNSUPPORTED";
      draft.coverage_state = "UNSUPPORTED";
      failures.push(nonBlockingFailure({ now: failureOccurredAt(), stage: "PARSING", type: "UNSUPPORTED_BINARY", code: "BINARY_DEEP_PARSE_UNSUPPORTED", message: `Binary file ${entry.relative_path} remains in inventory without deep parsing.`, impact: "LOCAL" }));
      drafts.push(draft);
      continue;
    }
    if (read.tooLarge) {
      draft.parse_status = "METADATA_ONLY";
      draft.coverage_state = "METADATA_ONLY";
      failures.push(nonBlockingFailure({ now: failureOccurredAt(), stage: "CONTENT_READ", type: "DEEP_PARSE_LIMIT", code: "FILE_EXCEEDS_DEEP_PARSE_LIMIT", message: `File ${entry.relative_path} was hashed by streaming and retained as metadata-only because it exceeds the deep-parser byte limit.`, impact: "LOCAL" }));
      drafts.push(draft);
      continue;
    }
    const parsedText = read.content ?? "";
    const parsedTextBytes = Buffer.byteLength(parsedText, "utf8");
    if (parsedTextBytes > budgets.maxRetainedTextBytesPerFile) {
      draft.parse_status = "METADATA_ONLY";
      draft.coverage_state = "METADATA_ONLY";
      failures.push(nonBlockingFailure({
        now: failureOccurredAt(),
        stage: "DECODING",
        type: "PER_FILE_RETAINED_TEXT_BOUNDARY",
        code: "DECODED_TEXT_EXCEEDS_PER_FILE_RETAINED_TEXT_LIMIT",
        message: `Decoded text for ${entry.relative_path} exceeded the per-file retained-text limit; only its hash and metadata were retained.`,
        impact: "LOCAL",
        recoverability: "PERMANENT_FOR_THIS_REVISION",
      }));
      drafts.push(draft);
      continue;
    }
    retainAggregateText(parsedTextBytes, entry.relative_path, "FULL_TEXT");
    draft.coverage_stage = "CONTENT_READABLE";
    const parser = parserRegistry.resolve({ relative_path: entry.relative_path, file_name: entry.file_name, file_kind: entry.file_kind, language: entry.language });
    if (!parser) {
      draft.parse_status = "UNSUPPORTED";
      draft.coverage_state = "UNSUPPORTED";
      failures.push(nonBlockingFailure({ now: failureOccurredAt(), stage: "PARSING", type: "PARSER_SUPPORT", code: "NO_REGISTERED_PARSER", message: `No registered parser supports ${entry.relative_path}.`, impact: "LOCAL" }));
      drafts.push(draft);
      continue;
    }
    try {
      const parsed = parser.parse({ relative_path: entry.relative_path, file_name: entry.file_name, file_kind: entry.file_kind, language: entry.language, content: parsedText });
      draft.parser_id = parser.parser_id;
      draft.parser_version = parser.parser_version;
      draft.parsed_facts = parsed.facts;
      draft.parse_status = "PARSED";
      draft.coverage_stage = parsed.facts.length ? "FACTS_EXTRACTED" : "STRUCTURE_PARSED";
      draft.coverage_state = "COMPLETE";
      progress.parsedFiles += 1;
      for (const item of parsed.diagnostics) failures.push(nonBlockingFailure({ now: failureOccurredAt(), stage: "PARSING", type: "PARSER_DIAGNOSTIC", code: item.code, message: item.message, extractorId: parser.parser_id, extractorVersion: parser.parser_version }));
    } catch {
      draft.parser_id = parser.parser_id;
      draft.parser_version = parser.parser_version;
      draft.parse_status = "FAILED";
      draft.coverage_state = "FAILED";
      failures.push(nonBlockingFailure({ now: failureOccurredAt(), stage: "PARSING", type: "PARSER_FAILURE", code: "REGISTERED_PARSER_FAILED", message: `Registered parser failed for ${entry.relative_path}.`, extractorId: parser.parser_id, extractorVersion: parser.parser_version, impact: "CONTEXT_DEGRADING", recoverability: "RETRYABLE" }));
    }
    request.on_progress?.({ ...progress, elapsedMs: Math.max(0, Date.now() - attemptStartedAtMs), ...durationEvidence() });
    drafts.push(draft);
  }

  currentProcessingRelativePath = undefined;
  beginGovernancePhase("FINALIZATION", durationGovernance.finalizationMaxMs);
  checkpoint("ASSEMBLING");
  const treeFingerprint = workspaceSourceStateFingerprintFromFiles(drafts.map(draft => ({
    relative_path: draft.inventory.relative_path,
    size_bytes: draft.inventory.size_bytes,
    content_hash: draft.content_hash,
  })));
  const previousRevisionId = request.previous_contract?.workspace.workspace_revision_id ?? null;
  const workspaceRevisionId = stableWorkspaceIndexId("wsr", { workspace_instance_id: request.workspace_instance_id, workspace_tree_fingerprint: treeFingerprint });

  const files: WorkspaceFileRecord[] = drafts.map(draft => {
    const fileRevisionId = stableWorkspaceIndexId("fir", {
      workspace_revision_id: workspaceRevisionId,
      workspace_file_id: draft.workspace_file_id,
      content_hash: draft.content_hash,
      metadata_hash: draft.metadata_hash,
    });
    const contentRefId = stableWorkspaceIndexId("wcr", { workspace_instance_id: request.workspace_instance_id, workspace_file_id: draft.workspace_file_id });
    return {
      workspace_file_id: draft.workspace_file_id,
      file_revision_id: fileRevisionId,
      relative_path: draft.inventory.relative_path,
      file_name: draft.inventory.file_name,
      file_kind: draft.inventory.file_kind,
      ...(draft.inventory.language ? { language: draft.inventory.language } : {}),
      size_bytes: draft.inventory.size_bytes,
      content_hash: draft.content_hash,
      metadata_hash: draft.metadata_hash,
      encoding: draft.encoding,
      parse_status: draft.parse_status,
      sensitivity_state: draft.inventory.sensitivity_state,
      coverage_stage: draft.coverage_stage,
      coverage_state: draft.coverage_state,
      content_ref_id: contentRefId,
      lineage_state: draft.lineage_state,
      ...(draft.previous_file_revision_id ? { previous_file_revision_id: draft.previous_file_revision_id } : {}),
    };
  });
  const filesByPath = new Map(files.map(file => [file.relative_path, file]));
  const draftsByPath = new Map(drafts.map(draft => [draft.inventory.relative_path, draft]));

  const contentReferences: ContentReferenceRecord[] = files.map(file => {
    const draft = draftsByPath.get(file.relative_path)!;
    return {
      content_ref_id: file.content_ref_id!,
      file_revision_id: file.file_revision_id,
      content_hash: file.content_hash,
      content_kind: file.file_kind,
      media_type: draft.inventory.media_type,
      encoding: file.encoding,
      size_bytes: file.size_bytes,
      retrieval_ref: `workspace://${request.workspace_instance_id}/${encodeURI(file.relative_path)}`,
      sensitivity_class: file.sensitivity_state,
      availability_state: contentAvailability(draft),
      scope_type: "FULL_FILE",
    };
  });

  const facts: WorkspaceFactRecord[] = [];
  for (const file of files) {
    checkpoint("ASSEMBLING");
    const draft = draftsByPath.get(file.relative_path)!;
    if (!draft.parser_id || !draft.parser_version) continue;
    const occurrences = new Map<string, number>();
    for (const parsedFact of draft.parsed_facts) {
      const identitySignature = parsedFact.source_location.normalized_signature ?? parsedFact.qualified_name;
      const occurrenceKey = `${parsedFact.fact_type}|${identitySignature}`;
      const occurrenceOrdinal = occurrences.get(occurrenceKey) ?? 0;
      occurrences.set(occurrenceKey, occurrenceOrdinal + 1);
      facts.push(createFactRecord({
        draft: parsedFact,
        file,
        workspaceRevisionId,
        workspaceInstanceId: request.workspace_instance_id,
        extractorId: draft.parser_id,
        extractorVersion: draft.parser_version,
        occurrenceOrdinal,
        previous: request.previous_contract,
      }));
    }
  }

  const relations: WorkspaceRelationRecord[] = [];
  const fileByRevision = new Map(files.map(file => [file.file_revision_id, file]));
  for (const fact of facts) {
    checkpoint("ASSEMBLING");
    const sourceFile = fileByRevision.get(fact.source_file_revision_id)!;
    relations.push(relationRecord({
      workspaceInstanceId: request.workspace_instance_id,
      workspaceRevisionId,
      relationType: "DECLARES",
      sourceLogicalId: sourceFile.workspace_file_id,
      targetLogicalId: fact.workspace_fact_id,
      sourceRevisionId: sourceFile.file_revision_id,
      targetRevisionId: fact.fact_revision_id,
      sourceType: "FILE",
      targetType: "FACT",
      evidenceFileRevisionId: sourceFile.file_revision_id,
      sourceLocation: fact.source_location,
      evidenceText: fact.provenance.evidence_hash,
      extractorId: fact.extractor_id,
      extractorVersion: fact.extractor_version,
      extractionMethod: fact.extraction_method,
      evidenceRole: fact.evidence_role,
      certainty: fact.certainty,
    }));
  }

  const availablePaths = new Set(files.map(file => file.relative_path));
  for (const fact of facts.filter(item => item.fact_type === "IMPORT")) {
    checkpoint("ASSEMBLING");
    const sourceFile = fileByRevision.get(fact.source_file_revision_id)!;
    const specifier = typeof fact.attributes.specifier === "string" ? fact.attributes.specifier : undefined;
    if (!specifier) continue;
    const targetPath = resolveRelativeImportCandidate(sourceFile.relative_path, specifier, availablePaths);
    const targetFile = targetPath ? filesByPath.get(targetPath) : undefined;
    if (!targetFile) continue;
    relations.push(relationRecord({
      workspaceInstanceId: request.workspace_instance_id,
      workspaceRevisionId,
      relationType: "IMPORTS",
      sourceLogicalId: sourceFile.workspace_file_id,
      targetLogicalId: targetFile.workspace_file_id,
      sourceRevisionId: sourceFile.file_revision_id,
      targetRevisionId: targetFile.file_revision_id,
      sourceType: "FILE",
      targetType: "FILE",
      evidenceFileRevisionId: sourceFile.file_revision_id,
      sourceLocation: fact.source_location,
      evidenceText: fact.provenance.evidence_hash,
      extractorId: fact.extractor_id,
      extractorVersion: fact.extractor_version,
      extractionMethod: "TEXT_PATTERN",
      evidenceRole: "SIGNAL_ONLY",
      certainty: "DERIVED",
      attributes: { specifier },
    }));
  }

  for (const file of files.filter(item => /\.test\.[cm]?[jt]sx?$/.test(item.relative_path))) {
    checkpoint("ASSEMBLING");
    const targetPath = file.relative_path.replace(/\.test(\.[cm]?[jt]sx?)$/, "$1");
    const target = filesByPath.get(targetPath);
    if (!target) continue;
    relations.push(relationRecord({
      workspaceInstanceId: request.workspace_instance_id,
      workspaceRevisionId,
      relationType: "TESTS",
      sourceLogicalId: file.workspace_file_id,
      targetLogicalId: target.workspace_file_id,
      sourceRevisionId: file.file_revision_id,
      targetRevisionId: target.file_revision_id,
      sourceType: "FILE",
      targetType: "FILE",
      evidenceFileRevisionId: file.file_revision_id,
      sourceLocation: { normalized_signature: `test-file-name:${file.relative_path}` },
      evidenceText: file.relative_path,
      extractorId: "TEST_NAMING_RELATION_EXTRACTOR",
      extractorVersion: "1.0.0",
      extractionMethod: "HEURISTIC",
      evidenceRole: "SIGNAL_ONLY",
      certainty: "HEURISTIC",
    }));
  }

  const mergedRelations = mergeDuplicateRelations(relations, workspaceRevisionId);
  const relatedFileIds = new Set(mergedRelations.flatMap(relation => [relation.source.entity_revision_id, relation.target.entity_revision_id]));
  for (const file of files) {
    if (file.parse_status === "PARSED" && relatedFileIds.has(file.file_revision_id)) file.coverage_stage = "RELATIONS_RESOLVED";
  }

  const snapshot: WorkspaceIndexSnapshot = { files, facts, relations: mergedRelations, content_references: contentReferences };
  const coverage = deriveCoverageSummary(snapshot);
  checkpoint("VALIDATING");
  const sourceBindingId = request.source_binding_id ?? stableWorkspaceIndexId("sbi", {
    normalized_reference: inventory.root_path,
    device_name: hostname(),
    platform: platform(),
  });
  const git: GitWorkspaceEnrichment = request.git_enrichment ?? { rename_hints: [], diagnostics: [] };
  const contractStatus = failures.length || files.some(file => file.coverage_state !== "COMPLETE") ? "COMPLETE_WITH_GAPS" as const : "COMPLETE" as const;
  const buildTerminalCandidate = (completedAt: string): CanonicalWorkspaceIndexContract => {
    const baseWithoutIntegrityAndDelta = {
      contract_type: CANONICAL_WORKSPACE_INDEX_CONTRACT_TYPE,
      contract_version: CANONICAL_WORKSPACE_INDEX_CONTRACT_VERSION,
      contract_id: stableWorkspaceIndexId("cwi", { workspace_revision_id: workspaceRevisionId, contract_version: CANONICAL_WORKSPACE_INDEX_CONTRACT_VERSION }),
      contract_status: contractStatus,
      workspace: {
        workspace_instance_id: request.workspace_instance_id,
        workspace_revision_id: workspaceRevisionId,
        previous_revision_id: previousRevisionId,
        source_binding_id: sourceBindingId,
      },
      source_binding: {
        source_binding_id: sourceBindingId,
        binding_type: request.binding_type ?? "LOCAL_FILESYSTEM" as const,
        normalized_reference: inventory.root_path,
        device_name: hostname(),
        platform: platform(),
        ...(git.repository_identity ? { repository_identity: git.repository_identity } : {}),
        ...(git.branch ? { branch: git.branch } : {}),
        ...(git.commit_sha ? { commit_sha: git.commit_sha } : {}),
        metadata: {
          read_only: true,
          raw_content_embedded: false,
          git_required: false,
          parser_registry_entries: parserRegistry.entries().length,
          fact_count_by_type: factTypeCounts(facts),
          git_diagnostics: git.diagnostics,
          traversal_policy_id: WORKSPACE_TRAVERSAL_POLICY_ID,
          technical_excluded_boundaries: inventory.excluded_boundaries.filter(item => item.exclusion_reason === "TECHNICAL_GENERATED_TREE"),
          owner_restricted_boundaries: inventory.excluded_boundaries.filter(item => item.exclusion_reason === "OWNER_RESTRICTED_PATH"),
          governed_budgets: budgets,
          governed_budget_semantics: {
            per_file_retained_text_limit: "LOCAL_GAP_METADATA_ONLY",
            aggregate_retained_text_budget: "GLOBAL_FAIL_CLOSED_CUMULATIVE",
            csv_sample_limit: "BOUNDED_PREFIX_EVIDENCE_ONLY",
            hash_budgets: "GLOBAL_FAIL_CLOSED_STREAMING",
            operation_duration: "PHASED_DETERMINISTIC_WORKLOAD_AWARE_WITH_ABSOLUTE_CEILING",
            abort_handling: "GLOBAL_FAIL_CLOSED",
          },
          duration_governance: {
            policy: workspaceDurationConfigurationIdentity(durationGovernance),
            ...processingDurationDecision!,
          },
          csv_profile_policy: {
            parser_id: CSV_BOUNDED_PROFILE_PARSER_ID,
            parser_version: CSV_BOUNDED_PROFILE_PARSER_VERSION,
            exact_row_count_only_when_full_file_sampled: true,
            incomplete_boundary_record_counted: false,
            quoted_commas_supported: true,
            embedded_newlines_supported: true,
            original_file_identity_independent_from_profile_fact_identity: true,
          },
          inventory_totals: inventory.totals,
          capture_consistency: {
            model: "GOVERNED_ROLLING_FILE_REVISION_MANIFEST_V1",
            exact_file_revision_manifest: true,
            bounded_observation_interval: { started_at: startedAt, completed_at: completedAt },
            immutable_after_assembly: true,
            atomic_filesystem_snapshot_claimed: false,
          },
        },
      },
      generation: {
        indexing_session_id: indexingSessionId,
        indexer_name: WORKSPACE_INDEXER_NAME,
        indexer_version: WORKSPACE_INDEXER_VERSION,
        parser_registry_version: PARSER_REGISTRY_VERSION,
        relation_registry_version: RELATION_REGISTRY_VERSION,
        started_at: startedAt,
        completed_at: completedAt,
      },
      snapshot,
      coverage,
      failures,
    };
    const delta = deriveWorkspaceIndexDelta({
      base: request.previous_contract,
      target: baseWithoutIntegrityAndDelta,
      generated_at: completedAt,
    });
    const candidate = finalizeWorkspaceIndexContract({ ...baseWithoutIntegrityAndDelta, delta });
    if (candidate.integrity.workspace_tree_fingerprint !== treeFingerprint) {
      throw new WorkspaceIndexingError("TREE_FINGERPRINT_INTERNAL_MISMATCH", "The assembled snapshot differs from the indexed file tree.");
    }
    return candidate;
  };

  // First prove that the fully assembled deterministic result is validator-acceptable.
  // The provisional timestamp is observational only and is replaced after this terminal-success gate.
  const provisionalCompletedAt = request.completed_at ?? startedAt;
  const terminalCandidate = buildTerminalCandidate(provisionalCompletedAt);
  const terminalValidation = validateCanonicalWorkspaceIndexContract(terminalCandidate, { base_contract: request.previous_contract });
  checkpoint("VALIDATING");
  if (!terminalValidation.contract || terminalValidation.status === "REJECTED") {
    throw new WorkspaceIndexingError("CANONICAL_INDEX_VALIDATION_REJECTED", "The technical validator rejected the Workspace Index candidate.", terminalValidation.diagnostics.map(item => item.code));
  }
  request.terminal_validation_observer?.("TERMINAL_CANDIDATE_VALIDATED");

  // Stamp completion only after terminal validation has established a successful result, then rebuild
  // integrity/delta and validate the exact returned projection so timestamps never weaken determinism.
  const completedAt = request.completed_at ?? terminalNow();
  const finalCandidate = buildTerminalCandidate(completedAt);
  const finalValidation = validateCanonicalWorkspaceIndexContract(finalCandidate, { base_contract: request.previous_contract });
  checkpoint("VALIDATING");
  if (!finalValidation.contract || finalValidation.status === "REJECTED") {
    throw new WorkspaceIndexingError("CANONICAL_INDEX_FINAL_PROJECTION_REJECTED", "The technical validator rejected the final timestamped Workspace Index projection.", finalValidation.diagnostics.map(item => item.code));
  }
  request.terminal_validation_observer?.("FINAL_PROJECTION_VALIDATED");
  indexWorkspaceResult = finalValidation.contract;
  } catch (error) {
    indexWorkspacePrimaryError = error;
  }
  let objectAuthorityCloseError: unknown;
  try {
    await objectAuthority.close();
  } catch (closeError) {
    objectAuthorityCloseError = closeError;
  }
  if (indexWorkspacePrimaryError !== undefined) {
    // CASE A: the originating index failure remains authoritative; a failing close() is secondary evidence only.
    if (objectAuthorityCloseError !== undefined) {
      reportBoundedSecondaryDiagnostic("workspace-index-object-authority-close-secondary", objectAuthorityCloseError);
    }
    throw indexWorkspacePrimaryError;
  }
  // CASE B: after a successful index, a failing close() is a real operation failure and is never discarded.
  if (objectAuthorityCloseError !== undefined) throw objectAuthorityCloseError;
  return indexWorkspaceResult!;
}

export function emptyWorkspaceIndexSnapshot(): WorkspaceIndexSnapshot {
  return { ...EMPTY_SNAPSHOT };
}

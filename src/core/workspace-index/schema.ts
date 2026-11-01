import { z } from "zod/v3";
import schemaDocument from "@/core/workspace-index/canonical-workspace-index-v1.schema.json";
import {
  CANONICAL_WORKSPACE_INDEX_CONTRACT_TYPE,
  CANONICAL_WORKSPACE_INDEX_CONTRACT_VERSION,
  type CanonicalWorkspaceIndexContract,
} from "@/core/workspace-index/types";
import type { JsonValue } from "@/core/truth/project-truth-hash";

const bounded = (min = 1, max = 4096) => z.string().trim().min(min).max(max);
const idSchema = bounded(1, 160).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const sha256Schema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const isoTimestampSchema = z.string().datetime({ offset: true });

export const fileKindValues = [
  "SOURCE_CODE", "MARKDOWN", "CSV", "JSON", "YAML", "TOML", "XML", "SCRIPT", "MANIFEST", "CONFIGURATION", "BINARY", "UNKNOWN",
] as const;
export const fileEncodingValues = ["UTF8", "UTF16LE", "BINARY", "UNKNOWN"] as const;
export const parseStatusValues = ["PARSED", "NOT_APPLICABLE", "METADATA_ONLY", "RESTRICTED", "UNSUPPORTED", "FAILED"] as const;
export const sensitivityStateValues = ["NORMAL", "SENSITIVE", "SECRET", "CREDENTIAL_LIKE", "OWNER_RESTRICTED"] as const;
export const coverageStageValues = ["DISCOVERED", "METADATA_INDEXED", "CONTENT_READABLE", "STRUCTURE_PARSED", "FACTS_EXTRACTED", "RELATIONS_RESOLVED"] as const;
export const coverageStateValues = ["COMPLETE", "PARTIAL", "METADATA_ONLY", "RESTRICTED", "UNSUPPORTED", "FAILED"] as const;
export const contentAvailabilityValues = ["AVAILABLE", "METADATA_ONLY", "RESTRICTED", "UNREADABLE", "BINARY", "MISSING"] as const;
export const contentScopeValues = ["FULL_FILE", "BYTE_RANGE", "LINE_RANGE", "NORMALIZED_FRAGMENT"] as const;
export const factTypeValues = ["SYMBOL", "IMPORT", "DEPENDENCY", "ROUTE", "SERVICE", "COMPONENT", "TEST", "CONFIGURATION", "SCRIPT", "DOCUMENTATION", "DATABASE_ENTITY"] as const;
export const relationTypeValues = ["CONTAINS", "DECLARES", "IMPORTS", "DEPENDS_ON", "CALLS", "IMPLEMENTS", "CONFIGURES", "EXPOSES_ROUTE", "HANDLES_EVENT", "READS_FROM", "WRITES_TO", "TESTS", "VALIDATES", "REFERENCES"] as const;
export const extractionMethodValues = ["PARSER_EXACT", "AST_DERIVED", "MANIFEST_DECLARED", "TEXT_PATTERN", "HEURISTIC", "DOCUMENTED_CLAIM"] as const;
export const certaintyValues = ["EXACT", "DERIVED", "HEURISTIC", "UNRESOLVED"] as const;
export const evidenceRoleValues = ["CANONICAL_EVIDENCE", "SIGNAL_ONLY", "UNRESOLVED"] as const;
export const failureStageValues = ["DISCOVERY", "METADATA", "CONTENT_READ", "DECODING", "PARSING", "FACT_EXTRACTION", "RELATION_RESOLUTION", "HASHING", "CONTRACT_ASSEMBLY"] as const;
export const failureRecoverabilityValues = ["RETRYABLE", "REQUIRES_OWNER_PERMISSION", "REQUIRES_PARSER_SUPPORT", "PERMANENT_FOR_THIS_REVISION"] as const;
export const failureImpactValues = ["LOCAL", "CONTEXT_DEGRADING", "REVISION_INCOMPLETE", "CONTRACT_BLOCKING"] as const;

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.string(), z.number().finite(), z.boolean(), z.null(),
  z.array(jsonValueSchema),
  z.record(jsonValueSchema),
]));
const jsonObjectSchema = z.record(jsonValueSchema);

export const sourceLocationSchema = z.object({
  line_range: z.object({ start: z.number().int().positive(), end: z.number().int().positive() }).strict().refine((value: { start: number; end: number }) => value.end >= value.start, "line_range end must be >= start").optional(),
  byte_range: z.object({ start: z.number().int().nonnegative(), end: z.number().int().nonnegative() }).strict().refine((value: { start: number; end: number }) => value.end >= value.start, "byte_range end must be >= start").optional(),
  ast_node_path: bounded(1, 2048).optional(),
  symbol_path: bounded(1, 2048).optional(),
  normalized_signature: bounded(1, 4096).optional(),
}).strict().refine((value: Record<string, unknown>) => Object.values(value).some(item => item !== undefined), "At least one source locator is required.");

export const workspaceBindingSchema = z.object({
  source_binding_id: idSchema,
  binding_type: z.enum(["LOCAL_FILESYSTEM", "REMOTE_REFERENCE", "FIXTURE"]),
  normalized_reference: bounded(1, 8192),
  device_name: bounded(1, 512).optional(),
  platform: bounded(1, 128).optional(),
  repository_identity: bounded(1, 8192).optional(),
  branch: bounded(1, 512).optional(),
  commit_sha: z.string().regex(/^[0-9a-f]{7,64}$/i).optional(),
  metadata: jsonObjectSchema,
}).strict();

export const workspaceIdentitySchema = z.object({
  workspace_instance_id: idSchema,
  workspace_revision_id: idSchema,
  previous_revision_id: idSchema.nullable(),
  source_binding_id: idSchema,
}).strict();

export const generationMetadataSchema = z.object({
  indexing_session_id: idSchema,
  indexer_name: bounded(1, 160),
  indexer_version: bounded(1, 80),
  parser_registry_version: bounded(1, 160),
  relation_registry_version: bounded(1, 160),
  started_at: isoTimestampSchema,
  completed_at: isoTimestampSchema,
}).strict().refine((value: { started_at: string; completed_at: string }) => Date.parse(value.completed_at) >= Date.parse(value.started_at), "completed_at must not precede started_at");

export const workspaceFileRecordSchema = z.object({
  workspace_file_id: idSchema,
  file_revision_id: idSchema,
  relative_path: bounded(1, 8192).refine((value: string) => !value.startsWith("/") && !value.includes("\\") && !value.split("/").includes(".."), "relative_path must be normalized and workspace-relative"),
  file_name: bounded(1, 1024),
  file_kind: z.enum(fileKindValues),
  language: bounded(1, 160).optional(),
  size_bytes: z.number().int().nonnegative(),
  content_hash: sha256Schema,
  metadata_hash: sha256Schema,
  encoding: z.enum(fileEncodingValues),
  parse_status: z.enum(parseStatusValues),
  sensitivity_state: z.enum(sensitivityStateValues),
  coverage_stage: z.enum(coverageStageValues),
  coverage_state: z.enum(coverageStateValues),
  content_ref_id: idSchema.optional(),
  lineage_state: z.enum(["NEW", "CONTINUED", "RENAMED_OR_MOVED", "UNPROVEN"]),
  previous_file_revision_id: idSchema.optional(),
  possible_lineage: z.object({
    previous_workspace_file_id: idSchema,
    reason: bounded(1, 2048),
    confidence: z.enum(["LOW", "MEDIUM", "HIGH"]),
  }).strict().optional(),
}).strict();

export const factProvenanceSchema = z.object({
  workspace_revision_id: idSchema,
  file_revision_id: idSchema,
  file_content_hash: sha256Schema,
  source_location: sourceLocationSchema,
  extractor_id: idSchema,
  extractor_version: bounded(1, 80),
  extraction_method: z.enum(extractionMethodValues),
  evidence_hash: sha256Schema,
}).strict();

export const workspaceFactRecordSchema = z.object({
  workspace_fact_id: idSchema,
  fact_revision_id: idSchema,
  fact_type: z.enum(factTypeValues),
  qualified_name: bounded(1, 8192),
  display_name: bounded(1, 2048),
  attributes: jsonObjectSchema,
  source_file_revision_id: idSchema,
  source_location: sourceLocationSchema,
  parent_fact_revision_id: idSchema.optional(),
  extraction_method: z.enum(extractionMethodValues),
  extractor_id: idSchema,
  extractor_version: bounded(1, 80),
  certainty: z.enum(certaintyValues),
  evidence_role: z.enum(evidenceRoleValues),
  provenance: factProvenanceSchema,
}).strict();

export const relationEndpointSchema = z.object({
  entity_type: z.enum(["FILE", "FACT"]),
  entity_revision_id: idSchema,
}).strict();

export const relationEvidenceReferenceSchema = z.object({
  file_revision_id: idSchema,
  source_location: sourceLocationSchema,
  evidence_hash: sha256Schema,
  extractor_id: idSchema,
  extractor_version: bounded(1, 80),
}).strict();

export const workspaceRelationRecordSchema = z.object({
  workspace_relation_id: idSchema,
  relation_revision_id: idSchema,
  relation_type: z.enum(relationTypeValues),
  source: relationEndpointSchema,
  target: relationEndpointSchema,
  direction: z.enum(["DIRECTED", "UNDIRECTED"]),
  attributes: jsonObjectSchema,
  evidence_refs: z.array(relationEvidenceReferenceSchema).min(1).max(100),
  extraction_method: z.enum(extractionMethodValues),
  extractor_id: idSchema,
  extractor_version: bounded(1, 80),
  certainty: z.enum(certaintyValues),
  evidence_role: z.enum(evidenceRoleValues),
}).strict();

export const contentReferenceRecordSchema = z.object({
  content_ref_id: idSchema,
  file_revision_id: idSchema,
  content_hash: sha256Schema,
  content_kind: z.enum(fileKindValues),
  media_type: bounded(1, 512),
  encoding: z.enum(fileEncodingValues),
  size_bytes: z.number().int().nonnegative(),
  retrieval_ref: bounded(1, 8192),
  sensitivity_class: z.enum(sensitivityStateValues),
  availability_state: z.enum(contentAvailabilityValues),
  scope_type: z.enum(contentScopeValues),
}).strict();

export const workspaceIndexSnapshotSchema = z.object({
  files: z.array(workspaceFileRecordSchema),
  facts: z.array(workspaceFactRecordSchema),
  relations: z.array(workspaceRelationRecordSchema),
  content_references: z.array(contentReferenceRecordSchema),
}).strict();

// B1 intrinsic Artifact fact provenance deliberately omits the V1 container Workspace Revision.
// V1 compatibility remains governed by workspaceIndexSnapshotSchema above.
export const canonicalArtifactFactProvenanceSchema = factProvenanceSchema.omit({ workspace_revision_id: true });
export const canonicalArtifactFactRecordSchema = workspaceFactRecordSchema.extend({
  provenance: canonicalArtifactFactProvenanceSchema,
}).strict();
export const canonicalIndexArtifactSnapshotSchema = z.object({
  files: z.array(workspaceFileRecordSchema),
  facts: z.array(canonicalArtifactFactRecordSchema),
  relations: z.array(workspaceRelationRecordSchema),
  content_references: z.array(contentReferenceRecordSchema),
}).strict();

const countRecordSchema = z.record(z.number().int().nonnegative());
export const workspaceCoverageSummarySchema = z.object({
  total_discovered_files: z.number().int().nonnegative(),
  metadata_indexed_files: z.number().int().nonnegative(),
  fully_parsed_files: z.number().int().nonnegative(),
  partially_parsed_files: z.number().int().nonnegative(),
  metadata_only_files: z.number().int().nonnegative(),
  restricted_files: z.number().int().nonnegative(),
  unsupported_files: z.number().int().nonnegative(),
  failed_files: z.number().int().nonnegative(),
  fact_count_by_type: countRecordSchema,
  relation_count_by_type: countRecordSchema,
  parser_coverage_by_language: z.record(z.object({
    discovered_files: z.number().int().nonnegative(),
    parsed_files: z.number().int().nonnegative(),
    partial_files: z.number().int().nonnegative(),
    unsupported_files: z.number().int().nonnegative(),
  }).strict()),
}).strict();

export const workspaceIndexFailureSchema = z.object({
  failure_id: idSchema,
  file_revision_id: idSchema.optional(),
  stage: z.enum(failureStageValues),
  failure_type: bounded(1, 160),
  error_code: bounded(1, 160).regex(/^[A-Z0-9_:-]+$/),
  sanitized_message: bounded(1, 4096),
  extractor_id: idSchema.optional(),
  extractor_version: bounded(1, 80).optional(),
  occurred_at: isoTimestampSchema,
  recoverability: z.enum(failureRecoverabilityValues),
  impact: z.enum(failureImpactValues),
}).strict();

const fileDeltaSchema = z.object({
  added: z.array(workspaceFileRecordSchema),
  modified: z.array(z.object({ before_file_revision_id: idSchema, after: workspaceFileRecordSchema }).strict()),
  deleted: z.array(z.object({ workspace_file_id: idSchema, file_revision_id: idSchema, relative_path: bounded(1, 8192) }).strict()),
  renamed_or_moved: z.array(z.object({
    workspace_file_id: idSchema,
    from_file_revision_id: idSchema,
    from_relative_path: bounded(1, 8192),
    to: workspaceFileRecordSchema,
  }).strict()),
}).strict();
const factDeltaSchema = z.object({
  added: z.array(workspaceFactRecordSchema),
  modified: z.array(z.object({ before_fact_revision_id: idSchema, after: workspaceFactRecordSchema }).strict()),
  removed: z.array(z.object({ workspace_fact_id: idSchema, fact_revision_id: idSchema }).strict()),
  lineage_changed: z.array(z.object({ workspace_fact_id: idSchema, from_fact_revision_id: idSchema, to_fact_revision_id: idSchema, reason: bounded(1, 2048) }).strict()),
}).strict();
const relationDeltaSchema = z.object({
  added: z.array(workspaceRelationRecordSchema),
  modified: z.array(z.object({ before_relation_revision_id: idSchema, after: workspaceRelationRecordSchema }).strict()),
  removed: z.array(z.object({ workspace_relation_id: idSchema, relation_revision_id: idSchema }).strict()),
}).strict();
const contentReferenceDeltaSchema = z.object({
  added: z.array(contentReferenceRecordSchema),
  modified: z.array(z.object({ before_content_ref_id: idSchema, after: contentReferenceRecordSchema }).strict()),
  removed: z.array(z.object({ content_ref_id: idSchema, file_revision_id: idSchema }).strict()),
  sensitivity_changed: z.array(z.object({ content_ref_id: idSchema, from: z.enum(sensitivityStateValues), to: z.enum(sensitivityStateValues) }).strict()),
}).strict();

export const workspaceIndexDeltaSchema = z.object({
  delta_id: idSchema,
  from_workspace_revision_id: idSchema.nullable(),
  to_workspace_revision_id: idSchema,
  delta_schema_version: bounded(1, 160),
  comparison_engine_version: bounded(1, 160),
  generated_at: isoTimestampSchema,
  files: fileDeltaSchema,
  facts: factDeltaSchema,
  relations: relationDeltaSchema,
  content_references: contentReferenceDeltaSchema,
}).strict();

export const workspaceIndexIntegritySchema = z.object({
  workspace_tree_fingerprint: sha256Schema,
  canonical_payload_hash: sha256Schema,
  file_count: z.number().int().nonnegative(),
  fact_count: z.number().int().nonnegative(),
  relation_count: z.number().int().nonnegative(),
  content_reference_count: z.number().int().nonnegative(),
}).strict();

export const canonicalWorkspaceIndexContractSchema: z.ZodType<CanonicalWorkspaceIndexContract> = z.object({
  contract_type: z.literal(CANONICAL_WORKSPACE_INDEX_CONTRACT_TYPE),
  contract_version: z.literal(CANONICAL_WORKSPACE_INDEX_CONTRACT_VERSION),
  contract_id: idSchema,
  contract_status: z.enum(["COMPLETE", "COMPLETE_WITH_GAPS"]),
  workspace: workspaceIdentitySchema,
  source_binding: workspaceBindingSchema,
  generation: generationMetadataSchema,
  snapshot: workspaceIndexSnapshotSchema,
  delta: workspaceIndexDeltaSchema.nullable(),
  coverage: workspaceCoverageSummarySchema,
  failures: z.array(workspaceIndexFailureSchema),
  integrity: workspaceIndexIntegritySchema,
}).strict();

export const canonicalWorkspaceIndexJsonSchema = schemaDocument;

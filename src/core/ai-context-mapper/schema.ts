import { z } from "zod/v3";
import jsonSchemaDocument from "@/core/ai-context-mapper/model-proposed-context-catalog-v1.schema.json";
import {
  B1_MAPPING_INPUT_SCHEMA_VERSION,
  MAPPING_INPUT_SCHEMA_VERSION,
  MODEL_PROPOSED_CATALOG_SCHEMA_VERSION,
  contextKinds,
  relationshipTypes,
  type MappingInputSnapshot,
  type ModelProposedContextCatalogV1,
} from "@/core/ai-context-mapper/types";
import { jsonValueSchema } from "@/core/workspace-index/schema";

const boundedText = (min: number, max: number) => z.string().trim().min(min).max(max);
const sha256Schema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const isoTimestampSchema = z.string().datetime({ offset: true });
const contextIdSchema = z.string().regex(/^ctx_[a-z0-9][a-z0-9_-]{2,63}$/);
const relationshipIdSchema = z.string().regex(/^rel_[a-z0-9][a-z0-9_-]{2,63}$/);

const uniqueStrings = (schema: z.ZodType<string>, min = 0, max?: number) => {
  const array = z.array(schema).min(min);
  const bounded = max === undefined ? array : array.max(max);
  return bounded.superRefine((value, context) => {
    if (new Set(value).size !== value.length) context.addIssue({ code: "custom", message: "Array values must be unique." });
  });
};

export const mappingInputEntrySchema = z.object({
  entry_id: boundedText(1, 256),
  workspace_id: boundedText(1, 128),
  normalized_path: boundedText(1, 8192).refine(value => !value.startsWith("/") && !value.includes("\\") && !value.split("/").includes(".."), "Path must be normalized and workspace-relative."),
  entry_type: z.literal("FILE"),
  language_or_format: boundedText(1, 160),
  size_bytes: z.number().int().nonnegative(),
  content_or_metadata_fingerprint: sha256Schema,
  index_supported_signals: z.object({
    file_kind: boundedText(1, 80),
    parse_status: boundedText(1, 80),
    coverage_state: boundedText(1, 80),
    fact_signals: z.array(z.object({
      fact_type: boundedText(1, 80),
      qualified_name: boundedText(1, 8192),
      display_name: boundedText(1, 1024),
      attributes: z.record(jsonValueSchema),
      certainty: boundedText(1, 80),
      evidence_role: boundedText(1, 80),
    }).strict()).max(500),
    relation_signals: z.array(z.object({
      relation_type: boundedText(1, 80),
      direction: boundedText(1, 80),
      source_entry_or_entity_id: boundedText(1, 256),
      target_entry_or_entity_id: boundedText(1, 256),
      certainty: boundedText(1, 80),
      evidence_role: boundedText(1, 80),
    }).strict()).max(1000),
  }).strict(),
}).strict();

const mappingInputSnapshotBaseSchema = z.object({
  mapping_input_snapshot_id: boundedText(1, 160),
  workspace_index_contract_version: boundedText(1, 160),
  workspace_snapshot_id: boundedText(1, 160),
  workspace_index_sha256: sha256Schema,
  created_at: isoTimestampSchema,
  eligible_workspace_ids: uniqueStrings(boundedText(1, 128), 1, 100),
  eligible_entry_count: z.number().int().nonnegative(),
  excluded_entry_count: z.number().int().nonnegative(),
  serialized_payload_sha256: sha256Schema,
  provider_neutral_estimated_tokens: z.number().int().nonnegative(),
  secret_policy_status: z.literal("PASS"),
  entries: z.array(mappingInputEntrySchema),
});

const legacyMappingInputSnapshotSchema = mappingInputSnapshotBaseSchema.extend({
  mapping_input_schema_version: z.literal(MAPPING_INPUT_SCHEMA_VERSION),
}).strict();

const b1CanonicalArtifactMappingInputSnapshotSchema = mappingInputSnapshotBaseSchema.extend({
  mapping_input_schema_version: z.literal(B1_MAPPING_INPUT_SCHEMA_VERSION),
  source_authority: z.literal("CANONICAL_INDEX_ARTIFACT"),
  canonical_index_artifact_id: boundedText(1, 160),
  artifact_semantic_sha256: sha256Schema,
}).strict();

export const mappingInputSnapshotSchema: z.ZodType<MappingInputSnapshot> = z.union([
  legacyMappingInputSnapshotSchema,
  b1CanonicalArtifactMappingInputSnapshotSchema,
]).superRefine((value, context) => {
  if (value.entries.length !== value.eligible_entry_count) context.addIssue({ code: "custom", path: ["eligible_entry_count"], message: "eligible_entry_count must equal entries.length." });
  const ids = value.entries.map(entry => entry.entry_id);
  if (new Set(ids).size !== ids.length) context.addIssue({ code: "custom", path: ["entries"], message: "Entry IDs must be unique." });
  const workspaces = new Set(value.eligible_workspace_ids);
  for (const [index, entry] of value.entries.entries()) if (!workspaces.has(entry.workspace_id)) context.addIssue({ code: "custom", path: ["entries", index, "workspace_id"], message: "Entry references an unknown workspace." });
  if (value.mapping_input_schema_version === B1_MAPPING_INPUT_SCHEMA_VERSION
      && value.workspace_index_sha256 !== value.artifact_semantic_sha256) {
    context.addIssue({ code: "custom", path: ["workspace_index_sha256"], message: "Registered B1 Mapping Input must bind workspace_index_sha256 to artifact_semantic_sha256." });
  }
});

const proposedContextSchema = z.object({
  context_id: contextIdSchema,
  display_name: boundedText(1, 160),
  context_kind: z.enum(contextKinds),
  summary: boundedText(1, 3000),
  responsibilities: uniqueStrings(boundedText(1, 500), 1, 30),
  workspace_ids: uniqueStrings(boundedText(1, 128), 1),
  evidence_entry_ids: uniqueStrings(boundedText(1, 256), 1),
  interfaces: uniqueStrings(boundedText(1, 500), 0, 50),
  unknowns: uniqueStrings(boundedText(1, 700), 0, 30),
  confidence: z.enum(["high", "medium", "low"]),
  rationale: boundedText(1, 2000),
}).strict();

const proposedRelationshipSchema = z.object({
  relationship_id: relationshipIdSchema,
  from_context_id: contextIdSchema,
  to_context_id: contextIdSchema,
  relationship_type: z.enum(relationshipTypes),
  evidence_entry_ids: uniqueStrings(boundedText(1, 256), 1),
  confidence: z.enum(["high", "medium", "low"]),
  rationale: boundedText(1, 1500),
}).strict();

const unmappedEntrySchema = z.object({
  entry_id: boundedText(1, 256),
  reason_code: z.enum(["insufficient_evidence", "ambiguous", "technical_noise", "generated_or_vendor", "out_of_mapper_scope"]),
  explanation: boundedText(1, 1000),
}).strict();

export const modelProposedContextCatalogSchema: z.ZodType<ModelProposedContextCatalogV1> = z.object({
  schema_version: z.literal(MODEL_PROPOSED_CATALOG_SCHEMA_VERSION),
  catalog_summary: boundedText(1, 4000),
  contexts: z.array(proposedContextSchema).min(1),
  relationships: z.array(proposedRelationshipSchema),
  unmapped_entries: z.array(unmappedEntrySchema),
  global_unknowns: uniqueStrings(boundedText(1, 1000), 0, 100),
  warnings: uniqueStrings(boundedText(1, 1000), 0, 100),
}).strict();

export const modelProposedContextCatalogJsonSchema = jsonSchemaDocument as Record<string, unknown>;

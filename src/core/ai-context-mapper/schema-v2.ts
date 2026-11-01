import { z } from "zod/v3";
import jsonSchemaDocument from "@/core/ai-context-mapper/model-context-analysis-v2.schema.json";
import { contextKinds, relationshipTypes } from "@/core/ai-context-mapper/types";
import type { JsonValue } from "@/core/truth/project-truth-hash";
import {
  CONTEXT_ASSEMBLY_MAPPING_INPUT_SCHEMA_VERSION,
  MODEL_CONTEXT_ANALYSIS_SCHEMA_VERSION_V2,
  type ContextAssemblyMappingInputV2,
  type ModelContextAnalysisV2,
} from "@/core/ai-context-mapper/v2";

const text = (min: number, max: number) => z.string().trim().min(min).max(max);
const sha256 = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const id = z.string().regex(/^[a-z0-9][a-z0-9_-]{2,127}$/);
const uuidOrId = z.string().trim().min(1).max(256);
const jsonPrimitiveSchema = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);
const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([jsonPrimitiveSchema, z.array(jsonValueSchema), z.record(z.string(), jsonValueSchema)]),
);
const unique = (schema: z.ZodType<string>, max = 4000) => z.array(schema).max(max).superRefine((values, ctx) => {
  if (new Set(values).size !== values.length) ctx.addIssue({ code: "custom", message: "Array values must be unique." });
});

const entrySchema = z.object({
  entry_id: text(1, 256),
  workspace_id: text(1, 128),
  normalized_path: text(1, 8192),
  entry_type: z.literal("FILE"),
  language_or_format: text(1, 160),
  size_bytes: z.number().int().nonnegative(),
  content_or_metadata_fingerprint: sha256,
  index_supported_signals: z.object({
    file_kind: text(1, 80),
    parse_status: text(1, 80),
    coverage_state: text(1, 80),
    fact_signals: z.array(z.object({
      fact_type: text(1, 160), qualified_name: text(1, 4096), display_name: text(1, 4096),
      attributes: z.record(z.string(), jsonValueSchema), certainty: text(1, 80), evidence_role: text(1, 80),
    }).strict()).max(20000),
    relation_signals: z.array(z.object({
      relation_type: text(1, 160), direction: text(1, 80), source_entry_or_entity_id: text(1, 4096),
      target_entry_or_entity_id: text(1, 4096), certainty: text(1, 80), evidence_role: text(1, 80),
    }).strict()).max(20000),
  }).strict(),
}).strict();

export const contextAssemblyMappingInputV2Schema: z.ZodType<ContextAssemblyMappingInputV2> = z.object({
  schema_version: z.literal(CONTEXT_ASSEMBLY_MAPPING_INPUT_SCHEMA_VERSION),
  context_assembly_id: uuidOrId,
  context_assembly_revision_id: uuidOrId,
  context_assembly_revision: z.number().int().positive(),
  created_at: z.string().datetime({ offset: true }),
  source_bindings: z.array(z.object({
    workspace_id: uuidOrId,
    workspace_registration_revision: z.number().int().nonnegative(),
    workspace_registration_fingerprint: text(1, 10000),
    workspace_revision_id: uuidOrId,
    workspace_index_snapshot_id: uuidOrId,
    canonical_index_artifact_id: uuidOrId,
    workspace_index_sha256: sha256,
    artifact_semantic_sha256: sha256,
  }).strict()).min(1).max(100),
  entries: z.array(entrySchema).max(1000000),
  serialized_payload_sha256: sha256,
  provider_neutral_estimated_tokens: z.number().int().nonnegative(),
  proof_obligations: unique(text(1, 1000), 500),
}).strict();

const component = z.object({
  component_id: z.string().regex(/^ctx_[a-z0-9][a-z0-9_-]{2,63}$/),
  display_name: text(1, 240),
  context_kind: z.enum(contextKinds),
  summary: text(1, 12000),
  responsibilities: unique(text(1, 4000)),
  workspace_ids: unique(text(1, 128)),
  evidence_entry_ids: unique(text(1, 256)),
  interfaces: unique(text(1, 4000)),
  unknowns: unique(text(1, 4000)),
  confidence: z.enum(["high", "medium", "low"]),
  rationale: text(1, 12000),
}).strict();

const relationship = z.object({
  relationship_id: z.string().regex(/^rel_[a-z0-9][a-z0-9_-]{2,63}$/),
  from_component_id: text(1, 200),
  to_component_id: text(1, 200),
  relationship_type: z.enum(relationshipTypes),
  evidence_entry_ids: unique(text(1, 256)),
  confidence: z.enum(["high", "medium", "low"]),
  rationale: text(1, 12000),
}).strict();

const missingEvidence = z.object({
  gap_id: z.string().regex(/^gap_[a-z0-9][a-z0-9_-]{2,63}$/),
  gap_type: z.enum(["INTERNAL_SOURCE", "EXTERNAL_DEPENDENCY", "NON_BLOCKING_UNRESOLVED", "OPTIONAL_CONTEXT_GAP"]),
  affected_component_ids: unique(text(1, 200)),
  affected_relationship_ids: unique(text(1, 200)),
  known_evidence_entry_ids: unique(text(1, 256)),
  missing_evidence_description: text(1, 12000),
  required_evidence_kind: text(1, 2000),
  source_hint: text(1, 1000).optional(),
  blocking_reason: text(1, 12000),
  materiality: z.enum(["BLOCKING", "NON_BLOCKING"]),
  confidence: z.enum(["high", "medium", "low"]),
}).strict();

const contradiction = z.object({
  contradiction_id: z.string().regex(/^ctr_[a-z0-9][a-z0-9_-]{2,63}$/),
  affected_component_ids: unique(text(1, 200)),
  affected_relationship_ids: unique(text(1, 200)),
  evidence_entry_ids: unique(text(1, 256)),
  summary: text(1, 12000),
  materiality: z.enum(["BLOCKING", "NON_BLOCKING"]),
}).strict();

export const modelContextAnalysisV2Schema: z.ZodType<ModelContextAnalysisV2> = z.object({
  schema_version: z.literal(MODEL_CONTEXT_ANALYSIS_SCHEMA_VERSION_V2),
  analysis_outcome: z.enum(["ANALYSIS_FINDINGS_NO_KNOWN_BLOCKING_GAP", "ANALYSIS_REQUIRES_ADDITIONAL_EVIDENCE"]),
  catalog_summary: text(1, 12000),
  components: z.array(component).max(1000),
  relationships: z.array(relationship).max(4000),
  missing_evidence_requests: z.array(missingEvidence).max(500),
  material_contradictions: z.array(contradiction).max(500),
  global_unknowns: unique(text(1, 4000), 1000),
  warnings: unique(text(1, 4000), 1000),
}).strict();

export const modelContextAnalysisV2JsonSchema = jsonSchemaDocument as Record<string, unknown>;

export function parseContextAssemblyMappingInputV2(value: unknown): ContextAssemblyMappingInputV2 {
  return contextAssemblyMappingInputV2Schema.parse(value);
}

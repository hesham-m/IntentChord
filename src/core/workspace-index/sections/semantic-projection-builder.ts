/**
 * SEMANTIC PROJECTION BUILDER — shared deterministic builder.
 *
 * Produces MappingInputEntry-equivalent records from governed V1 evidence.
 * This is the SINGLE SOURCE used by both:
 * - V2 SEMANTIC_PROJECTION section production (during indexing)
 * - V1 Mapper Input Builder (existing path)
 *
 * The output is deterministic: given the same governed logical records,
 * the produced entries are identical in content and ordering.
 */

import { createHash } from "node:crypto";
import type {
  MappingInputEntry,
  MappingInputEntryType,
} from "@/core/ai-context-mapper/types";
import type {
  WorkspaceFileRecord,
  WorkspaceFactRecord,
  WorkspaceRelationRecord,
  WorkspaceIndexSnapshot,
} from "@/core/workspace-index/types";

function normalizedPath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//, "");
}

function fileFingerprint(file: WorkspaceFileRecord): string {
  return file.content_hash || file.metadata_hash;
}

function stableMapperId(prefix: string, material: Record<string, unknown>): string {
  const canonical = JSON.stringify(material, Object.keys(material).sort());
  return `${prefix}_${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

/**
 * Build a single MappingInputEntry from a WorkspaceFileRecord and its associated evidence.
 * This is the exact same logic as input-builder.ts:buildEntry, extracted for reuse.
 */
export function buildSemanticProjectionEntry(
  workspaceId: string,
  file: WorkspaceFileRecord,
  facts: WorkspaceFactRecord[],
  relations: WorkspaceRelationRecord[],
): MappingInputEntry {
  const factRevisionIds = new Set(facts.map(fact => fact.fact_revision_id));
  const fileRelations = relations.filter(relation =>
    relation.source.entity_revision_id === file.file_revision_id
    || relation.target.entity_revision_id === file.file_revision_id
    || factRevisionIds.has(relation.source.entity_revision_id)
    || factRevisionIds.has(relation.target.entity_revision_id));
  return {
    entry_id: stableMapperId("mie", {
      workspace_id: workspaceId,
      file_revision_id: file.file_revision_id,
      normalized_path: normalizedPath(file.relative_path),
    }),
    workspace_id: workspaceId,
    normalized_path: normalizedPath(file.relative_path),
    entry_type: "FILE" as MappingInputEntryType,
    language_or_format: file.language ?? file.file_kind,
    size_bytes: file.size_bytes,
    content_or_metadata_fingerprint: fileFingerprint(file),
    index_supported_signals: {
      file_kind: file.file_kind,
      parse_status: file.parse_status,
      coverage_state: file.coverage_state,
      fact_signals: facts.map(fact => ({
        fact_type: fact.fact_type,
        qualified_name: fact.qualified_name,
        display_name: fact.display_name,
        attributes: fact.attributes,
        certainty: fact.certainty,
        evidence_role: fact.evidence_role,
      })).sort((left, right) => left.qualified_name.localeCompare(right.qualified_name)),
      relation_signals: fileRelations.map(relation => ({
        relation_type: relation.relation_type,
        direction: relation.direction,
        source_entry_or_entity_id: relation.source.entity_revision_id,
        target_entry_or_entity_id: relation.target.entity_revision_id,
        certainty: relation.certainty,
        evidence_role: relation.evidence_role,
      })).sort((left, right) => `${left.relation_type}|${left.source_entry_or_entity_id}|${left.target_entry_or_entity_id}`.localeCompare(`${right.relation_type}|${right.source_entry_or_entity_id}|${right.target_entry_or_entity_id}`)),
    },
  };
}

/**
 * Build all semantic projection entries from a governed workspace snapshot.
 * Returns entries in canonical deterministic order (workspace_id, normalized_path, entry_id).
 *
 * This produces the EXACT SAME entries as the V1 governedEntries() function in input-builder.ts.
 */
export function buildSemanticProjectionEntries(
  workspaceId: string,
  snapshot: WorkspaceIndexSnapshot,
): MappingInputEntry[] {
  const eligibleFiles = snapshot.files.filter(file => file.sensitivity_state === "NORMAL");
  const entries = eligibleFiles.map(file => {
    const facts = snapshot.facts.filter(fact => fact.source_file_revision_id === file.file_revision_id);
    const factRevisionIds = new Set(facts.map(fact => fact.fact_revision_id));
    const relations = snapshot.relations.filter(relation =>
      relation.source.entity_revision_id === file.file_revision_id
      || relation.target.entity_revision_id === file.file_revision_id
      || factRevisionIds.has(relation.source.entity_revision_id)
      || factRevisionIds.has(relation.target.entity_revision_id));
    return buildSemanticProjectionEntry(workspaceId, file, facts, relations);
  });
  return entries.sort((left, right) =>
    left.workspace_id.localeCompare(right.workspace_id)
    || left.normalized_path.localeCompare(right.normalized_path)
    || left.entry_id.localeCompare(right.entry_id));
}

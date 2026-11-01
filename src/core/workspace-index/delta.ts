import { canonicalJson, normalizedWorkspaceIndexSnapshot, stableWorkspaceIndexId } from "@/core/workspace-index/canonical";
import {
  normalizedCanonicalIndexArtifactSnapshot,
  type CanonicalIndexArtifactFactRecord,
  type CanonicalIndexArtifactSemanticState,
  type CanonicalIndexArtifactSnapshot,
} from "@/core/workspace-index/artifact-identity";
import {
  COMPARISON_ENGINE_VERSION,
  DELTA_SCHEMA_VERSION,
  type CanonicalWorkspaceIndexContract,
  type ContentReferenceRecord,
  type FileDelta,
  type RelationDelta,
  type WorkspaceFactRecord,
  type WorkspaceFileRecord,
  type WorkspaceIndexDelta,
  type WorkspaceIndexSnapshot,
  type WorkspaceRelationRecord,
  type ContentReferenceDelta,
} from "@/core/workspace-index/types";

export const CANONICAL_INDEX_DELTA_SEMANTIC_VERSION = "intentchord.canonical-index-delta-semantic/v3" as const;

type FactDeltaShape<TFact extends Pick<WorkspaceFactRecord, "workspace_fact_id" | "fact_revision_id" | "source_file_revision_id">> = {
  added: TFact[];
  modified: Array<{ before_fact_revision_id: string; after: TFact }>;
  removed: Array<{ workspace_fact_id: string; fact_revision_id: string }>;
  lineage_changed: Array<{ workspace_fact_id: string; from_fact_revision_id: string; to_fact_revision_id: string; reason: string }>;
};

type SnapshotShape<TFact extends Pick<WorkspaceFactRecord, "workspace_fact_id" | "fact_revision_id" | "source_file_revision_id">> = {
  files: WorkspaceFileRecord[];
  facts: TFact[];
  relations: WorkspaceRelationRecord[];
  content_references: ContentReferenceRecord[];
};

export type CanonicalIndexArtifactDelta = {
  schema: typeof CANONICAL_INDEX_DELTA_SEMANTIC_VERSION;
  from_canonical_index_artifact_id: string;
  to_canonical_index_artifact_id: string;
  from_workspace_revision_id: string;
  to_workspace_revision_id: string;
  delta_schema_version: typeof DELTA_SCHEMA_VERSION;
  comparison_engine_version: typeof COMPARISON_ENGINE_VERSION;
  files: FileDelta;
  facts: FactDeltaShape<CanonicalIndexArtifactFactRecord>;
  relations: RelationDelta;
  content_references: ContentReferenceDelta;
};

function same(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function mapBy<T>(items: T[], key: (item: T) => string): Map<string, T> {
  return new Map(items.map(item => [key(item), item]));
}

function deriveSnapshotDelta<TFact extends Pick<WorkspaceFactRecord, "workspace_fact_id" | "fact_revision_id" | "source_file_revision_id">>(
  baseSnapshot: SnapshotShape<TFact>,
  targetSnapshot: SnapshotShape<TFact>,
  options: { allowTransitionLineage: boolean },
): {
  files: FileDelta;
  facts: FactDeltaShape<TFact>;
  relations: RelationDelta;
  content_references: ContentReferenceDelta;
} {
  const baseFiles = mapBy(baseSnapshot.files, item => item.workspace_file_id);
  const targetFiles = mapBy(targetSnapshot.files, item => item.workspace_file_id);
  const fileAdded: WorkspaceFileRecord[] = [];
  const fileModified: FileDelta["modified"] = [];
  const fileDeleted: FileDelta["deleted"] = [];
  const fileRenamed: FileDelta["renamed_or_moved"] = [];
  for (const target of targetSnapshot.files) {
    const before = baseFiles.get(target.workspace_file_id);
    if (!before) fileAdded.push(target);
    else if (options.allowTransitionLineage && before.relative_path !== target.relative_path && target.lineage_state === "RENAMED_OR_MOVED") {
      fileRenamed.push({ workspace_file_id: target.workspace_file_id, from_file_revision_id: before.file_revision_id, from_relative_path: before.relative_path, to: target });
    } else if (!same(before, target)) fileModified.push({ before_file_revision_id: before.file_revision_id, after: target });
  }
  for (const before of baseSnapshot.files) {
    if (!targetFiles.has(before.workspace_file_id)) fileDeleted.push({ workspace_file_id: before.workspace_file_id, file_revision_id: before.file_revision_id, relative_path: before.relative_path });
  }

  const baseFacts = mapBy(baseSnapshot.facts, item => item.workspace_fact_id);
  const targetFacts = mapBy(targetSnapshot.facts, item => item.workspace_fact_id);
  const factAdded: TFact[] = [];
  const factModified: FactDeltaShape<TFact>["modified"] = [];
  const factRemoved: FactDeltaShape<TFact>["removed"] = [];
  const factLineage: FactDeltaShape<TFact>["lineage_changed"] = [];
  for (const target of targetSnapshot.facts) {
    const before = baseFacts.get(target.workspace_fact_id);
    if (!before) factAdded.push(target);
    else if (!same(before, target)) {
      factModified.push({ before_fact_revision_id: before.fact_revision_id, after: target });
      if (before.source_file_revision_id !== target.source_file_revision_id) {
        factLineage.push({ workspace_fact_id: target.workspace_fact_id, from_fact_revision_id: before.fact_revision_id, to_fact_revision_id: target.fact_revision_id, reason: "Source file revision changed." });
      }
    }
  }
  for (const before of baseSnapshot.facts) {
    if (!targetFacts.has(before.workspace_fact_id)) factRemoved.push({ workspace_fact_id: before.workspace_fact_id, fact_revision_id: before.fact_revision_id });
  }

  const baseRelations = mapBy(baseSnapshot.relations, item => item.workspace_relation_id);
  const targetRelations = mapBy(targetSnapshot.relations, item => item.workspace_relation_id);
  const relationAdded: WorkspaceRelationRecord[] = [];
  const relationModified: RelationDelta["modified"] = [];
  const relationRemoved: RelationDelta["removed"] = [];
  for (const target of targetSnapshot.relations) {
    const before = baseRelations.get(target.workspace_relation_id);
    if (!before) relationAdded.push(target);
    else if (!same(before, target)) relationModified.push({ before_relation_revision_id: before.relation_revision_id, after: target });
  }
  for (const before of baseSnapshot.relations) {
    if (!targetRelations.has(before.workspace_relation_id)) relationRemoved.push({ workspace_relation_id: before.workspace_relation_id, relation_revision_id: before.relation_revision_id });
  }

  const baseRefs = mapBy(baseSnapshot.content_references, item => item.content_ref_id);
  const targetRefs = mapBy(targetSnapshot.content_references, item => item.content_ref_id);
  const refAdded: ContentReferenceRecord[] = [];
  const refModified: ContentReferenceDelta["modified"] = [];
  const refRemoved: ContentReferenceDelta["removed"] = [];
  const sensitivityChanged: ContentReferenceDelta["sensitivity_changed"] = [];
  for (const target of targetSnapshot.content_references) {
    const before = baseRefs.get(target.content_ref_id);
    if (!before) refAdded.push(target);
    else if (!same(before, target)) {
      refModified.push({ before_content_ref_id: before.content_ref_id, after: target });
      if (before.sensitivity_class !== target.sensitivity_class) sensitivityChanged.push({ content_ref_id: target.content_ref_id, from: before.sensitivity_class, to: target.sensitivity_class });
    }
  }
  for (const before of baseSnapshot.content_references) {
    if (!targetRefs.has(before.content_ref_id)) refRemoved.push({ content_ref_id: before.content_ref_id, file_revision_id: before.file_revision_id });
  }

  return {
    files: { added: fileAdded, modified: fileModified, deleted: fileDeleted, renamed_or_moved: fileRenamed },
    facts: { added: factAdded, modified: factModified, removed: factRemoved, lineage_changed: factLineage },
    relations: { added: relationAdded, modified: relationModified, removed: relationRemoved },
    content_references: { added: refAdded, modified: refModified, removed: refRemoved, sensitivity_changed: sensitivityChanged },
  };
}

export function deriveWorkspaceIndexDelta(input: {
  base?: CanonicalWorkspaceIndexContract;
  target: Omit<CanonicalWorkspaceIndexContract, "delta" | "integrity"> & { snapshot: WorkspaceIndexSnapshot };
  generated_at: string;
}): WorkspaceIndexDelta {
  const baseSnapshot: WorkspaceIndexSnapshot = input.base?.snapshot ?? { files: [], facts: [], relations: [], content_references: [] };
  const targetSnapshot = input.target.snapshot;
  const fromRevision = input.base?.workspace.workspace_revision_id ?? null;
  const toRevision = input.target.workspace.workspace_revision_id;
  return {
    delta_id: stableWorkspaceIndexId("wid", { fromRevision, toRevision, schema: DELTA_SCHEMA_VERSION }),
    from_workspace_revision_id: fromRevision,
    to_workspace_revision_id: toRevision,
    delta_schema_version: DELTA_SCHEMA_VERSION,
    comparison_engine_version: COMPARISON_ENGINE_VERSION,
    generated_at: input.generated_at,
    ...deriveSnapshotDelta(baseSnapshot, targetSnapshot, { allowTransitionLineage: true }),
  };
}

export function deriveCanonicalIndexArtifactDelta(input: {
  fromArtifactId: string;
  toArtifactId: string;
  base: CanonicalIndexArtifactSemanticState;
  target: CanonicalIndexArtifactSemanticState;
}): CanonicalIndexArtifactDelta {
  return {
    schema: CANONICAL_INDEX_DELTA_SEMANTIC_VERSION,
    from_canonical_index_artifact_id: input.fromArtifactId,
    to_canonical_index_artifact_id: input.toArtifactId,
    from_workspace_revision_id: input.base.workspace_revision_id,
    to_workspace_revision_id: input.target.workspace_revision_id,
    delta_schema_version: DELTA_SCHEMA_VERSION,
    comparison_engine_version: COMPARISON_ENGINE_VERSION,
    ...deriveSnapshotDelta(input.base.snapshot, input.target.snapshot, { allowTransitionLineage: false }),
  };
}

function applyEntityDelta<T>(input: {
  base: T[];
  added: T[];
  modified: Array<{ after: T }>;
  removedIds: string[];
  identity: (item: T) => string;
}): T[] {
  const map = mapBy(input.base, input.identity);
  for (const id of input.removedIds) map.delete(id);
  for (const item of input.modified.map(entry => entry.after)) map.set(input.identity(item), item);
  for (const item of input.added) map.set(input.identity(item), item);
  return [...map.values()];
}

function applySnapshotDelta<TFact extends Pick<WorkspaceFactRecord, "workspace_fact_id" | "fact_revision_id" | "source_file_revision_id">>(
  base: SnapshotShape<TFact>,
  delta: { files: FileDelta; facts: FactDeltaShape<TFact>; relations: RelationDelta; content_references: ContentReferenceDelta },
): SnapshotShape<TFact> {
  const fileMap = mapBy(base.files, item => item.workspace_file_id);
  for (const item of delta.files.deleted) fileMap.delete(item.workspace_file_id);
  for (const item of delta.files.modified) fileMap.set(item.after.workspace_file_id, item.after);
  for (const item of delta.files.renamed_or_moved) fileMap.set(item.workspace_file_id, item.to);
  for (const item of delta.files.added) fileMap.set(item.workspace_file_id, item);

  return {
    files: [...fileMap.values()],
    facts: applyEntityDelta({ base: base.facts, added: delta.facts.added, modified: delta.facts.modified, removedIds: delta.facts.removed.map(item => item.workspace_fact_id), identity: item => item.workspace_fact_id }),
    relations: applyEntityDelta({ base: base.relations, added: delta.relations.added, modified: delta.relations.modified, removedIds: delta.relations.removed.map(item => item.workspace_relation_id), identity: item => item.workspace_relation_id }),
    content_references: applyEntityDelta({ base: base.content_references, added: delta.content_references.added, modified: delta.content_references.modified, removedIds: delta.content_references.removed.map(item => item.content_ref_id), identity: item => item.content_ref_id }),
  };
}

export function applyWorkspaceIndexDelta(base: WorkspaceIndexSnapshot, delta: WorkspaceIndexDelta): WorkspaceIndexSnapshot {
  return normalizedWorkspaceIndexSnapshot(applySnapshotDelta(base, delta));
}

export function validateWorkspaceIndexDelta(input: {
  base?: CanonicalWorkspaceIndexContract;
  target: CanonicalWorkspaceIndexContract;
  delta: WorkspaceIndexDelta;
}): { accepted: boolean; diagnostics: string[] } {
  const diagnostics: string[] = [];
  const expectedBase = input.base?.workspace.workspace_revision_id ?? null;
  if (input.delta.from_workspace_revision_id !== expectedBase) diagnostics.push("DELTA_BASE_REVISION_MISMATCH");
  if (input.delta.to_workspace_revision_id !== input.target.workspace.workspace_revision_id) diagnostics.push("DELTA_TARGET_REVISION_MISMATCH");
  const reconstructed = applyWorkspaceIndexDelta(input.base?.snapshot ?? { files: [], facts: [], relations: [], content_references: [] }, input.delta);
  if (!same(normalizedWorkspaceIndexSnapshot(reconstructed), normalizedWorkspaceIndexSnapshot(input.target.snapshot))) diagnostics.push("DELTA_RECONCILIATION_MISMATCH");
  return { accepted: diagnostics.length === 0, diagnostics };
}

export function validateCanonicalIndexArtifactDelta(input: {
  base: CanonicalIndexArtifactSemanticState;
  target: CanonicalIndexArtifactSemanticState;
  delta: CanonicalIndexArtifactDelta;
}): { accepted: boolean; diagnostics: string[] } {
  const diagnostics: string[] = [];
  if (input.delta.from_workspace_revision_id !== input.base.workspace_revision_id) diagnostics.push("CANONICAL_DELTA_BASE_REVISION_MISMATCH");
  if (input.delta.to_workspace_revision_id !== input.target.workspace_revision_id) diagnostics.push("CANONICAL_DELTA_TARGET_REVISION_MISMATCH");
  const reconstructed = applySnapshotDelta<CanonicalIndexArtifactFactRecord>(input.base.snapshot, input.delta);
  if (!same(normalizedCanonicalIndexArtifactSnapshot(reconstructed as CanonicalIndexArtifactSnapshot), normalizedCanonicalIndexArtifactSnapshot(input.target.snapshot))) diagnostics.push("CANONICAL_DELTA_RECONCILIATION_MISMATCH");
  return { accepted: diagnostics.length === 0, diagnostics };
}

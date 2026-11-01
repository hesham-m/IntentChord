import { rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalJson, finalizeWorkspaceIndexContract, sha256Canonical } from "@/core/workspace-index/canonical";
import { applyWorkspaceIndexDelta, deriveCanonicalIndexArtifactDelta, validateCanonicalIndexArtifactDelta, validateWorkspaceIndexDelta } from "@/core/workspace-index/delta";
import { canonicalIndexArtifactId, canonicalIndexArtifactSemanticState, workspaceIndexConfigurationDescriptor, workspaceIndexConfigurationSha256 } from "@/core/workspace-index/artifact-identity";
import { indexWorkspace } from "@/core/workspace-index/indexer";
import { validateCanonicalWorkspaceIndexContract } from "@/core/workspace-index/validator";
import { createWorkspaceIndexFixture } from "@/test/workspace-index-helpers";

const time = (second: number) => `2026-08-02T18:00:${String(second).padStart(2, "0")}.000Z`;

async function baseline(instance: string, root: string) {
  return indexWorkspace({ workspace_instance_id: instance, root_path: root, binding_type: "FIXTURE", indexing_session_id: `${instance}_s1`, started_at: time(0), completed_at: time(1) });
}

describe("Workspace/File identity and derived Delta", () => {
  it("preserves logical file identity across content changes and creates a new file revision", async () => {
    const root = await createWorkspaceIndexFixture();
    const first = await baseline("wsi_modify", root);
    const before = first.snapshot.files.find(file => file.relative_path === "src/util.ts")!;
    await writeFile(path.join(root, "src", "util.ts"), "export function double(value: number) { return value * 3; }\n");
    const second = await indexWorkspace({ workspace_instance_id: "wsi_modify", root_path: root, binding_type: "FIXTURE", previous_contract: first, indexing_session_id: "wsi_modify_s2", started_at: time(2), completed_at: time(3) });
    const after = second.snapshot.files.find(file => file.relative_path === "src/util.ts")!;
    expect(after.workspace_file_id).toBe(before.workspace_file_id);
    expect(after.file_revision_id).not.toBe(before.file_revision_id);
    expect(second.delta?.files.modified.some(item => item.after.workspace_file_id === before.workspace_file_id)).toBe(true);
  });

  it("preserves logical identity only for a proven rename/move", async () => {
    const root = await createWorkspaceIndexFixture();
    const first = await baseline("wsi_rename", root);
    const before = first.snapshot.files.find(file => file.relative_path === "src/util.ts")!;
    await rename(path.join(root, "src", "util.ts"), path.join(root, "src", "helper.ts"));
    const second = await indexWorkspace({
      workspace_instance_id: "wsi_rename", root_path: root, binding_type: "FIXTURE", previous_contract: first,
      indexing_session_id: "wsi_rename_s2", started_at: time(2), completed_at: time(3),
      git_enrichment: { rename_hints: [{ from_relative_path: "src/util.ts", to_relative_path: "src/helper.ts", confidence: "PROVEN", evidence: "fixture" }], diagnostics: [] },
    });
    const after = second.snapshot.files.find(file => file.relative_path === "src/helper.ts")!;
    expect(after.workspace_file_id).toBe(before.workspace_file_id);
    expect(after.lineage_state).toBe("RENAMED_OR_MOVED");
    expect(second.delta?.files.renamed_or_moved).toHaveLength(1);
  });

  it("represents an unproven rename as delete plus add", async () => {
    const root = await createWorkspaceIndexFixture();
    const first = await baseline("wsi_unproven_rename", root);
    const before = first.snapshot.files.find(file => file.relative_path === "src/util.ts")!;
    await rename(path.join(root, "src", "util.ts"), path.join(root, "src", "helper.ts"));
    const second = await indexWorkspace({ workspace_instance_id: "wsi_unproven_rename", root_path: root, binding_type: "FIXTURE", previous_contract: first, indexing_session_id: "wsi_unproven_rename_s2", started_at: time(2), completed_at: time(3) });
    const after = second.snapshot.files.find(file => file.relative_path === "src/helper.ts")!;
    expect(after.workspace_file_id).not.toBe(before.workspace_file_id);
    expect(second.delta?.files.deleted.some(item => item.workspace_file_id === before.workspace_file_id)).toBe(true);
    expect(second.delta?.files.added.some(item => item.workspace_file_id === after.workspace_file_id)).toBe(true);
  });

  it("reuses intrinsic file identity when the exact same path/content state is restored", async () => {
    const root = await createWorkspaceIndexFixture();
    const first = await baseline("wsi_reuse", root);
    const original = first.snapshot.files.find(file => file.relative_path === "src/util.ts")!;
    await unlink(path.join(root, "src", "util.ts"));
    const second = await indexWorkspace({ workspace_instance_id: "wsi_reuse", root_path: root, binding_type: "FIXTURE", previous_contract: first, indexing_session_id: "wsi_reuse_s2", started_at: time(2), completed_at: time(3) });
    await writeFile(path.join(root, "src", "util.ts"), "export function double(value: number) { return value * 2; }\n");
    const third = await indexWorkspace({ workspace_instance_id: "wsi_reuse", root_path: root, binding_type: "FIXTURE", previous_contract: second, indexing_session_id: "wsi_reuse_s3", started_at: time(4), completed_at: time(5) });
    const recreated = third.snapshot.files.find(file => file.relative_path === "src/util.ts")!;
    expect(recreated.workspace_file_id).toBe(original.workspace_file_id);
  });

  it("reconciles a valid derived Delta with the authoritative target snapshot", async () => {
    const root = await createWorkspaceIndexFixture();
    const first = await baseline("wsi_delta", root);
    await writeFile(path.join(root, "src", "util.ts"), "export const value = 7;\n");
    const second = await indexWorkspace({ workspace_instance_id: "wsi_delta", root_path: root, binding_type: "FIXTURE", previous_contract: first, indexing_session_id: "wsi_delta_s2", started_at: time(2), completed_at: time(3) });
    expect(validateWorkspaceIndexDelta({ base: first, target: second, delta: second.delta! }).accepted).toBe(true);
    expect(applyWorkspaceIndexDelta(first.snapshot, second.delta!)).toEqual(second.snapshot);
  });

  it("rejects a corrupt Delta without rejecting the valid target full snapshot", async () => {
    const root = await createWorkspaceIndexFixture();
    const first = await baseline("wsi_corrupt_delta", root);
    await writeFile(path.join(root, "src", "util.ts"), "export const changed = true;\n");
    const second = await indexWorkspace({ workspace_instance_id: "wsi_corrupt_delta", root_path: root, binding_type: "FIXTURE", previous_contract: first, indexing_session_id: "wsi_corrupt_delta_s2", started_at: time(2), completed_at: time(3) });
    const corruptDelta = structuredClone(second.delta!);
    corruptDelta.files.modified = [];
    const { integrity: _integrity, ...withoutIntegrity } = second;
    const corruptContract = finalizeWorkspaceIndexContract({ ...withoutIntegrity, delta: corruptDelta });
    const result = validateCanonicalWorkspaceIndexContract(corruptContract, { base_contract: first });
    expect(result.status).not.toBe("REJECTED");
    expect(result.delta_status).toBe("REJECTED");
    expect(result.contract?.delta).toBeNull();
    expect(result.contract?.snapshot).toEqual(second.snapshot);
  });

  it("accepts a full snapshot when Delta is absent", async () => {
    const value = await baseline("wsi_no_delta", await createWorkspaceIndexFixture());
    const { integrity: _integrity, ...withoutIntegrity } = value;
    const noDelta = finalizeWorkspaceIndexContract({ ...withoutIntegrity, delta: null });
    expect(validateCanonicalWorkspaceIndexContract(noDelta).status).not.toBe("REJECTED");
  });

  it("T18 canonical Delta semantic bytes/hash are independent from observation time for the same Artifact pair", async () => {
    const root = await createWorkspaceIndexFixture();
    const first = await baseline("wsi_delta_time_independent", root);
    await writeFile(path.join(root, "src", "util.ts"), "export const value = 99;\n");
    const second = await indexWorkspace({
      workspace_instance_id: "wsi_delta_time_independent", root_path: root, binding_type: "FIXTURE", previous_contract: first,
      indexing_session_id: "wsi_delta_time_independent_s2", started_at: time(2), completed_at: time(3),
    });
    const configSha = workspaceIndexConfigurationSha256(workspaceIndexConfigurationDescriptor());
    const firstState = canonicalIndexArtifactSemanticState(first);
    const secondState = canonicalIndexArtifactSemanticState(second);
    const firstArtifactId = canonicalIndexArtifactId(first.workspace.workspace_revision_id, configSha);
    const secondArtifactId = canonicalIndexArtifactId(second.workspace.workspace_revision_id, configSha);

    const deltaAtObservationA = deriveCanonicalIndexArtifactDelta({ fromArtifactId: firstArtifactId, toArtifactId: secondArtifactId, base: firstState, target: secondState });
    const deltaAtObservationB = deriveCanonicalIndexArtifactDelta({ fromArtifactId: firstArtifactId, toArtifactId: secondArtifactId, base: firstState, target: secondState });

    expect(canonicalJson(deltaAtObservationA)).toBe(canonicalJson(deltaAtObservationB));
    expect(sha256Canonical(deltaAtObservationA)).toBe(sha256Canonical(deltaAtObservationB));
    expect(canonicalJson(deltaAtObservationA)).not.toContain("generated_at");
    expect(validateCanonicalIndexArtifactDelta({ base: firstState, target: secondState, delta: deltaAtObservationA }).accepted).toBe(true);
  });

  it("T23 same-path content modification is one canonical logical file MODIFIED, not add+delete churn", async () => {
    const root = await createWorkspaceIndexFixture();
    const first = await baseline("wsi_canonical_same_path_modified", root);
    await writeFile(path.join(root, "src", "util.ts"), "export function double(value: number) { return value * 3; }\n");
    const second = await indexWorkspace({
      workspace_instance_id: "wsi_canonical_same_path_modified", root_path: root, binding_type: "FIXTURE",
      indexing_session_id: "wsi_canonical_same_path_modified_s2", started_at: time(2), completed_at: time(3),
    });
    const configSha = workspaceIndexConfigurationSha256(workspaceIndexConfigurationDescriptor());
    const firstState = canonicalIndexArtifactSemanticState(first);
    const secondState = canonicalIndexArtifactSemanticState(second);
    const before = firstState.snapshot.files.find(file => file.relative_path === "src/util.ts")!;
    const after = secondState.snapshot.files.find(file => file.relative_path === "src/util.ts")!;

    expect(after.workspace_file_id).toBe(before.workspace_file_id);
    expect(after.file_revision_id).not.toBe(before.file_revision_id);

    const delta = deriveCanonicalIndexArtifactDelta({
      fromArtifactId: canonicalIndexArtifactId(first.workspace.workspace_revision_id, configSha),
      toArtifactId: canonicalIndexArtifactId(second.workspace.workspace_revision_id, configSha),
      base: firstState,
      target: secondState,
    });
    expect(delta.files.modified.filter(item => item.after.workspace_file_id === before.workspace_file_id)).toHaveLength(1);
    expect(delta.files.added.some(item => item.relative_path === "src/util.ts")).toBe(false);
    expect(delta.files.deleted.some(item => item.relative_path === "src/util.ts")).toBe(false);
  });

  it("T24 facts in the same logical file remain comparable across a normal file modification", async () => {
    const root = await createWorkspaceIndexFixture();
    const first = await baseline("wsi_canonical_fact_stability", root);
    await writeFile(path.join(root, "src", "util.ts"), "export function double(value: number) { return value * 3; }\n");
    const second = await indexWorkspace({
      workspace_instance_id: "wsi_canonical_fact_stability", root_path: root, binding_type: "FIXTURE",
      indexing_session_id: "wsi_canonical_fact_stability_s2", started_at: time(2), completed_at: time(3),
    });
    const configSha = workspaceIndexConfigurationSha256(workspaceIndexConfigurationDescriptor());
    const firstState = canonicalIndexArtifactSemanticState(first);
    const secondState = canonicalIndexArtifactSemanticState(second);
    const beforeFile = firstState.snapshot.files.find(file => file.relative_path === "src/util.ts")!;
    const afterFile = secondState.snapshot.files.find(file => file.relative_path === "src/util.ts")!;
    const beforeFacts = firstState.snapshot.facts.filter(fact => fact.source_file_revision_id === beforeFile.file_revision_id);
    const afterFacts = secondState.snapshot.facts.filter(fact => fact.source_file_revision_id === afterFile.file_revision_id);
    const afterIds = new Set(afterFacts.map(fact => fact.workspace_fact_id));
    const stableFactIds = beforeFacts.map(fact => fact.workspace_fact_id).filter(id => afterIds.has(id));
    expect(beforeFacts.length).toBeGreaterThan(0);
    expect(stableFactIds.length).toBeGreaterThan(0);

    const delta = deriveCanonicalIndexArtifactDelta({
      fromArtifactId: canonicalIndexArtifactId(first.workspace.workspace_revision_id, configSha),
      toArtifactId: canonicalIndexArtifactId(second.workspace.workspace_revision_id, configSha),
      base: firstState,
      target: secondState,
    });
    for (const id of stableFactIds) {
      expect(delta.facts.removed.some(item => item.workspace_fact_id === id)).toBe(false);
      expect(delta.facts.added.some(item => item.workspace_fact_id === id)).toBe(false);
    }
    const afterRelationIds = new Set(secondState.snapshot.relations.map(relation => relation.workspace_relation_id));
    const stableRelationIds = firstState.snapshot.relations
      .map(relation => relation.workspace_relation_id)
      .filter(id => afterRelationIds.has(id));
    expect(stableRelationIds.length).toBeGreaterThan(0);
    for (const id of stableRelationIds) {
      expect(delta.relations.removed.some(item => item.workspace_relation_id === id)).toBe(false);
      expect(delta.relations.added.some(item => item.workspace_relation_id === id)).toBe(false);
    }
  });

});

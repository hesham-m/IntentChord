import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  canonicalIndexArtifactId,
  canonicalIndexArtifactSemanticSha256,
  canonicalIndexArtifactSemanticState,
  classifyWorkspaceObservation,
  workspaceIndexConfigurationDescriptor,
  workspaceIndexConfigurationSha256,
  workspaceIndexDeltaArtifactId,
} from "@/core/workspace-index/artifact-identity";
import { canonicalJson, workspaceTreeFingerprint } from "@/core/workspace-index/canonical";
import { buildMappingInputSnapshotFromCanonicalArtifact } from "@/core/ai-context-mapper/input-builder";
import { indexWorkspace } from "@/core/workspace-index/indexer";
import { createWorkspaceIndexFixture } from "@/test/workspace-index-helpers";

describe("Plane B1 source revision / artifact / observation identity", () => {
  const revisionA = `wsr_${"a".repeat(64)}`;
  const revisionB = `wsr_${"b".repeat(64)}`;
  const configC1 = workspaceIndexConfigurationDescriptor();
  const configC2 = { ...configC1, deep_parse_bytes: configC1.deep_parse_bytes + 1 };
  const configC1Sha = workspaceIndexConfigurationSha256(configC1);
  const configC2Sha = workspaceIndexConfigurationSha256(configC2);
  const artifactA1 = canonicalIndexArtifactId(revisionA, configC1Sha);
  const artifactA2 = canonicalIndexArtifactId(revisionA, configC2Sha);
  const artifactB1 = canonicalIndexArtifactId(revisionB, configC1Sha);

  it("keeps Source Revision independent from Index configuration", () => {
    expect(configC2Sha).not.toBe(configC1Sha);
    expect(artifactA2).not.toBe(artifactA1);
    expect(artifactA1).toMatch(/^cia_[0-9a-f]{64}$/);
    expect(artifactA2).toMatch(/^cia_[0-9a-f]{64}$/);
  });

  it("classifies first, unchanged, changed, restored, and index-refreshed observations without inventing revisions", () => {
    expect(classifyWorkspaceObservation({ currentRevisionId: revisionA, currentArtifactId: artifactA1, revisionWasKnown: false })).toBe("FIRST_INDEXED");
    expect(classifyWorkspaceObservation({ previousRevisionId: revisionA, previousArtifactId: artifactA1, currentRevisionId: revisionA, currentArtifactId: artifactA1, revisionWasKnown: true })).toBe("SOURCE_UNCHANGED");
    expect(classifyWorkspaceObservation({ previousRevisionId: revisionA, previousArtifactId: artifactA1, currentRevisionId: revisionB, currentArtifactId: artifactB1, revisionWasKnown: false })).toBe("SOURCE_CHANGED");
    expect(classifyWorkspaceObservation({ previousRevisionId: revisionB, previousArtifactId: artifactB1, currentRevisionId: revisionA, currentArtifactId: artifactA1, revisionWasKnown: true })).toBe("KNOWN_STATE_RESTORED");
    expect(classifyWorkspaceObservation({ previousRevisionId: revisionA, previousArtifactId: artifactA1, currentRevisionId: revisionA, currentArtifactId: artifactA2, revisionWasKnown: true })).toBe("SOURCE_UNCHANGED_INDEX_REFRESHED");
  });

  it("binds Delta artifact identity to FROM and TO Canonical Index Artifacts", () => {
    const forward = workspaceIndexDeltaArtifactId({ fromArtifactId: artifactA1, toArtifactId: artifactB1 });
    const reverse = workspaceIndexDeltaArtifactId({ fromArtifactId: artifactB1, toArtifactId: artifactA1 });
    expect(forward).not.toBe(reverse);
    expect(forward).toMatch(/^wida_[0-9a-f]{64}$/);
  });

  it("T16 same exact Source State + Config reached through different lineage paths yields the same intrinsic Canonical Artifact", async () => {
    const rootWithHistory = await createWorkspaceIndexFixture();
    const rootDirect = await createWorkspaceIndexFixture();
    const instance = "wsi_b1_history_independence";

    const predecessor = await indexWorkspace({
      workspace_instance_id: instance, root_path: rootWithHistory, binding_type: "FIXTURE", indexing_session_id: "history-a",
      started_at: "2026-08-12T00:00:00.000Z", completed_at: "2026-08-12T00:00:01.000Z",
    });
    await rename(path.join(rootWithHistory, "src", "util.ts"), path.join(rootWithHistory, "src", "helper.ts"));
    const viaRename = await indexWorkspace({
      workspace_instance_id: instance, root_path: rootWithHistory, binding_type: "FIXTURE", previous_contract: predecessor, indexing_session_id: "history-b",
      started_at: "2026-08-12T00:00:02.000Z", completed_at: "2026-08-12T00:00:03.000Z",
      git_enrichment: { rename_hints: [{ from_relative_path: "src/util.ts", to_relative_path: "src/helper.ts", confidence: "PROVEN", evidence: "fixture" }], diagnostics: [] },
    });

    await rename(path.join(rootDirect, "src", "util.ts"), path.join(rootDirect, "src", "helper.ts"));
    const direct = await indexWorkspace({
      workspace_instance_id: instance, root_path: rootDirect, binding_type: "FIXTURE", indexing_session_id: "direct",
      started_at: "2026-08-12T01:00:00.000Z", completed_at: "2026-08-12T01:00:01.000Z",
    });

    expect(viaRename.workspace.workspace_revision_id).toBe(direct.workspace.workspace_revision_id);
    const configSha = workspaceIndexConfigurationSha256(workspaceIndexConfigurationDescriptor());
    expect(canonicalIndexArtifactId(viaRename.workspace.workspace_revision_id, configSha)).toBe(
      canonicalIndexArtifactId(direct.workspace.workspace_revision_id, configSha),
    );
    expect(canonicalIndexArtifactSemanticSha256(viaRename)).toBe(canonicalIndexArtifactSemanticSha256(direct));
    expect(canonicalJson(canonicalIndexArtifactSemanticState(viaRename))).toBe(canonicalJson(canonicalIndexArtifactSemanticState(direct)));
  });

  it("T17 intrinsic Canonical Artifact state ignores observation-only predecessor and generation lineage", async () => {
    const contract = await indexWorkspace({
      workspace_instance_id: "wsi_b1_intrinsic_projection", root_path: await createWorkspaceIndexFixture(), binding_type: "FIXTURE", indexing_session_id: "intrinsic-a",
      started_at: "2026-08-12T02:00:00.000Z", completed_at: "2026-08-12T02:00:01.000Z",
    });
    const variant = structuredClone(contract);
    variant.workspace.previous_revision_id = `wsr_${"f".repeat(64)}`;
    variant.generation.indexing_session_id = "different-observation";
    variant.generation.started_at = "2030-01-01T00:00:00.000Z";
    variant.generation.completed_at = "2030-01-01T00:00:01.000Z";
    for (const file of variant.snapshot.files) {
      file.lineage_state = "CONTINUED";
      file.previous_file_revision_id = `fir_${"e".repeat(64)}`;
    }
    expect(canonicalJson(canonicalIndexArtifactSemanticState(variant))).toBe(canonicalJson(canonicalIndexArtifactSemanticState(contract)));
    expect(canonicalIndexArtifactSemanticSha256(variant)).toBe(canonicalIndexArtifactSemanticSha256(contract));
  });


  it("T29 unrelated file change preserves unaffected File Revision locality", async () => {
    const root = await createWorkspaceIndexFixture();
    await mkdir(path.join(root, "src", "locality"), { recursive: true });
    await writeFile(path.join(root, "src", "locality", "A.ts"), "export const A = 'H1';\n");
    await writeFile(path.join(root, "src", "locality", "B.ts"), "export const B = 'H2';\n");
    await writeFile(path.join(root, "src", "locality", "C.ts"), "export const C = 'H3';\n");
    const first = await indexWorkspace({ workspace_instance_id: "wsi_t29", root_path: root, binding_type: "FIXTURE" });
    await writeFile(path.join(root, "src", "locality", "C.ts"), "export const C = 'H4';\n");
    const second = await indexWorkspace({ workspace_instance_id: "wsi_t29", root_path: root, binding_type: "FIXTURE" });
    const a = canonicalIndexArtifactSemanticState(first);
    const b = canonicalIndexArtifactSemanticState(second);
    const file = (state: typeof a, relativePath: string) => state.snapshot.files.find(item => item.relative_path === relativePath)!;
    expect(file(b, "src/locality/A.ts").workspace_file_id).toBe(file(a, "src/locality/A.ts").workspace_file_id);
    expect(file(b, "src/locality/A.ts").file_revision_id).toBe(file(a, "src/locality/A.ts").file_revision_id);
    expect(file(b, "src/locality/B.ts").file_revision_id).toBe(file(a, "src/locality/B.ts").file_revision_id);
    expect(file(b, "src/locality/C.ts").workspace_file_id).toBe(file(a, "src/locality/C.ts").workspace_file_id);
    expect(file(b, "src/locality/C.ts").file_revision_id).not.toBe(file(a, "src/locality/C.ts").file_revision_id);
  });

  it("T30/T31 unaffected Fact and Relation revisions remain local when another file changes", async () => {
    const root = await createWorkspaceIndexFixture();
    const first = await indexWorkspace({ workspace_instance_id: "wsi_t30_t31", root_path: root, binding_type: "FIXTURE" });
    const firstState = canonicalIndexArtifactSemanticState(first);
    await writeFile(path.join(root, "README.md"), "# unrelated workspace documentation change\n");
    const second = await indexWorkspace({ workspace_instance_id: "wsi_t30_t31", root_path: root, binding_type: "FIXTURE" });
    const secondState = canonicalIndexArtifactSemanticState(second);
    const utilBefore = firstState.snapshot.files.find(file => file.relative_path === "src/util.ts")!;
    const utilAfter = secondState.snapshot.files.find(file => file.relative_path === "src/util.ts")!;
    expect(utilAfter.file_revision_id).toBe(utilBefore.file_revision_id);
    const factsBefore = firstState.snapshot.facts.filter(fact => fact.source_file_revision_id === utilBefore.file_revision_id);
    const factsAfter = new Map(secondState.snapshot.facts.map(fact => [fact.workspace_fact_id, fact]));
    expect(factsBefore.length).toBeGreaterThan(0);
    for (const fact of factsBefore) {
      expect(factsAfter.get(fact.workspace_fact_id)?.fact_revision_id).toBe(fact.fact_revision_id);
    }
    const relationsAfter = new Map(secondState.snapshot.relations.map(relation => [relation.workspace_relation_id, relation]));
    const stableRelations = firstState.snapshot.relations.filter(relation => relationsAfter.has(relation.workspace_relation_id));
    expect(stableRelations.length).toBeGreaterThan(0);
    for (const relation of stableRelations) {
      expect(relationsAfter.get(relation.workspace_relation_id)?.relation_revision_id).toBe(relation.relation_revision_id);
    }
  });

  it("T32 Registered B1 Mapping entries for unaffected entities remain stable across an unrelated file change", async () => {
    const root = await createWorkspaceIndexFixture();
    const first = await indexWorkspace({ workspace_instance_id: "wsi_t32", root_path: root, binding_type: "FIXTURE" });
    await writeFile(path.join(root, "README.md"), "# changed only documentation\n");
    const second = await indexWorkspace({ workspace_instance_id: "wsi_t32", root_path: root, binding_type: "FIXTURE" });
    const configSha = workspaceIndexConfigurationSha256(workspaceIndexConfigurationDescriptor());
    const stateA = canonicalIndexArtifactSemanticState(first);
    const stateB = canonicalIndexArtifactSemanticState(second);
    const inputA = buildMappingInputSnapshotFromCanonicalArtifact({
      canonicalIndexArtifactId: canonicalIndexArtifactId(first.workspace.workspace_revision_id, configSha),
      artifactSemanticSha256: canonicalIndexArtifactSemanticSha256(first), semanticState: stateA,
    }, { createdAt: "2026-08-12T10:00:00.000Z" });
    const inputB = buildMappingInputSnapshotFromCanonicalArtifact({
      canonicalIndexArtifactId: canonicalIndexArtifactId(second.workspace.workspace_revision_id, configSha),
      artifactSemanticSha256: canonicalIndexArtifactSemanticSha256(second), semanticState: stateB,
    }, { createdAt: "2030-08-12T10:00:00.000Z" });
    const utilA = inputA.entries.find(entry => entry.normalized_path === "src/util.ts")!;
    const utilB = inputB.entries.find(entry => entry.normalized_path === "src/util.ts")!;
    expect(canonicalJson(utilB)).toBe(canonicalJson(utilA));
  });

  it("T35 Source fingerprint is independent from index/classification policy interpretation", async () => {
    const root = await createWorkspaceIndexFixture();
    const contract = await indexWorkspace({ workspace_instance_id: "wsi_t35", root_path: root, binding_type: "FIXTURE" });
    const variant = structuredClone(contract.snapshot);
    variant.files[0].sensitivity_state = variant.files[0].sensitivity_state === "NORMAL" ? "SENSITIVE" : "NORMAL";
    variant.files[0].metadata_hash = `sha256:${"f".repeat(64)}`;
    variant.files[0].language = "policy-reclassified";
    expect(workspaceTreeFingerprint(variant)).toBe(workspaceTreeFingerprint(contract.snapshot));
    const c1 = workspaceIndexConfigurationDescriptor();
    const c2 = { ...c1, sensitivity_policy_id: "intentchord.workspace-sensitivity-classification/v2" as typeof c1.sensitivity_policy_id };
    const c1Sha = workspaceIndexConfigurationSha256(c1);
    const c2Sha = workspaceIndexConfigurationSha256(c2);
    expect(c2Sha).not.toBe(c1Sha);
    expect(canonicalIndexArtifactId(contract.workspace.workspace_revision_id, c2Sha)).not.toBe(canonicalIndexArtifactId(contract.workspace.workspace_revision_id, c1Sha));
  });

  it("T41 revision-significant Fact/Relation fields change intrinsic revisions while container-only provenance does not", async () => {
    const contract = await indexWorkspace({ workspace_instance_id: "wsi_t41", root_path: await createWorkspaceIndexFixture(), binding_type: "FIXTURE" });
    const base = canonicalIndexArtifactSemanticState(contract);
    const fact = contract.snapshot.facts[0]!;
    const originalFact = base.snapshot.facts.find(item => item.qualified_name === fact.qualified_name)!;
    const factVariant = structuredClone(contract);
    factVariant.snapshot.facts.find(item => item.fact_revision_id === fact.fact_revision_id)!.display_name += " changed";
    const changedFact = canonicalIndexArtifactSemanticState(factVariant).snapshot.facts.find(item => item.workspace_fact_id === originalFact.workspace_fact_id)!;
    expect(changedFact.fact_revision_id).not.toBe(originalFact.fact_revision_id);

    const transportVariant = structuredClone(contract);
    transportVariant.snapshot.facts[0].provenance.workspace_revision_id = `wsr_${"e".repeat(64)}`;
    const transportState = canonicalIndexArtifactSemanticState(transportVariant);
    expect(transportState.snapshot.facts.find(item => item.workspace_fact_id === originalFact.workspace_fact_id)?.fact_revision_id).toBe(originalFact.fact_revision_id);

    const relation = contract.snapshot.relations[0]!;
    const relationVariant = structuredClone(contract);
    relationVariant.snapshot.relations[0].certainty = relation.certainty === "EXACT" ? "DERIVED" : "EXACT";
    const relationChangedState = canonicalIndexArtifactSemanticState(relationVariant);
    const relationChangedById = new Map(relationChangedState.snapshot.relations.map(item => [item.workspace_relation_id, item]));
    const changedRelationRevisions = base.snapshot.relations.filter(item =>
      relationChangedById.get(item.workspace_relation_id)?.relation_revision_id !== item.relation_revision_id,
    );
    expect(changedRelationRevisions).toHaveLength(1);
  });


  it("T50 revision-significant Relation evidence provenance participates in intrinsic Relation Revision identity", async () => {
    const contract = await indexWorkspace({ workspace_instance_id: "wsi_t50", root_path: await createWorkspaceIndexFixture(), binding_type: "FIXTURE" });
    const relationIndex = contract.snapshot.relations.findIndex(item => item.evidence_refs.length > 0);
    expect(relationIndex).not.toBe(-1);
    const relation = contract.snapshot.relations[relationIndex];
    const evidenceHash = relation.evidence_refs[0].evidence_hash;
    const baseState = canonicalIndexArtifactSemanticState(contract);
    const baseRelation = baseState.snapshot.relations.find(item =>
      item.relation_type === relation.relation_type
      && item.direction === relation.direction
      && item.evidence_refs.some(ref => ref.evidence_hash === evidenceHash)
    )!;
    expect(baseRelation).toBeTruthy();

    const variant = structuredClone(contract);
    const target = variant.snapshot.relations[relationIndex];
    target.evidence_refs[0].extractor_version = `${target.evidence_refs[0].extractor_version ?? "unknown"}-changed`;
    const variantState = canonicalIndexArtifactSemanticState(variant);
    const changed = variantState.snapshot.relations.find(item =>
      item.workspace_relation_id === baseRelation.workspace_relation_id
      && item.evidence_refs.some(ref => ref.evidence_hash === evidenceHash)
    )!;
    expect(changed).toBeTruthy();

    expect(changed.workspace_relation_id).toBe(baseRelation.workspace_relation_id);
    expect(changed.relation_revision_id).not.toBe(baseRelation.relation_revision_id);
    expect(changed.evidence_refs[0].extractor_version).not.toBe(baseRelation.evidence_refs[0].extractor_version);
  });

});

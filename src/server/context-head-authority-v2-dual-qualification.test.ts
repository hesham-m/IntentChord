import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createBlankTaskDraft } from "@/core/tasks/task-input";

const head = readFileSync(resolve(process.cwd(), "src/server/context-head-authority.ts"), "utf8");

function unifiedDraft() {
  return {
    ...createBlankTaskDraft("SOURCE_IMPLEMENTATION"),
    orchestrationVersion: "UNIFIED_V1" as const,
    objective: "Test V2 dual authority.",
    workspaces: [{
      id: "00000000-0000-0000-0000-000000000001",
      displayName: "Test Workspace",
      role: "primary",
      referenceType: "LOCAL_PATH" as const,
      source: "MANUAL_VERIFIED" as const,
      reference: "E:/server",
      fingerprint: "sha256:" + "a".repeat(64),
      discoveryScopeMode: "SELECTED_PATHS" as const,
      allowedPaths: ["src"],
      excludedPaths: [],
      authorizationContext: "owner",
      ordering: 0,
    }],
  };
}

function makeClient(rows: Record<string, unknown>[]) {
  return {
    query: async (sql: string) => {
      if (sql.includes("from intentchord.workspaces")) {
        return { rowCount: 1, rows: [{ id: "00000000-0000-0000-0000-000000000001", revision: 3, fingerprint: "sha256:" + "a".repeat(64), verification_status: "VERIFIED" }] };
      }
      if (sql.includes("from lateral")) return { rowCount: rows.length ? 1 : 0, rows };
      throw new Error("UNEXPECTED_SQL:" + sql);
    },
  } as any;
}

function v1Row(overrides: Record<string, unknown> = {}) {
  return {
    observation_id: "obs-v1",
    authority_sequence: 10,
    observation_result: "SOURCE_PROVEN_INDEX_SUCCEEDED",
    workspace_revision_id: "wsr_v1",
    canonical_index_artifact_id: "cia_v1",
    accepted_workspace_evidence_artifact_id: null,
    index_configuration_sha256: "sha256:" + "b".repeat(64),
    snapshot_id: "snap-00000000-0001-0001-0001-000000000001",
    snapshot_status: "READY",
    snapshot_attempt_status: "SUCCEEDED",
    snapshot_registration_revision: 3,
    snapshot_registration_fingerprint: "sha256:" + "a".repeat(64),
    snapshot_workspace_revision_id: "wsr_v1",
    snapshot_artifact_id: "cia_v1",
    snapshot_canonical_sha256: "sha256:" + "c".repeat(64),
    snapshot_evidence_artifact_id: null,
    snapshot_source_continuity_attestation_id: null,
    artifact_id: "cia_v1",
    artifact_semantic_sha256: "sha256:" + "d".repeat(64),
    artifact_semantic_json: { schema_version: "test" },
    evidence_artifact_id: null,
    evidence_artifact_semantic_sha256: null,
    ...overrides,
  };
}

function v2Row(overrides: Record<string, unknown> = {}) {
  return {
    observation_id: "obs-v2",
    authority_sequence: 20,
    observation_result: "SOURCE_PROVEN_INDEX_SUCCEEDED",
    workspace_revision_id: "wsr_v2",
    canonical_index_artifact_id: null,
    accepted_workspace_evidence_artifact_id: "wea_v2",
    index_configuration_sha256: "sha256:" + "b".repeat(64),
    snapshot_id: "snap-00000000-0002-0002-0002-000000000002",
    snapshot_status: "READY",
    snapshot_attempt_status: "SUCCEEDED",
    snapshot_registration_revision: 3,
    snapshot_registration_fingerprint: "sha256:" + "a".repeat(64),
    snapshot_workspace_revision_id: "wsr_v2",
    snapshot_artifact_id: null,
    snapshot_canonical_sha256: null,
    snapshot_evidence_artifact_id: "wea_v2",
    snapshot_source_continuity_attestation_id: "sca-att-1",
    artifact_id: null,
    artifact_semantic_sha256: null,
    artifact_semantic_json: null,
    evidence_artifact_id: "wea_v2",
    evidence_artifact_semantic_sha256: "sha256:" + "e".repeat(64),
    ...overrides,
  };
}

async function capture(client: ReturnType<typeof makeClient>) {
  const { captureLockedTaskSourceAuthority } = await import("@/server/context-head-authority");
  return captureLockedTaskSourceAuthority(client, unifiedDraft());
}

describe("context-head-authority V1/V2 dual authority qualification", () => {
  it("T01: V1 CIA authority is rejected (CIA_CURRENT_AUTHORITY_REJECTED)", async () => {
    await expect(capture(makeClient([v1Row()]))).rejects.toMatchObject({
      code: "CURRENT_SOURCE_AUTHORITY_UNPROVEN",
    });
  });

  it("T02: V2 qualified authority resolves successfully", async () => {
    const proof = await capture(makeClient([v2Row()]));
    expect(proof.sources[0].observationId).toBe("obs-v2");
    expect(proof.sources[0].canonicalIndexArtifactId).toBe("wea_v2");
    expect(proof.sources[0].workspaceIndexSha256).toBe("sha256:" + "e".repeat(64));
    expect(proof.sources[0].artifactSemanticSha256).toBe("sha256:" + "e".repeat(64));
    expect(proof.sources[0].artifactSemanticState).toEqual({
      workspace_instance_id: "00000000-0000-0000-0000-000000000001",
      workspace_revision_id: "wsr_v2",
      evidence_artifact_id: "wea_v2",
    });
  });

  it("T03: both canonical_index_artifact_id and accepted_workspace_evidence_artifact_id null is UNPROVEN", async () => {
    await expect(capture(makeClient([v1Row({
      canonical_index_artifact_id: null,
      accepted_workspace_evidence_artifact_id: null,
      snapshot_artifact_id: null,
      snapshot_canonical_sha256: null,
      artifact_id: null,
      artifact_semantic_sha256: null,
      artifact_semantic_json: null,
    })]))).rejects.toMatchObject({ code: "CURRENT_SOURCE_AUTHORITY_UNPROVEN" });
  });

  it("T04: both canonical_index_artifact_id and accepted_workspace_evidence_artifact_id non-null is UNPROVEN", async () => {
    await expect(capture(makeClient([v1Row({
      accepted_workspace_evidence_artifact_id: "wea_extra",
    })]))).rejects.toMatchObject({ code: "CURRENT_SOURCE_AUTHORITY_UNPROVEN" });
  });

  it("T05: V2 observation but snapshot evidence artifact missing is UNPROVEN", async () => {
    await expect(capture(makeClient([v2Row({
      snapshot_evidence_artifact_id: null,
    })]))).rejects.toMatchObject({ code: "CURRENT_SOURCE_AUTHORITY_UNPROVEN" });
  });

  it("T06: V2 observation but evidence artifact semantic sha256 missing is UNPROVEN", async () => {
    await expect(capture(makeClient([v2Row({
      evidence_artifact_semantic_sha256: null,
    })]))).rejects.toMatchObject({ code: "CURRENT_SOURCE_AUTHORITY_UNPROVEN" });
  });

  it("T07: V2 observation but continuity attestation missing is UNPROVEN", async () => {
    await expect(capture(makeClient([v2Row({
      snapshot_source_continuity_attestation_id: null,
    })]))).rejects.toMatchObject({ code: "CURRENT_SOURCE_AUTHORITY_UNPROVEN" });
  });

  it("T08: V2 observation but snapshot not READY is UNPROVEN", async () => {
    await expect(capture(makeClient([v2Row({
      snapshot_status: "FINALIZING",
    })]))).rejects.toMatchObject({ code: "CURRENT_SOURCE_AUTHORITY_UNPROVEN" });
  });

  it("T09: V2 observation but index attempt not SUCCEEDED is UNPROVEN", async () => {
    await expect(capture(makeClient([v2Row({
      snapshot_attempt_status: "PENDING",
    })]))).rejects.toMatchObject({ code: "CURRENT_SOURCE_AUTHORITY_UNPROVEN" });
  });

  it("T10: V2 observation but snapshot evidence artifact ID mismatch is UNPROVEN", async () => {
    await expect(capture(makeClient([v2Row({
      snapshot_evidence_artifact_id: "wea_wrong",
    })]))).rejects.toMatchObject({ code: "CURRENT_SOURCE_AUTHORITY_UNPROVEN" });
  });

  it("T11: query includes workspace_evidence_artifacts join and V2 observation fields", () => {
    expect(head).toContain("h.accepted_workspace_evidence_artifact_id");
    expect(head).toContain("left join intentchord.workspace_evidence_artifacts wea");
    expect(head).toContain("wea.id=h.accepted_workspace_evidence_artifact_id");
    expect(head).toContain("s.accepted_workspace_evidence_artifact_id as snapshot_evidence_artifact_id");
    expect(head).toContain("s.source_continuity_attestation_id as snapshot_source_continuity_attestation_id");
    expect(head).toContain("wea.artifact_semantic_sha256 as evidence_artifact_semantic_sha256");
  });

  it("T12: qualification predicate enforces V2-only WEA authority (V1 CIA authority eliminated)", () => {
    expect(head).toContain("isV2Authority");
    expect(head).toContain("v2Qualified");
    expect(head).toContain("const qualified = baseQualified && v2Qualified;");
    expect(head).not.toContain("baseQualified && (v1Qualified || v2Qualified)");
  });

  it("T13: V2 output mapping uses WEA ID for canonicalIndexArtifactId and evidence sha256 for workspaceIndexSha256", () => {
    expect(head).toContain('canonicalIndexArtifactId: row.accepted_workspace_evidence_artifact_id!');
    expect(head).toContain('workspaceIndexSha256: row.evidence_artifact_semantic_sha256!');
    expect(head).toContain('artifactSemanticSha256: row.evidence_artifact_semantic_sha256!');
  });
});

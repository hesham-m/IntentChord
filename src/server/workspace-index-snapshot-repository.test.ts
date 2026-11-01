import { beforeEach, describe, expect, it, vi } from "vitest";
import { sampleCanonicalWorkspaceIndex } from "@/core/ai-context-mapper/test-fixtures";

const dbMocks = vi.hoisted(() => ({
  databaseQuery: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock("@/server/db", () => dbMocks);

import { PostgresWorkspaceIndexSnapshotRepository } from "@/server/workspace-index-snapshot-repository";

const workspaceRegistrationId = "11111111-1111-4111-8111-111111111111";
const workspaceRevisionId = "wsr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const canonicalIndexArtifactId = "cia_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const indexConfigurationSha256 = "sha256:" + "c".repeat(64);

function selectResult(rows: Record<string, unknown>[]) {
  return {
    command: "SELECT",
    rowCount: rows.length,
    oid: 0,
    fields: [],
    rows,
  };
}

describe("PostgresWorkspaceIndexSnapshotRepository terminal failure safety", () => {
  beforeEach(() => {
    dbMocks.databaseQuery.mockReset();
    dbMocks.transaction.mockReset();
  });

  it("T04 keeps progress mutation bound to status='CREATING' so a late updateProgress cannot mutate a terminal FAILED Snapshot", async () => {
    dbMocks.databaseQuery.mockResolvedValueOnce(selectResult([]));
    const repository = new PostgresWorkspaceIndexSnapshotRepository();
    await repository.updateProgress({
      id: "60cde623-b1d3-48a5-8820-06302092d0bf",
      phase: "HASHING",
      evidence: { late: true },
      heartbeatAt: "2026-08-24T15:46:00.000Z",
    });
    expect(dbMocks.databaseQuery).toHaveBeenCalledTimes(1);
    const [sql, values] = dbMocks.databaseQuery.mock.calls[0];
    expect(sql).toContain("update intentchord.workspace_index_snapshots set progress_phase=$2,progress_evidence=$3,heartbeat_at=$4");
    expect(sql).toContain("where id=$1 and status='CREATING'");
    expect(values).toEqual([
      "60cde623-b1d3-48a5-8820-06302092d0bf",
      "HASHING",
      JSON.stringify({ late: true }),
      "2026-08-24T15:46:00.000Z",
    ]);
  });

  it("T04b transitions terminal FAILED only from status='CREATING' and falls back to the authoritative read when the guard blocks", async () => {
    dbMocks.databaseQuery
      .mockResolvedValueOnce(selectResult([]))
      .mockResolvedValueOnce(selectResult([]));
    const repository = new PostgresWorkspaceIndexSnapshotRepository();
    await expect(repository.fail({
      id: "60cde623-b1d3-48a5-8820-06302092d0bf",
      failureCode: "WORKSPACE_INDEX_SNAPSHOT_FAILED",
      safeFailureEvidence: { code: "WORKSPACE_INDEX_SNAPSHOT_FAILED" },
      completedAt: "2026-08-24T15:44:22.638Z",
    })).rejects.toMatchObject({ code: "WORKSPACE_INDEX_SNAPSHOT_NOT_FOUND" });
    expect(dbMocks.databaseQuery).toHaveBeenCalledTimes(2);
    const [failSql] = dbMocks.databaseQuery.mock.calls[0];
    expect(failSql).toContain("set status='FAILED',failure_code=$2,safe_failure_evidence=$3,completed_at=$4,progress_phase='FAILED'");
    expect(failSql).toContain("where id=$1 and status='CREATING'");
    const [readSql] = dbMocks.databaseQuery.mock.calls[1];
    expect(readSql).toContain("from intentchord.workspace_index_snapshots");
    expect(readSql).toContain("where id=$1");
  });
});

describe("PostgresWorkspaceIndexSnapshotRepository.readLatestResolvedArtifact", () => {
  beforeEach(() => {
    dbMocks.databaseQuery.mockReset();
    dbMocks.transaction.mockReset();
  });

  it("reads the latest Observation-specific V1 projection/hash from its exact Snapshot while proving the same bound Canonical Artifact", async () => {
    const canonicalIndex = sampleCanonicalWorkspaceIndex();
    canonicalIndex.source_binding = {
      ...canonicalIndex.source_binding,
      source_binding_id: "sbi_observation_2",
      normalized_reference: "E:/workspace/binding-y",
    };
    canonicalIndex.workspace = {
      ...canonicalIndex.workspace,
      source_binding_id: canonicalIndex.source_binding.source_binding_id,
    };
    canonicalIndex.generation = {
      ...canonicalIndex.generation,
      indexing_session_id: "session-observation-2",
      started_at: "2026-08-13T07:10:00.000Z",
      completed_at: "2026-08-13T07:10:01.000Z",
    };
    const observation1Sha256 = "sha256:" + "1".repeat(64);
    const observation2Sha256 = "sha256:" + "2".repeat(64);
    expect(observation2Sha256).not.toBe(observation1Sha256);
    dbMocks.databaseQuery.mockResolvedValueOnce(selectResult([{
      id: "obs_00000000-0000-4000-8000-000000000001",
      workspace_revision_id: workspaceRevisionId,
      canonical_index_artifact_id: canonicalIndexArtifactId,
      observation_result: "SOURCE_CHANGED",
      observed_at: "2026-08-13T07:00:00.000Z",
      authority_sequence: "41",
      index_configuration_sha256: indexConfigurationSha256,
      canonical_index_json: canonicalIndex,
      canonical_sha256: observation2Sha256,
    }]));

    const repository = new PostgresWorkspaceIndexSnapshotRepository();
    const resolved = await repository.readLatestResolvedArtifact(workspaceRegistrationId);

    expect(resolved).toEqual({
      observationId: "obs_00000000-0000-4000-8000-000000000001",
      workspaceRevisionId,
      canonicalIndexArtifactId,
      observationResult: "SOURCE_CHANGED",
      observedAt: "2026-08-13T07:00:00.000Z",
      indexConfigurationSha256,
      canonicalIndex,
      canonicalSha256: observation2Sha256,
    });

    const [sql, values] = dbMocks.databaseQuery.mock.calls[0];
    expect(values).toEqual([workspaceRegistrationId]);
    expect(sql).toContain("s.canonical_index_json,s.canonical_sha256");
    expect(sql).not.toContain("a.canonical_index_json,a.canonical_sha256");
    expect(sql).toContain("join intentchord.workspace_index_snapshots s");
    expect(sql).toContain("a.id=o.canonical_index_artifact_id");
    expect(sql).toContain("a.workspace_registration_id=o.workspace_registration_id");
    expect(sql).toContain("a.workspace_revision_id=o.workspace_revision_id");
    expect(sql).toContain("a.index_configuration_sha256=o.index_configuration_sha256");
    expect(sql).toContain("s.id=o.snapshot_operation_id");
    expect(sql).toContain("s.workspace_registration_id=o.workspace_registration_id");
    expect(sql).toContain("s.workspace_observation_id=o.id");
    expect(sql).toContain("s.workspace_revision_id=o.workspace_revision_id");
    expect(sql).toContain("s.canonical_index_artifact_id=o.canonical_index_artifact_id");
    expect(sql).toContain("s.index_configuration_sha256=o.index_configuration_sha256");
    expect(sql).toContain("s.observation_result=o.observation_result");
    expect(sql).toContain("s.delta_artifact_id is not distinct from o.delta_artifact_id");
    expect(sql).toContain("s.source_mode='REGISTERED_WORKSPACE'");
    expect(sql).toContain("s.status='READY'");
    expect(sql).toContain("s.index_attempt_status='SUCCEEDED'");
    expect(sql).toContain("s.canonical_index_json is not null");
    expect(sql).toContain("s.canonical_sha256 is not null");
    expect(resolved?.canonicalIndex.source_binding.source_binding_id).toBe("sbi_observation_2");
    expect(resolved?.canonicalIndex.source_binding.normalized_reference).toBe("E:/workspace/binding-y");
    expect(resolved?.canonicalIndex.generation.indexing_session_id).toBe("session-observation-2");
    expect(resolved?.canonicalSha256).toBe(observation2Sha256);
  });

  it("does not resolve a failed Observation or any Observation whose exact Artifact binding does not join", async () => {
    dbMocks.databaseQuery.mockResolvedValueOnce(selectResult([]));

    const repository = new PostgresWorkspaceIndexSnapshotRepository();
    await expect(repository.readLatestResolvedArtifact(workspaceRegistrationId)).resolves.toBeUndefined();

    const [sql] = dbMocks.databaseQuery.mock.calls[0];
    expect(sql).toContain("join intentchord.canonical_index_artifacts a");
    expect(sql).toContain("o.canonical_index_artifact_id is not null");
    expect(sql).toContain("a.workspace_registration_id=o.workspace_registration_id");
    expect(sql).toContain("a.workspace_revision_id=o.workspace_revision_id");
    expect(sql).toContain("a.index_configuration_sha256=o.index_configuration_sha256");
    expect(sql).toContain("join intentchord.workspace_index_snapshots s");
    expect(sql).toContain("s.id=o.snapshot_operation_id");
    expect(sql).toContain("s.workspace_observation_id=o.id");
    expect(sql).toContain("s.status='READY'");
    expect(sql).toContain("s.index_attempt_status='SUCCEEDED'");
  });

  it("preserves repeated-observation history while reusing one intrinsic Artifact and returning each Observation's own projection", async () => {
    const firstProjection = sampleCanonicalWorkspaceIndex();
    firstProjection.source_binding = {
      ...firstProjection.source_binding,
      source_binding_id: "sbi_repeat_x",
      normalized_reference: "E:/workspace/repeat-x",
    };
    firstProjection.workspace = { ...firstProjection.workspace, source_binding_id: firstProjection.source_binding.source_binding_id };

    const secondProjection = sampleCanonicalWorkspaceIndex();
    secondProjection.source_binding = {
      ...secondProjection.source_binding,
      source_binding_id: "sbi_repeat_y",
      normalized_reference: "E:/workspace/repeat-y",
    };
    secondProjection.workspace = { ...secondProjection.workspace, source_binding_id: secondProjection.source_binding.source_binding_id };
    secondProjection.generation = { ...secondProjection.generation, indexing_session_id: "session-repeat-y" };

    const firstSha256 = "sha256:" + "a".repeat(64);
    const secondSha256 = "sha256:" + "b".repeat(64);

    dbMocks.databaseQuery
      .mockResolvedValueOnce(selectResult([{
        id: "obs_00000000-0000-4000-8000-000000000010",
        workspace_revision_id: workspaceRevisionId,
        canonical_index_artifact_id: canonicalIndexArtifactId,
        observation_result: "SOURCE_UNCHANGED",
        observed_at: "2026-08-13T07:10:00.000Z",
        authority_sequence: "50",
        index_configuration_sha256: indexConfigurationSha256,
        canonical_index_json: firstProjection,
        canonical_sha256: firstSha256,
      }]))
      .mockResolvedValueOnce(selectResult([{
        id: "obs_00000000-0000-4000-8000-000000000011",
        workspace_revision_id: workspaceRevisionId,
        canonical_index_artifact_id: canonicalIndexArtifactId,
        observation_result: "SOURCE_UNCHANGED",
        observed_at: "2026-08-13T07:11:00.000Z",
        authority_sequence: "51",
        index_configuration_sha256: indexConfigurationSha256,
        canonical_index_json: secondProjection,
        canonical_sha256: secondSha256,
      }]));

    const repository = new PostgresWorkspaceIndexSnapshotRepository();
    const first = await repository.readLatestResolvedArtifact(workspaceRegistrationId);
    const repeated = await repository.readLatestResolvedArtifact(workspaceRegistrationId);

    expect(repeated?.observationId).not.toBe(first?.observationId);
    expect(repeated?.workspaceRevisionId).toBe(first?.workspaceRevisionId);
    expect(repeated?.canonicalIndexArtifactId).toBe(first?.canonicalIndexArtifactId);
    expect(repeated?.canonicalSha256).toBe(secondSha256);
    expect(repeated?.canonicalSha256).not.toBe(first?.canonicalSha256);
    expect(repeated?.canonicalIndex.source_binding.source_binding_id).toBe("sbi_repeat_y");
    expect(repeated?.canonicalIndex.source_binding.normalized_reference).toBe("E:/workspace/repeat-y");
    expect(repeated?.canonicalIndex.generation.indexing_session_id).toBe("session-repeat-y");
  });
});

function snapshotRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "snap_00000000-0000-4000-8000-000000000001",
    source_mode: "REGISTERED_WORKSPACE",
    status: "READY",
    workspace_registration_id: workspaceRegistrationId,
    workspace_registration_revision: 1,
    workspace_registration_fingerprint: "fp_abc",
    project_context_id: null,
    governed_scope: {},
    snapshot_idempotencyKey: "idem_001",
    snapshot_request_fingerprint_sha256: "sha256:" + "f".repeat(64),
    canonical_contract_version: null,
    canonical_index_json: null,
    canonical_sha256: null,
    workspace_observation_id: "obs_001",
    workspace_revision_id: workspaceRevisionId,
    canonical_index_artifact_id: null,
    index_configuration_sha256: indexConfigurationSha256,
    observation_result: "FIRST_INDEXED",
    delta_artifact_id: null,
    scan_base_observation_id: null,
    index_attempt_status: "SUCCEEDED",
    index_attempt_evidence: null,
    index_attempt_candidate_json: null,
    index_attempt_candidate_sha256: null,
    failure_code: null,
    safe_failure_evidence: null,
    owner_reference: "owner_test",
    accepted_workspace_evidence_artifact_id: null,
    started_at: "2026-08-20T10:00:00.000Z",
    completed_at: "2026-08-20T10:00:01.000Z",
    progress_phase: "READY",
    progress_evidence: null,
    heartbeat_at: "2026-08-20T10:00:01.000Z",
    created_at: "2026-08-20T09:59:59.000Z",
    ...overrides,
  };
}

describe("PostgresWorkspaceIndexSnapshotRepository.readMappingAuthority", () => {
  beforeEach(() => {
    dbMocks.databaseQuery.mockReset();
  });

  it("T01: valid V2 READY snapshot resolves WEA artifact authority", async () => {
    const weaId = "wea_e40f970d9a7019e97c36cd938bea38b05ccb0149031916f8d5d2a76fde08e768";
    const weaSemanticSha = "sha256:" + "a".repeat(64);
    dbMocks.databaseQuery
      .mockResolvedValueOnce(selectResult([snapshotRow({
        canonical_index_artifact_id: null,
        accepted_workspace_evidence_artifact_id: weaId,
      })]))
      .mockResolvedValueOnce(selectResult([{
        id: weaId,
        workspace_registration_id: workspaceRegistrationId,
        workspace_revision_id: workspaceRevisionId,
        artifact_semantic_sha256: weaSemanticSha,
      }]));

    const repository = new PostgresWorkspaceIndexSnapshotRepository();
    const result = await repository.readMappingAuthority("snap_001");

    expect(result.snapshot.status).toBe("READY");
    expect(result.snapshot.canonicalIndexArtifactId).toBeUndefined();
    expect(result.snapshot.acceptedWorkspaceEvidenceArtifactId).toBe(weaId);
    expect(result.artifact).toBeDefined();
    expect(result.artifact!.id).toBe(weaId);
    expect(result.artifact!.semanticSha256).toBe(weaSemanticSha);
    expect(result.artifact!.semanticState).toEqual({
      workspace_instance_id: workspaceRegistrationId,
      workspace_revision_id: workspaceRevisionId,
      evidence_artifact_id: weaId,
    });

    const weaQuery = dbMocks.databaseQuery.mock.calls[1][0];
    expect(weaQuery).toContain("workspace_evidence_artifacts");
    expect(weaQuery).toContain("id=$1");
    expect(weaQuery).toContain("workspace_registration_id=$2");
  });

  it("T02: existing B1 READY snapshot preserves B1 artifact resolution path", async () => {
    const semanticState = { schema: "intentchord.canonical-index-artifact-semantic-state/v1", workspace_instance_id: workspaceRegistrationId, workspace_revision_id: workspaceRevisionId, contract_status: "COMPLETE", snapshot: {}, coverage: {}, failures: [] };
    dbMocks.databaseQuery
      .mockResolvedValueOnce(selectResult([snapshotRow({
        canonical_index_artifact_id: canonicalIndexArtifactId,
        accepted_workspace_evidence_artifact_id: null,
      })]))
      .mockResolvedValueOnce(selectResult([{
        id: canonicalIndexArtifactId,
        workspace_registration_id: workspaceRegistrationId,
        workspace_revision_id: workspaceRevisionId,
        index_configuration_sha256: indexConfigurationSha256,
        artifact_semantic_sha256: "sha256:" + "b".repeat(64),
        artifact_semantic_json: semanticState,
        canonical_index_json: sampleCanonicalWorkspaceIndex(),
        canonical_sha256: "sha256:" + "c".repeat(64),
      }]));

    const repository = new PostgresWorkspaceIndexSnapshotRepository();
    const result = await repository.readMappingAuthority("snap_002");

    expect(result.artifact).toBeDefined();
    expect(result.artifact!.id).toBe(canonicalIndexArtifactId);

    const ciaQuery = dbMocks.databaseQuery.mock.calls[1][0];
    expect(ciaQuery).toContain("canonical_index_artifacts");
    expect(ciaQuery).not.toContain("workspace_evidence_artifacts");
  });

  it("T03: historical pre-B1 snapshot with zero bindings returns snapshot without artifact", async () => {
    dbMocks.databaseQuery
      .mockResolvedValueOnce(selectResult([snapshotRow({
        workspace_observation_id: null,
        workspace_revision_id: null,
        canonical_index_artifact_id: null,
        index_configuration_sha256: null,
        observation_result: null,
        accepted_workspace_evidence_artifact_id: null,
      })]));

    const repository = new PostgresWorkspaceIndexSnapshotRepository();
    const result = await repository.readMappingAuthority("snap_003");

    expect(result.artifact).toBeUndefined();
    expect(dbMocks.databaseQuery).toHaveBeenCalledTimes(1);
  });

  it("T04: partial V2 authority fails closed", async () => {
    dbMocks.databaseQuery
      .mockResolvedValueOnce(selectResult([snapshotRow({
        canonical_index_artifact_id: null,
        accepted_workspace_evidence_artifact_id: "wea_partial",
        workspace_revision_id: null,
      })]));

    const repository = new PostgresWorkspaceIndexSnapshotRepository();
    await expect(repository.readMappingAuthority("snap_004"))
      .rejects.toMatchObject({ code: "REGISTERED_V2_MAPPING_AUTHORITY_BINDING_REQUIRED" });
  });

  it("T04_obs: V2 READY shape with accepted WEA present but workspaceObservationId missing fails closed", async () => {
    dbMocks.databaseQuery
      .mockResolvedValueOnce(selectResult([snapshotRow({
        canonical_index_artifact_id: null,
        accepted_workspace_evidence_artifact_id: "wea_valid_id",
        workspace_observation_id: null,
      })]));

    const repository = new PostgresWorkspaceIndexSnapshotRepository();
    await expect(repository.readMappingAuthority("snap_004_obs"))
      .rejects.toMatchObject({ code: "REGISTERED_V2_MAPPING_AUTHORITY_BINDING_REQUIRED" });
  });

  it("T05: mixed V1+V2 authority fails closed", async () => {
    dbMocks.databaseQuery
      .mockResolvedValueOnce(selectResult([snapshotRow({
        canonical_index_artifact_id: canonicalIndexArtifactId,
        accepted_workspace_evidence_artifact_id: "wea_extra",
      })]));

    const repository = new PostgresWorkspaceIndexSnapshotRepository();
    await expect(repository.readMappingAuthority("snap_005"))
      .rejects.toMatchObject({ code: "REGISTERED_B1_MAPPING_AUTHORITY_BINDING_REQUIRED" });
  });

  it("T06: missing/mismatched accepted WEA fails closed", async () => {
    const weaId = "wea_nonexistent";
    dbMocks.databaseQuery
      .mockResolvedValueOnce(selectResult([snapshotRow({
        canonical_index_artifact_id: null,
        accepted_workspace_evidence_artifact_id: weaId,
      })]))
      .mockResolvedValueOnce(selectResult([]));

    const repository = new PostgresWorkspaceIndexSnapshotRepository();
    await expect(repository.readMappingAuthority("snap_006"))
      .rejects.toMatchObject({ code: "REGISTERED_V2_MAPPING_EVIDENCE_ARTIFACT_BINDING_MISMATCH" });
  });

  it("T07: V2 READY snapshot does not produce old B1 409 error", async () => {
    const weaId = "wea_proven_owner";
    dbMocks.databaseQuery
      .mockResolvedValueOnce(selectResult([snapshotRow({
        canonical_index_artifact_id: null,
        accepted_workspace_evidence_artifact_id: weaId,
      })]))
      .mockResolvedValueOnce(selectResult([{
        id: weaId,
        workspace_registration_id: workspaceRegistrationId,
        workspace_revision_id: workspaceRevisionId,
        artifact_semantic_sha256: "sha256:" + "d".repeat(64),
      }]));

    const repository = new PostgresWorkspaceIndexSnapshotRepository();
    const result = await repository.readMappingAuthority("snap_007");

    expect(result.artifact).toBeDefined();
    expect(result.artifact!.id).toBe(weaId);
  });
});

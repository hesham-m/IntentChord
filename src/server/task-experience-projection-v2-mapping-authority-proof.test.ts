import { describe, expect, it, vi } from "vitest";
import { createBlankContractInput } from "@/core/tasks/task-input";
import type { TaskRecord } from "@/lib/workspace";
import { getTaskExperienceProjection } from "@/server/task-experience-projection-service";

const IDS = {
  task: "550e8400-e29b-41d4-a716-446655440000",
  workspace: "11111111-1111-4111-8111-111111111111",
  snapshot: "33333333-3333-4333-8333-333333333333",
  wea: "wea_e40f970d9a7019e97c36cd938bea38b05ccb0149031916f8d5d2a76fde08e768",
};

const fakes = vi.hoisted(() => ({
  readTaskLifecycle: vi.fn(),
  readWorkspaceAuthorityRegistration: vi.fn(),
  readPersistedWorkspaceIndexSnapshot: vi.fn(),
  readPersistedWorkspaceIndexMappingAuthority: vi.fn(),
  readMappingRun: vi.fn(),
  listAttempts: vi.fn(),
  databaseQuery: vi.fn(),
}));

vi.mock("@/server/lifecycle", () => ({ readTaskLifecycle: fakes.readTaskLifecycle }));
vi.mock("@/server/workspace-connector", () => ({ readWorkspaceAuthorityRegistration: fakes.readWorkspaceAuthorityRegistration }));
vi.mock("@/server/workspace-index-snapshot-service", () => ({
  readPersistedWorkspaceIndexSnapshot: fakes.readPersistedWorkspaceIndexSnapshot,
  readPersistedWorkspaceIndexMappingAuthority: fakes.readPersistedWorkspaceIndexMappingAuthority,
}));
vi.mock("@/server/ai-context-mapping-repository", () => ({
  PostgresAiContextMappingRepository: class {
    readRun = fakes.readMappingRun;
    listAttempts = fakes.listAttempts;
  },
}));
vi.mock("@/server/db", () => ({ databaseQuery: fakes.databaseQuery }));

function makeTask(): TaskRecord {
  const draft = createBlankContractInput("SOURCE_IMPLEMENTATION");
  draft.objective = "V2 Projection Mapping Authority Verification";
  draft.workspaces = [{
    id: IDS.workspace,
    displayName: "Backend",
    role: "primary",
    referenceType: "LOCAL_PATH",
    source: "WINDOWS_NATIVE_SELECTOR",
    reference: "E:\\backend",
    fingerprint: "sha256:v2-workspace-fp",
    discoveryScopeMode: "SELECTED_PATHS",
    allowedPaths: ["src"],
    excludedPaths: [],
    authorizationContext: "owner",
    ordering: 0,
  }];
  draft.workspaceRef = "E:\\backend";
  draft.workspaceFingerprint = "sha256:v2-workspace-fp";
  return {
    id: IDS.task,
    revision: 1,
    createdAt: "2026-09-02T12:00:00.000Z",
    updatedAt: "2026-09-02T12:00:00.000Z",
    draft,
    runs: [],
    promptLocaleExplicit: false,
    contractTab: "summary",
    reviewTab: "summary",
  };
}

// Persisted V2 READY snapshot matching the proven Owner Runtime row in intentchord_dev
const v2ReadySnapshot = {
  id: IDS.snapshot,
  sourceMode: "REGISTERED_WORKSPACE",
  status: "READY",
  workspaceRegistrationId: IDS.workspace,
  workspaceRegistrationRevision: 1,
  workspaceRegistrationFingerprint: "sha256:v2-workspace-fp",
  governedScope: {},
  snapshotIdempotencyKey: "v2-snapshot-idem-key",
  requestFingerprintSha256: "a".repeat(64),
  canonicalContractVersion: "intentchord.canonical-workspace-index.v2",
  canonicalSha256: "b".repeat(64),
  workspaceObservationId: "obs_77777777-7777-4777-8777-777777777777",
  workspaceRevisionId: "rev_88888888-8888-4888-8888-888888888888",
  canonicalIndexArtifactId: undefined, // NULL in V2
  acceptedWorkspaceEvidenceArtifactId: IDS.wea, // WEA present in V2
  indexConfigurationSha256: "c".repeat(64),
  observationResult: "FIRST_INDEXED",
  indexAttemptStatus: "SUCCEEDED",
  ownerReference: "owner-local:Hisham",
  startedAt: "2026-09-02T12:00:00.000Z",
  completedAt: "2026-09-02T12:01:00.000Z",
  createdAt: "2026-09-02T12:00:00.000Z",
};

describe("TaskExperienceProjection V2 Mapping Authority Proof Suite", () => {
  function setupV2Mocks() {
    fakes.readTaskLifecycle.mockResolvedValue(makeTask());
    fakes.readWorkspaceAuthorityRegistration.mockResolvedValue({
      id: IDS.workspace,
      revision: 1,
      displayName: "Backend",
      role: "primary",
      referenceType: "LOCAL_PATH",
      source: "WINDOWS_NATIVE_SELECTOR",
      reference: "E:\\backend",
      normalizedReference: "E:\\backend",
      verificationStatus: "VERIFIED",
      verificationMethod: "WINDOWS_NATIVE_SELECTOR",
      verifiedAt: "2026-09-02T12:00:00.000Z",
      verificationAuthority: "owner-local:Hisham",
      fingerprint: "sha256:v2-workspace-fp",
      provenance: {},
      authorizationContext: "owner",
      verifiedRootRealPath: "E:\\backend",
      verifiedRootObjectIdentity: { device_id: "dev", file_id: "file", proof_method: "WINDOWS_FILE_ID_128_V1" },
      verifiedRootVerifiedAt: "2026-09-02T12:00:00.000Z",
      rootAuthorityState: "VERIFIED_MATCH",
      rootAuthorityCheckedAt: "2026-09-02T12:00:00.000Z",
    });
    fakes.databaseQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("from intentchord.workspace_index_snapshots")) {
        return { rowCount: 1, rows: [{ id: IDS.snapshot }] };
      }
      if (sql.includes("from intentchord.context_mapping_runs")) {
        return { rowCount: 0, rows: [] };
      }
      if (sql.includes("from intentchord.context_assemblies")) {
        return { rowCount: 0, rows: [] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    });
    fakes.readPersistedWorkspaceIndexSnapshot.mockResolvedValue(v2ReadySnapshot);
    fakes.readPersistedWorkspaceIndexMappingAuthority.mockResolvedValue({
      snapshot: v2ReadySnapshot,
      artifact: {
        id: IDS.wea,
        semanticSha256: "sha256:" + "e".repeat(64),
        semanticState: {
          workspace_instance_id: IDS.workspace,
          workspace_revision_id: v2ReadySnapshot.workspaceRevisionId,
          evidence_artifact_id: IDS.wea,
        },
      },
    });
    fakes.readMappingRun.mockResolvedValue(undefined);
    fakes.listAttempts.mockResolvedValue([]);
  }

  it("T07: Production Projection call path with valid V2 authority does NOT emit REGISTERED_B1_MAPPING_AUTHORITY_BINDING_REQUIRED", async () => {
    setupV2Mocks();

    let errorThrown: unknown;
    try {
      const projection = await getTaskExperienceProjection(IDS.task, "ar");
      expect(projection).toBeDefined();
      expect(projection?.analysisSummary.indexStatus).toBe("READY");
    } catch (err) {
      errorThrown = err;
    }

    expect(errorThrown).toBeUndefined();
    expect(fakes.readPersistedWorkspaceIndexMappingAuthority).toHaveBeenCalledWith(IDS.snapshot);
  });

  it("T08: Production Projection call path with valid V2 authority does NOT emit READY_WORKSPACE_INDEX_SNAPSHOT_REQUIRED", async () => {
    setupV2Mocks();

    let errorThrown: unknown;
    try {
      const projection = await getTaskExperienceProjection(IDS.task, "ar");
      expect(projection).toBeDefined();
      expect(projection?.analysisSummary.indexStatus).toBe("READY");
    } catch (err) {
      errorThrown = err;
    }

    expect(errorThrown).toBeUndefined();
  });

  it("T09: task-experience-authority-snapshot returns empty V2 mapping entries without breaking projection correctness", async () => {
    setupV2Mocks();

    const projection = await getTaskExperienceProjection(IDS.task, "ar");

    expect(projection).toBeDefined();
    // V2 workspace analysis reflects READY indexStatus
    expect(projection?.analysisSummary.indexStatus).toBe("READY");
    // Discovered components exist via V2 acceptedCatalog or empty if none closed yet
    expect(projection?.discoveredWorkSummary.components).toBeDefined();
    expect(Array.isArray(projection?.discoveredWorkSummary.components)).toBe(true);
    // Task summary is fully intact
    expect(projection?.taskSummary.id).toBe(IDS.task);
    expect(projection?.workspaceSummary.workspaces[0].id).toBe(IDS.workspace);
    expect(projection?.workspaceSummary.workspaces[0].verificationStatus).toBe("VERIFIED");
  });
});

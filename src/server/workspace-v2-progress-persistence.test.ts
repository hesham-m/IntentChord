import { describe, expect, it, vi } from "vitest";
import { WorkspaceIndexSnapshotService } from "@/server/workspace-index-snapshot-service";
import type { WorkspaceIndexSnapshotRepository } from "@/server/workspace-index-snapshot-repository";
import type { PostgresWorkspaceEvidenceRepository } from "@/server/workspace-evidence-repository";
import type { WorkspaceAuthorityRegistration } from "@/server/workspace-connector";
import type { V2Outcome } from "@/core/workspace-index/ingestion/engine-v2-adapter";

describe("Workspace V2 Progress Persistence Proof Suite (T01 - T07)", () => {
  const IDS = {
    workspace: "11111111-1111-4111-8111-111111111111",
    snapshot: "22222222-2222-4222-8222-222222222222",
  };

  const registration: WorkspaceAuthorityRegistration = {
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
  };

  const creatingSnapshot = {
    id: IDS.snapshot,
    sourceMode: "REGISTERED_WORKSPACE",
    status: "CREATING",
    workspaceRegistrationId: IDS.workspace,
    workspaceRegistrationRevision: 1,
    workspaceRegistrationFingerprint: "sha256:v2-workspace-fp",
    governedScope: {},
    snapshotIdempotencyKey: "idem-key-v2",
    requestFingerprintSha256: "a".repeat(64),
    ownerReference: "owner-local:Hisham",
    startedAt: "2026-09-02T12:00:00.000Z",
  };

  function setupService(options: {
    engineMode?: "V1" | "V2";
    runIndexerV2Outcome?: V2Outcome;
    upsertProgressError?: Error;
    onProgressCallbackToTrigger?: (cb: (phase: string, filesSeen: number, bytesSeen: number) => void) => void;
  }) {
    const updateProgressSpy = vi.fn().mockResolvedValue(undefined);
    const upsertProgressSpy = options.upsertProgressError
      ? vi.fn().mockRejectedValue(options.upsertProgressError)
      : vi.fn().mockResolvedValue(undefined);

    const repo = {
      recoverStale: vi.fn().mockResolvedValue(0),
      readByIdempotencyKey: vi.fn().mockResolvedValue(undefined),
      readLatestScanBase: vi.fn().mockResolvedValue(undefined),
      readLatestObservationHead: vi.fn().mockResolvedValue(undefined),
      reserve: vi.fn().mockResolvedValue({
        snapshot: creatingSnapshot,
        created: true,
      }),
      updateProgress: updateProgressSpy,
      completeRegisteredObservation: vi.fn().mockResolvedValue({
        ...creatingSnapshot,
        status: "READY",
      }),
      sealV2Snapshot: vi.fn().mockResolvedValue({
        ...creatingSnapshot,
        status: "READY",
      }),
      fail: vi.fn().mockResolvedValue({
        ...creatingSnapshot,
        status: "FAILED",
      }),
      wasRevisionPreviouslyObserved: vi.fn().mockResolvedValue(false),
    } as unknown as WorkspaceIndexSnapshotRepository;

    const evidenceRepo = {
      upsertProgress: upsertProgressSpy,
      insertStagedRecords: vi.fn().mockResolvedValue(undefined),
      insertStagedSegment: vi.fn().mockResolvedValue(undefined),
      insertAttestationOpen: vi.fn().mockResolvedValue(undefined),
      transitionAttestation: vi.fn().mockResolvedValue(undefined),
    } as unknown as PostgresWorkspaceEvidenceRepository;

    const runIndexer = vi.fn().mockImplementation(async (req) => {
      req.on_progress?.({ phase: "DISCOVERING", discoveredFiles: 10, discoveredBytes: 100, hashedFiles: 0, hashedBytes: 0, parsedFiles: 0, aggregateRetainedTextBytes: 0, csvSampledBytes: 0, excludedTrees: 0, elapsedMs: 100 });
      throw new Error("V1_STOP_AFTER_PROGRESS");
    });

    const runIndexerV2 = vi.fn().mockImplementation(async (_req, opts) => {
      if (options.onProgressCallbackToTrigger) {
        options.onProgressCallbackToTrigger(opts.on_progress);
      }
      return options.runIndexerV2Outcome ?? {
        engine_mode: "V2_SECTIONED" as const,
        outcome: "SEALED" as const,
        workspaceInstanceId: IDS.workspace,
        openedBoundaryUsn: null,
        closedBoundaryUsn: null,
        reconciliationPasses: 0,
        files: [],
        continuityAttestation: {
          attestationId: "wca_" + "a".repeat(64),
          providerClass: "METADATA_ONLY_PROVIDER",
          providerId: "GENERIC_METADATA_V1",
          claimType: "ROLLING_EXACT_FILE_MANIFEST",
          currentPolicyHash: "sha256:" + "b".repeat(64),
          bootstrap: true,
        },
        continuityEvidence: { engine: "V2_SECTIONED" },
        sealPlan: {
          workspace_revision_id: "rev_" + "c".repeat(64),
          canonical_compat_sha256: "sha256:" + "d".repeat(64),
          header_json: {},
          section_manifest_json: {},
          sections: [],
          observation_result: "FIRST_INDEXED",
        },
        artifactCandidate: {
          artifactId: "wea_" + "e".repeat(64),
          workspaceRevisionId: "rev_" + "c".repeat(64),
          sectionManifestDigest: "sha256:" + "f".repeat(64),
          artifactManifestSha256: "sha256:" + "1".repeat(64),
          artifactSemanticSha256: "sha256:" + "2".repeat(64),
        },
        observationResult: "FIRST_INDEXED",
      };
    });

    const service = new WorkspaceIndexSnapshotService({
      repository: repo,
      evidenceRepository: evidenceRepo,
      readWorkspace: vi.fn().mockResolvedValue(registration),
      authorizeWorkspaceSource: vi.fn().mockResolvedValue({
        registration,
        currentIdentity: {
          realPath: "E:\\backend",
          rootObjectIdentity: { device_id: "dev", file_id: "file", proof_method: "WINDOWS_FILE_ID_128_V1" },
        },
      }),
      runIndexer,
      runIndexerV2,
      now: () => "2026-09-02T12:00:00.000Z",
    });

    return { service, repo, evidenceRepo, updateProgressSpy, upsertProgressSpy };
  }

  it("T01 & T04: V2 CLASSIFYING progress routes to workspace_ingestion_progress without legacy check violation", async () => {
    process.env.WORKSPACE_INDEX_ENGINE = "V2";

    const { service, updateProgressSpy, upsertProgressSpy } = setupService({
      onProgressCallbackToTrigger: (on_progress) => {
        on_progress("CLASSIFYING", 150, 2048);
      },
    });

    const result = await service.createOperation({
      sourceMode: "REGISTERED_WORKSPACE",
      workspaceRegistrationId: IDS.workspace,
      idempotencyKey: "test-idem-key",
    }, "owner-local:Hisham");

    expect(result.snapshot.status).toBe("READY");
    // Target is workspace_ingestion_progress via upsertProgress
    expect(upsertProgressSpy).toHaveBeenCalledWith({
      snapshot_operation_id: IDS.snapshot,
      phase: "CLASSIFYING",
      counters_json: { filesSeen: 150, bytesSeen: 2048 },
      heartbeat_at: expect.any(Date),
    });
    // Legacy updateProgress was NOT called for V2 progress
    expect(updateProgressSpy).not.toHaveBeenCalled();
  });

  it("T02 & T06: V2 SEALING progress routes to workspace_ingestion_progress with NO dual write to legacy progress_phase", async () => {
    process.env.WORKSPACE_INDEX_ENGINE = "V2";

    const { service, updateProgressSpy, upsertProgressSpy } = setupService({
      onProgressCallbackToTrigger: (on_progress) => {
        on_progress("SEALING", 500, 102400);
      },
    });

    const result = await service.createOperation({
      sourceMode: "REGISTERED_WORKSPACE",
      workspaceRegistrationId: IDS.workspace,
      idempotencyKey: "test-idem-key",
    }, "owner-local:Hisham");

    expect(result.snapshot.status).toBe("READY");
    // Verified V2 ingestion progress store was written
    expect(upsertProgressSpy).toHaveBeenCalledWith({
      snapshot_operation_id: IDS.snapshot,
      phase: "SEALING",
      counters_json: { filesSeen: 500, bytesSeen: 102400 },
      heartbeat_at: expect.any(Date),
    });
    // Legacy snapshot progress was NOT written with SEALING
    expect(updateProgressSpy).not.toHaveBeenCalled();
  });

  it("T03: V1 progress persistence remains unchanged on legacy workspace_index_snapshots", async () => {
    process.env.WORKSPACE_INDEX_ENGINE = "V1";

    const { service, updateProgressSpy, upsertProgressSpy } = setupService({});

    try {
      await service.createOperation({
        sourceMode: "REGISTERED_WORKSPACE",
        workspaceRegistrationId: IDS.workspace,
        idempotencyKey: "test-idem-key",
      }, "owner-local:Hisham");
    } catch {
      // Expected stop after progress
    }

    // V1 updates legacy progress
    expect(updateProgressSpy).toHaveBeenCalled();
    expect(updateProgressSpy.mock.calls[0][0].phase).toBe("DISCOVERING");
    // V2 ingestion progress is NOT called for V1
    expect(upsertProgressSpy).not.toHaveBeenCalled();
  });

  it("T05: Bounded/coalesced progress updates update the same operation record", async () => {
    process.env.WORKSPACE_INDEX_ENGINE = "V2";

    const { service, upsertProgressSpy } = setupService({
      onProgressCallbackToTrigger: (on_progress) => {
        on_progress("DISCOVERING", 50, 1000);
        on_progress("CLASSIFYING", 100, 2000);
        on_progress("CLASSIFYING", 200, 4000);
        on_progress("SEALING", 200, 4000);
      },
    });

    await service.createOperation({
      sourceMode: "REGISTERED_WORKSPACE",
      workspaceRegistrationId: IDS.workspace,
      idempotencyKey: "test-idem-key",
    }, "owner-local:Hisham");

    // 4 progress events were recorded, all for the exact same snapshot_operation_id
    expect(upsertProgressSpy).toHaveBeenCalledTimes(4);
    for (const call of upsertProgressSpy.mock.calls) {
      expect(call[0].snapshot_operation_id).toBe(IDS.snapshot);
    }
  });

  it("T07: Authoritative V2 progress persistence failure is fail-closed and rethrown", async () => {
    process.env.WORKSPACE_INDEX_ENGINE = "V2";

    const progressDbError = new Error("DB_PROGRESS_WRITE_FAILED");
    const { service } = setupService({
      upsertProgressError: progressDbError,
      onProgressCallbackToTrigger: (on_progress) => {
        on_progress("CLASSIFYING", 10, 500);
      },
    });

    let caughtError: unknown;
    try {
      await service.createOperation({
        sourceMode: "REGISTERED_WORKSPACE",
        workspaceRegistrationId: IDS.workspace,
        idempotencyKey: "test-idem-key",
      }, "owner-local:Hisham");
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBe(progressDbError);
  });
});

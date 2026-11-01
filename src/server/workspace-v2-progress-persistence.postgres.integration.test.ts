import { describe, expect, it, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import path from "node:path";
import { URL } from "node:url";
import { randomUUID } from "node:crypto";
import pg from "pg";
import {
  WorkspaceIndexSnapshotService,
} from "@/server/workspace-index-snapshot-service";
import {
  PostgresWorkspaceIndexSnapshotRepository,
} from "@/server/workspace-index-snapshot-repository";
import {
  PostgresWorkspaceEvidenceRepository,
} from "@/server/workspace-evidence-repository";
import { bindRollbackOnlyTestClient } from "@/server/db";

function getDisposableUrl(): string | undefined {
  const envUrl = process.env.INTENTCHORD_C1_VALIDATION_DATABASE_URL;
  if (envUrl) {
    return assertDisposable(envUrl);
  }
  try {
    const fs = require("node:fs");
    const envPath = path.resolve(".env.local");
    if (fs.existsSync(envPath)) {
      const match = fs.readFileSync(envPath, "utf8").match(/DATABASE_URL=([^\r\n]+)/);
      if (match) {
        const candidate = match[1].replace("/intentchord_dev", "/intentchord_validation_20260820_160113").trim();
        return assertDisposable(candidate);
      }
    }
  } catch {}
  return undefined;
}

function assertDisposable(urlStr: string): string {
  const parsed = new URL(urlStr);
  const database = parsed.pathname.replace(/^\//, "");
  const user = decodeURIComponent(parsed.username);
  if (!database.startsWith("intentchord_validation_") || user !== "intentchord_app" || database === "intentchord_dev") {
    throw new Error(`DISPOSABLE_DATABASE_IDENTITY_BLOCKED: database=${database}, user=${user}`);
  }
  return urlStr;
}

const DISPOSABLE_URL = getDisposableUrl();

describe.runIf(Boolean(DISPOSABLE_URL))("Workspace V2 Progress Persistence Integration Suite (T08)", () => {
  let pool: pg.Pool;
  let client: pg.PoolClient;
  let releaseRollbackBinding: (() => void) | undefined;
  let savepointSeq = 0;

  beforeAll(async () => {
    process.env.INTENTCHORD_ROLLBACK_ONLY_PG_TEST = "1";
    pool = new pg.Pool({ connectionString: DISPOSABLE_URL });
    client = await pool.connect();
    await client.query("BEGIN");
    releaseRollbackBinding = bindRollbackOnlyTestClient(client);
  });

  afterAll(async () => {
    releaseRollbackBinding?.();
    if (client) {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
    }
    if (pool) {
      await pool.end().catch(() => {});
    }
  });

  beforeEach(async () => {
    savepointSeq++;
    await client.query(`SAVEPOINT test_sp_${savepointSeq}`);
  });

  afterEach(async () => {
    await client.query(`ROLLBACK TO SAVEPOINT test_sp_${savepointSeq}`).catch(() => {});
  });

  it("T08: Full V2 progress sequence with CLASSIFYING and SEALING succeeds on disposable PostgreSQL without 23514", async () => {
    process.env.WORKSPACE_INDEX_ENGINE = "V2";

    const workspaceId = "c1e20000-0000-4000-8000-00000000c1e1";
    const snapshotId = randomUUID();
    const idempotencyKey = `idem_${randomUUID()}`;
    const fingerprint = `sha256:${"0".repeat(64)}`;

    // 1. Seed workspace in database
    await client.query(
      `INSERT INTO intentchord.workspaces
         (id,display_name,role,reference_type,reference,fingerprint,revision,normalized_reference,
          verification_status,verification_method,verification_authority,device_provenance,source_type,
          verified_root_real_path,verified_root_device_id,verified_root_file_id,verified_root_identity_method,
          verified_root_verified_at,root_authority_state,current_root_real_path,current_root_device_id,
          current_root_file_id,current_root_identity_method,root_authority_checked_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
       ON CONFLICT (id) DO NOTHING`,
      [
        workspaceId, "V2 Test Workspace", "PRIMARY", "LOCAL_PATH", "E:\\backend",
        fingerprint, 1, "E:\\backend",
        "VERIFIED", "MANUAL", "OWNER", "{}", "MANUAL_VERIFIED",
        "E:\\backend", "1234567890", "00000000000000000000000000000abc", "WINDOWS_FILE_ID_128_V1",
        new Date(), "VERIFIED_MATCH", "E:\\backend", "1234567890",
        "00000000000000000000000000000abc", "WINDOWS_FILE_ID_128_V1", new Date(),
      ],
    );

    const repo = new PostgresWorkspaceIndexSnapshotRepository();
    const evidenceRepo = new PostgresWorkspaceEvidenceRepository(client as any);

    const emittedPhases: string[] = [];
    const runIndexerV2Mock = async (_req: any, opts: any) => {
      // Simulate real V2 engine progress sequence:
      // 1. DISCOVERING
      emittedPhases.push("DISCOVERING");
      opts.on_progress?.("DISCOVERING", 10, 1024);

      // 2. CLASSIFYING (previously caused SQLSTATE 23514)
      emittedPhases.push("CLASSIFYING");
      opts.on_progress?.("CLASSIFYING", 50, 5120);

      // 3. SEALING (previously caused SQLSTATE 23514)
      emittedPhases.push("SEALING");
      opts.on_progress?.("SEALING", 50, 5120);

      // Return valid V2 outcome
      return {
        engine_mode: "V2_SECTIONED" as const,
        outcome: "SEALED" as const,
        snapshotOperationId: "snp_" + "1".repeat(64),
        workspaceInstanceId: workspaceId,
        workspaceRegistrationId: workspaceId,
        sealPlanSections: [],
        sectionManifest: [],
        reconciliationPassSummary: [],
        priorHead: null,
        openedBoundaryUsn: null,
        closedBoundaryUsn: null,
        reconciliationPasses: 0,
        files: [],
        continuityAttestation: {
          attestationId: "wca_" + "a".repeat(64),
          providerClass: "METADATA_ONLY_PROVIDER" as const,
          providerId: "GENERIC_METADATA_V1" as const,
          claimType: "ROLLING_EXACT_FILE_MANIFEST" as const,
          openedBoundaryUsn: null,
          closedBoundaryUsn: null,
          journalId: "jid",
          volumeSerial: "vser",
          predecessorPolicyHash: "sha256:" + "0".repeat(64),
          currentPolicyHash: "sha256:" + "b".repeat(64),
          reconciliationPasses: 0,
          bootstrap: true,
        },
        continuityEvidence: {
          engine: "V2_SECTIONED",
          providerClass: "METADATA_ONLY_PROVIDER",
          providerId: "GENERIC_METADATA_V1",
          claimType: "ROLLING_EXACT_FILE_MANIFEST",
          bootstrap: true,
          openedBoundaryUsn: null,
          closedBoundaryUsn: null,
          previousTrustedBoundaryUsn: null,
          reconciliationPasses: 0,
          reconciliationPassSummary: [],
          journalId: "jid",
          volumeSerial: "vser",
          currentPolicyHash: "sha256:" + "b".repeat(64),
          predecessorPolicyHash: "sha256:" + "0".repeat(64),
        },
        sealPlan: {
          snapshot_operation_id: "snp_" + "1".repeat(64),
          workspace_registration_id: workspaceId,
          workspace_revision_id: "wsr_" + "c".repeat(64),
          index_configuration_sha256: "sha256:" + "3".repeat(64),
          header_json: {},
          section_manifest_json: [],
          section_manifest_digest: "sha256:" + "f".repeat(64),
          artifact_manifest_sha256: "sha256:" + "1".repeat(64),
          artifact_semantic_sha256: "sha256:" + "2".repeat(64),
          canonical_compat_sha256: "sha256:" + "d".repeat(64),
          attestation_id: "wca_" + "a".repeat(64),
          observation_result: "FIRST_INDEXED",
          sections: [],
        },
        artifactCandidate: {
          artifactId: "wea_" + "e".repeat(64),
          workspaceRevisionId: "wsr_" + "c".repeat(64),
          indexConfigurationSha256: "sha256:" + "3".repeat(64),
          sectionManifestDigest: "sha256:" + "f".repeat(64),
          artifactManifestSha256: "sha256:" + "1".repeat(64),
          artifactSemanticSha256: "sha256:" + "2".repeat(64),
        },
        observationResult: "FIRST_INDEXED",
      };
    };

    const service = new WorkspaceIndexSnapshotService({
      repository: repo,
      evidenceRepository: evidenceRepo,
      readWorkspace: async () => ({
        id: workspaceId,
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
        fingerprint,
        provenance: {},
        authorizationContext: "owner",
        verifiedRootRealPath: "E:\\backend",
        verifiedRootObjectIdentity: { device_id: "dev", file_id: "file", proof_method: "WINDOWS_FILE_ID_128_V1" },
        verifiedRootVerifiedAt: "2026-09-02T12:00:00.000Z",
        rootAuthorityState: "VERIFIED_MATCH",
        rootAuthorityCheckedAt: "2026-09-02T12:00:00.000Z",
      }),
      authorizeWorkspaceSource: async () => ({
        registration: {
          id: workspaceId,
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
          fingerprint,
          provenance: {},
          authorizationContext: "owner",
          verifiedRootRealPath: "E:\\backend",
          verifiedRootObjectIdentity: { device_id: "dev", file_id: "file", proof_method: "WINDOWS_FILE_ID_128_V1" },
          verifiedRootVerifiedAt: "2026-09-02T12:00:00.000Z",
          rootAuthorityState: "VERIFIED_MATCH",
          rootAuthorityCheckedAt: "2026-09-02T12:00:00.000Z",
        },
        currentIdentity: {
          realPath: "E:\\backend",
          normalizedReference: "E:\\backend",
          fingerprint,
          provenance: {},
          rootObjectIdentity: { device_id: "dev", file_id: "file", proof_method: "WINDOWS_FILE_ID_128_V1" },
        },
      }),
      runIndexer: vi.fn(),
      runIndexerV2: runIndexerV2Mock,
      now: () => "2026-09-02T12:00:00.000Z",
    });

    // Execute the service operation against real PostgreSQL
    const result = await service.createOperation({
      sourceMode: "REGISTERED_WORKSPACE",
      workspaceRegistrationId: workspaceId,
      idempotencyKey,
    }, "owner-local:Hisham");

    expect(result.snapshot.status).toBe("READY");

    // 2. Query workspace_ingestion_progress in real PostgreSQL
    const progressRows = await client.query(
      `SELECT snapshot_operation_id, phase, counters_json, update_seq
       FROM intentchord.workspace_ingestion_progress
       WHERE snapshot_operation_id = $1`,
      [result.snapshot.id]
    );

    // Exactly one bounded row exists for this snapshot operation
    expect(progressRows.rows).toHaveLength(1);
    const progressRow = progressRows.rows[0];
    expect(progressRow.phase).toBe("SEALING");
    expect(progressRow.counters_json).toEqual({ filesSeen: 50, bytesSeen: 5120 });
    // update_seq was incremented 3 times (1 for DISCOVERING, 2 for CLASSIFYING, 3 for SEALING)
    expect(progressRow.update_seq).toBe(3);

    // 3. Query legacy workspace_index_snapshots in real PostgreSQL
    const snapshotRows = await client.query(
      `SELECT id, status, progress_phase
       FROM intentchord.workspace_index_snapshots
       WHERE id = $1`,
      [result.snapshot.id]
    );
    expect(snapshotRows.rows).toHaveLength(1);
    // Terminal state is READY, progress_phase is READY (allowed by legacy constraint)
    expect(snapshotRows.rows[0].status).toBe("READY");
    expect(snapshotRows.rows[0].progress_phase).toBe("READY");
  });
});

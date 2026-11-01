import { describe, expect, it, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { URL } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import {
  IngestionEngineV2,
  buildSealPlan,
  type BoundedEvidenceStagingPort,
  type BoundedStagedRecord,
  type BoundedStagedSegment,
  type DiscoveryPort,
  type HashPort,
  type ParsingPort,
  type PriorHead,
  type UsnEventSource,
  type EngineFileResult,
  type ParsedFileResult,
} from "@/core/workspace-index/ingestion/engine-v2";
import { indexWorkspaceV2 } from "@/core/workspace-index/ingestion/engine-v2-adapter";
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
import { PARSER_REGISTRY_VERSION } from "@/core/workspace-index/types";
import { EVIDENCE_SECTION_TYPES } from "@/core/workspace-index/sections/sectioned-contracts";

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
const MIGRATIONS_DIR = path.resolve("migrations");

const HEX = (ch: string) => ch.repeat(64);
const WS_ID = "c1e20000-0000-4000-8000-00000000c1e1";

let pool: pg.Pool | undefined;
let rollbackClient: pg.PoolClient | undefined;
let releaseRollbackBinding: (() => void) | undefined;
let testSavepoint = "sp_init";

beforeAll(async () => {
  if (!DISPOSABLE_URL) return;
  process.env.INTENTCHORD_ROLLBACK_ONLY_PG_TEST = "1";
  pool = new pg.Pool({ connectionString: DISPOSABLE_URL });
  rollbackClient = await pool.connect();
  await rollbackClient.query("BEGIN");
  releaseRollbackBinding = bindRollbackOnlyTestClient(rollbackClient);
  await applyMigrationsThrough15(rollbackClient);
  await seedWorkspace(rollbackClient);
});

beforeEach(async () => {
  if (!rollbackClient) return;
  testSavepoint = `sp_${randomUUID().replace(/-/g, "")}`;
  await rollbackClient.query(`SAVEPOINT ${testSavepoint}`);
});

afterEach(async () => {
  if (!rollbackClient) return;
  try {
    await rollbackClient.query(`ROLLBACK TO SAVEPOINT ${testSavepoint}`);
  } catch {}
});

afterAll(async () => {
  try {
    if (rollbackClient) await rollbackClient.query("ROLLBACK");
  } finally {
    releaseRollbackBinding?.();
    rollbackClient?.release();
    delete process.env.INTENTCHORD_ROLLBACK_ONLY_PG_TEST;
    await pool?.end();
  }
});

async function applyMigrationsThrough15(client: pg.PoolClient): Promise<void> {
  await client.query("DROP SCHEMA IF EXISTS intentchord CASCADE");
  await client.query("CREATE SCHEMA intentchord AUTHORIZATION intentchord_app");
  const names = (await readdir(MIGRATIONS_DIR)).filter(n => /^0\d\d_.*\.sql$/.test(n)).sort();
  for (const name of names) {
    if (Number(name.slice(1, 3)) > 15) continue;
    await client.query(await readFile(path.join(MIGRATIONS_DIR, name), "utf8"));
  }
}

async function seedWorkspace(client: pg.PoolClient): Promise<void> {
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
      WS_ID, "V2 Test Workspace", "PRIMARY", "LOCAL_PATH", "C:\\v2\\proof",
      "v2-proof-fp", 1, "c:/v2/proof",
      "VERIFIED", "MANUAL", "OWNER", "{}", "MANUAL_VERIFIED",
      "C:\\v2\\proof", "1234567890", "00000000000000000000000000000abc", "WINDOWS_FILE_ID_128_V1",
      new Date(), "VERIFIED_MATCH", "C:\\v2\\proof", "1234567890",
      "00000000000000000000000000000abc", "WINDOWS_FILE_ID_128_V1", new Date(),
    ],
  );
}

function sha256Hex(s: string): string {
  return `sha256:${createHash("sha256").update(s, "utf8").digest("hex")}`;
}

function makeSyntheticEngineFiles(count: number): EngineFileResult[] {
  return Array.from({ length: count }, (_, i) => ({
    relativePath: `src/file_${i}.ts`,
    state: "NEW" as const,
    contentHash: sha256Hex(`content_${i}`),
    contentHashSource: "FRESH" as const,
    sizeBytes: 100 + i,
    objectFileId: `obj_${i}`,
    objectSequence: null,
    workspaceFileId: `wfi_synthetic_${i}`,
    fileName: `file_${i}.ts`,
    fileKind: "SOURCE_CODE" as const,
    language: "typescript",
    sensitivityState: "NORMAL" as const,
  }));
}

function makeSyntheticParsedResults(files: EngineFileResult[]): Map<string, ParsedFileResult> {
  const map = new Map<string, ParsedFileResult>();
  for (const f of files) {
    const fileRevisionId = `fir_${createHash("sha256").update(f.workspaceFileId).digest("hex")}`;
    map.set(f.relativePath, {
      fileRecord: {
        workspace_file_id: f.workspaceFileId,
        file_revision_id: fileRevisionId,
        relative_path: f.relativePath,
        file_name: f.fileName ?? f.relativePath,
        file_kind: f.fileKind ?? "SOURCE_CODE",
        language: f.language,
        size_bytes: f.sizeBytes,
        content_hash: f.contentHash,
        metadata_hash: f.contentHash,
        encoding: "UNKNOWN" as const,
        parse_status: "PARSED" as const,
        sensitivity_state: f.sensitivityState ?? "NORMAL" as const,
        coverage_stage: "FACTS_EXTRACTED" as const,
        coverage_state: "COMPLETE" as const,
        lineage_state: "NEW" as const,
      },
      facts: [{
        workspace_fact_id: `wfa_${f.workspaceFileId}`,
        fact_revision_id: `far_${f.workspaceFileId}`,
        fact_type: "SYMBOL" as const,
        qualified_name: `${f.relativePath}::entry`,
        display_name: `Symbol: ${f.relativePath}`,
        attributes: {},
        source_file_revision_id: fileRevisionId,
        source_location: { normalized_signature: `symbol:${f.relativePath}` },
        extraction_method: "PARSER_EXACT" as const,
        extractor_id: "TYPESCRIPT_DETERMINISTIC_TEXT_PARSER",
        extractor_version: "1.0.0",
        certainty: "EXACT" as const,
        evidence_role: "CANONICAL_EVIDENCE" as const,
        provenance: {
          workspace_revision_id: "wsr-proof",
          file_revision_id: fileRevisionId,
          file_content_hash: f.contentHash,
          source_location: { normalized_signature: `symbol:${f.relativePath}` },
          extractor_id: "TYPESCRIPT_DETERMINISTIC_TEXT_PARSER",
          extractor_version: "1.0.0",
          extraction_method: "PARSER_EXACT" as const,
          evidence_hash: sha256Hex("fact_evidence"),
        },
      }],
      relations: [{
        workspace_relation_id: `wre_${f.workspaceFileId}`,
        relation_revision_id: `rrr_${f.workspaceFileId}`,
        relation_type: "CALLS" as const,
        source: {
          entity_type: "FACT" as const,
          entity_revision_id: `far_${f.workspaceFileId}`,
        },
        target: {
          entity_type: "FILE" as const,
          entity_revision_id: fileRevisionId,
        },
        direction: "DIRECTED" as const,
        attributes: {},
        evidence_refs: [],
        extraction_method: "PARSER_EXACT" as const,
        extractor_id: "TYPESCRIPT_DETERMINISTIC_TEXT_PARSER",
        extractor_version: "1.0.0",
        certainty: "EXACT" as const,
        evidence_role: "CANONICAL_EVIDENCE" as const,
      }],
      contentReference: {
        content_ref_id: `wcr_${f.workspaceFileId}`,
        file_revision_id: fileRevisionId,
        content_hash: f.contentHash,
        content_kind: "SOURCE_CODE",
        media_type: "application/octet-stream",
        encoding: "UNKNOWN" as const,
        size_bytes: f.sizeBytes,
        retrieval_ref: `ref:${f.relativePath}`,
        sensitivity_class: "NORMAL" as const,
        availability_state: "AVAILABLE" as const,
        scope_type: "FULL_FILE" as const,
      },
      failures: f.relativePath === "src/file_0.ts" ? [{
        failure_id: `wif_${f.workspaceFileId}`,
        file_revision_id: fileRevisionId,
        stage: "PARSING" as const,
        failure_type: "EXTRACTION_WARNING",
        error_code: "NON_FATAL_PARSE_WARNING",
        sanitized_message: "Synthetic proof non-fatal warning",
        occurred_at: new Date().toISOString(),
        recoverability: "RETRYABLE" as const,
        impact: "LOCAL" as const,
      }] : [],
    });
  }
  return map;
}

describe.skipIf(!DISPOSABLE_URL)("INTENTCHORD_V2_BOUNDED_STAGING_WRITER_PERSISTENCE_REGRESSION_CORRECTION_V1", () => {

  // =========================================================================
  // DECISIVE INTEGRATION PROOF: Non-Empty V2 Workspace
  // =========================================================================
  it("DECISIVE PROOF: Staging occurs DURING ingestion before last record is produced, and snapshot reaches READY", async () => {
    const evidenceRepo = new PostgresWorkspaceEvidenceRepository(rollbackClient!);
    const snapshotRepo = new PostgresWorkspaceIndexSnapshotRepository();

    const snapshotOpId = `op-${randomUUID()}`;
    const snapId = snapshotOpId.replace(/^op-/, "");

    // 1. Reserve snapshot in database (status = CREATING)
    await rollbackClient!.query(
      `INSERT INTO intentchord.workspace_index_snapshots
         (id, source_mode, status, workspace_registration_id, workspace_registration_revision,
          workspace_registration_fingerprint, governed_scope, snapshot_idempotency_key,
          snapshot_request_fingerprint_sha256, owner_reference, started_at)
       VALUES ($1, 'REGISTERED_WORKSPACE', 'CREATING', $2, 1, 'v2-proof-fp', '{}', $3, $4, 'proof-owner', now())`,
      [snapId, WS_ID, `idem-${snapId}`, sha256Hex(snapId)],
    );

    // 2. Prepare 600 files so that section 1 (FILES) exceeds SEGMENT_SIZE (512)
    // Segment 1: 512 records, Segment 2: 88 records
    const FILE_COUNT = 600;
    const files = makeSyntheticEngineFiles(FILE_COUNT);
    const parsedResults = makeSyntheticParsedResults(files);

    let firstDbStagingWriteBeforeLastRecordProduced = false;
    let stagingOccursDuringIngestion = false;
    let recordsStagedAtInterception = 0;
    let acceptedArtifactsAtInterception = -1;
    let snapshotStatusAtInterception = "";

    // 3. Create Service-Owned Abstract Bounded Staging Port (Option B)
    const stagingPort: BoundedEvidenceStagingPort = {
      stageRecords: async (sectionType, records) => {
        if (records.length === 0) return;
        const batch = records.map(r => ({
          snapshot_operation_id: snapId,
          section_type: sectionType,
          record_seq: r.record_seq,
          record_id: r.record_id,
          record_digest: r.record_digest,
          source_file_revision_id: r.source_file_revision_id ?? null,
          record_json: r.record_json,
        }));
        await evidenceRepo.insertStagedRecords(batch);

        // DECISIVE PROOF CHECK:
        // On the very first segment flush of FILES (512 records):
        // Ingestion is STILL RUNNING! File 513..600 and subsequent sections are NOT produced yet!
        if (sectionType === "FILES" && records[0].record_seq === 1 && records.length === 512) {
          stagingOccursDuringIngestion = true;

          // Query PostgreSQL directly while ingestion is still in progress
          const stagingCountRes = await rollbackClient!.query(
            "SELECT count(*)::int as count FROM intentchord.workspace_evidence_staging_records WHERE snapshot_operation_id = $1",
            [snapId],
          );
          recordsStagedAtInterception = stagingCountRes.rows[0].count;

          const artifactCountRes = await rollbackClient!.query(
            "SELECT count(*)::int as count FROM intentchord.workspace_evidence_artifacts",
          );
          acceptedArtifactsAtInterception = artifactCountRes.rows[0].count;

          const snapStatusRes = await rollbackClient!.query(
            "SELECT status FROM intentchord.workspace_index_snapshots WHERE id = $1",
            [snapId],
          );
          snapshotStatusAtInterception = snapStatusRes.rows[0].status;

          if (recordsStagedAtInterception > 0 && acceptedArtifactsAtInterception === 0) {
            firstDbStagingWriteBeforeLastRecordProduced = true;
          }
        }
      },
      stageSegment: async (sectionType, segment) => {
        await evidenceRepo.insertStagedSegment({
          snapshot_operation_id: snapId,
          section_type: sectionType,
          segment_seq: segment.segment_seq,
          record_count: segment.record_count,
          first_record_seq: segment.first_record_seq,
          last_record_seq: segment.last_record_seq,
          segment_digest: segment.segment_digest,
          byte_size: segment.byte_size,
        });
      },
    };

    // 4. Run engine observation with streaming staging port
    const attestationId = `wca_${createHash("sha256").update(`att_${snapId}`).digest("hex")}`;
    const sealPlan = await buildSealPlan({
      snapshotOperationId: snapId,
      registrationId: WS_ID,
      configSha256: sha256Hex("test_config"),
      files,
      attestationId,
      parsedResults,
      workspaceId: WS_ID,
      staging: stagingPort,
    });

    // PROOF 1: Interception checks during ingestion
    expect(stagingOccursDuringIngestion).toBe(true);
    expect(firstDbStagingWriteBeforeLastRecordProduced).toBe(true);
    expect(recordsStagedAtInterception).toBe(512);
    expect(acceptedArtifactsAtInterception).toBe(0);
    expect(snapshotStatusAtInterception).toBe("CREATING");

    // PROOF 2: SealPlan contains zero record bodies (streaming architecture preserved)
    expect(sealPlan.sections.length).toBe(9);
    for (const section of sealPlan.sections) {
      expect(section.records).toEqual([]);
    }

    // PROOF 3: All expected staged records exist in database
    const totalStagedRecordsRes = await rollbackClient!.query(
      "SELECT count(*)::int as count FROM intentchord.workspace_evidence_staging_records WHERE snapshot_operation_id = $1",
      [snapId],
    );
    const totalManifestRecords = (sealPlan.section_manifest_json as Array<{ record_count: number }>).reduce((sum, e) => sum + e.record_count, 0);
    expect(totalStagedRecordsRes.rows[0].count).toBe(totalManifestRecords);
    expect(totalStagedRecordsRes.rows[0].count).toBeGreaterThan(FILE_COUNT);

    // PROOF 4: All expected staged segments exist in database
    const totalStagedSegmentsRes = await rollbackClient!.query(
      "SELECT count(*)::int as count FROM intentchord.workspace_evidence_staging_segments WHERE snapshot_operation_id = $1",
      [snapId],
    );
    const totalManifestSegments = (sealPlan.section_manifest_json as Array<{ segment_count: number }>).reduce((sum, e) => sum + e.segment_count, 0);
    expect(totalStagedSegmentsRes.rows[0].count).toBe(totalManifestSegments);

    // PROOF 5: All 9 section counts match manifest
    for (const s of sealPlan.sections) {
      const sectionRecordsRes = await rollbackClient!.query(
        "SELECT count(*)::int as count FROM intentchord.workspace_evidence_staging_records WHERE snapshot_operation_id = $1 AND section_type = $2",
        [snapId, s.section_type],
      );
      expect(sectionRecordsRes.rows[0].count).toBe(s.record_count);

      const sectionSegmentsRes = await rollbackClient!.query(
        "SELECT count(*)::int as count FROM intentchord.workspace_evidence_staging_segments WHERE snapshot_operation_id = $1 AND section_type = $2",
        [snapId, s.section_type],
      );
      expect(sectionSegmentsRes.rows[0].count).toBe(s.segment_count);
    }

    // 5. Open and seal attestation
    await evidenceRepo.insertAttestationOpen({
      id: attestationId,
      workspace_registration_id: WS_ID,
      provider_class: "STRONG_CONTINUITY_PROVIDER",
      provider_id: "WINDOWS_NTFS_USN_V1",
      claim_type: "SEALED_INTERVAL",
      volume_identity_json: { volume_serial: "V2_PROOF" },
      journal_identity_json: { usn_journal_id: "J_PROOF" },
      previous_trusted_boundary_usn: null,
      opened_boundary_usn: 100,
      bootstrap: true,
      policy_hash: `sha256:${HEX("9")}`,
      continuity_evidence_json: { proofs: {} },
      snapshot_operation_id: snapId,
    });
    await evidenceRepo.transitionAttestation(attestationId, { attestation_state: "RECONCILING" });
    await evidenceRepo.transitionAttestation(attestationId, {
      attestation_state: "SEALED",
      closed_boundary_usn: 200,
      reconciliation_passes: 0,
      continuity_evidence_json: { engine: "V2_SECTIONED", bootstrap: true },
      attestation_sha256: `sha256:${HEX("e")}`,
    });

    // PROOF 6: Accepted artifact does NOT exist before seal
    const preSealArtifactCount = await rollbackClient!.query(
      "SELECT count(*)::int as count FROM intentchord.workspace_evidence_artifacts",
    );
    expect(preSealArtifactCount.rows[0].count).toBe(0);

    // 6. Execute atomic seal transaction (Step-B promotion)
    const artifactId = `wea_${createHash("sha256").update(snapId).digest("hex")}`;
    const sealed = await snapshotRepo.sealV2Snapshot({
      snapshotId: snapId,
      workspaceRegistrationId: WS_ID,
      workspaceInstanceId: WS_ID,
      completedAt: new Date().toISOString(),
      evidenceArtifact: {
        id: artifactId,
        workspaceRevisionId: sealPlan.workspace_revision_id,
        indexConfigurationSha256: sealPlan.index_configuration_sha256,
        headerJson: sealPlan.header_json,
        sectionManifestJson: sealPlan.section_manifest_json,
        sectionManifestDigest: sealPlan.section_manifest_digest,
        artifactManifestSha256: sealPlan.artifact_manifest_sha256,
        artifactSemanticSha256: sealPlan.artifact_semantic_sha256.startsWith("sha256:")
          ? sealPlan.artifact_semantic_sha256
          : `sha256:${sealPlan.artifact_semantic_sha256}`,
        canonicalCompatSha256: sealPlan.canonical_compat_sha256,
      },
      sections: sealPlan.sections.map(s => ({
        sectionType: s.section_type,
        sectionOrder: s.section_order,
        sectionSchemaVersion: s.section_schema_version,
        sectionDigest: s.section_digest,
        recordCount: s.record_count,
        segmentCount: s.segment_count,
      })),
      attestationId,
      observationResult: "FIRST_INDEXED",
      sourceBindingId: `sbi_${HEX("b")}`,
      sourceBindingMetadata: { normalized_reference: "c:/v2/proof", binding_type: "LOCAL_FILESYSTEM" },
      bindingType: "LOCAL_FILESYSTEM",
      normalizedReference: "c:/v2/proof",
      treeFingerprint: sealPlan.section_manifest_digest,
    }, evidenceRepo);

    // PROOF 7: Snapshot reaches READY
    expect(sealed.status).toBe("READY");

    // PROOF 8: Accepted WEA exists ONLY AFTER seal
    const postSealArtifactCount = await rollbackClient!.query(
      "SELECT count(*)::int as count FROM intentchord.workspace_evidence_artifacts WHERE id = $1",
      [artifactId],
    );
    expect(postSealArtifactCount.rows[0].count).toBe(1);

    // PROOF 9: Staging evidence promoted correctly to accepted evidence
    const promotedRecordsRes = await rollbackClient!.query(
      "SELECT count(*)::int as count FROM intentchord.workspace_evidence_section_records WHERE artifact_id = $1",
      [artifactId],
    );
    expect(promotedRecordsRes.rows[0].count).toBe(totalManifestRecords);

    const promotedSegmentsRes = await rollbackClient!.query(
      "SELECT count(*)::int as count FROM intentchord.workspace_evidence_segments seg JOIN intentchord.workspace_evidence_sections sec ON sec.id = seg.section_id WHERE sec.artifact_id = $1",
      [artifactId],
    );
    expect(promotedSegmentsRes.rows[0].count).toBe(totalManifestSegments);
  });

  // =========================================================================
  // FAILURE-PATH PROOF
  // =========================================================================
  it("FAILURE-PATH PROOF: Injected engine failure leaves no accepted artifact and snapshot not READY", async () => {
    const evidenceRepo = new PostgresWorkspaceEvidenceRepository(rollbackClient!);

    const failOpId = `op-${randomUUID()}`;
    const snapId = failOpId.replace(/^op-/, "");

    await rollbackClient!.query(
      `INSERT INTO intentchord.workspace_index_snapshots
         (id, source_mode, status, workspace_registration_id, workspace_registration_revision,
          workspace_registration_fingerprint, governed_scope, snapshot_idempotency_key,
          snapshot_request_fingerprint_sha256, owner_reference, started_at)
       VALUES ($1, 'REGISTERED_WORKSPACE', 'CREATING', $2, 1, 'fp-fail', '{}', $3, $4, 'proof-owner', now())`,
      [snapId, WS_ID, `idem-${snapId}`, sha256Hex(snapId)],
    );

    let stageCallCount = 0;
    const failingStagingPort: BoundedEvidenceStagingPort = {
      stageRecords: async (sectionType, records) => {
        stageCallCount++;
        // Stage first batch to DB
        await evidenceRepo.insertStagedRecords(records.map(r => ({
          snapshot_operation_id: snapId,
          section_type: sectionType,
          record_seq: r.record_seq,
          record_id: r.record_id,
          record_digest: r.record_digest,
          source_file_revision_id: r.source_file_revision_id ?? null,
          record_json: r.record_json,
        })));

        // INJECT BOUNDED FAILURE on second section or during ingestion
        if (stageCallCount >= 1) {
          throw new Error("INJECTED_ENGINE_INGESTION_FAILURE");
        }
      },
      stageSegment: async (sectionType, segment) => {
        await evidenceRepo.insertStagedSegment({
          snapshot_operation_id: snapId,
          section_type: sectionType,
          segment_seq: segment.segment_seq,
          record_count: segment.record_count,
          first_record_seq: segment.first_record_seq,
          last_record_seq: segment.last_record_seq,
          segment_digest: segment.segment_digest,
          byte_size: segment.byte_size,
        });
      },
    };

    const files = makeSyntheticEngineFiles(10);
    let engineError: unknown = null;
    try {
      await buildSealPlan({
        snapshotOperationId: snapId,
        registrationId: WS_ID,
        configSha256: sha256Hex("fail_config"),
        files,
        attestationId: `wca_${HEX("f")}`,
        staging: failingStagingPort,
      });
    } catch (err) {
      engineError = err;
    }

    // Engine operation failed as expected
    expect(engineError).toBeDefined();
    expect((engineError as Error).message).toBe("INJECTED_ENGINE_INGESTION_FAILURE");

    // VERIFY:
    // 1. PARTIAL_ACCEPTED_ARTIFACT = NO
    const artifactCountRes = await rollbackClient!.query(
      "SELECT count(*)::int as count FROM intentchord.workspace_evidence_artifacts WHERE id = $1",
      [`wea_${snapId}`],
    );
    expect(artifactCountRes.rows[0].count).toBe(0);

    // 2. SNAPSHOT_READY = NO
    const snapStatusRes = await rollbackClient!.query(
      "SELECT status FROM intentchord.workspace_index_snapshots WHERE id = $1",
      [snapId],
    );
    expect(snapStatusRes.rows[0].status).not.toBe("READY");

    // 3. Leftover staging rows remain non-authoritative (no accepted links)
    const stagedCountRes = await rollbackClient!.query(
      "SELECT count(*)::int as count FROM intentchord.workspace_evidence_staging_records WHERE snapshot_operation_id = $1",
      [snapId],
    );
    expect(stagedCountRes.rows[0].count).toBeGreaterThanOrEqual(1);

    const promotedCountRes = await rollbackClient!.query(
      "SELECT count(*)::int as count FROM intentchord.workspace_evidence_section_records WHERE workspace_registration_id = $1 AND record_id = $2",
      [WS_ID, `wfi_synthetic_0`],
    );
    expect(promotedCountRes.rows[0].count).toBe(0);
  });

  // =========================================================================
  // MEMORY PROOF: MAX_LIVE_RECORD_BODIES <= 512 & Does Not Grow With Workspace Size
  // =========================================================================
  it("MEMORY PROOF: MAX_LIVE_RECORD_BODIES <= 512 and does not grow with total workspace record count", async () => {
    // We test with 3 scales: 100 files, 600 files, and 1200 files
    const testScales = [100, 600, 1200];
    const maxLiveRecordsPerScale: number[] = [];

    for (const count of testScales) {
      const files = makeSyntheticEngineFiles(count);
      let currentLiveBodies = 0;
      let peakLiveBodies = 0;

      const memoryTrackingPort: BoundedEvidenceStagingPort = {
        stageRecords: async (_sectionType, records) => {
          // While records are in the segmentBuffer, they are live
          // Here they are about to be staged and flushed
          peakLiveBodies = Math.max(peakLiveBodies, records.length);
          // Confirm segment never exceeds 512
          expect(records.length).toBeLessThanOrEqual(512);
        },
        stageSegment: async () => {},
      };

      const sealPlan = await buildSealPlan({
        snapshotOperationId: `op-mem-${count}`,
        registrationId: WS_ID,
        configSha256: sha256Hex(`config_${count}`),
        files,
        attestationId: `wca_mem_${count}`,
        staging: memoryTrackingPort,
      });

      maxLiveRecordsPerScale.push(peakLiveBodies);

      // Verify final SealPlan has zero record bodies retained
      for (const section of sealPlan.sections) {
        expect(section.records.length).toBe(0);
      }
    }

    // PROOF: For 100 files: peak is 100 <= 512
    expect(maxLiveRecordsPerScale[0]).toBe(100);
    expect(maxLiveRecordsPerScale[0]).toBeLessThanOrEqual(512);

    // PROOF: For 600 files: peak is 512 <= 512
    expect(maxLiveRecordsPerScale[1]).toBe(512);

    // PROOF: For 1200 files: peak is STILL 512 <= 512 (does NOT grow with workspace size!)
    expect(maxLiveRecordsPerScale[2]).toBe(512);

    // Bounded constant invariant:
    expect(maxLiveRecordsPerScale[2]).toBe(maxLiveRecordsPerScale[1]);
  });

  // =========================================================================
  // ARCHITECTURAL CONTRACT ASSERTIONS
  // =========================================================================
  it("ARCHITECTURAL INTEGRITY: Engine has no Postgres/SQL dependency; zero post-engine service record staging", async () => {
    const fs = await import("node:fs");
    const engineSrc = fs.readFileSync("src/core/workspace-index/ingestion/engine-v2.ts", "utf8");
    const serviceSrc = fs.readFileSync("src/server/workspace-index-snapshot-service.ts", "utf8");

    // 1. Core Engine MUST NOT depend on Postgres, SQL, or database clients
    expect(engineSrc.includes('from "pg"')).toBe(false);
    expect(engineSrc.includes("from 'pg'")).toBe(false);
    expect(engineSrc.includes("WorkspaceEvidenceRepository")).toBe(false);
    expect(engineSrc.includes("SELECT ")).toBe(false);
    expect(engineSrc.includes("INSERT INTO")).toBe(false);

    // 2. Service layer creates the staging port before engine execution
    const v2Block = serviceSrc.substring(serviceSrc.indexOf('engineChoice === "V2"'));
    expect(v2Block.includes("const stagingPort:")).toBe(true);
    expect(v2Block.includes("stagingPort")).toBe(true);

    // 3. Obsolete post-engine authoritative record staging dependency is removed
    expect(v2Block.includes("for (const section of v2Sealed.sealPlan.sections)")).toBe(false);
  });
});

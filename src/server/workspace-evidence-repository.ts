import type { Pool, PoolClient } from "pg";
import { createHash, randomUUID } from "node:crypto";
import { databasePool } from "@/server/db";
import {
  FIXED_SECTION_ORDER,
  SECTION_FAILURE_CODES,
  type EvidenceSectionType,
  type SectionManifestEntry,
} from "@/core/workspace-index/sections/sectioned-contracts";

/**
 * Sectioned Evidence repositories (SPEC V3 Phase 2). BOUNDED APIs ONLY:
 * no method returns a whole workspace contract object or materializes an entire
 * artifact payload. Family data is always streamed record-by-record in canonical
 * order or addressed by stable identifiers.
 *
 * Identity/digest computation lives in Phase 1 core primitives and is NEVER
 * duplicated here; callers pass precomputed ids/digests into these persistence
 * surfaces.
 */

export type ArtifactInsert = {
  id: string;
  workspace_registration_id: string;
  workspace_revision_id: string;
  index_configuration_sha256: string;
  header_json: unknown;
  section_manifest_json: unknown;
  section_manifest_digest: string;
  artifact_manifest_sha256: string;
  artifact_semantic_sha256: string;
  canonical_compat_sha256: string;
};

export type SectionInsert = {
  workspace_registration_id: string;
  artifact_id: string;
  section_type: EvidenceSectionType;
  section_order: number;
  section_schema_version: string;
  section_digest: string;
  record_count: number;
  segment_count: number;
};

export type StagedRecordInsert = {
  snapshot_operation_id: string;
  section_type: EvidenceSectionType;
  record_seq: number;
  record_id: string;
  record_digest: string;
  source_file_revision_id?: string | null;
  record_json: unknown;
};

export type StagingRecordRow = {
  snapshot_operation_id: string;
  section_type: EvidenceSectionType;
  record_seq: number;
  record_id: string;
  record_digest: string;
  source_file_revision_id: string | null;
  record_json: unknown;
};

// PostgreSQL's extended-query protocol has a uint16 parameter ceiling. Keep a
// documented 9,535-parameter margin below 65,535 for driver/protocol safety.
export const POSTGRES_STAGING_BIND_PARAMETER_BUDGET = 56_000;
const STAGING_RECORD_COLUMNS = [
  "snapshot_operation_id",
  "section_type",
  "record_seq",
  "record_id",
  "record_digest",
  "source_file_revision_id",
  "record_json",
] as const;
export const PARAMETERS_PER_STAGING_RECORD = STAGING_RECORD_COLUMNS.length;
export const MAX_STAGED_RECORDS_PER_INSERT = Math.floor(
  POSTGRES_STAGING_BIND_PARAMETER_BUDGET / PARAMETERS_PER_STAGING_RECORD,
);

if (MAX_STAGED_RECORDS_PER_INSERT < 1) {
  throw new Error("STAGING_BIND_PARAMETER_BUDGET_INVALID");
}

type TransactionalQueryClient = Pick<PoolClient, "query">;

function hasPoolConnect(source: Pool | PoolClient | import("pg").Client): source is Pool {
  return typeof (source as { connect?: unknown }).connect === "function" && typeof (source as { release?: unknown }).release !== "function";
}

function hasPoolClientRelease(source: PoolClient | import("pg").Client): source is PoolClient {
  return typeof (source as { release?: unknown }).release === "function";
}

export class WorkspaceEvidencePersistenceError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly detail: Record<string, unknown> = {},
  ) {
    super(code);
    this.name = "WorkspaceEvidencePersistenceError";
    void message;
  }
}

function assertBoundedJson(label: string, value: unknown, maxOctets: number): void {
  const octets = Buffer.byteLength(JSON.stringify(value ?? null), "utf8");
  if (octets > maxOctets) {
    throw new WorkspaceEvidencePersistenceError(
      SECTION_FAILURE_CODES.RECORD_OVERBOUND,
      `${label} exceeds ${maxOctets} octets`,
      { octets },
    );
  }
}

function sha256HexOfJson(value: unknown): string {
  // Sorted-key canonical JSON via the repository's canonical serializer semantics.
  return createHash("sha256").update(JSON.stringify(sortDeep(value)), "utf8").digest("hex");
}

function sortDeep(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sortDeep);
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    out[key] = sortDeep((value as Record<string, unknown>)[key]);
  }
  return out;
}

export class PostgresWorkspaceEvidenceRepository {
  constructor(
    private readonly source: Pool | PoolClient | import("pg").Client = databasePool() as unknown as Pool,
  ) {}

  /** Parameterized passthrough for validation harnesses; production callers use bounded APIs. */
  async query(sqlText: string, values: ReadonlyArray<unknown> = []) {
    return this.source.query(sqlText, values as never[]);
  }

  private async withStagingTransaction<T>(work: (client: TransactionalQueryClient) => Promise<T>): Promise<T> {
    if (hasPoolConnect(this.source)) {
      const client = await this.source.connect();
      let begun = false;
      try {
        await client.query("BEGIN");
        begun = true;
        const result = await work(client);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        if (begun) {
          try { await client.query("ROLLBACK"); } catch { /* preserve the primary staging error */ }
        }
        throw error;
      } finally {
        client.release();
      }
    }

    const client = this.source as PoolClient | import("pg").Client;
    if (!hasPoolClientRelease(client)) {
      let begun = false;
      try {
        await client.query("BEGIN");
        begun = true;
        const result = await work(client);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        if (begun) {
          try { await client.query("ROLLBACK"); } catch { /* preserve the primary staging error */ }
        }
        throw error;
      }
    }

    // An injected PoolClient is caller-owned and may already be participating
    // in a broader transaction. A savepoint provides the same all-or-nothing
    // boundary without committing or rolling back that outer transaction.
    const savepoint = `intentchord_staging_${randomUUID().replaceAll("-", "")}`;
    await client.query(`SAVEPOINT ${savepoint}`);
    try {
      const result = await work(client);
      await client.query(`RELEASE SAVEPOINT ${savepoint}`);
      return result;
    } catch (error) {
      try {
        await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        await client.query(`RELEASE SAVEPOINT ${savepoint}`);
      } catch {
        // Preserve the primary staging error.
      }
      throw error;
    }
  }

  // ------------------------------------------------------------------
  // STAGING (attempt-scoped evidence; keys = snapshot_operation_id per US-1)
  // ------------------------------------------------------------------

  async insertStagedRecords(batch: ReadonlyArray<StagedRecordInsert>): Promise<number> {
    if (batch.length === 0) return 0;
    return this.withStagingTransaction(async client => {
      let inserted = 0;
      for (let offset = 0; offset < batch.length; offset += MAX_STAGED_RECORDS_PER_INSERT) {
        const statementRows = batch.slice(offset, offset + MAX_STAGED_RECORDS_PER_INSERT);
        const placeholders: string[] = [];
        const values: unknown[] = [];
        let parameter = 1;
        for (const item of statementRows) {
          assertBoundedJson("staged record_json", item.record_json, 262_144);
          const rowValues = [
            item.snapshot_operation_id,
            item.section_type,
            item.record_seq,
            item.record_id,
            item.record_digest,
            item.source_file_revision_id ?? null,
            JSON.stringify(item.record_json ?? null),
          ];
          if (rowValues.length !== PARAMETERS_PER_STAGING_RECORD) {
            throw new Error("STAGING_RECORD_PARAMETER_SHAPE_MISMATCH");
          }
          placeholders.push(`(${rowValues.map(() => `$${parameter++}`).join(",")})`);
          values.push(...rowValues);
        }
        if (values.length !== statementRows.length * PARAMETERS_PER_STAGING_RECORD || values.length > POSTGRES_STAGING_BIND_PARAMETER_BUDGET) {
          throw new Error("STAGING_BIND_PARAMETER_BUDGET_EXCEEDED");
        }
        const result = await client.query(
          `INSERT INTO intentchord.workspace_evidence_staging_records
             (${STAGING_RECORD_COLUMNS.join(", ")})
           VALUES ${placeholders.join(",")}
           ON CONFLICT (snapshot_operation_id, section_type, record_seq) DO NOTHING`,
          values,
        );
        inserted += result.rowCount ?? 0;
      }
      return inserted;
    });
  }

  async insertStagedSegment(input: {
    snapshot_operation_id: string;
    section_type: EvidenceSectionType;
    segment_seq: number;
    record_count: number;
    first_record_seq: number;
    last_record_seq: number;
    segment_digest: string;
    byte_size: number;
  }): Promise<void> {
    await this.query(
      `INSERT INTO intentchord.workspace_evidence_staging_segments
         (snapshot_operation_id, section_type, segment_seq, record_count,
          first_record_seq, last_record_seq, segment_digest, byte_size)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (snapshot_operation_id, section_type, segment_seq) DO NOTHING`,
      [
        input.snapshot_operation_id,
        input.section_type,
        input.segment_seq,
        input.record_count,
        input.first_record_seq,
        input.last_record_seq,
        input.segment_digest,
        input.byte_size,
      ],
    );
  }

  /** Ordered staged-record stream for one attempt+section (bounded page iteration). */
  async *streamStagedRecords(
    snapshotOperationId: string,
    sectionType: EvidenceSectionType,
    pageSize = 512,
  ): AsyncGenerator<StagingRecordRow, void, unknown> {
    let cursor = 0;
    for (;;) {
      const result = await this.query(
        `SELECT snapshot_operation_id, section_type, record_seq, record_id, record_digest,
                source_file_revision_id, record_json
           FROM intentchord.workspace_evidence_staging_records
          WHERE snapshot_operation_id=$1 AND section_type=$2 AND record_seq>$3
          ORDER BY record_seq ASC LIMIT $4`,
        [snapshotOperationId, sectionType, cursor, pageSize],
      );
      for (const row of result.rows) {
        cursor = row.record_seq;
        yield row as StagingRecordRow;
      }
      if (result.rowCount === 0 || result.rows.length < pageSize) return;
    }
  }

  async countStagedRecords(snapshotOperationId: string, sectionType?: EvidenceSectionType): Promise<number> {
    const result = await this.query(
      `SELECT count(*)::int AS n FROM intentchord.workspace_evidence_staging_records
        WHERE snapshot_operation_id=$1 AND ($2::text IS NULL OR section_type=$2)`,
      [snapshotOperationId, sectionType ?? null],
    );
    return result.rows[0]?.n ?? 0;
  }

  async deleteStagedForSnapshot(snapshotOperationId: string): Promise<number> {
    const a = await this.query(
      `DELETE FROM intentchord.workspace_evidence_staging_records WHERE snapshot_operation_id=$1`,
      [snapshotOperationId],
    );
    await this.query(
      `DELETE FROM intentchord.workspace_evidence_staging_segments WHERE snapshot_operation_id=$1`,
      [snapshotOperationId],
    );
    return a.rowCount ?? 0;
  }

  // ------------------------------------------------------------------
  // ACCEPTED TOPOLOGY (append-only; inserts only via the seal path)
  // ------------------------------------------------------------------

  async insertArtifact(artifact: ArtifactInsert): Promise<void> {
    assertBoundedJson("artifact header_json", artifact.header_json, 65_536);
    assertBoundedJson("artifact section_manifest_json", artifact.section_manifest_json, 16_384);
    await this.query(
      `INSERT INTO intentchord.workspace_evidence_artifacts
         (id, workspace_registration_id, workspace_revision_id, index_configuration_sha256,
          header_json, section_manifest_json, section_manifest_digest,
          artifact_manifest_sha256, artifact_semantic_sha256, canonical_compat_sha256)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        artifact.id,
        artifact.workspace_registration_id,
        artifact.workspace_revision_id,
        artifact.index_configuration_sha256,
        JSON.stringify(artifact.header_json),
        JSON.stringify(artifact.section_manifest_json),
        artifact.section_manifest_digest,
        artifact.artifact_manifest_sha256,
        artifact.artifact_semantic_sha256,
        artifact.canonical_compat_sha256,
      ],
    );
  }

  async insertSection(section: SectionInsert): Promise<number> {
    const result = await this.query(
      `INSERT INTO intentchord.workspace_evidence_sections
         (workspace_registration_id, artifact_id, section_type, section_order,
          section_schema_version, section_digest, record_count, segment_count)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id`,
      [
        section.workspace_registration_id,
        section.artifact_id,
        section.section_type,
        section.section_order,
        section.section_schema_version,
        section.section_digest,
        section.record_count,
        section.segment_count,
      ],
    );
    return result.rows[0].id as number;
  }

  async getSectionManifest(artifactId: string): Promise<ReadonlyArray<SectionManifestEntry>> {
    const result = await this.query(
      `SELECT section_manifest_json FROM intentchord.workspace_evidence_artifacts WHERE id=$1`,
      [artifactId],
    );
    return (result.rows[0]?.section_manifest_json ?? []) as ReadonlyArray<SectionManifestEntry>;
  }

  async getSectionIdByType(artifactId: string, sectionType: EvidenceSectionType): Promise<number | null> {
    const result = await this.query(
      `SELECT id FROM intentchord.workspace_evidence_sections WHERE artifact_id=$1 AND section_type=$2`,
      [artifactId, sectionType],
    );
    return result.rows[0]?.id ?? null;
  }

  async getSectionSchemaVersion(artifactId: string, sectionType: EvidenceSectionType): Promise<string | null> {
    const result = await this.query(
      `SELECT section_schema_version FROM intentchord.workspace_evidence_sections WHERE artifact_id=$1 AND section_type=$2`,
      [artifactId, sectionType],
    );
    return (result.rows[0]?.section_schema_version as string) ?? null;
  }

  /** Ordered accepted-record stream (bounded pages; canonical order by record_seq, with optional cursor range). */
  async *streamAcceptedRecords(
    artifactId: string,
    sectionType: EvidenceSectionType,
    pageSize = 512,
    startRecordSeqExclusive = 0,
    endRecordSeqInclusive?: number,
  ): AsyncGenerator<Record<string, unknown>, void, unknown> {
    let cursor = startRecordSeqExclusive;
    for (;;) {
      const params: unknown[] = [artifactId, sectionType, cursor];
      let query = `SELECT r.record_seq, r.record_id, r.record_digest, r.source_file_revision_id, r.record_json, s.section_schema_version
           FROM intentchord.workspace_evidence_section_records r
           JOIN intentchord.workspace_evidence_sections s ON s.id=r.section_id
          WHERE s.artifact_id=$1 AND s.section_type=$2 AND r.record_seq>$3`;
      if (typeof endRecordSeqInclusive === "number") {
        params.push(endRecordSeqInclusive);
        query += ` AND r.record_seq<=$${params.length}`;
      }
      params.push(pageSize);
      query += ` ORDER BY r.record_seq ASC LIMIT $${params.length}`;

      const result = await this.query(query, params);
      for (const row of result.rows) {
        cursor = Number(row.record_seq);
        yield row;
      }
      if (result.rows.length < pageSize || (typeof endRecordSeqInclusive === "number" && cursor >= endRecordSeqInclusive)) return;
    }
  }

  /** Selective drilldown: fetch structural entries for specific logical unit IDs in deterministic order. */
  async findStructuralEntriesByLogicalUnits(
    artifactId: string,
    logicalUnitIds: readonly string[],
  ): Promise<ReadonlyArray<Record<string, unknown>>> {
    if (logicalUnitIds.length === 0) return [];
    const result = await this.query(
      `SELECT r.record_seq, r.record_id, r.record_digest, r.source_file_revision_id, r.record_json, s.section_schema_version
         FROM intentchord.workspace_evidence_section_records r
         JOIN intentchord.workspace_evidence_sections s ON s.id=r.section_id
        WHERE s.artifact_id=$1
          AND s.section_type='SEMANTIC_PROJECTION'
          AND (r.record_json->>'logical_unit_id') = ANY($2::text[])
        ORDER BY r.record_seq ASC`,
      [artifactId, logicalUnitIds],
    );
    return result.rows;
  }

  /** Get authoritative SEMANTIC_PROJECTION section metadata for cursor scoping. */
  async getSemanticProjectionSection(artifactId: string): Promise<{
    id: number;
    section_schema_version: string;
    section_digest: string;
    record_count: number;
  } | null> {
    const result = await this.query(
      `SELECT id, section_schema_version, section_digest, record_count
         FROM intentchord.workspace_evidence_sections
        WHERE artifact_id=$1 AND section_type='SEMANTIC_PROJECTION'`,
      [artifactId],
    );
    if (!result.rows[0]) return null;
    return {
      id: Number(result.rows[0].id),
      section_schema_version: result.rows[0].section_schema_version,
      section_digest: result.rows[0].section_digest,
      record_count: Number(result.rows[0].record_count),
    };
  }

  /** Read all accepted records for a section as an array (bounded sections only). */
  async readAcceptedRecordsAsArray(
    artifactId: string,
    sectionType: EvidenceSectionType,
  ): Promise<ReadonlyArray<Record<string, unknown>>> {
    const result = await this.query(
      `SELECT r.record_seq, r.record_id, r.record_digest, r.source_file_revision_id, r.record_json
         FROM intentchord.workspace_evidence_section_records r
         JOIN intentchord.workspace_evidence_sections s ON s.id=r.section_id
        WHERE s.artifact_id=$1 AND s.section_type=$2
        ORDER BY r.record_seq ASC`,
      [artifactId, sectionType],
    );
    return result.rows;
  }

  async *streamSegments(artifactId: string, sectionType: EvidenceSectionType): AsyncGenerator<Record<string, unknown>, void, unknown> {
    const result = await this.query(
      `SELECT g.segment_seq, g.record_count, g.first_record_seq, g.last_record_seq,
              g.segment_digest, g.byte_size
         FROM intentchord.workspace_evidence_segments g
         JOIN intentchord.workspace_evidence_sections s ON s.id=g.section_id
        WHERE s.artifact_id=$1 AND s.section_type=$2
        ORDER BY g.segment_seq ASC`,
      [artifactId, sectionType],
    );
    for (const row of result.rows) yield row;
  }

  /**
   * SERVER-SIDE PROMOTION (SPEC 4.4 S4): copies staged rows into the accepted topology inside
   * the CALLER'S transaction; zero client-side transfer of record bodies.
   */
  async promoteStagedSectionWithinTransaction(
    client: PoolClient,
    params: {
      snapshot_operation_id: string;
      workspace_registration_id: string;
      artifact_id: string;
      section_type: EvidenceSectionType;
      expected_record_count: number;
    },
  ): Promise<number> {
    const inserted = await client.query(
      `INSERT INTO intentchord.workspace_evidence_section_records
         (workspace_registration_id, artifact_id, section_id, section_type, record_seq,
          record_id, record_digest, source_file_revision_id, record_json)
       SELECT $2,$3,s.id,s.section_type,r.record_seq,r.record_id,r.record_digest,
              r.source_file_revision_id,r.record_json
         FROM intentchord.workspace_evidence_staging_records r
         JOIN intentchord.workspace_evidence_sections s
           ON s.workspace_registration_id=$2 AND s.artifact_id=$3 AND s.section_type=r.section_type
        WHERE r.snapshot_operation_id=$1 AND r.section_type=$4
        ORDER BY r.record_seq`,
      [
        params.snapshot_operation_id,
        params.workspace_registration_id,
        params.artifact_id,
        params.section_type,
      ],
    );
    const rowCount = inserted.rowCount ?? 0;
    if (rowCount !== params.expected_record_count) {
      throw new WorkspaceEvidencePersistenceError(
        SECTION_FAILURE_CODES.MANIFEST_MISMATCH,
        `staged record count mismatch for ${params.section_type}`,
        { expected: params.expected_record_count, actual: rowCount },
      );
    }
    await client.query(
      `INSERT INTO intentchord.workspace_evidence_segments
         (section_id,segment_seq,record_count,first_record_seq,last_record_seq,segment_digest,byte_size)
       SELECT s.id,g.segment_seq,g.record_count,g.first_record_seq,g.last_record_seq,g.segment_digest,g.byte_size
         FROM intentchord.workspace_evidence_staging_segments g
         JOIN intentchord.workspace_evidence_sections s
           ON s.workspace_registration_id=$2 AND s.artifact_id=$3 AND s.section_type=g.section_type
        WHERE g.snapshot_operation_id=$1 AND g.section_type=$4
        ORDER BY g.segment_seq`,
      [
        params.snapshot_operation_id,
        params.workspace_registration_id,
        params.artifact_id,
        params.section_type,
      ],
    );
    return rowCount;
  }

  /**
   * Context Mapping dual-artifact binding surface (SPEC V3 13.8). Bounded insert used by
   * governed flows and validation; DB triggers enforce cia_/wea_ existence + semantic-sha
   * equality and protect referenced artifacts from deletion.
   */
  async insertContextMappingForValidation(input: {
    id: string;
    mapping_input_snapshot: unknown;
    workspace_snapshot_id: string;
    workspace_index_sha256: string;
    qualification_scope: string;
    workspace_index_snapshot_id?: string | null;
    mapping_idempotency_key: string;
    mapping_request_fingerprint_sha256: string;
    canonical_index_artifact_id: string;
    artifact_semantic_sha256: string;
    primary_provider_id?: string;
    primary_channel_id?: string;
    primary_model_id?: string;
  }): Promise<void> {
    assertBoundedJson("context mapping input snapshot", input.mapping_input_snapshot, 65_536);
    await this.query(
      `INSERT INTO intentchord.context_mapping_runs
         (id,mapping_input_snapshot_id,mapping_input_sha256,mapping_input_snapshot,
          workspace_index_contract_version,workspace_snapshot_id,workspace_index_sha256,
          eligible_entry_count,excluded_entry_count,provider_neutral_estimated_tokens,status,
          primary_provider_id,primary_channel_id,primary_model_id,standby_enabled,
          standby_governance_state,provider_configuration_snapshot,owner_verdict_state,
          qualification_scope,workspace_index_snapshot_id,mapping_idempotency_key,
          mapping_request_fingerprint_sha256,canonical_index_artifact_id,artifact_semantic_sha256)
       VALUES ($1,$2,$3,$4,'1.0.0',$5,$6,0,0,0,'CREATED',$7,$8,$9,false,
               'BLOCKED_BY_GOVERNANCE','{}'::jsonb,'PENDING',$10,$11,$12,$13,$14,$15)`,
      [
        input.id,
        "sectioned-validation",
        `sha256:${sha256HexOfJson(input.mapping_input_snapshot)}`,
        JSON.stringify(input.mapping_input_snapshot ?? {}),
        input.workspace_snapshot_id,
        input.workspace_index_sha256,
        input.primary_provider_id ?? "validation",
        input.primary_channel_id ?? "validation-channel",
        input.primary_model_id ?? "validation-model",
        input.qualification_scope,
        input.workspace_index_snapshot_id ?? null,
        input.mapping_idempotency_key,
        input.mapping_request_fingerprint_sha256,
        input.canonical_index_artifact_id,
        input.artifact_semantic_sha256,
      ],
    );
  }

  // ------------------------------------------------------------------
  // T7 OBJECT IDENTITY LOOKUPS (point + batched; no full-family loads)
  // ------------------------------------------------------------------

  async findPreviousFileByPath(registrationId: string, revisionId: string, relativePath: string) {
    const result = await this.query(
      `SELECT workspace_file_id, prior_relative_path, device_id, object_file_id, object_sequence,
              proof_method, lineage_state, move_proof
         FROM intentchord.workspace_file_object_identity_index
        WHERE workspace_registration_id=$1 AND workspace_revision_id=$2 AND relative_path=$3`,
      [registrationId, revisionId, relativePath],
    );
    return result.rows[0] ?? null;
  }

  async findPreviousFilesByObjectIdentity(
    registrationId: string,
    revisionId: string,
    identityKeys: ReadonlyArray<{ device_id: string; object_file_id: string; object_sequence: number | null }>,
  ): Promise<Map<string, Record<string, unknown>>> {
    const found = new Map<string, Record<string, unknown>>();
    const pageSize = 200;
    for (let offset = 0; offset < identityKeys.length; offset += pageSize) {
      const slice = identityKeys.slice(offset, offset + pageSize);
      const unnestDevices: string[] = [];
      const unnestIds: string[] = [];
      const unnestSeqs: Array<number | null> = [];
      for (const key of slice) {
        unnestDevices.push(key.device_id);
        unnestIds.push(key.object_file_id);
        unnestSeqs.push(key.object_sequence);
      }
      const result = await this.query(
        `SELECT i.workspace_file_id, i.relative_path, i.prior_relative_path, i.device_id,
                i.object_file_id, i.object_sequence, i.proof_method, i.lineage_state, i.move_proof
           FROM intentchord.workspace_file_object_identity_index i
           JOIN unnest($3::text[], $4::text[], $5::bigint[]) AS k(device_id, object_file_id, object_sequence)
             ON i.device_id=k.device_id AND i.object_file_id=k.object_file_id
            AND (($6::boolean AND i.object_sequence IS NOT DISTINCT FROM k.object_sequence)
                 OR (NOT $6::boolean))
          WHERE i.workspace_registration_id=$1 AND i.workspace_revision_id=$2`,
        [
          registrationId,
          revisionId,
          unnestDevices,
          unnestIds,
          unnestSeqs,
          true,
        ],
      );
      for (const row of result.rows) {
        found.set(`${row.device_id}|${row.object_file_id}|${row.object_sequence}`, row);
      }
    }
    return found;
  }

  // ------------------------------------------------------------------
  // CONTINUITY ATTESTATION LIFECYCLE PERSISTENCE (guards live in DB triggers)
  // ------------------------------------------------------------------

  async insertAttestationOpen(input: {
    id: string;
    workspace_registration_id: string;
    provider_class: string;
    provider_id: string;
    claim_type: string;
    volume_identity_json: unknown;
    journal_identity_json: unknown;
    previous_trusted_boundary_usn: number | string | null;
    opened_boundary_usn: number | string;
    bootstrap: boolean;
    policy_hash: string;
    continuity_evidence_json: unknown;
    snapshot_operation_id: string;
  }): Promise<void> {
    await this.query(
      `INSERT INTO intentchord.workspace_source_continuity_attestations
         (id,workspace_registration_id,provider_class,provider_id,claim_type,
          volume_identity_json,journal_identity_json,previous_trusted_boundary_usn,
          opened_boundary_usn,bootstrap,policy_hash,continuity_evidence_json,snapshot_operation_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        input.id,
        input.workspace_registration_id,
        input.provider_class,
        input.provider_id,
        input.claim_type,
        JSON.stringify(input.volume_identity_json ?? {}),
        input.journal_identity_json == null ? null : JSON.stringify(input.journal_identity_json),
        input.previous_trusted_boundary_usn,
        input.opened_boundary_usn,
        input.bootstrap,
        input.policy_hash,
        JSON.stringify(input.continuity_evidence_json ?? {}),
        input.snapshot_operation_id,
      ],
    );
  }

  async transitionAttestation(
    attestationId: string,
    patch: {
      attestation_state?: "RECONCILING" | "SEALED" | "VOID";
      closed_boundary_usn?: number | string;
      attestation_sha256?: string;
      policy_hash?: string;
      continuity_evidence_json?: unknown;
      reconciliation_passes?: number;
      void_reason?: string;
      observation_id?: string;
    },
  ): Promise<void> {
    const sets: string[] = [];
    const values: unknown[] = [attestationId];
    let p = 2;
    const push = (column: string, value: unknown) => {
      sets.push(`${column}=$${p++}`);
      values.push(value === undefined ? null : value);
    };
    if (patch.attestation_state !== undefined) push("attestation_state", patch.attestation_state);
    if (patch.closed_boundary_usn !== undefined) push("closed_boundary_usn", patch.closed_boundary_usn);
    if (patch.attestation_sha256 !== undefined) push("attestation_sha256", patch.attestation_sha256);
    if (patch.continuity_evidence_json !== undefined) push("continuity_evidence_json", JSON.stringify(patch.continuity_evidence_json));
    if (patch.reconciliation_passes !== undefined) push("reconciliation_passes", patch.reconciliation_passes);
    if (patch.void_reason !== undefined) push("void_reason", patch.void_reason);
    if (patch.observation_id !== undefined) push("observation_id", patch.observation_id);
    if (sets.length === 0) return;
    const result = await this.query(
      `UPDATE intentchord.workspace_source_continuity_attestations SET ${sets.join(",")} WHERE id=$1`,
      values,
    );
    // Belt-and-braces authority enforcement: PostgreSQL BEFORE-row triggers may silently skip a
    // row by returning NULL. A lifecycle transition MUST either apply or raise — never vanish.
    if ((result.rowCount ?? 0) === 0) {
      const current = await this.getAttestation(attestationId);
      throw new WorkspaceEvidencePersistenceError(
        "INTENTCHORD_WCA_TRANSITION_BLOCKED:SILENT_SUPPRESSION",
        `attestation transition suppressed for id=${attestationId}; persisted state=${current?.attestation_state ?? "<missing>"}`,
        { requested: patch, persistedState: current?.attestation_state ?? null },
      );
    }
    // Read-back verification for immutable-field mutations on SEALED attestations.
    if (patch.policy_hash !== undefined || patch.continuity_evidence_json !== undefined || patch.attestation_state === "SEALED" || patch.reconciliation_passes !== undefined) {
      const current = await this.getAttestation(attestationId);
      const persisted = current as unknown as Record<string, unknown> | null;
      if (!persisted) {
        throw new WorkspaceEvidencePersistenceError(
          "INTENTCHORD_WCA_TRANSITION_BLOCKED:MISSING_ATTESTATION",
          `attestation read-back failed: id=${attestationId} not found after transition`,
          { requested: patch },
        );
      }
      // M9: On SEALED transition, verify immutable material persisted correctly.
      if (patch.attestation_state === "SEALED") {
        if (persisted.attestation_state !== "SEALED") {
          throw new WorkspaceEvidencePersistenceError(
            "INTENTCHORD_WCA_TRANSITION_BLOCKED:SEALED_NOT_APPLIED",
            `attestation state did not transition to SEALED: persisted state=${persisted.attestation_state}`,
            { requested: "SEALED", persistedState: persisted.attestation_state },
          );
        }
        // Verify immutable identity fields were not silently altered.
        for (const field of ["provider_class", "provider_id", "claim_type", "bootstrap", "opened_boundary_usn"]) {
          if (patch[field as keyof typeof patch] !== undefined && persisted[field] !== patch[field as keyof typeof patch]) {
            throw new WorkspaceEvidencePersistenceError(
              "INTENTCHORD_WCA_TRANSITION_BLOCKED:IMMUTABLE_FIELD_MISMATCH",
              `immutable field ${field} does not match requested value after SEALED transition`,
              { field, requested: patch[field as keyof typeof patch], persisted: persisted[field] },
            );
          }
        }
      }
      if (patch.policy_hash !== undefined && persisted.policy_hash !== patch.policy_hash) {
        throw new WorkspaceEvidencePersistenceError(
          "INTENTCHORD_WCA_TRANSITION_BLOCKED:SEALED->SEALED",
          "immutable attestation material did not persist (silent suppression detected via read-back)",
          { field: "policy_hash", requested: patch.policy_hash, persistedState: current?.attestation_state ?? null },
        );
      }
      if (patch.reconciliation_passes !== undefined && persisted.reconciliation_passes !== patch.reconciliation_passes) {
        throw new WorkspaceEvidencePersistenceError(
          "INTENTCHORD_WCA_TRANSITION_BLOCKED:RECONCILIATION_PASSES_MISMATCH",
          "reconciliation_passes did not persist correctly",
          { field: "reconciliation_passes", requested: patch.reconciliation_passes, persisted: persisted.reconciliation_passes },
        );
      }
      // R1: Read-back verification for deferred fields set at SEALED transition.
      if (patch.closed_boundary_usn !== undefined) {
        const persistedVal = persisted.closed_boundary_usn;
        if (patch.closed_boundary_usn != null && String(persistedVal) !== String(patch.closed_boundary_usn)) {
          throw new WorkspaceEvidencePersistenceError(
            "INTENTCHORD_WCA_TRANSITION_BLOCKED:CLOSED_BOUNDARY_MISMATCH",
            "closed_boundary_usn did not persist correctly",
            { field: "closed_boundary_usn", requested: patch.closed_boundary_usn, persisted: persistedVal },
          );
        }
      }
      if (patch.continuity_evidence_json !== undefined) {
        const persistedEvidence = typeof persisted.continuity_evidence_json === "string"
          ? JSON.parse(persisted.continuity_evidence_json as string)
          : persisted.continuity_evidence_json;
        const requestedEvidence = patch.continuity_evidence_json;
        const normalizeKeys = (obj: unknown): unknown =>
          typeof obj === "object" && obj !== null && !Array.isArray(obj)
            ? Object.fromEntries(Object.keys(obj as Record<string, unknown>).sort().map(k => [k, normalizeKeys((obj as Record<string, unknown>)[k])]))
            : Array.isArray(obj) ? obj.map(normalizeKeys) : obj;
        if (JSON.stringify(normalizeKeys(persistedEvidence)) !== JSON.stringify(normalizeKeys(requestedEvidence))) {
          throw new WorkspaceEvidencePersistenceError(
            "INTENTCHORD_WCA_TRANSITION_BLOCKED:CONTINUITY_EVIDENCE_MISMATCH",
            "continuity_evidence_json did not persist correctly",
            { requested: requestedEvidence, persisted: persistedEvidence },
          );
        }
      }
      if (patch.attestation_sha256 !== undefined && persisted.attestation_sha256 !== patch.attestation_sha256) {
        throw new WorkspaceEvidencePersistenceError(
          "INTENTCHORD_WCA_TRANSITION_BLOCKED:ATTESTATION_SHA_MISMATCH",
          "attestation_sha256 did not persist correctly",
          { field: "attestation_sha256", requested: patch.attestation_sha256, persisted: persisted.attestation_sha256 },
        );
      }
    }
  }

  async getAttestation(attestationId: string) {
    const result = await this.query(
      `SELECT * FROM intentchord.workspace_source_continuity_attestations WHERE id=$1`,
      [attestationId],
    );
    return result.rows[0] ?? null;
  }

  async getSealedAttestationForObservation(
    workspaceRegistrationId: string,
    predecessorObservationId: string,
  ): Promise<{
    id: string;
    closed_boundary_usn: number | null;
    journal_id: string;
    volume_serial: string;
    policy_hash: string;
  } | null> {
    const result = await this.query(
      `SELECT wca.id, wca.closed_boundary_usn, wca.journal_identity_json, wca.policy_hash
       FROM intentchord.workspace_source_continuity_attestations wca
       JOIN intentchord.workspace_observations wo
         ON wo.source_continuity_attestation_id = wca.id
       WHERE wo.workspace_registration_id = $1
         AND wo.id = $2
         AND wca.observation_id = wo.id
         AND wca.workspace_registration_id = wo.workspace_registration_id
         AND wca.attestation_state = 'SEALED'`,
      [workspaceRegistrationId, predecessorObservationId],
    );
    const row = result.rows[0];
    if (!row) return null;
    const journalIdentity = row.journal_identity_json
      ? (typeof row.journal_identity_json === "string" ? JSON.parse(row.journal_identity_json) : row.journal_identity_json)
      : {};
    return {
      id: row.id,
      closed_boundary_usn: row.closed_boundary_usn ?? null,
      journal_id: journalIdentity.journalId ?? "",
      volume_serial: journalIdentity.volumeSerial ?? "",
      policy_hash: row.policy_hash ?? "",
    };
  }

  async voidUnlinkedSealedAttestations(workspaceRegistrationId: string): Promise<number> {
    const result = await this.query(
      `SELECT intentchord.void_unlinked_sealed_attestations($1) AS n`,
      [workspaceRegistrationId],
    );
    return result.rows[0]?.n ?? 0;
  }

  // ------------------------------------------------------------------
  // MAINTENANCE / PROGRESS
  // ------------------------------------------------------------------

  async reapStagingOlderThan(cutoff: Date, batch = 10_000): Promise<number> {
    const result = await this.query(
      `SELECT intentchord.workspace_evidence_staging_reaper($1,$2) AS n`,
      [cutoff, batch],
    );
    return result.rows[0]?.n ?? 0;
  }

  async upsertProgress(input: {
    snapshot_operation_id: string;
    phase: string;
    counters_json: unknown;
    heartbeat_at: Date;
  }): Promise<void> {
    assertBoundedJson("progress counters", input.counters_json, 8_192);
    const sql = `INSERT INTO intentchord.workspace_ingestion_progress
         (snapshot_operation_id,phase,counters_json,heartbeat_at,update_seq)
       VALUES ($1,$2,$3,$4,1)
       ON CONFLICT (snapshot_operation_id) DO UPDATE
         SET phase=EXCLUDED.phase,
             counters_json=EXCLUDED.counters_json,
             heartbeat_at=EXCLUDED.heartbeat_at,
             update_seq=intentchord.workspace_ingestion_progress.update_seq+1`;
    const params = [
      input.snapshot_operation_id,
      input.phase,
      JSON.stringify(input.counters_json ?? {}),
      input.heartbeat_at,
    ];
    try {
      await this.query(sql, params);
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      if (code === "ECONNRESET" || code === "EPIPE" || (err instanceof Error && err.message.includes("ECONNRESET"))) {
        await this.query(sql, params);
      } else {
        throw err;
      }
    }
  }
}

/** Fixed section order re-exported for seal orchestration callers (single source of truth). */
export const PROMOTION_SECTION_ORDER: ReadonlyArray<EvidenceSectionType> = FIXED_SECTION_ORDER;

import { describe, expect, it } from "vitest";
import {
  MAX_STAGED_RECORDS_PER_INSERT,
  PARAMETERS_PER_STAGING_RECORD,
  POSTGRES_STAGING_BIND_PARAMETER_BUDGET,
  PostgresWorkspaceEvidenceRepository,
} from "@/server/workspace-evidence-repository";

type QueryCall = { text: string; values: unknown[] };

class RecordingTransactionClient {
  readonly calls: QueryCall[] = [];
  insertCalls = 0;
  released = 0;
  failOnInsert?: number;

  async query(text: string, values: unknown[] = []) {
    this.calls.push({ text, values });
    if (text.includes("INSERT INTO intentchord.workspace_evidence_staging_records")) {
      this.insertCalls += 1;
      if (this.insertCalls === this.failOnInsert) throw new Error("LATE_STAGING_BATCH_FAILURE");
      return { rowCount: values.length / PARAMETERS_PER_STAGING_RECORD, rows: [] };
    }
    return { rowCount: 0, rows: [] };
  }

  release() { this.released += 1; }
}

class RecordingPool {
  readonly client = new RecordingTransactionClient();
  connects = 0;

  async connect() {
    this.connects += 1;
    return this.client;
  }
}

function records(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    snapshot_operation_id: "00000000-0000-4000-8000-000000000001",
    section_type: "FILES" as const,
    record_seq: index + 1,
    record_id: `record-${index + 1}`,
    record_digest: `sha256:${"a".repeat(64)}`,
    record_json: { path: `src/file-${index + 1}.ts` },
  }));
}

function insertCalls(pool: RecordingPool): QueryCall[] {
  return pool.client.calls.filter(call => call.text.includes("INSERT INTO intentchord.workspace_evidence_staging_records"));
}

function eventCount(pool: RecordingPool, event: string): number {
  return pool.client.calls.filter(call => call.text === event).length;
}

describe("PostgresWorkspaceEvidenceRepository", () => {
  it("C1 atomically commits all protocol-safe staging batches with exact boundary coverage", async () => {
    const pool = new RecordingPool();
    const repository = new PostgresWorkspaceEvidenceRepository(pool as never);
    const count = MAX_STAGED_RECORDS_PER_INSERT + 1;

    await expect(repository.insertStagedRecords(records(count))).resolves.toBe(count);

    const statements = insertCalls(pool);
    expect(pool.connects).toBe(1);
    expect(eventCount(pool, "BEGIN")).toBe(1);
    expect(eventCount(pool, "COMMIT")).toBe(1);
    expect(eventCount(pool, "ROLLBACK")).toBe(0);
    expect(pool.client.released).toBe(1);
    expect(statements.map(call => call.values.length)).toEqual([
      MAX_STAGED_RECORDS_PER_INSERT * PARAMETERS_PER_STAGING_RECORD,
      PARAMETERS_PER_STAGING_RECORD,
    ]);
    expect(statements.every(call => call.values.length <= POSTGRES_STAGING_BIND_PARAMETER_BUDGET)).toBe(true);
    expect(statements.every(call => call.text.includes("ON CONFLICT (snapshot_operation_id, section_type, record_seq) DO NOTHING"))).toBe(true);
    expect(statements.flatMap(call => call.values.filter((_, index) => index % PARAMETERS_PER_STAGING_RECORD === 2))).toEqual(
      Array.from({ length: count }, (_, index) => index + 1),
    );
  });

  it("C1 rolls back every earlier staging batch when a later batch fails", async () => {
    const pool = new RecordingPool();
    pool.client.failOnInsert = 2;
    const repository = new PostgresWorkspaceEvidenceRepository(pool as never);

    await expect(repository.insertStagedRecords(records(MAX_STAGED_RECORDS_PER_INSERT + 1))).rejects.toThrow("LATE_STAGING_BATCH_FAILURE");

    expect(pool.connects).toBe(1);
    expect(eventCount(pool, "BEGIN")).toBe(1);
    expect(insertCalls(pool)).toHaveLength(2);
    expect(eventCount(pool, "COMMIT")).toBe(0);
    expect(eventCount(pool, "ROLLBACK")).toBe(1);
    expect(pool.client.released).toBe(1);
  });

  it("C1 derives the batch size from the explicit parameter budget and row shape", () => {
    expect(MAX_STAGED_RECORDS_PER_INSERT).toBe(
      Math.floor(POSTGRES_STAGING_BIND_PARAMETER_BUDGET / PARAMETERS_PER_STAGING_RECORD),
    );
    expect(MAX_STAGED_RECORDS_PER_INSERT * PARAMETERS_PER_STAGING_RECORD).toBeLessThanOrEqual(POSTGRES_STAGING_BIND_PARAMETER_BUDGET);
  });
});

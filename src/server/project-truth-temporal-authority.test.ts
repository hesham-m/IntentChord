import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { readDatabaseCommandTime } from "@/server/database-clock";

const migration = readFileSync(
  "migrations/008_project_truth_database_clock_authority.sql",
  "utf8",
);
const contextService = readFileSync("src/server/project-context-service.ts", "utf8");
const truthService = readFileSync("src/server/project-truth-service.ts", "utf8");

describe("Project Truth temporal authority root correction", () => {
  it("keeps migration 007 immutable and adds a dedicated additive correction", () => {
    expect(migration).toContain("migration 007 remains immutable");
    expect(migration).not.toMatch(/DROP TABLE|TRUNCATE/i);
    expect(migration).not.toMatch(/ALTER TABLE intentchord\.(tasks|runs|workspaces)\b/i);
  });

  it("makes PostgreSQL the sole projection metadata clock authority", () => {
    expect(migration).toContain("clock_timestamp()");
    expect(migration).toContain("INTENTCHORD_PROJECT_CONTEXT_UPDATED_AT_DATABASE_MANAGED");
    expect(migration).toContain("INTENTCHORD_PROJECT_FACT_UPDATED_AT_DATABASE_MANAGED");
    expect(migration).toContain("BEFORE INSERT OR UPDATE ON intentchord.project_contexts");
    expect(migration).toContain("BEFORE INSERT OR UPDATE ON intentchord.project_facts");
    expect(migration).toContain("project_contexts_projection_time_order_check");
    expect(migration).toContain("project_facts_projection_time_order_check");
  });

  it("applies database clock authority to immutable history and Project Truth audit events", () => {
    expect(migration).toContain("project_context_workspaces_database_clock_insert");
    expect(migration).toContain("project_fact_revisions_database_clock_insert");
    expect(migration).toContain("project_truth_snapshots_database_clock_insert");
    expect(migration).toContain("project_truth_audit_events_database_clock_insert");
  });

  it("removes application clock writes from Phase 1 services", () => {
    expect(contextService).not.toMatch(/new Date\(|Date\.now\(|updated_at\s*=\s*now\(\)/);
    expect(truthService).not.toMatch(/new Date\(|Date\.now\(|updated_at\s*=\s*now\(\)/);
    expect(contextService).toContain("readDatabaseCommandTime");
    expect(truthService).toContain("readDatabaseCommandTime");
  });

  it("uses clock_timestamp rather than transaction_timestamp for omitted domain times", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{ command_time: "2026-07-28T12:34:56.789Z" }],
    });

    await expect(readDatabaseCommandTime({ query } as never)).resolves.toBe(
      "2026-07-28T12:34:56.789Z",
    );
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith("select clock_timestamp() as command_time");
  });
});

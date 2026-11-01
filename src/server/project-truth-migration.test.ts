import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync("migrations/007_project_context_and_truth_registry.sql", "utf8");

describe("Migration 007 Project Truth contract", () => {
  it("is additive, idempotent, and preserves migrations 001-006", () => {
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS intentchord.project_contexts");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS intentchord.project_facts");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS intentchord.project_fact_revisions");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS intentchord.project_truth_snapshots");
    expect(migration).not.toMatch(/DROP TABLE|TRUNCATE|ALTER TABLE intentchord\.(tasks|runs|workspaces)\s+DROP/i);
  });

  it("enforces immutable fact history and snapshot history", () => {
    expect(migration).toContain("INTENTCHORD_PROJECT_TRUTH_HISTORY_APPEND_ONLY");
    expect(migration).toContain("project_fact_revisions_append_only_update");
    expect(migration).toContain("project_truth_snapshots_append_only_delete");
    expect(migration).toContain("project_context_workspaces_append_only_update");
  });

  it("binds snapshot identity to an explicit effective time", () => {
    expect(migration).toContain("effective_at timestamptz NOT NULL");
    expect(migration).toContain("project_truth_snapshots_context_idx");
  });

  it("binds current projection and proposal/supersede relations to the same fact", () => {
    expect(migration).toContain("project_facts_current_revision_same_fact_fkey");
    expect(migration).toContain("project_fact_revisions_source_proposal_same_fact_fkey");
    expect(migration).toContain("project_fact_revisions_supersedes_same_fact_fkey");
    expect(migration).toContain("project_facts_projection_integrity_guard");
    expect(migration).toContain("INTENTCHORD_PROJECT_FACT_CURRENT_STATUS_MISMATCH");
  });

  it("keeps Task Workspace authority separate from Project Context association", () => {
    expect(migration).toContain("project_context_workspaces");
    expect(migration).not.toContain("task_workspace_snapshots");
    expect(migration).not.toContain("task_workspaces");
  });
});

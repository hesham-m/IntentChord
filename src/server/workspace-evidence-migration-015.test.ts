import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Static Migration 015 contract assertions (SPEC V3 Section 13 / Phase 2 scope item 12).
 * Database behavior is covered by the gated PostgreSQL integration suite.
 */

const MIGRATION_PATH = path.resolve(process.cwd(), "migrations", "015_sectioned_evidence_incremental_workspace.sql");
const SQL = readFileSync(MIGRATION_PATH, "utf8");

function requireAll(needles: ReadonlyArray<string>): void {
  const missing = needles.filter(needle => !SQL.includes(needle));
  if (missing.length > 0) {
    throw new Error(`MIGRATION_015_MISSING_OBJECTS: ${missing.join(", ")}`);
  }
}

describe("repository Migration 015 static contract", () => {
  it("creates every required V2 table", () => {
    requireAll([
      "CREATE TABLE IF NOT EXISTS intentchord.workspace_evidence_artifacts",
      "CREATE TABLE IF NOT EXISTS intentchord.workspace_evidence_sections",
      "CREATE TABLE IF NOT EXISTS intentchord.workspace_evidence_section_records",
      "CREATE TABLE IF NOT EXISTS intentchord.workspace_evidence_segments",
      "CREATE TABLE IF NOT EXISTS intentchord.workspace_source_continuity_attestations",
      "CREATE TABLE IF NOT EXISTS intentchord.workspace_file_object_identity_index",
      "CREATE TABLE IF NOT EXISTS intentchord.workspace_ingestion_progress",
      "CREATE TABLE IF NOT EXISTS intentchord.workspace_evidence_staging_records",
      "CREATE TABLE IF NOT EXISTS intentchord.workspace_evidence_staging_segments",
    ]);
  });

  it("keeps continuity attestation references TEXT end-to-end (PB-1)", () => {
    expect(SQL).toMatch(/ADD COLUMN IF NOT EXISTS source_continuity_attestation_id text/);
    expect(SQL).not.toMatch(/source_continuity_attestation_id uuid/);
    expect(SQL).toMatch(/^CREATE TABLE IF NOT EXISTS intentchord\.workspace_source_continuity_attestations \(\r?\n\s*id text PRIMARY KEY/m);
  });

  it("contains the V1+V2 replacement guards and constraints verbatim anchors", () => {
    requireAll([
      // PB-2 replacement guard with explicit dual branches
      "workspace_observation_b1_insert_guard()",
      "V2 SECTIONED BRANCH",
      "LEGACY V1 BRANCH (original 012 logic verbatim)",
      // PB-3 replacements
      "DROP CONSTRAINT IF EXISTS workspace_index_snapshots_state_payload_ck",
      "accepted_workspace_evidence_artifact_id IS NOT NULL",
      // US-4 full governed-update replacement
      "CREATE OR REPLACE FUNCTION intentchord.workspace_index_snapshot_governed_update()",
      "INTENTCHORD_WSNAPS_V2_TERMINAL_BINDING_MISMATCH",
      "INTENTCHORD_WSNAPS_V2_ATTESTATION_LINK_MISMATCH",
      // PB-5 lifecycle rule
      "INTENTCHORD_WCA_TRANSITION_BLOCKED:SEALED->%",
      "void_reason='UNLINKED'",
      // US-1 relational staging linkage
      "REFERENCES intentchord.workspace_index_snapshots(id) ON DELETE CASCADE",
      // US-5 coherence
      "CONSTRAINT wer_section_coherence_fk",
      "CONSTRAINT wes_reg_type_key_uq UNIQUE (workspace_registration_id, id, artifact_id, section_type)",
      // monolith prohibition + context mapping dual binding
      "wsnaps_v2_no_payload_ck",
      "INTENTCHORD_CONTEXT_MAPPING_ARTIFACT_BINDING_INVALID",
      "wea_cm_delete_guard",
      // maintenance functions
      "workspace_evidence_staging_reaper",
      "void_unlinked_sealed_attestations",
      // append-only enforcement
      "INTENTCHORD_WORKSPACE_EVIDENCE_APPEND_ONLY:%",
      // R1 — attestation_sha256 column and sealed shape constraint
      "attestation_sha256 text CHECK",
      "wca_sealed_shape_ck",
    ]);
  });

  it("does not self-register bookkeeping (runner owns schema_migrations)", () => {
    expect(SQL.includes("INSERT INTO intentchord.schema_migrations")).toBe(false);
  });

  it("is additive: destructive statements target ONLY staging maintenance", () => {
    // DROP TABLE is legal ONLY for the reaper's session-local temp victim table.
    const dropTargets = [...SQL.matchAll(/DROP TABLE\s+([a-z_]+)/g)].map(m => m[1]);
    for (const target of dropTargets) {
      expect(target).toBe("__reaper_victims");
    }
    expect(/\bTRUNCATE\b/.test(SQL)).toBe(false);
    expect(/\bALTER COLUMN .* TYPE\b/.test(SQL)).toBe(false);
    // DELETE is legal ONLY inside the staging reaper against staging tables.
    const deleteTargets = [...SQL.matchAll(/DELETE FROM\s+([a-z_.]+)/g)].map(m => m[1]);
    expect(deleteTargets.length).toBeGreaterThan(0);
    for (const target of deleteTargets) {
      // staging tables plus the reaper's own session-local temp victim table are the only targets
      expect(target).toMatch(/^(__reaper_victims|intentchord\.workspace_evidence_staging_)/);
    }
  });
});

import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration014 = readFileSync(resolve(process.cwd(), "migrations/014_governed_context_assembly_and_ai_context_mapping_v2.sql"), "utf8");
const migration013 = readFileSync(resolve(process.cwd(), "migrations/013_internal_ai_engine_runtime_identity_decoupling.sql"));
const sha256 = (value: Buffer | string) => createHash("sha256").update(value).digest("hex").toUpperCase();

describe("Migration 014 root Context Closure V2 persistence", () => {
  it("preserves authoritative Migration 013 bytes", () => {
    expect(sha256(migration013)).toBe("D89E8F42522F2A458289EA130CD07EB3A1D51A5E585FA5C9369F807BCEC0C7AD");
  });

  it("persists immutable evidence Assemblies and first-class root provenance", () => {
    for (const relation of [
      "context_assemblies","context_assembly_revisions","context_assembly_sources","context_mapping_v2_results","context_assembly_mapping_iterations",
      "context_missing_evidence_requests","context_gap_classifications","context_material_contradictions","context_resolution_requirements",
      "context_source_authorizations","context_forward_authority_consumptions","context_resolution_events","context_closure_evaluations","context_catalog_revisions",
    ]) expect(migration014).toContain(`intentchord.${relation}`);
  });

  it("keeps Assembly Revision evidence-only and removes mutable execution/closure/qualification coupling", () => {
    const table = migration014.slice(migration014.indexOf("CREATE TABLE IF NOT EXISTS intentchord.context_assembly_revisions"), migration014.indexOf("CREATE TABLE IF NOT EXISTS intentchord.context_assembly_sources"));
    expect(table).toContain("assembly_schema_version");
    expect(table).toContain("assembly_sha256");
    expect(table).not.toMatch(/\bstate\b/);
    expect(table).not.toContain("closure_state");
    expect(table).not.toContain("qualification_scope");
    expect(migration014).not.toContain("'MAPPING_RETRYABLE'");
  });

  it("owns execution liveness and orphan recovery on V2 Mapping Runs", () => {
    expect(migration014).toContain("execution_deadline_at");
    expect(migration014).toContain("deadline_policy_version");
    expect(migration014).toContain("ORPHANED_ACTIVE_MAPPING_EXECUTION");
    expect(migration014).toContain("clock_timestamp()>OLD.execution_deadline_at");
  });

  it("requires admitted Mapping Iterations to bind an exact validated V2 Run/result", () => {
    expect(migration014).toContain("context_mapping_iteration_insert_guard");
    expect(migration014).toContain("INTENTCHORD_CONTEXT_MAPPING_ITERATION_VALIDATED_RESULT_REQUIRED");
    expect(migration014).toContain("mapping_run_id uuid NOT NULL UNIQUE");
    expect(migration014).toContain("v2_result_id uuid NOT NULL UNIQUE");
  });

  it("persists grounded Missing Evidence and Material Contradictions through exact admitted-result guards", () => {
    expect(migration014).toContain("context_missing_evidence_insert_guard");
    expect(migration014).toContain("context_material_contradiction_insert_guard");
    expect(migration014).toContain("INTENTCHORD_CONTEXT_MISSING_EVIDENCE_NOT_IN_ADMITTED_ANALYSIS");
    expect(migration014).toContain("INTENTCHORD_CONTEXT_MATERIAL_CONTRADICTION_NOT_IN_ADMITTED_ANALYSIS");
  });

  it("uses append-only Resolution Requirements and Resolution Events for unresolved reality", () => {
    expect(migration014).toContain("MISSING_INTERNAL_EVIDENCE");
    expect(migration014).toContain("SOURCE_TRUTH_CONFLICT");
    expect(migration014).toContain("SOURCE_TRUTH_CORRECTION_REQUIRED");
    expect(migration014).toContain("SUPERSEDED_BY_NEW_ASSEMBLY");
    expect(migration014).not.toContain("RESOLVED_BY_NEW_ASSEMBLY");
    expect(migration014).toContain("context_assembly_history_append_only");
  });


  it("enforces exact same-Assembly sequential revision lineage in PostgreSQL", () => {
    expect(migration014).toContain("context_assembly_revision_lineage_guard");
    expect(migration014).toContain("FIRST_REVISION_PREVIOUS_FORBIDDEN");
    expect(migration014).toContain("PREVIOUS_REVISION_CROSS_ASSEMBLY");
    expect(migration014).toContain("PREVIOUS_REVISION_NOT_SEQUENTIAL");
  });

  it("enforces forward same-lineage successor events and distinguishes supersession from resolution", () => {
    expect(migration014).toContain("successor_context_assembly_revision_id");
    expect(migration014).toContain("successor_revision <= old_revision");
    expect(migration014).toContain("SUCCESSOR_LINEAGE_MISMATCH");
    expect(migration014).not.toContain("RESOLVED_BY_NEW_ASSEMBLY");
  });

  it("binds Owner Source authorization receipts to current Task/Workspace authority and rejects stale or duplicate source expansion", () => {
    for (const marker of [
      "task_id uuid NOT NULL",
      "task_revision bigint NOT NULL",
      "workspace_registration_revision bigint NOT NULL",
      "workspace_registration_fingerprint text NOT NULL",
      "INTENTCHORD_CONTEXT_SOURCE_AUTHORIZATION_STALE_CONTEXT_HEAD",
      "INTENTCHORD_CONTEXT_SOURCE_AUTHORIZATION_REQUIREMENT_SUPERSEDED",
      "INTENTCHORD_CONTEXT_SOURCE_AUTHORIZATION_TASK_REVISION_STALE",
      "INTENTCHORD_CONTEXT_SOURCE_AUTHORIZATION_WORKSPACE_REGISTRATION_STALE",
      "INTENTCHORD_CONTEXT_SOURCE_AUTHORIZATION_WORKSPACE_ALREADY_PRESENT",
    ]) expect(migration014).toContain(marker);
  });

  it("represents immutable multiple Closure Evaluations per Assembly and exact Mapping Iteration", () => {
    expect(migration014).toContain("context_closure_evaluations_input_uq UNIQUE(context_assembly_revision_id,mapping_iteration_id,evaluation_input_sha256)");
    const table = migration014.slice(migration014.indexOf("CREATE TABLE IF NOT EXISTS intentchord.context_closure_evaluations"), migration014.indexOf("CREATE TABLE IF NOT EXISTS intentchord.context_catalog_revisions"));
    expect(table).not.toMatch(/UNIQUE\s*\(\s*context_assembly_revision_id\s*\)/i);
    expect(migration014).toContain("context_closure_evaluation_insert_guard");
  });

  it("binds Accepted Catalog to exact Assembly + Mapping Iteration + PASS Closure Evaluation", () => {
    expect(migration014).toContain("mapping_iteration_id uuid NOT NULL");
    expect(migration014).toContain("closure_evaluation_id uuid NOT NULL UNIQUE");
    expect(migration014).toContain("INTENTCHORD_CONTEXT_CATALOG_REQUIRES_EXACT_PASS_CLOSURE_EVALUATION");
    expect(migration014).toContain("INTENTCHORD_CONTEXT_CATALOG_MAPPING_ITERATION_MISMATCH");
  });

  it("keeps V1/V2 qualification semantics distinct and does not manufacture qualification", () => {
    expect(migration014).toContain("qualification_scope IN ('AI_CONTEXT_MAPPING_V1','AI_CONTEXT_MAPPING_V2')");
    expect(migration014).toContain("qualification'->>'qualification_scope') IS NOT DISTINCT FROM qualification_scope");
    expect(migration014).not.toMatch(/insert\s+into\s+intentchord\.[a-z_]*qualification/i);
  });

  it("prevents V2 results from being reinterpreted as historical V1 Catalog proposals", () => {
    expect(migration014).toContain("INTENTCHORD_CONTEXT_CATALOG_PROPOSAL_REQUIRES_SUCCEEDED_V1_ATTEMPT");
    expect(migration014).toContain("attempt_row.qualification_scope<>'AI_CONTEXT_MAPPING_V1'");
    expect(migration014).toContain("run_row.qualification_scope<>'AI_CONTEXT_MAPPING_V1'");
  });

  it("aligns DB Current Effective Context with latest actual Draft, exact ordering/fingerprint source-set, and source-mutating consumption", () => {
    expect(migration014).toContain("ORDER BY revision DESC");
    expect(migration014).toContain("tws.ordering IS DISTINCT FROM cas.ordering");
    expect(migration014).toContain("tws.fingerprint IS DISTINCT FROM cas.workspace_registration_fingerprint");
    expect(migration014).toContain("context_forward_authority_consumptions");
    expect(migration014).toContain("SOURCE_MUTATING_RUN_STARTED");
    expect(migration014).toContain("RETURN 'UNPROVEN'");
  });


  it("defends Closure PASS and Accepted Catalog publication with the same Current Effective Context DB gate", () => {
    expect(migration014).toContain("INTENTCHORD_CONTEXT_CLOSURE_CURRENT_EFFECTIVE_CONTEXT_REQUIRED");
    expect(migration014).toContain("INTENTCHORD_CONTEXT_CATALOG_CURRENT_EFFECTIVE_CONTEXT_REQUIRED");
    expect(migration014).toContain("current_effective_context_authority_status(assembly_task_id,NEW.context_assembly_revision_id)");
  });


  it("does not create Migration 015", () => {
    expect(readdirSync(resolve(process.cwd(), "migrations")).some(name => name.startsWith("015_"))).toBe(false);
  });
});

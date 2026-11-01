import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const head = read("src/server/context-head-authority.ts");
const lifecycle = read("src/server/lifecycle.ts");
const closure = read("src/server/context-closure-service.ts");
const binding = read("src/server/context-assembly-task-binding-service.ts");
const projection = read("src/server/task-experience-projection-service.ts");
const snapshot = read("src/server/task-experience-authority-snapshot.ts");
const workbench = read("src/components/unified-task-workbench.tsx");
const migration014 = read("migrations/014_governed_context_assembly_and_ai_context_mapping_v2.sql");
const migration013 = readFileSync(resolve(process.cwd(), "migrations/013_internal_ai_engine_runtime_identity_decoupling.sql"));
const sha256 = (value: Buffer | string) => createHash("sha256").update(value).digest("hex").toUpperCase();

describe("Current Context Head forward authority and Scope freeze", () => {
  it("derives Current Head from immutable Assembly lineage and never persists is_current", () => {
    expect(head).toContain("order by revision desc");
    expect(head).toContain("select id from intentchord.context_assemblies where task_id=$1 for update");
    expect(migration014).not.toMatch(/\bis_current\b/i);
  });

  it("serializes Work Selection against the stable Context Assembly parent", () => {
    expect(lifecycle).toContain("resolveCurrentHeadContextAssemblyWorkSelection(client");
    expect(binding).toContain("ACCEPTED_CONTEXT_CATALOG_SUPERSEDED");
    expect(binding).toContain("assertCurrentEffectiveContextAuthority(");
  });

  it("treats Work Selection as intent and Scope Confirmation as the first authority freeze", () => {
    expect(lifecycle).toContain('authorityMeaning: "OWNER_INTENT_NOT_SCOPE_AUTHORITY_FREEZE"');
    expect(lifecycle).toContain('authorityMeaning: "FIRST_TASK_EXECUTION_AUTHORITY_FREEZE"');
    expect(lifecycle).toContain("assertCurrentEffectiveContextAuthority(");
  });

  it("rejects superseded Requirement source authorization and stale API replay", () => {
    expect(closure).toContain('"CONTEXT_REQUIREMENT_SUPERSEDED"');
    expect(closure).toContain("assertCurrentEffectiveContextAuthority(client,taskId,authority.context_assembly_revision_id");
    expect(closure).toContain("SUPERSEDED_BY_NEW_ASSEMBLY");
    expect(migration014).toContain("INTENTCHORD_CONTEXT_SOURCE_AUTHORIZATION_STALE_CONTEXT_HEAD");
    expect(migration014).toContain("INTENTCHORD_CONTEXT_SOURCE_AUTHORIZATION_REQUIREMENT_SUPERSEDED");
  });

  it("binds Source Authorization to exact Task and Workspace Registration authority", () => {
    for (const marker of ["task_id uuid NOT NULL", "task_revision bigint NOT NULL", "workspace_registration_revision bigint NOT NULL", "workspace_registration_fingerprint text NOT NULL"]) {
      expect(migration014).toContain(marker);
    }
    expect(migration014).toContain("INTENTCHORD_CONTEXT_SOURCE_AUTHORIZATION_TASK_REVISION_STALE");
    expect(migration014).toContain("INTENTCHORD_CONTEXT_SOURCE_AUTHORIZATION_WORKSPACE_REGISTRATION_STALE");
  });

  it("makes Owner authorization and Task source-set expansion one atomic transaction", () => {
    expect(closure).toContain("await transaction(async client=>{");
    expect(closure).toContain("appendAuthorizedContextWorkspaceInTransaction(client");
    expect(lifecycle).toContain("TASK_CONTEXT_SOURCE_EXPANDED");
    expect(lifecycle).toContain("NEW_CONTEXT_EVIDENCE_REQUIRES_NEW_ASSEMBLY_AND_REANALYSIS");
  });

  it("rejects fake additional-source expansion when Workspace is already governed", () => {
    expect(closure).toContain("SOURCE_ALREADY_PRESENT_REQUIRES_REFRESH_OR_REINDEX");
    expect(migration014).toContain("INTENTCHORD_CONTEXT_SOURCE_AUTHORIZATION_WORKSPACE_ALREADY_PRESENT");
  });

  it("blocks stale Candidate Scope confirmation inside the same authority transaction", () => {
    const confirmStart = lifecycle.indexOf("export async function confirmTaskScope");
    const confirmEnd = lifecycle.indexOf("export async function resolveIntent", confirmStart) > confirmStart
      ? lifecycle.indexOf("export async function resolveIntent", confirmStart)
      : lifecycle.indexOf("export async function resolveContract", confirmStart);
    const confirm = lifecycle.slice(confirmStart, confirmEnd);
    expect(confirm).toContain("assertCurrentEffectiveContextAuthority");
    expect(confirm).toContain("resolveCurrentUnifiedCandidateScope(taskId, currentDraft.draft, client)");
    expect(confirm).toContain("STALE_CANDIDATE_SCOPE");
  });

  it("gates late Platform, Contract, approval, compile, initial Run, and correction Run on current frozen authority", () => {
    for (const marker of [
      "export async function selectTaskExecutionPlatform",
      "export async function resolveContract",
      "export async function approveContractRevision",
      "export async function compileContractArtifact",
      "export async function createRun",
      "export async function startCorrection",
    ]) expect(lifecycle).toContain(marker);
    expect((lifecycle.match(/assertCurrentEffectiveContextAuthority\(/g) ?? []).length).toBeGreaterThanOrEqual(7);
  });

  it("proves current Workspace/Canonical Index authority without timestamp-latest inference", () => {
    expect(head).toContain("workspace_observations.authority_sequence");
    expect(head).toContain("order by o.authority_sequence desc");
    expect(head).toContain("CURRENT_SOURCE_AUTHORITY_UNPROVEN");
    expect(head).toContain("SOURCE_DRIFT_REBASE_REQUIRED");
  });

  it("derives stale/rebase product status in Backend projection while keeping active Run frozen", () => {
    expect(snapshot).toContain("readContextForwardAuthority");
    expect(projection).toContain("STALE_WORK_INTENT_CURRENT_CONTEXT_ADVANCED");
    expect(projection).toContain("SOURCE_DRIFT_REBASE_REQUIRED");
    expect(projection).toContain("ACTIVE_RUN_ON_FROZEN_AUTHORITY");
    expect(projection).toContain("REBASE_CONTEXT_WORK_SELECTION");
    expect(workbench).toContain("Rebase Work on Current Context");
  });

  it("does not silently port old Work Selection into the current Catalog", () => {
    expect(workbench).toContain("selectedComponentIds.includes");
    expect(workbench).toContain("toggleComponent(component)");
    expect(workbench).toContain("Rebase Work on Current Context");
    expect(workbench).not.toContain("autoRebaseSelectedComponentIds");
  });

  it("preserves frozen started-Run authority rather than retargeting it", () => {
    expect(projection).toContain('phaseStatus = "RUN_ACTIVE_EXECUTING"');
    expect(projection).toContain("A started Run remains frozen to its exact approved authority");
    expect(lifecycle).not.toContain("RETARGET_ACTIVE_RUN_TO_CONTEXT_HEAD");
  });

  it("preserves V1, Migration 013, and the no-Migration-015/no-Mistral boundaries", () => {
    expect(sha256(migration013)).toBe("D89E8F42522F2A458289EA130CD07EB3A1D51A5E585FA5C9369F807BCEC0C7AD");
    expect(migration014).toContain("AI_CONTEXT_MAPPING_V1");
    expect(migration014).toContain("AI_CONTEXT_MAPPING_V2");
    expect(readdirSync(resolve(process.cwd(), "migrations")).some((name: string) => name.startsWith("015_"))).toBe(false);
    expect([head, lifecycle, closure, binding, projection, migration014].join("\n")).not.toMatch(/internal-mistral-large-2512|mistral-large-2512/i);
  });
});

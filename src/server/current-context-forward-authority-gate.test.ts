import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { classifyCurrentEffectiveContextAuthority } from "@/core/context-authority/current-effective-context";
import { createBlankTaskDraft } from "@/core/tasks/task-input";
import { taskAuthorityInputSha256V1 } from "@/server/task-authority-input";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const head = read("src/server/context-head-authority.ts");
const closure = read("src/server/context-closure-service.ts");
const lifecycle = read("src/server/lifecycle.ts");
const authorityInput = read("src/server/task-authority-input.ts");
const migration014 = read("migrations/014_governed_context_assembly_and_ai_context_mapping_v2.sql");
const migration013 = readFileSync(resolve(process.cwd(), "migrations/013_internal_ai_engine_runtime_identity_decoupling.sql"));
const sha256 = (value: Buffer | string) => createHash("sha256").update(value).digest("hex").toUpperCase();

function facts(overrides: Partial<Parameters<typeof classifyCurrentEffectiveContextAuthority>[0]> = {}) {
  return {
    assemblyIsHead: true,
    taskSourceSetMatchesAssembly: true,
    sources: [{
      workspaceRegistrationId: "workspace-a",
      registrationProven: true,
      observationHeadPresent: true,
      observationHeadQualifiedReady: true,
      frozenAuthorityMatchesCurrentHead: true,
    }],
    ...overrides,
  };
}

describe("CURRENT EFFECTIVE CONTEXT AUTHORITY — executable truth table", () => {
  it("01 older READY A + newer READY B is DRIFT when frozen authority is A", () => {
    expect(classifyCurrentEffectiveContextAuthority(facts({ sources: [{ ...facts().sources[0], frozenAuthorityMatchesCurrentHead: false }] }))).toBe("DRIFT");
  });
  it("02 newer FAILED Observation is UNPROVEN and never falls back", () => {
    expect(classifyCurrentEffectiveContextAuthority(facts({ sources: [{ ...facts().sources[0], observationHeadQualifiedReady: false }] }))).toBe("UNPROVEN");
  });
  it("03 newer incomplete/unqualified Observation is UNPROVEN", () => {
    expect(classifyCurrentEffectiveContextAuthority(facts({ sources: [{ ...facts().sources[0], registrationProven: false }] }))).toBe("UNPROVEN");
  });
  it("04 exact current READY differing from frozen is DRIFT", () => {
    expect(classifyCurrentEffectiveContextAuthority(facts({ sources: [{ ...facts().sources[0], frozenAuthorityMatchesCurrentHead: false }] }))).toBe("DRIFT");
  });
  it("05 exact current READY matching frozen is CURRENT", () => {
    expect(classifyCurrentEffectiveContextAuthority(facts())).toBe("CURRENT");
  });
  it("06 no Observation head is UNPROVEN", () => {
    expect(classifyCurrentEffectiveContextAuthority(facts({ sources: [{ ...facts().sources[0], observationHeadPresent: false }] }))).toBe("UNPROVEN");
  });
  it("10 Task source-set mismatch makes Context non-current", () => {
    expect(classifyCurrentEffectiveContextAuthority(facts({ taskSourceSetMatchesAssembly: false }))).toBe("DRIFT");
  });
  it("11 non-head Assembly cannot create current forward authority", () => {
    expect(classifyCurrentEffectiveContextAuthority(facts({ assemblyIsHead: false }))).toBe("DRIFT");
  });
  it("multi-workspace requires every current source authority to be proven", () => {
    const sources = [facts().sources[0], { ...facts().sources[0], workspaceRegistrationId: "workspace-b", observationHeadQualifiedReady: false }];
    expect(classifyCurrentEffectiveContextAuthority(facts({ sources }))).toBe("UNPROVEN");
  });
});

describe("Scope authority-input freeze — executable fingerprint behavior", () => {
  const draft = () => {
    const value = createBlankTaskDraft("SOURCE_IMPLEMENTATION");
    value.orchestrationVersion = "UNIFIED_V1";
    value.objective = "Implement exact governed source correction.";
    value.ownerRequirements = [{ id: "req-1", outcome: "Preserve governed authority.", proofProfile: { sourceBehavior: true, positive: true, negativeAdversarial: true, persistenceReload: false } }];
    value.identity = "evidence-identity";
    return value;
  };

  it("28 freezes a deterministic authority-input identity", () => {
    const first = taskAuthorityInputSha256V1(draft());
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(taskAuthorityInputSha256V1(draft())).toBe(first);
  });
  it("29 objective change changes frozen authority identity", () => {
    const a=draft(), b=draft(); b.objective="Different executable objective.";
    expect(taskAuthorityInputSha256V1(b)).not.toBe(taskAuthorityInputSha256V1(a));
  });
  it("30 taskMode change changes frozen authority identity", () => {
    const a=draft(), b=draft(); b.taskMode="CONTROLLED_AUDIT";
    expect(taskAuthorityInputSha256V1(b)).not.toBe(taskAuthorityInputSha256V1(a));
  });
  it("31 capability expansion changes frozen authority identity", () => {
    const a=draft(), b=draft(); b.deploy=true;
    expect(taskAuthorityInputSha256V1(b)).not.toBe(taskAuthorityInputSha256V1(a));
  });
  it("32 Workspace/source-set change changes frozen authority identity", () => {
    const a=draft(), b=draft();
    b.workspaces=[{ id:"11111111-1111-4111-8111-111111111111",displayName:"ws",role:"server",referenceType:"LOCAL_PATH",source:"MANUAL_VERIFIED",reference:"E:/ws",fingerprint:"sha256:"+"a".repeat(64),discoveryScopeMode:"SELECTED_PATHS",allowedPaths:["src"],excludedPaths:[],authorizationContext:"owner",ordering:0 }];
    expect(taskAuthorityInputSha256V1(b)).not.toBe(taskAuthorityInputSha256V1(a));
  });
  it("33 presentation-only title mutation does not change authority identity", () => {
    const a=draft(), b=draft(); b.title="Presentation title only"; b.titleManuallyEdited=true;
    expect(taskAuthorityInputSha256V1(b)).toBe(taskAuthorityInputSha256V1(a));
  });
  it("late execution Platform/model fields are excluded from the first Scope freeze identity", () => {
    const a=draft(), b=draft();
    b.providerId="OPENAI"; b.modelId="gpt-5.6-sol"; b.executionChannelId="CODEX"; b.reasoningProfile="High"; b.runtimeProfileId="STANDARD";
    expect(taskAuthorityInputSha256V1(b)).toBe(taskAuthorityInputSha256V1(a));
  });
});

describe("Complete current-context forward-authority Gate contracts", () => {
  it("07/12-16 uses actual Observation head and no latest-success fallback", () => {
    expect(head).toContain("order by o.authority_sequence desc");
    expect(head).toContain("The actual current Workspace Observation authority head is failed, incomplete, or lacks qualified READY Canonical Index authority");
    expect(head).not.toContain("order by s.created_at desc limit 1");
  });
  it("08/09 captures Task sources, Workspace authority and Assembly creation in one transaction", () => {
    expect(closure).toContain("captureCurrentAssemblyRevision");
    expect(closure).toContain("captureLockedTaskSourceAuthority(client");
    expect(head).toContain("order by id\n      for update");
  });
  it("13/14 Closure PASS and Catalog publication re-prove current effective authority", () => {
    expect(closure).toContain("assertCurrentEffectiveContextAuthority(");
    expect(closure).toContain("currentEffectiveContextAuthorityProven:true");
    expect(closure).toContain("currentTaskSourceSetSha256");
    expect(closure).toContain("currentSourceAuthoritySha256");
  });
  it("16 source-current proof participates in immutable Closure evaluation input", () => {
    const core=read("src/core/context-closure/v1.ts");
    expect(core).toContain("currentTaskSourceSetSha256");
    expect(core).toContain("currentSourceAuthoritySha256");
  });
  it("17-23 Source Authorization is current-gated, registration-locked, atomic, and non-retargeting", () => {
    expect(closure).toContain("CONTEXT_REQUIREMENT_SUPERSEDED");
    expect(closure).toContain("from intentchord.workspaces where id=$1 for update");
    expect(closure).toContain("appendAuthorizedContextWorkspaceInTransaction(client");
    expect(closure).toContain("SOURCE_ALREADY_PRESENT_REQUIRES_REFRESH_OR_REINDEX");
    expect(migration014).toContain("current_effective_context_authority_status");
  });
  it("24-27 Work Selection consumes exact accepted Catalog and current effective Context", () => {
    const binding=read("src/server/context-assembly-task-binding-service.ts");
    expect(binding).toContain("assertCurrentEffectiveContextAuthority(");
    expect(binding).toContain("ACCEPTED_CONTEXT_CATALOG_SUPERSEDED");
    expect(binding).not.toMatch(/order by[\s\S]*context_mapping_runs[\s\S]*created_at desc[\s\S]*limit 1/i);
  });
  it("34 stale pre-confirm authority-input mutation clears old Candidate authority", () => {
    expect(lifecycle).toContain("delete rebased.contextAssemblyBinding");
    expect(lifecycle).toContain("delete rebased.candidateScope");
    expect(lifecycle).toContain("delete rebased.scopeConfirmation");
  });
  it("35-40 historical V1 cannot create new UNIFIED Scope/Platform/Contract/Run authority", () => {
    expect(lifecycle).toContain("UNIFIED_V2_SCOPE_AUTHORITY_REQUIRED");
    expect(lifecycle).toContain("UNIFIED_V2_CONTEXT_AUTHORITY_REQUIRED");
    expect(lifecycle).toContain("requireUnifiedV2ScopeFreeze");
  });
  it("41-45 terminal historical execution does not permanently block Rebase while active Run stays frozen", () => {
    expect(lifecycle).toContain("CONTEXT_SOURCE_EXPANSION_LOCKED_DURING_ACTIVE_RUN");
    expect(lifecycle).toContain("Terminal historical Runs remain frozen provenance and do not permanently block Rebase");
    expect(lifecycle).not.toContain("exists(select 1 from intentchord.runs where task_id=$1) as run_exists");
  });
  it("46-51 Correction child executes exact current approved authority while preserving parent lineage", () => {
    expect(lifecycle).toContain("CORRECTION_CURRENT_AUTHORITY_CONTRACT_REQUIRED");
    expect(lifecycle).toContain("const currentResolved = await currentContract(client, parent.task_id)");
    expect(lifecycle).toContain("parentContractRevisionId");
    expect(lifecycle).toContain("currentAuthorityContractRevisionId");
  });
  it("52-56 authority writes are serialized server-side and stale generic Task PUT cannot widen frozen authority", () => {
    expect(head).toContain("select id from intentchord.context_assemblies where task_id=$1 for update");
    expect(lifecycle).toContain("SCOPE_AUTHORITY_REBASE_REQUIRED");
    expect(lifecycle).toContain("SCOPE_AUTHORITY_INPUT_DRIFT_REBASE_REQUIRED");
  });
  it("57-65 preserves root provenance architecture and frozen started Runs", () => {
    expect(migration014).not.toMatch(/\bis_current\b/i);
    expect(migration014).not.toMatch(/context_assembly_revisions[\s\S]*?\bstate\b/i);
    expect(migration014).toContain("context_closure_evaluations");
    expect(migration014).toContain("SUPERSEDED_BY_NEW_ASSEMBLY");
    expect(lifecycle).not.toContain("RETARGET_ACTIVE_RUN_TO_CONTEXT_HEAD");
  });
  it("66-70 preserves V1, Migration 013, no 015, and no Mistral", () => {
    expect(sha256(migration013)).toBe("D89E8F42522F2A458289EA130CD07EB3A1D51A5E585FA5C9369F807BCEC0C7AD");
    expect(migration014).toContain("AI_CONTEXT_MAPPING_V1");
    expect(migration014).toContain("AI_CONTEXT_MAPPING_V2");
    expect(readdirSync(resolve(process.cwd(),"migrations")).some((name: string)=>name.startsWith("015_"))).toBe(false);
    expect([head,closure,lifecycle,migration014,authorityInput].join("\n")).not.toMatch(/internal-mistral-large-2512|mistral-large-2512/i);
  });
});

describe("Current source head resolution — executable Backend query behavior", () => {
  const workspace = {
    id: "11111111-1111-4111-8111-111111111111",
    displayName: "Server",
    role: "server",
    referenceType: "LOCAL_PATH" as const,
    source: "MANUAL_VERIFIED" as const,
    reference: "E:/server",
    fingerprint: "sha256:" + "a".repeat(64),
    discoveryScopeMode: "SELECTED_PATHS" as const,
    allowedPaths: ["src"], excludedPaths: [], authorizationContext: "owner", ordering: 0,
  };
  const unifiedDraft = () => ({ ...createBlankTaskDraft("SOURCE_IMPLEMENTATION"), orchestrationVersion: "UNIFIED_V1" as const, objective: "Audit current source authority.", workspaces: [workspace] });

  async function authorityModule() {
    return import("@/server/context-head-authority");
  }

  it("resolves the actual latest Observation head first and accepts the exact qualified READY head", async () => {
    const { captureLockedTaskSourceAuthority } = await authorityModule();
    const calls: string[] = [];
    const client = { query: async (sql: string) => {
      calls.push(sql);
      if (sql.includes("from intentchord.workspaces")) return { rowCount: 1, rows: [{ id: workspace.id, revision: 3, fingerprint: workspace.fingerprint, verification_status: "VERIFIED" }] };
      if (sql.includes("from lateral")) return { rowCount: 1, rows: [{ observation_id: "obs-b", authority_sequence: 11, observation_result: "SOURCE_CHANGED", workspace_revision_id: "wsr_b", canonical_index_artifact_id: "cia_b", index_configuration_sha256: "sha256:"+"b".repeat(64), snapshot_id: "22222222-2222-4222-8222-222222222222", snapshot_status: "READY", snapshot_attempt_status: "SUCCEEDED", snapshot_registration_revision: 3, snapshot_registration_fingerprint: workspace.fingerprint, snapshot_workspace_revision_id: "wsr_b", snapshot_artifact_id: "cia_b", snapshot_canonical_sha256: "sha256:"+"c".repeat(64), artifact_id: "cia_b", artifact_semantic_sha256: "sha256:"+"d".repeat(64), artifact_semantic_json: { schema_version: "test" } }] };
      throw new Error("UNEXPECTED_SQL:"+sql);
    }} as any;
    const proof = await captureLockedTaskSourceAuthority(client, unifiedDraft());
    expect(proof.sources[0].observationId).toBe("obs-b");
    expect(proof.sources[0].authoritySequence).toBe(11);
    expect(calls.join("\n")).toContain("order by o.authority_sequence desc");
  });

  it("does not fall back to an older READY Observation when the actual head failed", async () => {
    const { captureLockedTaskSourceAuthority } = await authorityModule();
    const client = { query: async (sql: string) => {
      if (sql.includes("from intentchord.workspaces")) return { rowCount: 1, rows: [{ id: workspace.id, revision: 3, fingerprint: workspace.fingerprint, verification_status: "VERIFIED" }] };
      if (sql.includes("from lateral")) return { rowCount: 1, rows: [{ observation_id: "obs-failed", authority_sequence: 12, observation_result: "SOURCE_PROVEN_INDEX_FAILED", workspace_revision_id: "wsr_c", canonical_index_artifact_id: null, snapshot_id: "33333333-3333-4333-8333-333333333333", snapshot_status: "FAILED", snapshot_attempt_status: "FAILED", snapshot_registration_revision: 3, snapshot_registration_fingerprint: workspace.fingerprint, snapshot_workspace_revision_id: "wsr_c", snapshot_artifact_id: null, snapshot_canonical_sha256: null, artifact_id: null, artifact_semantic_sha256: null, artifact_semantic_json: null }] };
      throw new Error("UNEXPECTED_SQL:"+sql);
    }} as any;
    await expect(captureLockedTaskSourceAuthority(client, unifiedDraft())).rejects.toMatchObject({ code: "CURRENT_SOURCE_AUTHORITY_UNPROVEN" });
  });

  it("treats absence of any Observation head as UNPROVEN", async () => {
    const { captureLockedTaskSourceAuthority } = await authorityModule();
    const client = { query: async (sql: string) => {
      if (sql.includes("from intentchord.workspaces")) return { rowCount: 1, rows: [{ id: workspace.id, revision: 3, fingerprint: workspace.fingerprint, verification_status: "VERIFIED" }] };
      if (sql.includes("from lateral")) return { rowCount: 0, rows: [] };
      throw new Error("UNEXPECTED_SQL:"+sql);
    }} as any;
    await expect(captureLockedTaskSourceAuthority(client, unifiedDraft())).rejects.toMatchObject({ code: "CURRENT_SOURCE_AUTHORITY_UNPROVEN" });
  });
});

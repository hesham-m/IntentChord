import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  classifyCurrentEffectiveContextAuthority,
  taskSourceSetAuthoritySha256V1,
} from "@/core/context-authority/current-effective-context";

const head = (over: Record<string, unknown> = {}) => ({
  workspaceRegistrationId: "ws-a",
  registrationProven: true,
  observationHeadPresent: true,
  observationHeadQualifiedReady: true,
  frozenAuthorityMatchesCurrentHead: true,
  ...over,
});
const facts = (over: Record<string, unknown> = {}) => ({
  assemblyIsHead: true,
  taskSourceSetMatchesAssembly: true,
  forwardAuthorityConsumed: false,
  sources: [head()],
  ...over,
});
const lifecycle = readFileSync("src/server/lifecycle.ts", "utf8");
const authority = readFileSync("src/server/context-head-authority.ts", "utf8");
const closure = readFileSync("src/server/context-closure-service.ts", "utf8");
const migration = readFileSync("migrations/014_governed_context_assembly_and_ai_context_mapping_v2.sql", "utf8");

function functionSlice(name: string, next: string) {
  const start = lifecycle.indexOf(`export async function ${name}`);
  const end = lifecycle.indexOf(`export async function ${next}`, start + 1);
  expect(start).toBeGreaterThanOrEqual(0);
  return lifecycle.slice(start, end < 0 ? lifecycle.length : end);
}

function expectOrder(source: string, markers: string[]) {
  let cursor = -1;
  for (const marker of markers) {
    const next = source.indexOf(marker, cursor + 1);
    expect(next, marker).toBeGreaterThan(cursor);
    cursor = next;
  }
}

describe("Current Effective Context semantic parity and global lock order", () => {
  it("01 exact proven authority is CURRENT", () => {
    expect(classifyCurrentEffectiveContextAuthority(facts())).toBe("CURRENT");
  });
  it("02 proven frozen/current mismatch is DRIFT", () => {
    expect(classifyCurrentEffectiveContextAuthority(facts({ sources: [head({ frozenAuthorityMatchesCurrentHead: false })] }))).toBe("DRIFT");
  });
  it("03 failed/unqualified actual head is UNPROVEN", () => {
    expect(classifyCurrentEffectiveContextAuthority(facts({ sources: [head({ observationHeadQualifiedReady: false })] }))).toBe("UNPROVEN");
  });
  it("04 missing actual head is UNPROVEN", () => {
    expect(classifyCurrentEffectiveContextAuthority(facts({ sources: [head({ observationHeadPresent: false })] }))).toBe("UNPROVEN");
  });
  it("05 consumed Context is UNPROVEN", () => {
    expect(classifyCurrentEffectiveContextAuthority(facts({ forwardAuthorityConsumed: true }))).toBe("UNPROVEN");
  });
  it("06 source-set ordering is authority material", () => {
    const a = taskSourceSetAuthoritySha256V1([{ workspaceRegistrationId: "ws", workspaceRegistrationFingerprint: "fp", ordering: 0 }]);
    const b = taskSourceSetAuthoritySha256V1([{ workspaceRegistrationId: "ws", workspaceRegistrationFingerprint: "fp", ordering: 1 }]);
    expect(a).not.toBe(b);
  });
  it("07 Registration fingerprint is authority material", () => {
    const a = taskSourceSetAuthoritySha256V1([{ workspaceRegistrationId: "ws", workspaceRegistrationFingerprint: "fp-a", ordering: 0 }]);
    const b = taskSourceSetAuthoritySha256V1([{ workspaceRegistrationId: "ws", workspaceRegistrationFingerprint: "fp-b", ordering: 0 }]);
    expect(a).not.toBe(b);
  });
  it("08 projection consumes typed evaluator rather than Http error-name inference", () => {
    const slice = authority.slice(authority.indexOf("export async function readFrozenContextForwardAuthorityStatus"));
    expect(slice).toContain("evaluateCurrentEffectiveContextAuthority");
    expect(slice).not.toContain("error.code === \"CURRENT_SOURCE_AUTHORITY_UNPROVEN\"");
  });
  it("09 no exported alternate source-only CURRENT resolver remains", () => {
    expect(authority).not.toContain("export async function inspectFrozenContextSourceAuthority");
  });
  it("10 Migration distinguishes UNPROVEN establishment from DRIFT comparison", () => {
    expect(migration).toContain("STEP 1: establish current authority");
    expect(migration).toContain("STEP 2: current authority is proven");
    expect(migration).toContain("RETURN 'UNPROVEN'");
    expect(migration).toContain("RETURN 'DRIFT'");
  });
  it("11 frozen Observation identity is persisted for TS/DB parity", () => {
    expect(migration).toContain("workspace_observation_id uuid NOT NULL");
    expect(migration).toContain("workspace_observation_authority_sequence bigint NOT NULL");
    expect(authority).toContain("observationId: row.workspace_observation_id");
  });
  it("12 Contract approval is Task-first and Contract-last", () => {
    expectOrder(functionSlice("approveContractRevision", "compileContractArtifact"), ["lookupContractRouting", "lockTask", "assertCurrentEffectiveContextAuthority", "loadContractForUpdate"]);
  });
  it("13 Contract compilation is Task-first and Contract-last", () => {
    expectOrder(functionSlice("compileContractArtifact", "createRun"), ["lookupContractRouting", "lockTask", "assertCurrentEffectiveContextAuthority", "loadContractForUpdate"]);
  });
  it("14 INITIAL Run locks current Contract only after Task/Context/Workspaces", () => {
    expectOrder(functionSlice("createRun", "submitRawReport"), ["lockTask", "assertCurrentEffectiveContextAuthority", "currentContractForUpdate"]);
  });
  it("15 CORRECTION Run uses Task -> Context -> Contract -> parent Run", () => {
    const slice = lifecycle.slice(lifecycle.indexOf("export async function startCorrection"));
    expectOrder(slice, ["lockTask", "assertCurrentEffectiveContextAuthority", "currentContractForUpdate", "loadRunForUpdate"]);
  });
  it("16 Contract ID lookup is explicitly non-locking routing metadata", () => {
    const start = lifecycle.indexOf("async function lookupContractRouting");
    const end = lifecycle.indexOf("async function readRuns", start);
    expect(lifecycle.slice(start, end)).not.toContain("for update");
  });
  it("17 Source Authorization locks current+target Workspace UNION in one order", () => {
    expect(closure).toContain("[command.workspaceRegistrationId]");
    expect(migration).toContain("UNION\n     SELECT NEW.workspace_registration_id");
    expect(migration).toContain("ORDER BY w.id");
  });
  it("18 target Workspace is not separately FOR UPDATE after the union lock", () => {
    const slice = closure.slice(closure.indexOf("export async function authorizeTaskContextSource"));
    expect(slice).not.toContain("from intentchord.workspaces where id=$1 for update");
  });
  it("19 Context Assembly capture remains Task -> Context -> ordered Workspaces", () => {
    const slice = closure.slice(closure.indexOf("async function captureCurrentAssemblyRevision"), closure.indexOf("async function ensureMappingRun"));
    expectOrder(slice, ["intentchord.tasks where id=$1 for update", "context_assemblies where task_id=$1 for update", "captureLockedTaskSourceAuthority"]);
  });
  it("20 source locks are globally registration-ID ordered", () => {
    expect(authority).toContain("Array.from(new Set([...taskWorkspaceIds, ...additionalWorkspaceRegistrationIds])).sort()");
    expect(authority).toContain("order by id\n      for update");
  });
});

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  classifyCurrentEffectiveContextAuthority,
  taskSourceSetAuthoritySha256V1,
} from "@/core/context-authority/current-effective-context";

const read = (path: string) => readFileSync(path, "utf8");
const lifecycle = read("src/server/lifecycle.ts");
const authority = read("src/server/context-head-authority.ts");
const closure = read("src/server/context-closure-service.ts");
const binding = read("src/server/context-assembly-task-binding-service.ts");
const projection = read("src/server/task-experience-projection-service.ts");
const migration = read("migrations/014_governed_context_assembly_and_ai_context_mapping_v2.sql");
const concurrency = read("src/server/current-context-forward-authority-concurrency.postgres.integration.test.ts");
const sameTaskRequiredSource = sliceBetween(concurrency, "const sameTaskRequired", "const contractBranchRequired");
const contractBranchRequiredSource = sliceBetween(concurrency, "const contractBranchRequired", "const taskEarlyStopRequired");
const taskEarlyStopRequiredSource = sliceBetween(concurrency, "const taskEarlyStopRequired", "const taskEarlyStopForbidden");
const taskEarlyStopForbiddenSource = sliceBetween(concurrency, "const taskEarlyStopForbidden", 'describe("Owner disposable PostgreSQL Current Context product concurrency"');
const schemas = read("src/server/schemas.ts");
const mapperTypes = read("src/core/ai-context-mapper/types.ts");
const finalIntegration = read("src/server/current-context-forward-authority-final-integration.test.ts");
const rootInvariant = read("src/server/context-closure-root-invariant-correction.test.ts");
const rootState = read("src/server/context-closure-root-state-provenance.test.ts");

const source = (over: Record<string, unknown> = {}) => ({
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
  sources: [source()],
  ...over,
});
function sliceBetween(text: string, startMarker: string, endMarker?: string) {
  const start = text.indexOf(startMarker);
  expect(start, startMarker).toBeGreaterThanOrEqual(0);
  const end = endMarker ? text.indexOf(endMarker, start + startMarker.length) : -1;
  return text.slice(start, end < 0 ? text.length : end);
}
function expectOrder(text: string, markers: string[]) {
  let cursor = -1;
  for (const marker of markers) {
    const next = text.indexOf(marker, cursor + 1);
    expect(next, marker).toBeGreaterThan(cursor);
    cursor = next;
  }
}

type Case = [string, () => void | Promise<void>];
const cases: Case[] = [
  ["01 Frozen A + current exact READY A => TS CURRENT", () => expect(classifyCurrentEffectiveContextAuthority(facts())).toBe("CURRENT")],
  ["02 exact CURRENT DB semantic is represented", () => expect(migration).toContain("RETURN 'CURRENT'")],
  ["03 Frozen A + current exact READY B => TS DRIFT", () => expect(classifyCurrentEffectiveContextAuthority(facts({ sources: [source({ frozenAuthorityMatchesCurrentHead: false })] }))).toBe("DRIFT")],
  ["04 proven mismatch DB semantic is DRIFT not UNPROVEN", () => { expect(migration).toContain("STEP 2: current authority is proven"); expect(migration).toContain("RETURN 'DRIFT'"); }],
  ["05 newer failed Observation => TS UNPROVEN", () => expect(classifyCurrentEffectiveContextAuthority(facts({ sources: [source({ observationHeadQualifiedReady: false })] }))).toBe("UNPROVEN")],
  ["06 failed actual head DB semantic is UNPROVEN", () => { expect(migration).toContain("SOURCE_PROVEN_INDEX_FAILED"); expect(migration).toContain("RETURN 'UNPROVEN'"); }],
  ["07 no Observation head => TS/DB UNPROVEN", () => { expect(classifyCurrentEffectiveContextAuthority(facts({ sources: [source({ observationHeadPresent: false })] }))).toBe("UNPROVEN"); expect(migration).toContain("h.id IS NULL"); }],
  ["08 consumed frozen Assembly => TS/DB UNPROVEN", () => { expect(classifyCurrentEffectiveContextAuthority(facts({ forwardAuthorityConsumed: true }))).toBe("UNPROVEN"); expect(migration).toContain("context_forward_authority_consumptions"); }],
  ["09 ordering mismatch changes exact source-set authority", () => { const a=taskSourceSetAuthoritySha256V1([{workspaceRegistrationId:"w",workspaceRegistrationFingerprint:"f",ordering:0}]); const b=taskSourceSetAuthoritySha256V1([{workspaceRegistrationId:"w",workspaceRegistrationFingerprint:"f",ordering:1}]); expect(a).not.toBe(b); expect(migration).toContain("tws.ordering IS DISTINCT FROM cas.ordering"); }],
  ["10 Registration fingerprint mismatch changes exact source-set authority", () => { const a=taskSourceSetAuthoritySha256V1([{workspaceRegistrationId:"w",workspaceRegistrationFingerprint:"a",ordering:0}]); const b=taskSourceSetAuthoritySha256V1([{workspaceRegistrationId:"w",workspaceRegistrationFingerprint:"b",ordering:0}]); expect(a).not.toBe(b); expect(migration).toContain("tws.fingerprint IS DISTINCT FROM cas.workspace_registration_fingerprint"); }],
  ["11 historical Assembly cannot be CURRENT through canonical Gate", () => { expect(classifyCurrentEffectiveContextAuthority(facts({ assemblyIsHead:false }))).toBe("DRIFT"); expect(authority).not.toContain("export async function inspectFrozenContextSourceAuthority"); }],
  ["12 read-only projection consumes canonical typed evaluator", () => { const s=sliceBetween(authority,"export async function readFrozenContextForwardAuthorityStatus"); expect(s).toContain("evaluateCurrentEffectiveContextAuthority"); }],
  ["13 UNPROVEN is not inferred/mapped to DRIFT by HttpCommandError", () => { const s=sliceBetween(authority,"export async function readFrozenContextForwardAuthorityStatus"); expect(s).not.toContain("instanceof HttpCommandError"); expect(s).not.toContain("SOURCE_DRIFT_REBASE_REQUIRED"); }],
  ["14 DB DRIFT remains a distinct semantic result", () => { expect(migration.match(/RETURN 'DRIFT'/g)?.length ?? 0).toBeGreaterThan(0); expect(migration).toContain("STEP 2: current authority is proven"); }],
  ["15 stale/unproven preselection Catalog remains fail-closed", () => { expect(projection).toContain("currentContextAuthorityStale"); expect(projection).toContain("CURRENT_CONTEXT_REBUILD_REQUIRED"); }],
  ["16 stale/unproven Requirement remains fail-closed", () => { expect(projection).toContain("CURRENT_CONTEXT_REBUILD_REQUIRED"); expect(projection).toContain("RESOLVE_CONTEXT"); }],

  ["17 every current forward-authority Contract path is Task-first", () => { expectOrder(sliceBetween(lifecycle,"export async function approveContractRevision","export async function compileContractArtifact"),["lookupContractRouting","lockTask","assertCurrentEffectiveContextAuthority","loadContractForUpdate"]); expectOrder(sliceBetween(lifecycle,"export async function compileContractArtifact","export async function createRun"),["lookupContractRouting","lockTask","assertCurrentEffectiveContextAuthority","loadContractForUpdate"]); }],
  ["18 Contract approval never Contract-locks before Task", () => expectOrder(sliceBetween(lifecycle,"export async function approveContractRevision","export async function compileContractArtifact"),["lockTask","loadContractForUpdate"])],
  ["19 Contract compilation never Contract-locks before Task", () => expectOrder(sliceBetween(lifecycle,"export async function compileContractArtifact","export async function createRun"),["lockTask","loadContractForUpdate"])],
  ["20 Contract resolution follows Task→Context→Workspaces before Contract mutation", () => expectOrder(sliceBetween(lifecycle,"export async function resolveContract","async function loadContractForUpdate"),["lockTask","assertCurrentEffectiveContextAuthority","update intentchord.contract_revisions"])],
  ["21 INITIAL Run follows Task→Context→Workspaces→Contract", () => { expectOrder(sliceBetween(lifecycle,"export async function createRun","export async function submitRawReport"),["lockTask","assertCurrentEffectiveContextAuthority","currentContractForUpdate","createRunInTransaction"]); const guard=sliceBetween(migration,"CREATE OR REPLACE FUNCTION intentchord.context_forward_authority_consumption_insert_guard()","DROP TRIGGER IF EXISTS context_forward_authority_consumptions_insert_guard"); expectOrder(guard,["PERFORM 1 FROM intentchord.tasks","PERFORM 1 FROM intentchord.context_assemblies","ORDER BY w.id","contract_revisions WHERE id=NEW.contract_revision_id FOR UPDATE","runs WHERE id=NEW.run_id FOR UPDATE"]); }],
  ["22 CORRECTION Run follows Task→Context→Workspaces→Contract→parent Run", () => expectOrder(sliceBetween(lifecycle,"export async function startCorrection"),["lockTask","assertCurrentEffectiveContextAuthority","currentContractForUpdate","loadRunForUpdate","createRunInTransaction"])],
  ["23 Source Authorization locks UNION(current sources + target) in global ID order", () => { expect(closure).toContain("[command.workspaceRegistrationId]"); expect(migration).toContain("UNION\n     SELECT NEW.workspace_registration_id"); expect(migration).toContain("ORDER BY w.id"); }],
  ["24 Context Assembly capture uses the same globally sorted Workspace lock helper", () => { expect(closure).toContain("captureLockedTaskSourceAuthority"); expect(authority).toContain(".sort()"); expect(authority).toContain("order by id\n      for update"); }],
  ["25 Work Selection and Scope Confirmation share Task→Context→Workspace authority Gate", () => { expect(binding).toContain("assertCurrentEffectiveContextAuthority"); expect(sliceBetween(lifecycle,"export async function confirmTaskScope","export async function selectTaskExecutionPlatform")).toContain("assertCurrentEffectiveContextAuthority"); }],

  ["26 PostgreSQL source aligns resolveContract vs approveContractRevision to REVISION_CONFLICT after Contract lock", () => { const s=sliceBetween(concurrency,'it("26 actual resolveContract vs approveContractRevision forces Task-first contention"','it("27 actual resolveContract vs compileContractArtifact forces Task-first contention"'); expect(s).toContain("resolveContract("); expect(s).toContain("approveContractRevision("); expect(s).toContain('required: contractBranchRequired'); expect(s).toContain('allowedDomainCodes: new Set(["REVISION_CONFLICT"])'); expect(contractBranchRequiredSource).toContain('CONTRACT_LOCK_ATTEMPTED'); }],
  ["27 PostgreSQL source aligns resolveContract vs compileContractArtifact to REVISION_CONFLICT after Contract lock", () => { const s=sliceBetween(concurrency,'it("27 actual resolveContract vs compileContractArtifact forces Task-first contention"','it("28 actual commitTaskWorkSelection vs approveContractRevision forces Task-first contention"'); expect(s).toContain("resolveContract("); expect(s).toContain("compileContractArtifact("); expect(s).toContain('required: contractBranchRequired'); expect(s).toContain('allowedDomainCodes: new Set(["REVISION_CONFLICT"])'); expect(contractBranchRequiredSource).toContain('CONTRACT_LOCK_ATTEMPTED'); }],
  ["28 PostgreSQL source proves UNIFIED_V2_SCOPE_AUTHORITY_REQUIRED stops Branch B after Task lock", () => { const s=sliceBetween(concurrency,'it("28 actual commitTaskWorkSelection vs approveContractRevision forces Task-first contention"','it("29 reciprocal authorizeTaskContextSource forces both Tasks into Workspace authority together"'); expect(s).toContain("commitTaskWorkSelection("); expect(s).toContain("approveContractRevision("); expect(s).toContain('required: taskEarlyStopRequired'); expect(s).toContain('forbidden: taskEarlyStopForbidden'); expect(s).toContain('allowedDomainCodes: new Set(["UNIFIED_V2_SCOPE_AUTHORITY_REQUIRED"])'); expect(taskEarlyStopRequiredSource).toContain('B: ["TRANSACTION_STARTED", "TASK_LOCK_ATTEMPTED", "TASK_LOCK_ACQUIRED", "TRANSACTION_RELEASED"]'); expect(taskEarlyStopForbiddenSource).toContain('B: ["CONTEXT_LOCK_ATTEMPTED", "WORKSPACE_LOCK_ATTEMPTED", "CONTRACT_LOCK_ATTEMPTED"]'); }],
  ["29 PostgreSQL source preserves reciprocal authorizeTaskContextSource Workspace-authority contention", () => { const s=sliceBetween(concurrency,'it("29 reciprocal authorizeTaskContextSource forces both Tasks into Workspace authority together"','it("30 actual confirmTaskScope vs resolveContract forces Task-first contention"'); expect(s.match(/authorizeTaskContextSource\(/g)?.length ?? 0).toBe(2); expect(s).toContain('mode: "SIMULTANEOUS_ATTEMPT"'); expect(s).toContain('milestone: "WORKSPACE_LOCK"'); expect(s).toContain('CONTEXT_LOCK_ATTEMPTED'); expect(s).toContain('WORKSPACE_LOCK_ATTEMPTED'); expect(s).toContain("targetWorkspaceId"); }],
  ["30 PostgreSQL source proves REVISION_CONFLICT stops Branch B after Task lock", () => { const s=sliceBetween(concurrency,'it("30 actual confirmTaskScope vs resolveContract forces Task-first contention"','it("31 actual runTaskContextClosure R2 vs Work Selection historical real C1 reaches real Catalog/Context gate"'); expect(s).toContain("confirmTaskScope("); expect(s).toContain("resolveContract("); expect(s).toContain('required: taskEarlyStopRequired'); expect(s).toContain('forbidden: taskEarlyStopForbidden'); expect(s).toContain('allowedDomainCodes: new Set(["REVISION_CONFLICT"])'); expect(taskEarlyStopRequiredSource).toContain('B: ["TRANSACTION_STARTED", "TASK_LOCK_ATTEMPTED", "TASK_LOCK_ACQUIRED", "TRANSACTION_RELEASED"]'); }],
  ["31 PostgreSQL source preserves R2 Closure vs historical C1 current Context/Workspace authority path", () => { const s=sliceBetween(concurrency,'it("31 actual runTaskContextClosure R2 vs Work Selection historical real C1 reaches real Catalog/Context gate"','it("32 PostgreSQL semantic fixture returns CURRENT"'); expect(s).toContain("runTaskContextClosure("); expect(s).toContain("commitTaskWorkSelection("); expect(s).toContain("fixture.closure31"); expect(s).toContain("acceptedCatalogRevisionId: f.acceptedCatalogRevisionId"); expect(s).toContain('required: sameTaskRequired'); expect(s).toContain('allowedDomainCodes: new Set(["ACCEPTED_CONTEXT_CATALOG_SUPERSEDED"])'); expect(sameTaskRequiredSource).toContain('CONTEXT_LOCK_ATTEMPTED'); expect(sameTaskRequiredSource).toContain('WORKSPACE_LOCK_ATTEMPTED'); }],
  ["32 PostgreSQL source asserts proven mismatch => DRIFT", () => expect(concurrency).toContain('toBe("DRIFT")')],
  ["33 PostgreSQL source asserts failed actual head => UNPROVEN", () => expect(concurrency).toContain("unprovenFailedHead")],
  ["34 PostgreSQL source asserts consumed Assembly => UNPROVEN", () => expect(concurrency).toContain("unprovenConsumed")],

  ["35 actual Observation authority-head-first rule preserved", () => expect(authority).toContain("order by o.authority_sequence desc")],
  ["36 no fallback to older successful Observation", () => { const start=authority.indexOf("from lateral ("); const end=authority.indexOf(") h",start); expect(start).toBeGreaterThanOrEqual(0); const headSelect=authority.slice(start,end); expect(headSelect).toContain("authority_sequence desc"); expect(headSelect).not.toContain("SUCCEEDED"); expect(headSelect).not.toContain("SOURCE_PROVEN_INDEX_FAILED"); }],
  ["37 exact Task source-set identity includes Registration ID+fingerprint+ordering", () => { expect(taskSourceSetAuthoritySha256V1([{workspaceRegistrationId:"w",workspaceRegistrationFingerprint:"f",ordering:0}])).not.toBe(taskSourceSetAuthoritySha256V1([{workspaceRegistrationId:"w",workspaceRegistrationFingerprint:"x",ordering:0}])); }],
  ["38 aggregate Task revision remains distinct from latest Draft resolution", () => { expect(migration).toContain("FROM intentchord.task_draft_revisions"); expect(migration).toContain("ORDER BY revision DESC"); }],
  ["39 source-mutating Run consumption remains preserved", () => expect(migration).toContain("SOURCE_MUTATING_RUN_STARTED")],
  ["40 read-only Run does not consume Context", () => expect(finalIntegration).toContain("read-only Run does not consume")],
  ["41 presentation-only edits preserve frozen authority", () => { expect(lifecycle).toContain("unifiedAuthorityInputChanged"); expect(lifecycle).toContain("preserveUnifiedFrozenAuthority"); expect(finalIntegration).toContain("title-only edit") }],
  ["42 authority mutation after Scope Confirmation still requires Rebase", () => expect(lifecycle).toContain("SCOPE_AUTHORITY_REBASE_REQUIRED")],
  ["43 rebased Correction operational inheritance is cleared", () => { expect(lifecycle).toContain("sameExactExecutionAuthority"); expect(lifecycle).toContain("inheritedCheckIds"); }],
  ["44 same-authority Correction inheritance remains permitted", () => { expect(lifecycle).toContain("sameExactExecutionAuthority"); expect(finalIntegration).toContain("same exact authority Correction") }],
  ["45 Source Authorization has no fallible post-commit old-Assembly reevaluation", () => { const s=sliceBetween(closure,"export async function authorizeTaskContextSource"); expect(s).not.toContain("reevaluateLatestAdmittedIteration(originatingRevisionId)"); }],
  ["46 historical V1 cannot create new UNIFIED authority", () => { expect(lifecycle).toContain("UNIFIED_V2_CONTEXT_AUTHORITY_REQUIRED"); expect(lifecycle).toContain("UNIFIED_V2_SCOPE_AUTHORITY_REQUIRED"); }],
  ["47 Context Assembly remains immutable evidence-only", () => { expect(migration).not.toMatch(/context_assembly_revisions\s*\([\s\S]*?\bstate\b/i); expect(migration).not.toMatch(/context_assembly_revisions\s*\([\s\S]*?\bclosure_state\b/i); }],
  ["48 Closure Evaluations remain immutable/multiple", () => { expect(migration).toContain("context_closure_evaluations"); expect(rootState).toContain("multiple Closure Evaluations") }],
  ["49 truthful SUPERSEDED_BY_NEW_ASSEMBLY remains", () => { expect(migration).toContain("SUPERSEDED_BY_NEW_ASSEMBLY"); expect(migration).not.toContain("RESOLVED_BY_NEW_ASSEMBLY") }],
  ["50 exact Missing Evidence classification coverage remains", () => { expect(rootInvariant).toContain("exact classification"); expect(migration).toContain("context_gap_classifications") }],
  ["51 active Run is never silently retargeted", () => { expect(projection).toContain("ACTIVE_RUN_ON_FROZEN_AUTHORITY"); expect(lifecycle).not.toContain("RETARGET_ACTIVE_RUN") }],
  ["52 latest Mapping Run remains non-authoritative", () => expect(binding).not.toMatch(/context_mapping_runs[\s\S]{0,180}order\s+by[\s\S]{0,100}created_at\s+desc\s+limit\s+1/i)],
  ["53 Migration 013 remains outside Migration 014 correction", () => expect(migration).not.toContain("ALTER MIGRATION 013")],
  ["54 Migration 015 absent from active schema source", () => expect(read("PACKAGE_INVENTORY.txt")).not.toContain("015_")],
  ["55 AI_CONTEXT_MAPPING_V1 preserved", () => { expect(migration).toContain("AI_CONTEXT_MAPPING_V1"); expect(mapperTypes).toContain('INTERNAL_AI_QUALIFICATION_SCOPE_V1 = "AI_CONTEXT_MAPPING_V1"') }],
  ["56 V1 qualification does not imply V2", () => { expect(migration).toContain("AI_CONTEXT_MAPPING_V2"); expect(migration).toContain("qualification_scope") }],
  ["57 Mistral remains unconfigured/unqualified", () => { const all=lifecycle+closure+migration; expect(all).not.toContain("internal-mistral-large-2512"); expect(all).not.toContain("mistral-large-2512") }],
];

describe("Current Context semantic parity + global lock-order matrix", () => {
  for (const [name, check] of cases) it(name, check);
  it("matrix cardinality is exactly 57 required cases", () => expect(cases).toHaveLength(57));
});

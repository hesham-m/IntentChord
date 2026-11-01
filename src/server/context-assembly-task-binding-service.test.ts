import { beforeEach, describe, expect, it, vi } from "vitest";
import { mapperSha256 } from "@/core/ai-context-mapper/canonical";
import {
  ACCEPTED_CONTEXT_CATALOG_SCHEMA_VERSION,
  CONTEXT_ASSEMBLY_MAPPING_INPUT_SCHEMA_VERSION,
  type AcceptedContextCatalogV2,
  type ContextAssemblyMappingInputV2,
} from "@/core/ai-context-mapper/v2";

const dbMocks = vi.hoisted(() => ({ databaseQuery: vi.fn() }));
vi.mock("@/server/db", () => dbMocks);

import { resolveContextAssemblyWorkSelection } from "@/server/context-assembly-task-binding-service";

const sha = (character: string) => `sha256:${character.repeat(64)}`;
const taskId = "11111111-1111-4111-8111-111111111111";
const catalogRevisionId = "22222222-2222-4222-8222-222222222222";
const assemblyId = "33333333-3333-4333-8333-333333333333";
const assemblyRevisionId = "44444444-4444-4444-8444-444444444444";
const mappingIterationId = "55555555-5555-4555-8555-555555555555";
const closureEvaluationId = "aaaaaaaa-5555-4555-8555-555555555555";
const mappingRunId = "bbbbbbbb-5555-4555-8555-555555555555";
const workspaceClient = "66666666-6666-4666-8666-666666666666";
const workspaceServer = "77777777-7777-4777-8777-777777777777";

function selectResult<T>(rows: T[]) { return { command: "SELECT", rowCount: rows.length, oid: 0, fields: [], rows }; }

const catalog: AcceptedContextCatalogV2 = {
  schema_version: ACCEPTED_CONTEXT_CATALOG_SCHEMA_VERSION,
  context_assembly_id: assemblyId,
  context_assembly_revision_id: assemblyRevisionId,
  mapping_iteration_id: mappingIterationId,
  closure_evaluation_id: closureEvaluationId,
  catalog_summary: "Closed cross-workspace Update and Policy catalog.",
  components: [
    { component_id: "update_channel", display_name: "Update Channel", context_kind: "service", summary: "Cross-workspace update delivery.", responsibilities: ["publish", "consume"], workspace_ids: [workspaceClient, workspaceServer], evidence_entry_ids: ["entry_client_update", "entry_server_update"], interfaces: [], unknowns: [], confidence: "high", rationale: "Evidence from both sides." },
    { component_id: "policy", display_name: "Policy", context_kind: "service", summary: "Server policy publication.", responsibilities: ["publish policy"], workspace_ids: [workspaceServer], evidence_entry_ids: ["entry_server_policy"], interfaces: [], unknowns: [], confidence: "high", rationale: "Server policy evidence." },
  ],
  relationships: [],
  source_bindings: [
    { workspace_id: workspaceClient, workspace_registration_revision: 3, workspace_registration_fingerprint: sha("1"), workspace_revision_id: "wsr_client", workspace_index_snapshot_id: "wis_client", canonical_index_artifact_id: "cia_client", workspace_index_sha256: sha("2"), artifact_semantic_sha256: sha("3") },
    { workspace_id: workspaceServer, workspace_registration_revision: 5, workspace_registration_fingerprint: sha("4"), workspace_revision_id: "wsr_server", workspace_index_snapshot_id: "wis_server", canonical_index_artifact_id: "cia_server", workspace_index_sha256: sha("5"), artifact_semantic_sha256: sha("6") },
  ],
};

const mappingInput: ContextAssemblyMappingInputV2 = {
  schema_version: CONTEXT_ASSEMBLY_MAPPING_INPUT_SCHEMA_VERSION,
  context_assembly_id: assemblyId,
  context_assembly_revision_id: assemblyRevisionId,
  context_assembly_revision: 2,
  created_at: "2026-08-18T10:00:00.000Z",
  source_bindings: catalog.source_bindings,
  entries: [
    { entry_id: "entry_client_update", workspace_id: workspaceClient, normalized_path: "client/updater.ts", entry_type: "FILE", language_or_format: "typescript", size_bytes: 10, content_or_metadata_fingerprint: sha("7"), index_supported_signals: { file_kind: "SOURCE", parse_status: "PARSED", coverage_state: "COVERED", fact_signals: [], relation_signals: [] } },
    { entry_id: "entry_server_update", workspace_id: workspaceServer, normalized_path: "server/update/api.ts", entry_type: "FILE", language_or_format: "typescript", size_bytes: 10, content_or_metadata_fingerprint: sha("8"), index_supported_signals: { file_kind: "SOURCE", parse_status: "PARSED", coverage_state: "COVERED", fact_signals: [], relation_signals: [] } },
    { entry_id: "entry_server_policy", workspace_id: workspaceServer, normalized_path: "server/policy/publisher.ts", entry_type: "FILE", language_or_format: "typescript", size_bytes: 10, content_or_metadata_fingerprint: sha("9"), index_supported_signals: { file_kind: "SOURCE", parse_status: "PARSED", coverage_state: "COVERED", fact_signals: [], relation_signals: [] } },
  ],
  serialized_payload_sha256: sha("a"), provider_neutral_estimated_tokens: 100, proof_obligations: ["complete assembly"],
};

function authorityRow(decision = "PASS") {
  return {
    id: catalogRevisionId,
    catalog_sha256: mapperSha256(catalog),
    catalog_json: catalog,
    context_assembly_revision_id: assemblyRevisionId,
    mapping_iteration_id: mappingIterationId,
    closure_evaluation_id: closureEvaluationId,
    context_assembly_id: assemblyId,
    assembly_revision: 2,
    closure_decision: decision,
    closure_evaluation_input_sha256: sha("b"),
    mapping_run_id: mappingRunId,
    mapping_input_snapshot: mappingInput,
    task_id: taskId,
  };
}

describe("Context Assembly V2 Owner Work Selection exact provenance", () => {
  beforeEach(() => dbMocks.databaseQuery.mockReset());

  it("derives one multi-component Candidate Scope across governed Workspaces from the exact accepted Catalog chain", async () => {
    dbMocks.databaseQuery.mockResolvedValueOnce(selectResult([authorityRow()]));
    const resolved = await resolveContextAssemblyWorkSelection({ taskId, acceptedCatalogRevisionId: catalogRevisionId, selectedComponentIds: ["policy", "update_channel", "update_channel"], boundWorkspaceIds: [workspaceClient, workspaceServer] });
    expect(new Set(resolved.candidateScope.entries.map(entry => entry.componentId))).toEqual(new Set(["update_channel", "policy"]));
    expect(resolved.candidateScope.candidateAllowedPaths).toEqual([
      { workspaceId: workspaceClient, path: "client/updater.ts" },
      { workspaceId: workspaceServer, path: "server/policy/publisher.ts" },
      { workspaceId: workspaceServer, path: "server/update/api.ts" },
    ]);
    expect(resolved.binding).toMatchObject({ contextAssemblyId: assemblyId, contextAssemblyRevisionId: assemblyRevisionId, mappingIterationId, closureEvaluationId, acceptedCatalogRevisionId: catalogRevisionId });
    expect(dbMocks.databaseQuery).toHaveBeenCalledTimes(1);
    expect(String(dbMocks.databaseQuery.mock.calls[0][0])).not.toMatch(/order\s+by\s+.*created_at\s+desc\s+limit\s+1/i);
  });

  it("fails closed when the exact Catalog Closure Evaluation is not PASS", async () => {
    dbMocks.databaseQuery.mockResolvedValueOnce(selectResult([authorityRow("BLOCKED")]));
    await expect(resolveContextAssemblyWorkSelection({ taskId, acceptedCatalogRevisionId: catalogRevisionId, selectedComponentIds: ["update_channel"], boundWorkspaceIds: [workspaceClient, workspaceServer] })).rejects.toMatchObject({ code: "CONTEXT_CLOSURE_NOT_PASS" });
  });

  it("fails closed when accepted Catalog evidence depends on a Workspace that is not Task-bound", async () => {
    dbMocks.databaseQuery.mockResolvedValueOnce(selectResult([authorityRow()]));
    await expect(resolveContextAssemblyWorkSelection({ taskId, acceptedCatalogRevisionId: catalogRevisionId, selectedComponentIds: ["update_channel"], boundWorkspaceIds: [workspaceServer] })).rejects.toMatchObject({ code: "CATALOG_EVIDENCE_WORKSPACE_NOT_BOUND" });
  });

  it("fails closed when Catalog JSON provenance does not match persisted exact chain", async () => {
    dbMocks.databaseQuery.mockResolvedValueOnce(selectResult([{ ...authorityRow(), mapping_iteration_id: "cccccccc-5555-4555-8555-555555555555" }]));
    await expect(resolveContextAssemblyWorkSelection({ taskId, acceptedCatalogRevisionId: catalogRevisionId, selectedComponentIds: ["policy"], boundWorkspaceIds: [workspaceClient, workspaceServer] })).rejects.toMatchObject({ code: "ACCEPTED_CONTEXT_CATALOG_PROVENANCE_MISMATCH" });
  });
});

import type { PoolClient } from "pg";
import { mapperSha256 } from "@/core/ai-context-mapper/canonical";
import type { ContextAssemblyMappingInputV2, AcceptedContextCatalogV2 } from "@/core/ai-context-mapper/v2";
import type {
  ContextAssemblyTaskCandidateScope,
  TaskContextAssemblyBinding,
  WorkspaceScopedPath,
} from "@/core/tasks/task-input";
import { candidateScopeIdentityMatches } from "@/core/tasks/task-input";
import { localRelativePathKey } from "@/core/workspace-index/local-path-semantics";
import { assertCurrentEffectiveContextAuthority } from "@/server/context-head-authority";
import { databaseQuery } from "@/server/db";
import { HttpCommandError } from "@/server/errors";

type Queryable = Pick<PoolClient, "query">;

type CatalogAuthorityRow = {
  id: string;
  catalog_sha256: string;
  catalog_json: AcceptedContextCatalogV2;
  context_assembly_revision_id: string;
  mapping_iteration_id: string;
  closure_evaluation_id: string;
  context_assembly_id: string;
  assembly_revision: number;
  closure_decision: string;
  closure_evaluation_input_sha256: string;
  mapping_run_id: string;
  mapping_input_snapshot: ContextAssemblyMappingInputV2;
  task_id: string;
};

function runtimeDatabase(): Queryable {
  return { query: databaseQuery as PoolClient["query"] };
}

export function contextAssemblyBindingMatches(
  left: TaskContextAssemblyBinding,
  right: TaskContextAssemblyBinding,
): boolean {
  return left.contractVersion === right.contractVersion
    && left.contextAssemblyId === right.contextAssemblyId
    && left.contextAssemblyRevisionId === right.contextAssemblyRevisionId
    && left.contextAssemblyRevision === right.contextAssemblyRevision
    && left.mappingIterationId === right.mappingIterationId
    && left.closureEvaluationId === right.closureEvaluationId
    && left.acceptedCatalogRevisionId === right.acceptedCatalogRevisionId
    && left.acceptedCatalogSha256 === right.acceptedCatalogSha256;
}

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//, "");
}

async function readCatalogAuthorityForTask(
  queryable: Queryable,
  taskId: string,
  acceptedCatalogRevisionId: string,
): Promise<CatalogAuthorityRow> {
  const result = await queryable.query<CatalogAuthorityRow>(
    `select c.id,c.catalog_sha256,c.catalog_json,c.context_assembly_revision_id,c.mapping_iteration_id,c.closure_evaluation_id,
            a.id as context_assembly_id,ar.revision as assembly_revision,ce.decision as closure_decision,
            ce.evaluation_input_sha256 as closure_evaluation_input_sha256,
            mi.mapping_run_id,mr.mapping_input_snapshot,a.task_id
       from intentchord.context_catalog_revisions c
       join intentchord.context_assembly_revisions ar on ar.id=c.context_assembly_revision_id
       join intentchord.context_assemblies a on a.id=ar.context_assembly_id
       join intentchord.context_closure_evaluations ce
         on ce.id=c.closure_evaluation_id
        and ce.context_assembly_revision_id=c.context_assembly_revision_id
        and ce.mapping_iteration_id=c.mapping_iteration_id
       join intentchord.context_assembly_mapping_iterations mi
         on mi.id=c.mapping_iteration_id
        and mi.context_assembly_revision_id=c.context_assembly_revision_id
       join intentchord.context_mapping_runs mr
         on mr.id=mi.mapping_run_id
        and mr.context_assembly_revision_id=c.context_assembly_revision_id
        and mr.qualification_scope='AI_CONTEXT_MAPPING_V2'
      where c.id=$1 and a.task_id=$2`,
    [acceptedCatalogRevisionId, taskId],
  );
  if (!result.rowCount) {
    throw new HttpCommandError(404, "ACCEPTED_CONTEXT_CATALOG_NOT_FOUND", "The accepted Context Catalog revision was not found for this Task.");
  }
  const row = result.rows[0];
  if (row.closure_decision !== "PASS") {
    throw new HttpCommandError(409, "CONTEXT_CLOSURE_NOT_PASS", "Owner Work Selection requires an exact PASS Context Closure Evaluation.");
  }
  if (mapperSha256(row.catalog_json) !== row.catalog_sha256) {
    throw new HttpCommandError(409, "ACCEPTED_CONTEXT_CATALOG_SHA_MISMATCH", "The accepted Context Catalog revision failed deterministic integrity validation.");
  }
  if (
    row.catalog_json.context_assembly_revision_id !== row.context_assembly_revision_id
    || row.catalog_json.mapping_iteration_id !== row.mapping_iteration_id
    || row.catalog_json.closure_evaluation_id !== row.closure_evaluation_id
  ) {
    throw new HttpCommandError(409, "ACCEPTED_CONTEXT_CATALOG_PROVENANCE_MISMATCH", "Accepted Catalog JSON does not match its exact persisted Assembly / Mapping Iteration / Closure Evaluation provenance.");
  }
  if (row.mapping_input_snapshot.context_assembly_revision_id !== row.context_assembly_revision_id) {
    throw new HttpCommandError(409, "ACCEPTED_CONTEXT_MAPPING_INPUT_MISMATCH", "Accepted Catalog Mapping provenance resolved an input for a different Context Assembly Revision.");
  }
  return row;
}

async function resolveContextAssemblyWorkSelectionWithQuery(input: {
  taskId: string;
  acceptedCatalogRevisionId: string;
  selectedComponentIds: string[];
  boundWorkspaceIds: string[];
}, queryable: Queryable): Promise<{ binding: TaskContextAssemblyBinding; candidateScope: ContextAssemblyTaskCandidateScope; catalogRow: CatalogAuthorityRow }> {
  const catalogRow = await readCatalogAuthorityForTask(queryable, input.taskId, input.acceptedCatalogRevisionId);
  const catalog = catalogRow.catalog_json;
  const selectedComponentIds = [...new Set(input.selectedComponentIds)].sort();
  if (!selectedComponentIds.length) {
    throw new HttpCommandError(422, "SELECTED_WORK_REQUIRED", "At least one Component must be selected from the accepted complete Context Catalog.");
  }
  const componentById = new Map(catalog.components.map(component => [component.component_id, component]));
  for (const componentId of selectedComponentIds) {
    if (!componentById.has(componentId)) {
      throw new HttpCommandError(422, "SELECTED_COMPONENT_NOT_IN_ACCEPTED_CATALOG", `Component ${componentId} is not present in the accepted Context Catalog revision.`);
    }
  }

  // Authority-critical evidence resolution is exact: Catalog -> Closure Evaluation ->
  // Mapping Iteration -> Mapping Run -> frozen Mapping Input. Never resolve "latest".
  const assemblyInput = catalogRow.mapping_input_snapshot;
  const evidenceById = new Map(assemblyInput.entries.map(entry => [entry.entry_id, entry]));
  const boundWorkspaceSet = new Set(input.boundWorkspaceIds);
  const entries: ContextAssemblyTaskCandidateScope["entries"] = [];
  const seenEntryKeys = new Set<string>();

  for (const componentId of selectedComponentIds) {
    const component = componentById.get(componentId)!;
    for (const evidenceEntryId of component.evidence_entry_ids) {
      const evidence = evidenceById.get(evidenceEntryId);
      if (!evidence) {
        throw new HttpCommandError(409, "CATALOG_EVIDENCE_ENTRY_NOT_FOUND", `Accepted Component ${componentId} references missing governed evidence ${evidenceEntryId}.`);
      }
      if (!boundWorkspaceSet.has(evidence.workspace_id)) {
        throw new HttpCommandError(409, "CATALOG_EVIDENCE_WORKSPACE_NOT_BOUND", `Accepted Component ${componentId} depends on Workspace ${evidence.workspace_id}, which is not bound to the Task.`);
      }
      const normalizedPath = normalizePath(evidence.normalized_path);
      const key = `${componentId}:${evidence.workspace_id}:${localRelativePathKey(normalizedPath)}:${evidence.entry_id}`;
      if (seenEntryKeys.has(key)) continue;
      seenEntryKeys.add(key);
      entries.push({ workspaceId: evidence.workspace_id, normalizedPath, componentId, evidenceEntryId: evidence.entry_id });
    }
  }
  entries.sort((a,b) => a.workspaceId.localeCompare(b.workspaceId) || a.normalizedPath.localeCompare(b.normalizedPath) || a.componentId.localeCompare(b.componentId));
  if (!entries.length) {
    throw new HttpCommandError(409, "SELECTED_COMPONENT_EVIDENCE_REQUIRED", "Selected Components must have governed evidence before Candidate Scope can be derived.");
  }

  const candidateAllowedPaths: WorkspaceScopedPath[] = [];
  const seenPaths = new Set<string>();
  for (const entry of entries) {
    const key = `${entry.workspaceId}:${localRelativePathKey(entry.normalizedPath)}`;
    if (seenPaths.has(key)) continue;
    seenPaths.add(key);
    candidateAllowedPaths.push({ workspaceId: entry.workspaceId, path: entry.normalizedPath });
  }
  candidateAllowedPaths.sort((a,b) => a.workspaceId.localeCompare(b.workspaceId) || a.path.localeCompare(b.path));

  const selectedComponentIdsSha256 = mapperSha256(selectedComponentIds);
  const candidateScopeSha256 = mapperSha256({
    authority_version: "CONTEXT_ASSEMBLY_V2",
    context_assembly_revision_id: catalogRow.context_assembly_revision_id,
    mapping_iteration_id: catalogRow.mapping_iteration_id,
    closure_evaluation_id: catalogRow.closure_evaluation_id,
    accepted_catalog_revision_id: catalogRow.id,
    selected_component_ids: selectedComponentIds,
    entries: entries.map(entry => ({
      workspace_id: entry.workspaceId,
      normalized_path: entry.normalizedPath,
      component_id: entry.componentId,
      evidence_entry_id: entry.evidenceEntryId,
    })),
    candidate_allowed_paths: candidateAllowedPaths.map(path => ({ workspace_id: path.workspaceId, path: path.path })),
  });

  const binding: TaskContextAssemblyBinding = {
    contractVersion: "intentchord.context-assembly.v1",
    contextAssemblyId: catalogRow.context_assembly_id,
    contextAssemblyRevisionId: catalogRow.context_assembly_revision_id,
    contextAssemblyRevision: Number(catalogRow.assembly_revision),
    mappingIterationId: catalogRow.mapping_iteration_id,
    closureEvaluationId: catalogRow.closure_evaluation_id,
    acceptedCatalogRevisionId: catalogRow.id,
    acceptedCatalogSha256: catalogRow.catalog_sha256,
  };
  return {
    binding,
    candidateScope: {
      authorityVersion: "CONTEXT_ASSEMBLY_V2",
      contextAssemblyId: binding.contextAssemblyId,
      contextAssemblyRevisionId: binding.contextAssemblyRevisionId,
      mappingIterationId: binding.mappingIterationId,
      closureEvaluationId: binding.closureEvaluationId,
      acceptedCatalogRevisionId: binding.acceptedCatalogRevisionId,
      acceptedCatalogSha256: binding.acceptedCatalogSha256,
      selectedComponentIdsSha256,
      candidateScopeSha256,
      entries,
      candidateAllowedPaths,
    },
    catalogRow,
  };
}

export async function resolveContextAssemblyWorkSelection(input: {
  taskId: string;
  acceptedCatalogRevisionId: string;
  selectedComponentIds: string[];
  boundWorkspaceIds: string[];
}): Promise<{ binding: TaskContextAssemblyBinding; candidateScope: ContextAssemblyTaskCandidateScope }> {
  const resolved = await resolveContextAssemblyWorkSelectionWithQuery(input, runtimeDatabase());
  return { binding: resolved.binding, candidateScope: resolved.candidateScope };
}

/**
 * Forward-authority variant. The stable Context Assembly parent row is locked before the
 * Current Head comparison and remains locked through the caller's Task-authority write.
 */
export async function resolveCurrentHeadContextAssemblyWorkSelection(
  client: PoolClient,
  input: {
    taskId: string;
    acceptedCatalogRevisionId: string;
    selectedComponentIds: string[];
    boundWorkspaceIds: string[];
  },
): Promise<{ binding: TaskContextAssemblyBinding; candidateScope: ContextAssemblyTaskCandidateScope }> {
  const resolved = await resolveContextAssemblyWorkSelectionWithQuery(input, client);
  await assertCurrentEffectiveContextAuthority(
    client,
    input.taskId,
    resolved.catalogRow.context_assembly_revision_id,
    "ACCEPTED_CONTEXT_CATALOG_SUPERSEDED",
  );
  return { binding: resolved.binding, candidateScope: resolved.candidateScope };
}

export async function validateContextAssemblyCandidateScope(input: {
  taskId: string;
  binding: TaskContextAssemblyBinding;
  candidateScope: ContextAssemblyTaskCandidateScope;
  boundWorkspaceIds: string[];
  queryable?: Queryable;
}): Promise<ContextAssemblyTaskCandidateScope> {
  if (input.candidateScope.authorityVersion !== "CONTEXT_ASSEMBLY_V2") {
    throw new HttpCommandError(409, "CONTEXT_ASSEMBLY_SCOPE_REQUIRED", "Expected a Context Assembly V2 Candidate Scope.");
  }
  const componentIds = [...new Set(input.candidateScope.entries.map(entry => entry.componentId))];
  const resolved = await resolveContextAssemblyWorkSelectionWithQuery({
    taskId: input.taskId,
    acceptedCatalogRevisionId: input.binding.acceptedCatalogRevisionId,
    selectedComponentIds: componentIds,
    boundWorkspaceIds: input.boundWorkspaceIds,
  }, input.queryable ?? runtimeDatabase());
  if (!contextAssemblyBindingMatches(resolved.binding, input.binding) || !candidateScopeIdentityMatches(resolved.candidateScope, input.candidateScope)) {
    throw new HttpCommandError(409, "CONTEXT_ASSEMBLY_SCOPE_STALE", "The persisted Context Assembly Candidate Scope no longer matches the exact accepted Catalog authority chain.");
  }
  return resolved.candidateScope;
}

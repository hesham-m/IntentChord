import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { mapperSha256 } from "@/core/ai-context-mapper/canonical";
import { buildMappingInputSnapshotFromCanonicalArtifact } from "@/core/ai-context-mapper/input-builder";
import { sampleCanonicalWorkspaceIndex, sampleInternalAiProviderConfiguration } from "@/core/ai-context-mapper/test-fixtures";
import { validateModelContextAnalysisV2 } from "@/core/ai-context-mapper/validator-v2";
import {
  CONTEXT_ASSEMBLY_CONTRACT_VERSION,
  CONTEXT_ASSEMBLY_MAPPING_INPUT_SCHEMA_VERSION,
  CONTEXT_MAPPING_RESULT_SCHEMA_VERSION_V2,
  CONTEXT_MAPPING_V2_QUALIFICATION_SCOPE,
  CONTEXT_MAPPING_PROMPT_TEMPLATE_ID_V2,
  MODEL_CONTEXT_ANALYSIS_SCHEMA_VERSION_V2,
  type ContextAssemblyMappingInputV2,
  type ContextAssemblySourceBindingV2,
  type ContextMappingResultEnvelopeV2,
  type ModelContextAnalysisV2,
} from "@/core/ai-context-mapper/v2";
import { AI_CONTEXT_MAPPER_PROMPT_TEMPLATE_SHA256_V2 } from "@/core/ai-context-mapper/prompt-v2";
import {
  CANONICAL_INDEX_ARTIFACT_SEMANTIC_STATE_VERSION,
  canonicalIndexArtifactId,
  canonicalIndexArtifactSemanticState,
  canonicalIndexArtifactSemanticStateSha256,
  workspaceIndexConfigurationDescriptor,
  workspaceIndexConfigurationSha256,
} from "@/core/workspace-index/artifact-identity";
import { taskSourceSetAuthoritySha256V1 } from "@/core/context-authority/current-effective-context";
import { candidateScopeIdentityFromScope, createBlankTaskDraft, type TaskDraftInput, type WorkspaceReference } from "@/core/tasks/task-input";
import { PostgresAiContextMappingV2Repository } from "@/server/ai-context-mapping-v2-repository";
import { assertRegisteredWorkspaceSourceAuthority, verifyAndRegisterWorkspace } from "@/server/workspace-connector";
import { runTaskContextClosure, readTaskContextClosure } from "@/server/context-closure-service";
import { databaseQuery, transaction } from "@/server/current-context-forward-authority-validation-db.test-support";
import {
  approveContractRevision,
  commitTaskWorkSelection,
  confirmTaskScope,
  createRun,
  createTask,
  readTaskLifecycle,
  reviseTask,
  resolveContract,
  selectTaskExecutionPlatform,
} from "@/server/lifecycle";

const OWNER = "owner-local:Hisham";
const WORKSPACE_SOURCE_REVISION_INSERT_SQL = `insert into intentchord.workspace_source_revisions(
  id,workspace_registration_id,workspace_instance_id,source_tree_fingerprint,source_state_summary,first_observed_at
) values($1,$2,$3,$4,$5,$6)`;
const shaHex = (value: string) => createHash("sha256").update(value).digest("hex");
export const sha256 = (value: string) => `sha256:${shaHex(value)}`;

export function deterministicUuid(label: string): string {
  const h = shaHex(`intentchord-current-context-validation:${label}`);
  const chars = h.slice(0, 32).split("");
  chars[12] = "4";
  chars[16] = (["8", "9", "a", "b"] as const)[parseInt(chars[16], 16) % 4];
  const x = chars.join("");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

function wsr(label: string) { return `wsr_${shaHex(`wsr:${label}`)}`; }
function fixedTime(offsetSeconds = 0) { return new Date(Date.UTC(2026, 7, 19, 10, 0, offsetSeconds)).toISOString(); }

export type SeededWorkspace = {
  id: string;
  displayName: string;
  fingerprint: string;
  reference: string;
  registrationRevision: number;
  revisionId: string;
  snapshotId: string;
  observationId: string;
  authoritySequence: number;
  artifactId: string;
  indexSha256: string;
  artifactSemanticSha256: string;
  semanticState: ReturnType<typeof canonicalIndexArtifactSemanticState>;
};

export type ClosedTaskFixture = {
  key: string;
  taskId: string;
  workspaceIds: string[];
  assemblyId: string;
  assemblyRevisionId: string;
  acceptedCatalogRevisionId: string;
  mappingIterationId: string;
  closureEvaluationId: string;
  contractRevisionId?: string;
  contractStateRevision?: number;
  contractContentSha256?: string;
  selectedComponentIds: string[];
};

export type MissingEvidenceFixture = {
  key: string;
  taskId: string;
  currentWorkspaceId: string;
  targetWorkspaceId: string;
  assemblyId: string;
  assemblyRevisionId: string;
  missingEvidenceRequestId: string;
  resolutionRequirementId: string;
};

let validationWorkspaceRoot: string | undefined;
const liveFixtureWorkspacePaths = new Map<string, string>();
const allSeededWorkspaces: SeededWorkspace[] = [];

async function ensureValidationWorkspaceRoot(): Promise<string> {
  if (!validationWorkspaceRoot) {
    validationWorkspaceRoot = await mkdtemp(path.join(tmpdir(), "intentchord-current-context-validation-"));
  }
  return validationWorkspaceRoot;
}

async function createRealFixtureWorkspaceRoot(label: string): Promise<string> {
  const root = await ensureValidationWorkspaceRoot();
  const safeLabel = label.replace(/[^a-z0-9._-]+/gi, "-").slice(0, 64) || "workspace";
  const reference = path.join(root, `${safeLabel}-${shaHex(label).slice(0, 10)}`);
  await mkdir(path.join(reference, "src"), { recursive: true });
  await mkdir(path.join(reference, "node_modules"), { recursive: true });
  await writeFile(path.join(reference, "src", "fixture-source.txt"), `IntentChord disposable validation fixture ${label}\n`, "utf8");
  liveFixtureWorkspacePaths.set(label, reference);
  return reference;
}

export async function cleanupValidationWorkspaceRoots(): Promise<void> {
  const root = validationWorkspaceRoot;
  validationWorkspaceRoot = undefined;
  liveFixtureWorkspacePaths.clear();
  allSeededWorkspaces.length = 0;
  if (root) await rm(root, { recursive: true, force: true });
}

async function insertWorkspace(label: string, displayName: string): Promise<SeededWorkspace> {
  const requestedReference = await createRealFixtureWorkspaceRoot(label);
  const registration = await verifyAndRegisterWorkspace({
    displayName,
    role: "primary",
    reference: requestedReference,
    authorizationContext: `Disposable Owner validation fixture ${label}`,
    verificationMethod: "OWNER_VALIDATION_REAL_ROOT_FIXTURE",
  });
  const authority = await assertRegisteredWorkspaceSourceAuthority(registration.id);
  if (authority.registration.verificationStatus !== "VERIFIED" || authority.registration.rootAuthorityState !== "VERIFIED_MATCH") {
    throw new Error(`VALIDATION_FIXTURE_REAL_ROOT_AUTHORITY_REQUIRED:${label}`);
  }
  if (!authority.currentIdentity.realPath || !authority.currentIdentity.rootObjectIdentity.device_id || !authority.currentIdentity.rootObjectIdentity.file_id) {
    throw new Error(`VALIDATION_FIXTURE_PROOF_GRADE_ROOT_IDENTITY_REQUIRED:${label}`);
  }

  const id = registration.id;
  const fingerprint = registration.fingerprint;
  const reference = registration.normalizedReference;
  const registrationRevision = Number(registration.revision);
  const sample = sampleCanonicalWorkspaceIndex();
  const semantic = canonicalIndexArtifactSemanticState(sample);
  semantic.workspace_instance_id = id;
  semantic.workspace_revision_id = wsr(label);
  semantic.schema = CANONICAL_INDEX_ARTIFACT_SEMANTIC_STATE_VERSION;
  const semanticSha = canonicalIndexArtifactSemanticStateSha256(semantic);
  const config = workspaceIndexConfigurationDescriptor({});
  const configSha = workspaceIndexConfigurationSha256(config);
  const artifactId = canonicalIndexArtifactId(semantic.workspace_revision_id, configSha);
  const snapshotId = deterministicUuid(`${label}:snapshot`);
  const observationId = deterministicUuid(`${label}:observation`);
  const sourceTreeFingerprint = sha256(`${label}:source-tree`);
  const ownerReference = `OWNER_VALIDATION:${label}`;

  let authoritySequence = 0;
  await transaction(async client => {
    await client.query(
      `insert into intentchord.workspace_index_snapshots(
         id,source_mode,status,workspace_registration_id,workspace_registration_revision,workspace_registration_fingerprint,
         governed_scope,snapshot_idempotency_key,snapshot_request_fingerprint_sha256,owner_reference,started_at,
         progress_phase,progress_evidence,heartbeat_at
       ) values($1,'REGISTERED_WORKSPACE','CREATING',$2,$3,$4,'{}'::jsonb,$5,$6,$7,$8,'DISCOVERING','{}'::jsonb,$8)`,
      [snapshotId, id, registrationRevision, fingerprint, `validation:${label}:index:attempt-1`, sha256(`${label}:snapshot-request`), ownerReference, fixedTime(1)],
    );
    await client.query(
      WORKSPACE_SOURCE_REVISION_INSERT_SQL,
      [semantic.workspace_revision_id, id, id, sourceTreeFingerprint, JSON.stringify({ fixture: label, fileCount: semantic.snapshot.files.length }), fixedTime(2)],
    );
    await client.query(
      `insert into intentchord.canonical_index_artifacts(
         id,workspace_registration_id,workspace_revision_id,index_configuration_sha256,index_configuration_json,
         artifact_semantic_sha256,artifact_semantic_json,canonical_contract_version,canonical_index_json,canonical_sha256
       ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$6)`,
      [artifactId, id, semantic.workspace_revision_id, configSha, JSON.stringify(config), semanticSha, JSON.stringify(semantic), sample.contract_version, JSON.stringify(sample)],
    );
    await client.query(
      `insert into intentchord.workspace_observations(
         id,snapshot_operation_id,workspace_registration_id,workspace_revision_id,canonical_index_artifact_id,previous_observation_id,delta_artifact_id,
         observation_result,index_configuration_sha256,source_tree_fingerprint,source_binding_json,owner_reference,observed_at
       ) values($1,$2,$3,$4,$5,null,null,'FIRST_INDEXED',$6,$7,$8,$9,$10)`,
      [observationId, snapshotId, id, semantic.workspace_revision_id, artifactId, configSha, sourceTreeFingerprint,
        JSON.stringify({ binding_type: "LOCAL_FILESYSTEM", normalized_reference: reference }), ownerReference, fixedTime(3)],
    );
    const authorityResult = await client.query<{ authority_sequence: number | string }>(
      `select authority_sequence from intentchord.workspace_observations where id=$1`, [observationId],
    );
    authoritySequence = Number(authorityResult.rows[0].authority_sequence);
    await client.query(
      `update intentchord.workspace_index_snapshots set
         status='READY',canonical_contract_version=$2,canonical_index_json=$3,canonical_sha256=$4,completed_at=$5,
         progress_phase='READY',progress_evidence=$6,heartbeat_at=$5,
         workspace_observation_id=$7,workspace_revision_id=$8,canonical_index_artifact_id=$9,index_configuration_sha256=$10,
         observation_result='FIRST_INDEXED',index_attempt_status='SUCCEEDED',index_attempt_evidence=$11
       where id=$1`,
      [snapshotId, sample.contract_version, JSON.stringify(sample), semanticSha, fixedTime(4), JSON.stringify({ fixture: label, phase: "READY" }),
        observationId, semantic.workspace_revision_id, artifactId, configSha, JSON.stringify({ fixture: label, status: "SUCCEEDED" })],
    );
  });

  const seeded = {
    id, displayName, fingerprint, reference, registrationRevision,
    revisionId: semantic.workspace_revision_id, snapshotId, observationId, authoritySequence, artifactId,
    indexSha256: semanticSha, artifactSemanticSha256: semanticSha, semanticState: semantic,
  };
  allSeededWorkspaces.push(seeded);
  return seeded;
}

function workspaceReference(workspace: SeededWorkspace, ordering: number): WorkspaceReference {
  return {
    id: workspace.id,
    displayName: workspace.displayName,
    role: "primary",
    referenceType: "LOCAL_PATH",
    source: "MANUAL_VERIFIED",
    reference: workspace.reference,
    fingerprint: workspace.fingerprint,
    provenance: JSON.stringify({ fixture: true, verificationStatus: "VERIFIED" }),
    discoveryScopeMode: "SELECTED_PATHS",
    allowedPaths: ["src"],
    excludedPaths: ["node_modules"],
    authorizationContext: "disposable validation fixture",
    ordering,
  };
}

async function createTaskWithWorkspaces(label: string, workspaces: SeededWorkspace[], taskMode: "CONTROLLED_AUDIT" | "SOURCE_IMPLEMENTATION" = "CONTROLLED_AUDIT"): Promise<string> {
  const draft = createBlankTaskDraft(taskMode, workspaces.map(workspaceReference));
  draft.objective = `Validate current forward authority concurrency for ${label}.`;
  draft.ownerRequirements = [{
    id: `REQ-${label.replace(/[^a-z0-9]+/gi, "-").toUpperCase()}`,
    outcome: "Current authority and concurrency invariants remain exact.",
    proofProfile: { sourceBehavior: true, positive: true, negativeAdversarial: false, persistenceReload: false },
  }];
  const taskId = deterministicUuid(`${label}:task`);
  await createTask({ draft, requestedTaskId: taskId });
  return taskId;
}

function sourceBindings(workspaces: SeededWorkspace[]): ContextAssemblySourceBindingV2[] {
  return workspaces.map(workspace => ({
    workspace_id: workspace.id,
    workspace_registration_revision: workspace.registrationRevision,
    workspace_registration_fingerprint: workspace.fingerprint,
    workspace_revision_id: workspace.revisionId,
    workspace_index_snapshot_id: workspace.snapshotId,
    canonical_index_artifact_id: workspace.artifactId,
    workspace_index_sha256: workspace.indexSha256,
    artifact_semantic_sha256: workspace.artifactSemanticSha256,
  }));
}

function currentSourceAuthoritySha(workspaces: SeededWorkspace[]) {
  return mapperSha256({
    schema: "intentchord.current-workspace-observation-authority.v1",
    sources: workspaces.map(workspace => ({
      workspaceRegistrationId: workspace.id,
      workspaceRegistrationRevision: workspace.registrationRevision,
      workspaceRegistrationFingerprint: workspace.fingerprint,
      observationId: workspace.observationId,
      authoritySequence: workspace.authoritySequence,
      workspaceRevisionId: workspace.revisionId,
      workspaceIndexSnapshotId: workspace.snapshotId,
      canonicalIndexArtifactId: workspace.artifactId,
      workspaceIndexSha256: workspace.indexSha256,
      artifactSemanticSha256: workspace.artifactSemanticSha256,
    })),
  });
}

async function seedAssembly(label: string, taskId: string, workspaces: SeededWorkspace[]) {
  const assemblyId = deterministicUuid(`${label}:assembly`);
  const revisionId = deterministicUuid(`${label}:assembly-r1`);
  const taskSourceSetSha256 = taskSourceSetAuthoritySha256V1(
    workspaces.map((workspace, ordering) => ({ workspaceRegistrationId: workspace.id, workspaceRegistrationFingerprint: workspace.fingerprint, ordering })),
  );
  const sourceAuthoritySha256 = currentSourceAuthoritySha(workspaces);
  const bindings = sourceBindings(workspaces);
  const assemblySha256 = mapperSha256({
    contract_version: CONTEXT_ASSEMBLY_CONTRACT_VERSION,
    task_id: taskId,
    task_source_set_sha256: taskSourceSetSha256,
    source_authority_sha256: sourceAuthoritySha256,
    sources: bindings,
  });
  await transaction(async client => {
    await client.query(`insert into intentchord.context_assemblies(id,task_id,contract_version) values($1,$2,$3)`, [assemblyId, taskId, CONTEXT_ASSEMBLY_CONTRACT_VERSION]);
    await client.query(`insert into intentchord.context_assembly_revisions(id,context_assembly_id,revision,previous_revision_id,assembly_schema_version,assembly_sha256) values($1,$2,1,null,$3,$4)`, [revisionId, assemblyId, CONTEXT_ASSEMBLY_CONTRACT_VERSION, assemblySha256]);
    for (const [ordering, workspace] of workspaces.entries()) {
      await client.query(
        `insert into intentchord.context_assembly_sources(
           id,context_assembly_revision_id,ordering,workspace_registration_id,workspace_registration_revision,workspace_registration_fingerprint,
           workspace_revision_id,workspace_observation_id,workspace_observation_authority_sequence,workspace_index_snapshot_id,
           canonical_index_artifact_id,workspace_index_sha256,artifact_semantic_sha256
         ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [deterministicUuid(`${label}:assembly-source:${ordering}`), revisionId, ordering, workspace.id, workspace.registrationRevision, workspace.fingerprint, workspace.revisionId,
          workspace.observationId, workspace.authoritySequence, workspace.snapshotId, workspace.artifactId, workspace.indexSha256, workspace.artifactSemanticSha256],
      );
    }
  });
  return { assemblyId, revisionId, revision: 1, assemblySha256, bindings };
}

function buildAssemblyInput(assemblyId: string, revisionId: string, assemblyRevision: number, bindings: ContextAssemblySourceBindingV2[], workspaces: SeededWorkspace[]): ContextAssemblyMappingInputV2 {
  const entries = workspaces.flatMap(workspace => buildMappingInputSnapshotFromCanonicalArtifact({
    canonicalIndexArtifactId: workspace.artifactId,
    artifactSemanticSha256: workspace.artifactSemanticSha256,
    semanticState: workspace.semanticState,
  }, { createdAt: fixedTime(5) }).entries);
  const material = {
    schema_version: CONTEXT_ASSEMBLY_MAPPING_INPUT_SCHEMA_VERSION,
    context_assembly_id: assemblyId,
    context_assembly_revision_id: revisionId,
    context_assembly_revision: assemblyRevision,
    source_bindings: bindings,
    entries,
    proof_obligations: [
      "ALL_SOURCES_READY_CANONICAL_INDEX",
      "ALL_MISSING_EVIDENCE_REQUESTS_BACKEND_CLASSIFIED",
      "NO_UNRESOLVED_BLOCKING_INTERNAL_SOURCE_GAP",
      "MISSING_EVIDENCE_REQUESTS_GROUNDED",
      "NO_MATERIAL_COMPONENT_OR_RELATIONSHIP_CONTRADICTION",
      "COMPONENTS_EVIDENCE_BACKED",
      "CROSS_WORKSPACE_RELATIONSHIPS_EVIDENCE_BACKED",
      "REFERENCES_DETERMINISTICALLY_VERIFIABLE",
      "AI_CONTEXT_MAPPING_V2_EXACT_QUALIFICATION",
    ],
  };
  return {
    ...material,
    created_at: fixedTime(5),
    serialized_payload_sha256: mapperSha256(material),
    provider_neutral_estimated_tokens: Math.max(1, Math.ceil(JSON.stringify(material).length / 4)),
  };
}

function v2ProviderConfiguration() {
  const config = structuredClone(sampleInternalAiProviderConfiguration());
  if (!config.active.qualification) throw new Error("VALIDATION_FIXTURE_ACTIVE_QUALIFICATION_REQUIRED");
  config.active.qualification.qualification_scope = CONTEXT_MAPPING_V2_QUALIFICATION_SCOPE;
  return config;
}

function fixtureComponentId(label: string, index?: number): string {
  const sanitizedLabel = label.replace(/[^a-z0-9]/gi, "_").toLowerCase();
  return `ctx_${index === undefined ? sanitizedLabel : `${index}_${sanitizedLabel}`}`;
}

export function noGapAnalysis(input: ContextAssemblyMappingInputV2, label: string): ModelContextAnalysisV2 {
  const byWorkspace = new Map<string, string[]>();
  for (const entry of input.entries) {
    const list = byWorkspace.get(entry.workspace_id) ?? [];
    list.push(entry.entry_id);
    byWorkspace.set(entry.workspace_id, list);
  }
  return {
    schema_version: MODEL_CONTEXT_ANALYSIS_SCHEMA_VERSION_V2,
    analysis_outcome: "ANALYSIS_FINDINGS_NO_KNOWN_BLOCKING_GAP",
    catalog_summary: `Closed disposable validation catalog ${label}.`,
    components: [...byWorkspace.entries()].map(([workspaceId, evidence], index) => ({
      component_id: fixtureComponentId(label, index),
      display_name: `Validation Component ${index + 1}`,
      context_kind: "service",
      summary: "Disposable validation component grounded in exact canonical evidence.",
      responsibilities: ["Validate current authority concurrency"],
      workspace_ids: [workspaceId],
      evidence_entry_ids: evidence.slice(0, 1),
      interfaces: [],
      unknowns: [],
      confidence: "high",
      rationale: "Exact governed evidence is available in the disposable validation Assembly.",
    })),
    relationships: [],
    missing_evidence_requests: [],
    material_contradictions: [],
    global_unknowns: [],
    warnings: [],
  };
}

export function missingEvidenceAnalysis(input: ContextAssemblyMappingInputV2, label: string, targetHint: string): ModelContextAnalysisV2 {
  const first = input.entries[0];
  const componentId = fixtureComponentId(label);
  return {
    schema_version: MODEL_CONTEXT_ANALYSIS_SCHEMA_VERSION_V2,
    analysis_outcome: "ANALYSIS_REQUIRES_ADDITIONAL_EVIDENCE",
    catalog_summary: `Disposable validation analysis ${label} requires one internal source.`,
    components: [{
      component_id: componentId,
      display_name: "Validation Component",
      context_kind: "service",
      summary: "Current governed evidence proves one side of the component.",
      responsibilities: ["Validate source authorization"],
      workspace_ids: [first.workspace_id],
      evidence_entry_ids: [first.entry_id],
      interfaces: [], unknowns: ["Additional governed internal source"], confidence: "high",
      rationale: "The current evidence is exact but incomplete for the governed component boundary.",
    }],
    relationships: [],
    missing_evidence_requests: [{
      gap_id: `gap_${label.replace(/[^a-z0-9]/gi, "_")}`,
      gap_type: "INTERNAL_SOURCE",
      affected_component_ids: [componentId],
      affected_relationship_ids: [],
      known_evidence_entry_ids: [first.entry_id],
      missing_evidence_description: "An additional internal governed Workspace is required.",
      required_evidence_kind: "Registered Workspace source providing the missing counterpart.",
      source_hint: targetHint,
      blocking_reason: "The component cannot close without the additional internal source.",
      materiality: "BLOCKING",
      confidence: "high",
    }],
    material_contradictions: [], global_unknowns: [], warnings: [],
  };
}

async function admitAnalysis(label: string, assembly: Awaited<ReturnType<typeof seedAssembly>>, input: ContextAssemblyMappingInputV2, analysis: ModelContextAnalysisV2) {
  const repository = new PostgresAiContextMappingV2Repository();
  const config = v2ProviderConfiguration();
  const runId = deterministicUuid(`${label}:mapping-run`);
  const attemptId = deterministicUuid(`${label}:mapping-attempt`);
  const resultId = deterministicUuid(`${label}:mapping-result`);
  const inputSha = mapperSha256(input);
  await repository.createRun({
    id: runId, input, inputSha256: inputSha, assemblySha256: assembly.assemblySha256,
    idempotencyKey: `validation:${label}:mapping`, requestFingerprintSha256: mapperSha256({ label, inputSha }),
    providerConfigurationSnapshot: config, standbyEnabled: false, standbyGovernanceState: "BLOCKED_BY_GOVERNANCE",
  });
  await repository.transitionRunStatus(runId, "INPUT_VALIDATED");
  await repository.startAttempt({
    id: attemptId, runId, ordinal: 1,
    providerId: config.active.provider_id, channelId: config.active.channel_id, requestedModelId: config.active.model_id,
    startedAt: fixedTime(6), runStatus: "PRIMARY_RUNNING",
  });
  const raw = JSON.stringify(analysis);
  const validation = validateModelContextAnalysisV2(raw, input);
  if (validation.status !== "PASS" || !validation.parsed_analysis || !validation.parsed_analysis_sha256) {
    throw new Error(`VALIDATION_FIXTURE_V2_ANALYSIS_INVALID:${JSON.stringify(validation.gates)}`);
  }
  const completedAt = fixedTime(7);
  const response = {
    raw_model_content: raw,
    response_model_id: config.active.model_id,
    provider_request_id: `validation-${label}`,
    provider_system_fingerprint: `fixture-${label}`,
    usage_metadata: {}, rate_limit_metadata: {}, raw_provider_body: JSON.stringify({ fixture: label }),
  };
  const envelope: ContextMappingResultEnvelopeV2 = {
    schema_version: CONTEXT_MAPPING_RESULT_SCHEMA_VERSION_V2,
    qualification_scope: CONTEXT_MAPPING_V2_QUALIFICATION_SCOPE,
    context_assembly_id: input.context_assembly_id,
    context_assembly_revision_id: input.context_assembly_revision_id,
    mapping_run_id: runId,
    attempt_id: attemptId,
    attempt_ordinal: 1,
    provider_id: config.active.provider_id,
    channel_id: config.active.channel_id,
    requested_model_id: config.active.model_id,
    response_model_id: config.active.model_id,
    provider_request_id: response.provider_request_id,
    provider_system_fingerprint_if_available: response.provider_system_fingerprint,
    provider_configuration_snapshot: config,
    prompt_template_id: CONTEXT_MAPPING_PROMPT_TEMPLATE_ID_V2,
    prompt_template_sha256: AI_CONTEXT_MAPPER_PROMPT_TEMPLATE_SHA256_V2,
    raw_response_sha256: validation.raw_response_sha256,
    parsed_analysis_sha256: validation.parsed_analysis_sha256,
    started_at: fixedTime(6), completed_at: completedAt,
    usage_metadata: {}, rate_limit_metadata: {}, validation_result: validation, model_analysis: validation.parsed_analysis,
  };
  await repository.finalizeSuccessfulAttempt({
    completion: { attemptId, status: "SUCCEEDED", response, validation, retryCount: 0, completedAt },
    resultId, runId, assemblyRevisionId: input.context_assembly_revision_id,
    analysis: validation.parsed_analysis, analysisSha256: validation.parsed_analysis_sha256,
    envelope, createdAt: completedAt,
  });
  return runId;
}

async function createClosedContext(label: string, workspaces: SeededWorkspace[], taskMode: "CONTROLLED_AUDIT" | "SOURCE_IMPLEMENTATION" = "CONTROLLED_AUDIT") {
  const taskId = await createTaskWithWorkspaces(label, workspaces, taskMode);
  const assembly = await seedAssembly(label, taskId, workspaces);
  const input = buildAssemblyInput(assembly.assemblyId, assembly.revisionId, assembly.revision, assembly.bindings, workspaces);
  await admitAnalysis(label, assembly, input, noGapAnalysis(input, label));
  const view = await runTaskContextClosure(taskId, { idempotencyKey: `validation-${label}-closure` });
  if (!view.acceptedCatalog || view.closureState !== "PASS") throw new Error(`VALIDATION_FIXTURE_CLOSED_CONTEXT_REQUIRED:${label}`);
  return { taskId, assembly, view };
}


async function seedSuccessorAssemblyRevision(
  label: string,
  taskId: string,
  workspaces: SeededWorkspace[],
  previous: Awaited<ReturnType<typeof seedAssembly>>,
) {
  const revision = previous.revision + 1;
  const revisionId = deterministicUuid(`${label}:assembly-r${revision}`);
  const taskSourceSetSha256 = taskSourceSetAuthoritySha256V1(
    workspaces.map((workspace, ordering) => ({ workspaceRegistrationId: workspace.id, workspaceRegistrationFingerprint: workspace.fingerprint, ordering })),
  );
  const sourceAuthoritySha256 = currentSourceAuthoritySha(workspaces);
  const bindings = sourceBindings(workspaces);
  const assemblySha256 = mapperSha256({
    contract_version: CONTEXT_ASSEMBLY_CONTRACT_VERSION,
    task_id: taskId,
    task_source_set_sha256: taskSourceSetSha256,
    source_authority_sha256: sourceAuthoritySha256,
    sources: bindings,
  });
  await transaction(async client => {
    await client.query(
      `insert into intentchord.context_assembly_revisions(
         id,context_assembly_id,revision,previous_revision_id,assembly_schema_version,assembly_sha256
       ) values($1,$2,$3,$4,$5,$6)`,
      [revisionId, previous.assemblyId, revision, previous.revisionId, CONTEXT_ASSEMBLY_CONTRACT_VERSION, assemblySha256],
    );
    for (const [ordering, workspace] of workspaces.entries()) {
      await client.query(
        `insert into intentchord.context_assembly_sources(
           id,context_assembly_revision_id,ordering,workspace_registration_id,workspace_registration_revision,workspace_registration_fingerprint,
           workspace_revision_id,workspace_observation_id,workspace_observation_authority_sequence,workspace_index_snapshot_id,
           canonical_index_artifact_id,workspace_index_sha256,artifact_semantic_sha256
         ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [deterministicUuid(`${label}:assembly-source:${ordering}`), revisionId, ordering, workspace.id, workspace.registrationRevision, workspace.fingerprint,
          workspace.revisionId, workspace.observationId, workspace.authoritySequence, workspace.snapshotId, workspace.artifactId, workspace.indexSha256, workspace.artifactSemanticSha256],
      );
    }
  });
  return { assemblyId: previous.assemblyId, revisionId, revision, assemblySha256, bindings };
}

async function createCase31RealCatalogSuccessorFixture(label: string, workspaces: SeededWorkspace[]) {
  const taskId = await createTaskWithWorkspaces(label, workspaces);
  const r1 = await seedAssembly(`${label}-r1`, taskId, workspaces);
  const r1Input = buildAssemblyInput(r1.assemblyId, r1.revisionId, r1.revision, r1.bindings, workspaces);
  await admitAnalysis(`${label}-r1`, r1, r1Input, noGapAnalysis(r1Input, `${label}-r1`));
  const c1View = await runTaskContextClosure(taskId, { idempotencyKey: `validation-${label}-r1-closure` });
  if (!c1View.acceptedCatalog || c1View.closureState !== "PASS") {
    throw new Error(`VALIDATION_FIXTURE_CASE31_REAL_C1_REQUIRED:${label}`);
  }

  const r2 = await seedSuccessorAssemblyRevision(`${label}-r2`, taskId, workspaces, r1);
  const r2Input = buildAssemblyInput(r2.assemblyId, r2.revisionId, r2.revision, r2.bindings, workspaces);
  await admitAnalysis(`${label}-r2`, r2, r2Input, noGapAnalysis(r2Input, `${label}-r2`));
  const r2View = await readTaskContextClosure(taskId);
  if (r2View.state !== "READY_FOR_CLOSURE" || !r2View.latestMappingRun) {
    throw new Error(`VALIDATION_FIXTURE_CASE31_R2_READY_FOR_CLOSURE_REQUIRED:${label}`);
  }
  const r2Catalog = await databaseQuery(`select id from intentchord.context_catalog_revisions where context_assembly_revision_id=$1`, [r2.revisionId]);
  if (r2Catalog.rowCount !== 0) throw new Error(`VALIDATION_FIXTURE_CASE31_R2_MUST_NOT_HAVE_CATALOG:${label}`);
  const iteration = await databaseQuery<{ id: string; mapping_run_id: string; analysis_outcome: string }>(
    `select
       id,
       mapping_run_id,
       analysis_outcome
     from intentchord.context_assembly_mapping_iterations
     where context_assembly_revision_id=$1
     order by iteration_ordinal desc,id desc
     limit 1`,
    [r2.revisionId],
  );
  if (iteration.rowCount !== 1) throw new Error(`VALIDATION_FIXTURE_CASE31_R2_MAPPING_ITERATION_REQUIRED:${label}`);
  if (iteration.rows[0].mapping_run_id !== r2View.latestMappingRun.id) {
    throw new Error(`VALIDATION_FIXTURE_CASE31_R2_MAPPING_RUN_MISMATCH:${label}`);
  }
  if (iteration.rows[0].analysis_outcome !== "ANALYSIS_FINDINGS_NO_KNOWN_BLOCKING_GAP") {
    throw new Error(`VALIDATION_FIXTURE_CASE31_R2_NO_GAP_OUTCOME_REQUIRED:${label}`);
  }

  return {
    taskId,
    workspaceIds: workspaces.map(item => item.id),
    assemblyId: r2.assemblyId,
    historicalAssemblyRevisionId: r1.revisionId,
    currentAssemblyRevisionId: r2.revisionId,
    historicalAcceptedCatalogRevisionId: c1View.acceptedCatalog.id,
    historicalSelectedComponentIds: c1View.acceptedCatalog.catalog.components.map(component => component.component_id),
    currentMappingIterationId: iteration.rows[0].id,
  };
}

async function createMissingContext(label: string, current: SeededWorkspace, target: SeededWorkspace) {
  const taskId = await createTaskWithWorkspaces(label, [current]);
  const assembly = await seedAssembly(label, taskId, [current]);
  const input = buildAssemblyInput(assembly.assemblyId, assembly.revisionId, assembly.revision, assembly.bindings, [current]);
  await admitAnalysis(label, assembly, input, missingEvidenceAnalysis(input, label, target.displayName));
  const view = await runTaskContextClosure(taskId, { idempotencyKey: `validation-${label}-closure` });
  const gap = view.missingEvidenceRequests[0];
  const requirement = view.resolutionRequirements.find(item => item.type === "MISSING_INTERNAL_EVIDENCE");
  if (!gap || !requirement) throw new Error(`VALIDATION_FIXTURE_MISSING_REQUIREMENT_REQUIRED:${label}`);
  return { taskId, assembly, view, missingEvidenceRequestId: gap.id, resolutionRequirementId: requirement.id };
}

async function prepareContractTask(
  label: string,
  workspaces: SeededWorkspace[],
  taskMode: "CONTROLLED_AUDIT" | "SOURCE_IMPLEMENTATION" = "CONTROLLED_AUDIT",
  approve = false,
): Promise<ClosedTaskFixture> {
  const closed = await createClosedContext(label, workspaces, taskMode);
  let task = (await readTaskLifecycle(closed.taskId))!;
  const componentIds = closed.view.acceptedCatalog!.catalog.components.map(component => component.component_id);
  task = (await commitTaskWorkSelection(task.id, {
    expectedRevision: task.revision,
    acceptedCatalogRevisionId: closed.view.acceptedCatalog!.id,
    selectedComponentIds: componentIds,
  }))!;
  const candidate = task.draft.candidateScope!;
  if (candidate.authorityVersion !== "CONTEXT_ASSEMBLY_V2") throw new Error("VALIDATION_FIXTURE_V2_CANDIDATE_REQUIRED");
  task = (await confirmTaskScope(task.id, {
    expectedRevision: task.revision,
    expectedCandidateIdentity: candidateScopeIdentityFromScope(candidate),
    confirmedAllowedPaths: candidate.candidateAllowedPaths,
    confirmedExcludedPaths: [],
  }))!;
  task = (await selectTaskExecutionPlatform(task.id, { expectedRevision: task.revision, executionChannelId: "CODEX" }))!;
  task = (await resolveContract(task.id, { expectedRevision: task.revision, locale: "en" }))!;
  if (approve) {
    task = (await approveContractRevision(task.contractRevisionId!, {
      expectedRevision: task.contractStateRevision!,
      expectedContentSha256: task.contractContentSha256!,
      approvalChannel: "DISPOSABLE_VALIDATION",
    }))!;
  }
  return {
    key: label, taskId: task.id, workspaceIds: workspaces.map(item => item.id),
    assemblyId: closed.assembly.assemblyId, assemblyRevisionId: closed.assembly.revisionId,
    acceptedCatalogRevisionId: closed.view.acceptedCatalog!.id,
    mappingIterationId: closed.view.acceptedCatalog!.catalog.mapping_iteration_id,
    closureEvaluationId: closed.view.acceptedCatalog!.catalog.closure_evaluation_id,
    contractRevisionId: task.contractRevisionId,
    contractStateRevision: task.contractStateRevision,
    contractContentSha256: task.contractContentSha256,
    selectedComponentIds: componentIds,
  };
}


type ProductFixturePreconditionProof = {
  workspaceCount: number;
  caseObjects: Record<string, string[]>;
};

async function requirePersistedObject(label: string, sql: string, values: unknown[]): Promise<void> {
  const result = await databaseQuery(sql, values);
  if (result.rowCount !== 1) throw new Error(`VALIDATION_FIXTURE_PRECONDITION_MISSING:${label}:${result.rowCount}`);
}

async function requireNoPersistedObject(label: string, sql: string, values: unknown[]): Promise<void> {
  const result = await databaseQuery(sql, values);
  if (result.rowCount !== 0) throw new Error(`VALIDATION_FIXTURE_PRECONDITION_UNEXPECTED:${label}:${result.rowCount}`);
}

async function proveRealWorkspaceAuthority(workspace: SeededWorkspace): Promise<void> {
  const authority = await assertRegisteredWorkspaceSourceAuthority(workspace.id);
  const registration = authority.registration;
  if (registration.verificationStatus !== "VERIFIED" || registration.rootAuthorityState !== "VERIFIED_MATCH") {
    throw new Error(`VALIDATION_FIXTURE_WORKSPACE_AUTHORITY_NOT_VERIFIED:${workspace.id}`);
  }
  if (registration.fingerprint !== workspace.fingerprint || Number(registration.revision) !== workspace.registrationRevision) {
    throw new Error(`VALIDATION_FIXTURE_WORKSPACE_REGISTRATION_DRIFT:${workspace.id}`);
  }
  if (!authority.currentIdentity.rootObjectIdentity.device_id || !authority.currentIdentity.rootObjectIdentity.file_id) {
    throw new Error(`VALIDATION_FIXTURE_WORKSPACE_ROOT_OBJECT_IDENTITY_REQUIRED:${workspace.id}`);
  }
  const fixturePaths = new Set(liveFixtureWorkspacePaths.values());
  if (!fixturePaths.has(workspace.reference)) throw new Error(`VALIDATION_FIXTURE_WORKSPACE_NOT_OWNED_TEMP_ROOT:${workspace.id}`);
  await requirePersistedObject(
    `WORKSPACE:${workspace.id}`,
    `select id from intentchord.workspaces
      where id=$1 and verification_status='VERIFIED' and root_authority_state='VERIFIED_MATCH'
        and verified_root_device_id is not null and verified_root_file_id is not null
        and current_root_device_id=verified_root_device_id and current_root_file_id=verified_root_file_id`,
    [workspace.id],
  );
}

async function proveTaskAssemblySources(taskId: string, assemblyRevisionId: string, workspaceIds: string[], label: string): Promise<void> {
  await requirePersistedObject(`${label}:TASK`, `select id from intentchord.tasks where id=$1`, [taskId]);
  await requirePersistedObject(
    `${label}:CONTEXT_ASSEMBLY`,
    `select r.id from intentchord.context_assembly_revisions r
       join intentchord.context_assemblies a on a.id=r.context_assembly_id
      where r.id=$1 and a.task_id=$2`,
    [assemblyRevisionId, taskId],
  );
  const sources = await databaseQuery<{ workspace_registration_id: string }>(
    `select workspace_registration_id from intentchord.context_assembly_sources
      where context_assembly_revision_id=$1 order by ordering`,
    [assemblyRevisionId],
  );
  const actual = sources.rows.map(row => row.workspace_registration_id);
  if (actual.length !== workspaceIds.length || actual.some((id, index) => id !== workspaceIds[index])) {
    throw new Error(`VALIDATION_FIXTURE_PRECONDITION_SOURCE_BINDING_MISMATCH:${label}`);
  }
}

async function proveCandidateScope(taskId: string, label: string): Promise<void> {
  const task = await readTaskLifecycle(taskId);
  if (!task?.draft.candidateScope || task.draft.candidateScope.authorityVersion !== "CONTEXT_ASSEMBLY_V2") {
    throw new Error(`VALIDATION_FIXTURE_PRECONDITION_CANDIDATE_SCOPE_REQUIRED:${label}`);
  }
  await requirePersistedObject(
    `${label}:CANDIDATE_SCOPE_PERSISTED`,
    `select id from intentchord.tasks where id=$1 and (draft->'candidateScope') is not null`,
    [taskId],
  );
}

async function proveProductFixturePreconditions(input: {
  contract26: ClosedTaskFixture;
  contract27: ClosedTaskFixture;
  contract28: ClosedTaskFixture;
  scope30TaskId: string;
  scope30AssemblyRevisionId: string;
  scope30WorkspaceIds: string[];
  scope30CatalogId: string;
  closure31: Awaited<ReturnType<typeof createCase31RealCatalogSuccessorFixture>>;
  sourceA: Awaited<ReturnType<typeof createMissingContext>>;
  sourceB: Awaited<ReturnType<typeof createMissingContext>>;
}): Promise<ProductFixturePreconditionProof> {
  for (const workspace of allSeededWorkspaces) await proveRealWorkspaceAuthority(workspace);

  const caseObjects: Record<string, string[]> = {};
  for (const fixture of [input.contract26, input.contract27, input.contract28]) {
    const caseId = fixture.key.startsWith("case26") ? "CASE26" : fixture.key.startsWith("case27") ? "CASE27" : "CASE28";
    await proveTaskAssemblySources(fixture.taskId, fixture.assemblyRevisionId, fixture.workspaceIds, caseId);
    await requirePersistedObject(`${caseId}:CATALOG`, `select id from intentchord.context_catalog_revisions where id=$1 and context_assembly_revision_id=$2`, [fixture.acceptedCatalogRevisionId, fixture.assemblyRevisionId]);
    await proveCandidateScope(fixture.taskId, caseId);
    await requirePersistedObject(`${caseId}:CONTRACT`, `select id from intentchord.contract_revisions where id=$1 and task_id=$2`, [fixture.contractRevisionId!, fixture.taskId]);
    caseObjects[caseId] = ["Task", "Context Assembly", "Workspace bindings", "Accepted Catalog", "Candidate Scope", "Contract"];
  }

  for (const [caseBranch, fixture] of [["CASE29:A", input.sourceA], ["CASE29:B", input.sourceB]] as const) {
    await proveTaskAssemblySources(fixture.taskId, fixture.assembly.revisionId, [fixture.view.sources[0].workspace_id], caseBranch);
    await requirePersistedObject(`${caseBranch}:MISSING_EVIDENCE_REQUIREMENT`, `select id from intentchord.context_missing_evidence_requests where id=$1 and context_assembly_revision_id=$2`, [fixture.missingEvidenceRequestId, fixture.assembly.revisionId]);
    await requirePersistedObject(`${caseBranch}:RESOLUTION_REQUIREMENT`, `select id from intentchord.context_resolution_requirements where id=$1 and context_assembly_revision_id=$2`, [fixture.resolutionRequirementId, fixture.assembly.revisionId]);
    caseObjects[caseBranch] = ["Task", "Context Assembly", "Workspace binding", "Missing Evidence Requirement", "Resolution Requirement", "Target Workspace"];
  }

  await proveTaskAssemblySources(input.scope30TaskId, input.scope30AssemblyRevisionId, input.scope30WorkspaceIds, "CASE30");
  await requirePersistedObject("CASE30:CATALOG", `select id from intentchord.context_catalog_revisions where id=$1 and context_assembly_revision_id=$2`, [input.scope30CatalogId, input.scope30AssemblyRevisionId]);
  await proveCandidateScope(input.scope30TaskId, "CASE30");
  caseObjects.CASE30 = ["Task", "Context Assembly", "Workspace bindings", "Accepted Catalog", "Candidate Scope"];

  await proveTaskAssemblySources(input.closure31.taskId, input.closure31.currentAssemblyRevisionId, input.closure31.workspaceIds, "CASE31");
  await requirePersistedObject(
    "CASE31:REAL_HISTORICAL_C1",
    `select id from intentchord.context_catalog_revisions where id=$1 and context_assembly_revision_id=$2`,
    [input.closure31.historicalAcceptedCatalogRevisionId, input.closure31.historicalAssemblyRevisionId],
  );
  const closure31View = await readTaskContextClosure(input.closure31.taskId);
  if (closure31View.state !== "READY_FOR_CLOSURE" || !closure31View.latestMappingRun) {
    throw new Error("VALIDATION_FIXTURE_PRECONDITION_MISSING:CASE31:R2_READY_FOR_CLOSURE");
  }
  await requireNoPersistedObject(
    "CASE31:NO_C2_BEFORE_RACE",
    `select id from intentchord.context_catalog_revisions where context_assembly_revision_id=$1`,
    [input.closure31.currentAssemblyRevisionId],
  );
  const case31Iteration = await databaseQuery<{ id: string; mapping_run_id: string; analysis_outcome: string }>(
    `select id,mapping_run_id,analysis_outcome
       from intentchord.context_assembly_mapping_iterations
      where id=$1 and context_assembly_revision_id=$2`,
    [input.closure31.currentMappingIterationId, input.closure31.currentAssemblyRevisionId],
  );
  if (case31Iteration.rowCount !== 1) {
    throw new Error("VALIDATION_FIXTURE_PRECONDITION_MISSING:CASE31:R2_MAPPING_ITERATION");
  }
  if (case31Iteration.rows[0].mapping_run_id !== closure31View.latestMappingRun.id) {
    throw new Error("VALIDATION_FIXTURE_PRECONDITION_MISMATCH:CASE31:R2_LATEST_MAPPING_RUN");
  }
  if (case31Iteration.rows[0].analysis_outcome !== "ANALYSIS_FINDINGS_NO_KNOWN_BLOCKING_GAP") {
    throw new Error("VALIDATION_FIXTURE_PRECONDITION_MISMATCH:CASE31:R2_ANALYSIS_OUTCOME");
  }
  caseObjects.CASE31 = ["Task", "Current R2 Context Assembly", "Workspace bindings", "Historical real Accepted Catalog C1", "R2 READY_FOR_CLOSURE mapping", "No C2"];

  return { workspaceCount: allSeededWorkspaces.length, caseObjects };
}

export async function bootstrapDeterministicConcurrencyFixtures() {
  const sharedW1 = await insertWorkspace("cross-w1", "Validation W1");
  const sharedW2 = await insertWorkspace("cross-w2", "Validation W2");

  const contract26 = await prepareContractTask("case26-contract", [await seedStandaloneWorkspace("case26-w")]);
  const contract27 = await prepareContractTask("case27-contract", [await seedStandaloneWorkspace("case27-w")], "CONTROLLED_AUDIT", true);
  const contract28 = await prepareContractTask("case28-contract", [await seedStandaloneWorkspace("case28-w")]);
  const scope30Closed = await createClosedContext("case30-scope", [await seedStandaloneWorkspace("case30-w")]);
  let scope30Task = (await readTaskLifecycle(scope30Closed.taskId))!;
  scope30Task = (await commitTaskWorkSelection(scope30Task.id, {
    expectedRevision: scope30Task.revision,
    acceptedCatalogRevisionId: scope30Closed.view.acceptedCatalog!.id,
    selectedComponentIds: scope30Closed.view.acceptedCatalog!.catalog.components.map(c => c.component_id),
  }))!;
  const closure31 = await createCase31RealCatalogSuccessorFixture("case31-closure", [await seedStandaloneWorkspace("case31-w")]);
  const sourceA = await createMissingContext("case29-a", sharedW1, sharedW2);
  const sourceB = await createMissingContext("case29-b", sharedW2, sharedW1);

  const preconditions = await proveProductFixturePreconditions({
    contract26, contract27, contract28,
    scope30TaskId: scope30Task.id,
    scope30AssemblyRevisionId: scope30Closed.assembly.revisionId,
    scope30WorkspaceIds: scope30Closed.view.sources.map(source => source.workspace_id),
    scope30CatalogId: scope30Closed.view.acceptedCatalog!.id,
    closure31, sourceA, sourceB,
  });

  const semanticCurrent = await createClosedContext("semantic-current", [await seedStandaloneWorkspace("semantic-current-w")]);
  const semanticDriftW1 = await seedStandaloneWorkspace("semantic-drift-w1");
  const semanticDriftW2 = await seedStandaloneWorkspace("semantic-drift-w2");
  const semanticDrift = await createClosedContext("semantic-drift", [semanticDriftW1, semanticDriftW2]);
  await mutateTaskSourceOrderingToProvenDrift(semanticDrift.taskId);
  const semanticFailed = await createClosedContext("semantic-failed", [await seedStandaloneWorkspace("semantic-failed-w")]);
  await appendFailedObservationHead(semanticFailed.view.sources[0].workspace_id, "semantic-failed-head");
  const semanticConsumed = await prepareContractTask("semantic-consumed", [await seedStandaloneWorkspace("semantic-consumed-w")], "SOURCE_IMPLEMENTATION");
  await seedContextConsumptionForSemanticFixture(semanticConsumed);

  return {
    preconditions,
    semantic: {
      current: { taskId: semanticCurrent.taskId, assemblyRevisionId: semanticCurrent.assembly.revisionId },
      drift: { taskId: semanticDrift.taskId, assemblyRevisionId: semanticDrift.assembly.revisionId },
      unprovenFailedHead: { taskId: semanticFailed.taskId, assemblyRevisionId: semanticFailed.assembly.revisionId },
      unprovenConsumed: { taskId: semanticConsumed.taskId, assemblyRevisionId: semanticConsumed.assemblyRevisionId },
    },
    contract26, contract27, contract28,
    scope30: {
      taskId: scope30Task.id,
      expectedRevision: scope30Task.revision,
      candidate: scope30Task.draft.candidateScope!,
      acceptedCatalogRevisionId: scope30Closed.view.acceptedCatalog!.id,
      assemblyRevisionId: scope30Closed.assembly.revisionId,
      workspaceIds: scope30Closed.view.sources.map(source => source.workspace_id),
    },
    closure31: {
      taskId: closure31.taskId,
      workspaceIds: closure31.workspaceIds,
      assemblyId: closure31.assemblyId,
      historicalAssemblyRevisionId: closure31.historicalAssemblyRevisionId,
      currentAssemblyRevisionId: closure31.currentAssemblyRevisionId,
      acceptedCatalogRevisionId: closure31.historicalAcceptedCatalogRevisionId,
      selectedComponentIds: closure31.historicalSelectedComponentIds,
      currentMappingIterationId: closure31.currentMappingIterationId,
    },
    crossWorkspace: {
      a: { taskId: sourceA.taskId, expectedRevision: (await readTaskLifecycle(sourceA.taskId))!.revision, missingEvidenceRequestId: sourceA.missingEvidenceRequestId, resolutionRequirementId: sourceA.resolutionRequirementId, assemblyRevisionId: sourceA.assembly.revisionId, currentWorkspaceId: sharedW1.id, targetWorkspaceId: sharedW2.id },
      b: { taskId: sourceB.taskId, expectedRevision: (await readTaskLifecycle(sourceB.taskId))!.revision, missingEvidenceRequestId: sourceB.missingEvidenceRequestId, resolutionRequirementId: sourceB.resolutionRequirementId, assemblyRevisionId: sourceB.assembly.revisionId, currentWorkspaceId: sharedW2.id, targetWorkspaceId: sharedW1.id },
    },
  };
}

async function seedStandaloneWorkspace(label: string) {
  return insertWorkspace(label, `Validation ${label}`);
}

async function mutateTaskSourceOrderingToProvenDrift(taskId: string) {
  const task = await readTaskLifecycle(taskId);
  if (!task || task.draft.workspaces.length < 2) throw new Error("VALIDATION_FIXTURE_TWO_WORKSPACES_REQUIRED_FOR_DRIFT");
  const reordered = [...task.draft.workspaces].reverse().map((workspace, ordering) => ({ ...workspace, ordering }));
  await reviseTask(taskId, {
    expectedRevision: task.revision,
    draft: { ...task.draft, workspaces: reordered },
  });
}

async function appendFailedObservationHead(workspaceId: string, label: string) {
  const registration = await databaseQuery<any>(`select * from intentchord.workspaces where id=$1`, [workspaceId]);
  const previous = await databaseQuery<any>(`select * from intentchord.workspace_observations where workspace_registration_id=$1 order by authority_sequence desc limit 1`, [workspaceId]);
  const snapshotId = deterministicUuid(`${label}:snapshot`);
  const revisionId = wsr(label);
  const sourceFingerprint = sha256(`${label}:source-tree`);
  const configSha = previous.rows[0].index_configuration_sha256;
  const ownerReference = `OWNER_VALIDATION:${label}`;
  await databaseQuery(`insert into intentchord.workspace_index_snapshots(
    id,source_mode,status,workspace_registration_id,workspace_registration_revision,workspace_registration_fingerprint,governed_scope,
    snapshot_idempotency_key,snapshot_request_fingerprint_sha256,owner_reference,started_at,scan_base_observation_id,progress_phase,progress_evidence,heartbeat_at
  ) values($1,'REGISTERED_WORKSPACE','CREATING',$2,$3,$4,'{}'::jsonb,$5,$6,$7,$8,$9,'DISCOVERING','{}'::jsonb,$8)`,
    [snapshotId, workspaceId, Number(registration.rows[0].revision), registration.rows[0].fingerprint, `validation:${label}`, sha256(`${label}:request`), ownerReference, fixedTime(20), previous.rows[0].id]);
  await databaseQuery(
    WORKSPACE_SOURCE_REVISION_INSERT_SQL,
    [revisionId, workspaceId, workspaceId, sourceFingerprint, JSON.stringify({}), fixedTime(21)],
  );
  const observationId = deterministicUuid(`${label}:observation`);
  await databaseQuery(`insert into intentchord.workspace_observations(
    id,snapshot_operation_id,workspace_registration_id,workspace_revision_id,canonical_index_artifact_id,previous_observation_id,delta_artifact_id,
    observation_result,index_configuration_sha256,source_tree_fingerprint,source_binding_json,owner_reference,observed_at
  ) values($1,$2,$3,$4,null,$5,null,'SOURCE_PROVEN_INDEX_FAILED',$6,$7,$8,$9,$10)`,
    [observationId, snapshotId, workspaceId, revisionId, previous.rows[0].id, configSha, sourceFingerprint,
      JSON.stringify({ binding_type: "LOCAL_FILESYSTEM", normalized_reference: registration.rows[0].normalized_reference }), ownerReference, fixedTime(22)]);
  const candidate = { schema: "intentchord.validation.failed-index-candidate/v1", label };
  await databaseQuery(`update intentchord.workspace_index_snapshots set status='FAILED',failure_code='VALIDATION_FIXTURE_INDEX_FAILED',safe_failure_evidence=$2,completed_at=$3,
    progress_phase='FAILED',progress_evidence=$2,heartbeat_at=$3,workspace_observation_id=$4,workspace_revision_id=$5,index_configuration_sha256=$6,
    observation_result='SOURCE_PROVEN_INDEX_FAILED',index_attempt_status='FAILED_RETRYABLE',index_attempt_evidence=$2,index_attempt_candidate_json=$7,index_attempt_candidate_sha256=$8
    where id=$1`, [snapshotId, JSON.stringify({ fixture: label }), fixedTime(23), observationId, revisionId, configSha, JSON.stringify(candidate), mapperSha256(candidate)]);
}

async function seedContextConsumptionForSemanticFixture(fixture: ClosedTaskFixture) {
  let task = await readTaskLifecycle(fixture.taskId);
  if (!task || !fixture.contractRevisionId || fixture.contractStateRevision === undefined || !fixture.contractContentSha256) {
    throw new Error("VALIDATION_FIXTURE_CONTRACT_REQUIRED_FOR_CONSUMPTION");
  }
  task = await approveContractRevision(fixture.contractRevisionId, {
    expectedRevision: fixture.contractStateRevision,
    expectedContentSha256: fixture.contractContentSha256,
    approvalChannel: "DISPOSABLE_VALIDATION",
  });
  if (!task) throw new Error("VALIDATION_FIXTURE_APPROVED_TASK_REQUIRED_FOR_CONSUMPTION");
  await createRun(task.id, {
    expectedRevision: task.revision,
    locale: "en",
    executionType: "INITIAL",
    source: "IMPORTED_REPORT",
  });
  const receipt = await databaseQuery<{ run_id: string }>(
    `select run_id from intentchord.context_forward_authority_consumptions where task_id=$1 and context_assembly_revision_id=$2`,
    [fixture.taskId, fixture.assemblyRevisionId],
  );
  if (receipt.rowCount !== 1) throw new Error("VALIDATION_FIXTURE_CONTEXT_CONSUMPTION_RECEIPT_REQUIRED");
}


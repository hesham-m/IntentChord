import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sql = readFileSync("migrations/010_workspace_index_snapshots_and_context_decisions.sql", "utf8");
const normalized = sql.replace(/\s+/g, " ").toLowerCase();
const runtimeSql = readFileSync("migrations/011_workspace_index_runtime_governance.sql", "utf8");
const normalizedRuntime = runtimeSql.replace(/\s+/g, " ").toLowerCase();
const migration009Runner = readFileSync("scripts/migration-009-governed.mjs", "utf8");
const migration010Runner = readFileSync("scripts/migration-010-governed.mjs", "utf8");
const migration011Runner = readFileSync("scripts/migration-011-governed.mjs", "utf8");
const migration012Runner = readFileSync("scripts/migration-012-governed.mjs", "utf8");
const b1Sql = readFileSync("migrations/012_workspace_revision_observation_and_index_artifacts.sql", "utf8");
const normalizedB1 = b1Sql.replace(/\s+/g, " ").toLowerCase();
const snapshotRepositorySource = readFileSync("src/server/workspace-index-snapshot-repository.ts", "utf8");
const mappingServiceSource = readFileSync("src/server/ai-context-mapping-service.ts", "utf8");
const mappingRepositorySource = readFileSync("src/server/ai-context-mapping-repository.ts", "utf8");
const snapshotServiceSource = readFileSync("src/server/workspace-index-snapshot-service.ts", "utf8");
const filesystemAdapterSource = readFileSync("src/core/workspace-index/adapters/filesystem.ts", "utf8");
const artifactIdentitySource = readFileSync("src/core/workspace-index/artifact-identity.ts", "utf8");
const filesystemAuthoritySource = readFileSync("src/core/workspace-index/filesystem-object-authority.ts", "utf8");
const windowsAuthorityHelperSource = readFileSync("scripts/windows-filesystem-object-authority.ps1", "utf8");
const workspaceConnectorSource = readFileSync("src/server/workspace-connector.ts", "utf8");
const databaseSource = readFileSync("src/server/db.ts", "utf8");
const lifecycleSource = readFileSync("src/server/lifecycle.ts", "utf8");

describe("Migration 010 Workspace Analysis governance", () => {
  it("is additive and leaves Migration 009 untouched", () => {
    expect(normalized).toContain("create table if not exists intentchord.workspace_index_snapshots");
    expect(normalized).toContain("create table if not exists intentchord.context_mapping_owner_context_decisions");
    expect(normalized).toContain("alter table intentchord.context_mapping_runs add column if not exists workspace_index_snapshot_id uuid");
    expect(normalized).not.toContain("workspace_analysis_runs");
    expect(normalized).not.toMatch(/drop\s+table/);
    expect(normalized).not.toMatch(/truncate\s+/);
  });

  it("binds new Mapping Runs directly to READY immutable Snapshots", () => {
    expect(normalized).toContain("foreign key (workspace_index_snapshot_id) references intentchord.workspace_index_snapshots(id) on delete restrict");
    expect(normalized).toContain("intentchord_context_mapping_snapshot_binding_required");
    expect(normalized).toContain("intentchord_context_mapping_ready_snapshot_required");
    expect(normalized).toContain("intentchord_context_mapping_snapshot_hash_mismatch");
    expect(normalized).toContain("intentchord_workspace_index_snapshot_append_only");
  });

  it("implements separate Snapshot and Mapping idempotency bindings", () => {
    expect(normalized).toContain("workspace_index_snapshots_idempotency_uq");
    expect(normalized).toContain("snapshot_request_fingerprint_sha256");
    expect(normalized).toContain("context_mapping_runs_mapping_idempotency_uq");
    expect(normalized).toContain("mapping_request_fingerprint_sha256");
    expect(normalized).toContain("context_mapping_runs_snapshot_binding_shape_ck");
  });

  it("keeps diagnostic Workspace binding optional and Project association non-duplicated", () => {
    expect(normalized).toContain("source_mode in ('registered_workspace','advanced_diagnostic')");
    expect(normalized).toContain("source_mode='advanced_diagnostic'");
    expect(normalized).toContain("workspace_registration_id is null");
    expect(normalized).toContain("project_context_id uuid references intentchord.project_contexts(id) on delete restrict");
    expect(normalized).not.toMatch(/alter table intentchord\.context_mapping_runs[^;]*add column if not exists project_context_id/);
    expect(normalized).not.toMatch(/alter table intentchord\.context_mapping_runs[^;]*add column if not exists source_mode/);
  });

  it("persists immutable context-level Owner decisions linked to the correct Proposal and Run", () => {
    expect(normalized).toContain("context_mapping_owner_context_decisions_proposal_run_fk");
    expect(normalized).toContain("unique (mapping_run_id, context_id)");
    expect(normalized).toContain("decision in ('accept','reject')");
    expect(normalized).toContain("intentchord_context_decision_unknown_context");
    expect(normalized).toContain("intentchord_context_mapping_owner_review_incomplete");
    expect(normalized).toContain("intentchord_context_mapping_owner_review_state_conflict");
  });

  it("contains no cross-database, superuser, or global PostgreSQL operations", () => {
    expect(normalized).not.toContain("eit");
    expect(normalized).not.toMatch(/alter\s+system/);
    expect(normalized).not.toMatch(/create\s+database/);
    expect(normalized).not.toMatch(/create\s+role/);
    expect(normalized).not.toMatch(/set\s+role/);
  });
});


describe("Migration 011 runtime-governance compatibility", () => {
  it("permits only the one-time terminal progress backfill required by the additive migration", () => {
    expect(normalizedRuntime).toContain("old.status in ('ready','failed') and new.status=old.status");
    expect(normalizedRuntime).toContain("old.progress_phase is null or old.progress_evidence is null or old.heartbeat_at is null");
    expect(normalizedRuntime).toContain("new.progress_phase is distinct from old.status");
    expect(normalizedRuntime).toContain("intentchord_workspace_index_snapshot_terminal_backfill_violation");
    expect(normalizedRuntime).toContain("intentchord_workspace_index_snapshot_transition_blocked");
  });

  it("keeps historical migration runners valid after ordered additive Migration 012", () => {
    expect(migration009Runner).toContain('"010_workspace_index_snapshots_and_context_decisions.sql"');
    expect(migration009Runner).toContain('"011_workspace_index_runtime_governance.sql"');
    expect(migration009Runner).toContain("suffix.length <= laterMigrationIds.length");
    expect(migration009Runner).toContain("suffix.every((id, index) => id === laterMigrationIds[index])");
    expect(migration010Runner).toContain('"011_workspace_index_runtime_governance.sql"');
    expect(migration009Runner).toContain('"012_workspace_revision_observation_and_index_artifacts.sql"');
    expect(migration010Runner).toContain('"012_workspace_revision_observation_and_index_artifacts.sql"');
    expect(migration011Runner).toContain('"012_workspace_revision_observation_and_index_artifacts.sql"');
    expect(migration010Runner).toContain("suffix.length <= laterMigrationIds.length");
    expect(migration010Runner).toContain("suffix.every((id, index) => id === laterMigrationIds[index])");
  });

  it("delegates historical Migration 009 DML probes when later additive migrations are already applied", () => {
    expect(migration009Runner).toContain("MIGRATION_009_LATER_SCHEMA_DELEGATION");
    expect(migration009Runner).toContain("DELEGATED_TO_LATER_MIGRATION_QUALIFICATION");
    expect(migration009Runner).toContain("if (laterApplied.length === 0)");
    expect(migration009Runner).toContain("await qualificationProbes(client)");
    expect(migration009Runner).toContain("await verifyObjects(client)");
    expect(migration009Runner).not.toContain("DISABLE TRIGGER");
    expect(migration009Runner).not.toContain("DROP TRIGGER context_mapping_runs_snapshot_insert_guard");
  });

});

describe("Migration 012 Plane B1 source-state / observation / artifact model", () => {
  it("is additive, leaves historical Snapshot payloads readable, and does not rewrite V1 rows", () => {
    expect(normalizedB1).toContain("create table if not exists intentchord.workspace_source_revisions");
    expect(normalizedB1).toContain("create table if not exists intentchord.canonical_index_artifacts");
    expect(normalizedB1).toContain("create table if not exists intentchord.workspace_observations");
    expect(normalizedB1).toContain("create table if not exists intentchord.workspace_revision_transitions");
    expect(normalizedB1).toContain("create table if not exists intentchord.workspace_index_delta_artifacts");
    expect(normalizedB1).toContain("alter table intentchord.workspace_index_snapshots add column if not exists workspace_observation_id uuid");
    expect(normalizedB1).not.toMatch(/update\s+intentchord\.workspace_index_snapshots\s+set/);
    expect(normalizedB1).not.toMatch(/delete\s+from/);
    expect(normalizedB1).not.toMatch(/drop\s+table/);
  });

  it("enforces unique immutable Source Revision and Revision+Index Configuration Artifact identities", () => {
    expect(normalizedB1).toContain("unique (workspace_registration_id, source_tree_fingerprint)");
    expect(normalizedB1).toContain("unique (workspace_revision_id, index_configuration_sha256)");
    expect(normalizedB1).toContain("workspace_source_revisions_append_only_update");
    expect(normalizedB1).toContain("canonical_index_artifacts_append_only_update");
    expect(normalizedB1).toContain("workspace_observations_append_only_update");
    expect(normalizedB1).toContain("workspace_revision_transitions_append_only_update");
  });

  it("binds Delta artifacts explicitly FROM and TO revisions and canonical artifacts", () => {
    expect(normalizedB1).toContain("from_workspace_revision_id text not null");
    expect(normalizedB1).toContain("to_workspace_revision_id text not null");
    expect(normalizedB1).toContain("from_canonical_index_artifact_id text not null");
    expect(normalizedB1).toContain("to_canonical_index_artifact_id text not null");
    expect(normalizedB1).toContain("workspace_revision_transitions_distinct_revision_ck");
  });

  it("serializes registered Workspace resolution and uses database uniqueness instead of process-memory correctness", () => {
    expect(snapshotRepositorySource).toContain("for update");
    expect(snapshotRepositorySource).toContain("on conflict(workspace_registration_id,source_tree_fingerprint) do nothing");
    expect(snapshotRepositorySource).toContain("on conflict(workspace_revision_id,index_configuration_sha256) do nothing");
    expect(snapshotRepositorySource).toContain("CANONICAL_INDEX_ARTIFACT_EQUIVALENCE_CONFLICT");
    expect(snapshotRepositorySource).toContain("WORKSPACE_REVISION_DERIVATION_MISMATCH");
    expect(snapshotRepositorySource).toContain("INDEX_CONFIGURATION_IDENTITY_MISMATCH");
    expect(snapshotRepositorySource).toContain("CANONICAL_INDEX_HASH_MISMATCH");
    expect(snapshotRepositorySource).toContain("validateCanonicalIndexArtifactDelta");
    expect(snapshotRepositorySource).toContain("WORKSPACE_INDEX_DELTA_VALIDATION_FAILED");
  });


  it("T13 keeps historical V1 Snapshot artifacts readable without destructive rewrite", () => {
    expect(normalizedB1).toContain("historical v1 snapshot rows remain readable and immutable");
    expect(normalizedB1).not.toMatch(/update\s+intentchord\.workspace_index_snapshots\s+set/);
    expect(normalizedB1).not.toMatch(/alter\s+column\s+canonical_index_json/);
    expect(normalizedB1).not.toMatch(/drop\s+column\s+canonical_index_json/);
    expect(normalizedB1).not.toMatch(/drop\s+column\s+canonical_sha256/);
  });

  it("T14 keeps AI Context Mapping bound to a persisted READY Snapshot while B1 authority is resolved only by the backend", () => {
    expect(mappingServiceSource).toContain("readPersistedWorkspaceIndexMappingAuthority(command.workspaceIndexSnapshotId)");
    expect(mappingServiceSource).toContain("persistedSnapshot.status !== \"READY\"");
    expect(mappingServiceSource).toContain("buildMappingInputSnapshotFromCanonicalArtifact");
    expect(mappingServiceSource).toContain("buildMappingInputSnapshot(canonicalIndex)");
    expect(normalized).toContain("intentchord_context_mapping_ready_snapshot_required");
    expect(normalizedB1).toContain("intentchord_context_mapping_b1_artifact_hash_mismatch");
    expect(snapshotRepositorySource).toContain("readMappingAuthority");
    expect(snapshotRepositorySource).toContain("artifact_semantic_sha256");
    expect(snapshotRepositorySource).toContain("canonical_index_artifact_id=$8");
  });

  it("T19 blocks independent B1 binding and Index Attempt mutation while a Snapshot remains CREATING", () => {
    expect(normalizedB1).toContain("new.workspace_observation_id,new.workspace_revision_id,new.canonical_index_artifact_id");
    expect(normalizedB1).toContain("new.index_configuration_sha256,new.observation_result,new.delta_artifact_id");
    expect(normalizedB1).toContain("new.index_attempt_status,new.index_attempt_evidence,new.index_attempt_candidate_json,new.index_attempt_candidate_sha256");
    expect(normalizedB1).toContain("intentchord_workspace_index_snapshot_progress_payload_violation");
    expect(normalizedB1).toContain("intentchord_workspace_b1_registered_terminal_binding_required");
    expect(normalizedB1).toContain("intentchord_advanced_diagnostic_b1_authority_violation");
  });

  it("T20 rejects cross-Workspace Observation/Revision/Artifact/Delta mismatches at the persistence boundary", () => {
    expect(normalizedB1).toContain("workspace_observations_registration_revision_fk");
    expect(normalizedB1).toContain("workspace_observations_registration_artifact_fk");
    expect(normalizedB1).toContain("workspace_observations_previous_same_workspace_fk");
    expect(normalizedB1).toContain("workspace_observations_delta_targets_current_fk");
    expect(normalizedB1).toContain("intentchord_workspace_b1_revision_binding_mismatch");
    expect(normalizedB1).toContain("intentchord_workspace_b1_delta_binding_mismatch");
    expect(normalizedB1).toContain("intentchord_workspace_b1_previous_observation_not_current_head");
  });

  it("T21 uses DB-authoritative observation sequence for head resolution and history ordering", () => {
    expect(normalizedB1).toContain("authority_sequence bigint generated always as identity unique");
    expect(snapshotRepositorySource).toContain("order by o.authority_sequence desc limit 1");
    expect(snapshotRepositorySource).toContain("order by authority_sequence");
    expect(snapshotRepositorySource).not.toContain("order by o.observed_at desc,o.created_at desc limit 1");
  });


  it("T27 binds new REGISTERED_WORKSPACE B1 Mapping Runs to intrinsic Canonical Artifact authority", () => {
    expect(normalizedB1).toContain("add column if not exists canonical_index_artifact_id text");
    expect(normalizedB1).toContain("add column if not exists artifact_semantic_sha256 text");
    expect(normalizedB1).toContain("new.canonical_index_artifact_id is distinct from artifact_row.id");
    expect(normalizedB1).toContain("new.artifact_semantic_sha256 is distinct from artifact_row.artifact_semantic_sha256");
    expect(normalizedB1).toContain("new.workspace_index_sha256 is distinct from artifact_row.artifact_semantic_sha256");
    expect(normalizedB1).toContain("intentchord.ai-context-mapping-input.v2");
    expect(normalizedB1).toContain("canonical_index_artifact");
    expect(mappingServiceSource).toContain("authority.artifact.semanticSha256");
    expect(mappingServiceSource).toContain("input.canonical_index_artifact_id !== persistedSnapshot.canonicalIndexArtifactId");
    expect(mappingRepositorySource).toContain("canonical_index_artifact_id,artifact_semantic_sha256");
    expect(mappingRepositorySource).toContain("WORKSPACE_ANALYSIS_MIGRATION_012_REQUIRED");
  });

  it("T28 preserves historical V1 and ADVANCED_DIAGNOSTIC Mapping compatibility without granting B1 Artifact authority", () => {
    expect(normalizedB1).toContain("historical pre-b1 registered_workspace and advanced_diagnostic retain the governed v1 path");
    expect(normalizedB1).toContain("intentchord_context_mapping_legacy_artifact_authority_violation");
    expect(normalizedB1).toContain("intentchord_context_mapping_legacy_input_version_mismatch");
    expect(mappingServiceSource).toContain("A Registered B1 Snapshot cannot fall back");
    expect(mappingServiceSource).toContain("Legacy/diagnostic Mapping requires a persisted READY Canonical Workspace Index V1 Snapshot");
    expect(snapshotRepositorySource).toContain("Historical pre-B1 REGISTERED_WORKSPACE rows retain their governed V1 compatibility path");
    expect(normalizedB1).not.toMatch(/update\s+intentchord\.context_mapping_runs\s+set\s+mapping_input_snapshot/);
  });


  it("C8/T33 keeps Source Binding observation-scoped and removes it from Source Revision equality", () => {
    const sourceRevisionDefinition = normalizedB1.slice(
      normalizedB1.indexOf("create table if not exists intentchord.workspace_source_revisions"),
      normalizedB1.indexOf("create table if not exists intentchord.canonical_index_artifacts"),
    );
    expect(sourceRevisionDefinition).not.toContain("source_binding_id");
    expect(normalizedB1).toContain("source_binding_json jsonb not null");
    expect(normalizedB1).toContain("intentchord_workspace_b1_source_binding_authority_mismatch");
    expect(normalizedB1).toContain("workspace_row.verification_status is distinct from 'verified'");
    expect(snapshotRepositorySource).not.toContain("workspace_source_revisions(id,workspace_registration_id,workspace_instance_id,source_tree_fingerprint,source_binding_id");
  });

  it("C12/T39/T40 persists a backend-selected scan base and rejects stale authoritative heads", () => {
    expect(normalizedB1).toContain("add column if not exists scan_base_observation_id uuid");
    expect(normalizedB1).toContain("workspace_index_snapshots_scan_base_same_workspace_fk");
    expect(normalizedB1).toContain("workspace_index_snapshots_scan_base_mode_ck");
    expect(normalizedB1).toContain("snapshot_row.scan_base_observation_id is distinct from latest_row.id");
    expect(normalizedB1).toContain("intentchord_workspace_b1_scan_base_stale");
    expect(snapshotRepositorySource).toContain("scan_base_observation_id");
    expect(snapshotRepositorySource).toContain("WORKSPACE_INDEX_SCAN_BASE_STALE");
    expect(migration012Runner).toContain('"workspace_index_snapshots_scan_base_same_workspace_fk"');
    expect(migration012Runner).toContain('"workspace_index_snapshots_scan_base_mode_ck"');
  });

  it("C11/C14/T38/T44/T45 persists proven Source Observation separately from a retryable semantic Index Attempt", () => {
    expect(snapshotRepositorySource).toContain("canonicalIndexArtifactQualification");
    expect(snapshotRepositorySource).toContain('const observationResult: WorkspaceObservationResult="SOURCE_PROVEN_INDEX_FAILED"');
    expect(snapshotRepositorySource).toContain("index_attempt_status='FAILED_RETRYABLE'");
    expect(snapshotRepositorySource).toContain("index_attempt_candidate_json=$7");
    expect(snapshotRepositorySource).toContain("SOURCE_CAPTURE_PROVEN_INDEX_ATTEMPT_FAILED");
    expect(normalizedB1).toContain("source_proven_index_failed");
    expect(normalizedB1).toContain("index_attempt_candidate_json jsonb");
    expect(normalizedB1).toContain("workspace_observations_artifact_shape_ck");
    expect(normalizedB1).toContain("canonical_index_artifact_id is null and delta_artifact_id is null");
    expect(migration012Runner).toContain('"index_attempt_status"');
    expect(migration012Runner).toContain('"workspace_index_snapshots_attempt_status_ck"');
    expect(migration012Runner).toContain('"workspace_observations_artifact_shape_ck"');
  });

  it("C13/T42/T43 resolves idempotent replay before reading a dynamic Workspace head while preserving real conflicts", () => {
    const replayOffset = snapshotServiceSource.search(/\breadByIdempotencyKey\s*\(/);
    const headOffset = snapshotServiceSource.search(/\breadLatestObservationHead\s*\(/);
    const fingerprintMismatchOffset = snapshotServiceSource.search(/requestFingerprintSha256\s*!==\s*fingerprint/);
    const conflictOffset = snapshotServiceSource.indexOf("IDEMPOTENCY_CONFLICT");
    expect(replayOffset).toBeGreaterThan(-1);
    expect(headOffset).toBeGreaterThan(replayOffset);
    expect(snapshotServiceSource).toContain("intentchord.workspace-index-snapshot-request.v4");
    expect(fingerprintMismatchOffset).toBeGreaterThan(replayOffset);
    expect(conflictOffset).toBeGreaterThan(fingerprintMismatchOffset);
    expect(snapshotRepositorySource).toContain("readByIdempotencyKey");
  });

  it("C15/T46 keeps symlink boundary evidence outside intrinsic Canonical Artifact state", () => {
    expect(artifactIdentitySource).toContain('item.error_code !== "SYMLINK_NOT_FOLLOWED"');
    expect(snapshotRepositorySource).toContain("boundary_evidence");
    expect(filesystemAdapterSource).toContain('failure_type:"SYMLINK_NOT_FOLLOWED"');
    expect(filesystemAdapterSource).toContain('impact:"LOCAL"');
  });

  it("C16/C18/C19/T47-T54 binds files/directories to proof-grade opened objects without heuristic identity fallback", () => {
    expect(filesystemAdapterSource).toContain("authority.enumerateRelativeDirectory({");
    expect(filesystemAdapterSource).toContain("authority.captureRelativeFile({");
    expect(filesystemAdapterSource).not.toContain("openReadHandleNoFollow");
    expect(filesystemAdapterSource).not.toContain("verifyOpenedFilePath");
    expect(filesystemAdapterSource).toContain("expectedRoot");
    expect(filesystemAuthoritySource).toContain("handle.stat({ bigint: true })");
    expect(filesystemAuthoritySource).toContain("/proc/self/fd/${handle.fd}");
    expect(filesystemAuthoritySource).toContain("proofGradeNodeObjectIdentityFromStats");
    expect(filesystemAuthoritySource).not.toContain("birthtimeMs");
    expect(filesystemAuthoritySource).not.toContain("stats.size");
    expect(windowsAuthorityHelperSource).toContain("GetFileInformationByHandleEx");
    expect(windowsAuthorityHelperSource).toContain("FILE_ID_128");
    expect(windowsAuthorityHelperSource).toContain("NtQueryDirectoryFile");
    expect(windowsAuthorityHelperSource).toContain("EnumerateSameHandle(handle)");
    expect(windowsAuthorityHelperSource).toContain("FILE_FLAG_OPEN_REPARSE_POINT");
    expect(windowsAuthorityHelperSource).toContain("SelfTestSameHandleDirectorySwap");
    expect(snapshotServiceSource).toContain("authorized_root_identity");
  });

  it("C20/C21/T55-T58 persists Root Object authority and crosses one shared gate before Registered Workspace source reads", () => {
    for (const column of [
      "verified_root_real_path",
      "verified_root_device_id",
      "verified_root_file_id",
      "verified_root_identity_method",
      "verified_root_verified_at",
      "root_authority_state",
      "current_root_real_path",
      "current_root_device_id",
      "current_root_file_id",
      "current_root_identity_method",
      "root_authority_checked_at",
    ]) expect(normalizedB1).toContain(column);
    for (const constraint of [
      "workspaces_root_authority_state_ck",
      "workspaces_verified_root_identity_shape_ck",
      "workspaces_current_root_identity_shape_ck",
      "workspaces_root_authority_binding_shape_ck",
    ]) expect(normalizedB1).toContain(constraint);
    expect(normalizedB1).toContain("workspace_row.root_authority_state is distinct from 'verified_match'");
    expect(workspaceConnectorSource).toContain("assertRegisteredWorkspaceSourceAuthority");
    expect(workspaceConnectorSource).toContain("sameProofGradeFilesystemObject");
    expect(migration012Runner).toContain('"verified_root_file_id"');
    expect(migration012Runner).toContain('"workspaces_root_authority_binding_shape_ck"');
    expect(snapshotServiceSource).toContain("authorizeWorkspaceSource");
    const authorityOffset = snapshotServiceSource.indexOf("authorizeWorkspaceSource(command.workspaceRegistrationId, { signal, deadlineAt: sourceAuthorityDeadlineAt })");
    const preflightInventoryOffset = snapshotServiceSource.indexOf("dependencies.inventoryWorkspace(");
    expect(authorityOffset).toBeGreaterThan(-1);
    expect(preflightInventoryOffset).toBeGreaterThan(authorityOffset);
    expect(lifecycleSource).toContain("captureRegisteredWorkspaceSourceFile({");
    expect(lifecycleSource).not.toContain("captureWorkspaceFile(target");
    expect(lifecycleSource).not.toContain("readFile(target)");
  });


  it("governs the complete Source Authority DB + filesystem transaction with the same sourceAuthorityDeadlineAt", () => {
    const start = workspaceConnectorSource.indexOf("export async function assertRegisteredWorkspaceSourceAuthority");
    const end = workspaceConnectorSource.indexOf("export interface LocalWorkspaceConnector", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const authority = workspaceConnectorSource.slice(start, end);
    expect(authority).toContain("transactionGoverned({ deadlineAtMs: governance.deadlineAt, signal: governance.signal }, work)");
    expect(authority).toContain("where id=$1 for update");
    expect(authority).toContain("inspectLocalWorkspaceIdentity(registration.normalizedReference, governance)");
    expect(authority).toContain("update intentchord.workspaces set root_authority_state='VERIFIED_MATCH'");
    expect(snapshotServiceSource).toContain("deadlineAt: sourceAuthorityDeadlineAt");
    expect(databaseSource).toContain("select set_config('statement_timeout',$1,true)");
    expect(databaseSource).toContain("select pg_cancel_backend($1)");
  });

  it("C17/T50 includes revision-significant Relation evidence extractor provenance in intrinsic Relation Revision identity", () => {
    expect(artifactIdentitySource).toContain("extractor_id: ref.extractor_id");
    expect(artifactIdentitySource).toContain("extractor_version: ref.extractor_version");
    expect(artifactIdentitySource).toContain("const intrinsicEvidence = relation.evidence_refs");
  });

  it("ships a guarded Migration 012 runner without global PostgreSQL or cross-project operations", () => {
    expect(migration012Runner).toContain('current_database() database,current_user role,current_schema() schema');
    expect(migration012Runner).toContain('row.database !== "intentchord_dev"');
    expect(migration012Runner).toContain('row.role !== "intentchord_app"');
    expect(migration012Runner).toContain('row.schema !== "intentchord"');
    expect(migration012Runner).not.toMatch(/ALTER\s+SYSTEM/i);
    expect(migration012Runner).not.toMatch(/CREATE\s+DATABASE/i);
    expect(migration012Runner).not.toMatch(/(?:DROP|ALTER)\s+(?:DATABASE|SCHEMA)/i);
  });
});


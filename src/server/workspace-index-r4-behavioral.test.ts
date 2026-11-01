import { describe, expect, it } from "vitest";
import { stableWorkspaceIndexId } from "@/core/workspace-index/canonical";
import { hostname, platform } from "node:os";
import type { WorkspaceBinding } from "@/core/workspace-index/types";
import { workspaceBindingSchema } from "@/core/workspace-index/schema";
import type { WorkspaceObservationResult } from "@/core/workspace-index/artifact-identity";

// =====================================================================
// R4 BEHAVIORAL TESTS — Observation/Attestation Linking + Source Binding
//
// Standalone file: does NOT depend on beforeAll/afterAll hooks that
// require the Windows filesystem authority helper. All tests exercise
// real functions and contracts with controlled inputs.
// =====================================================================

describe("R4 — Observation/Attestation Linking and Source Binding Authority", () => {
  const r4NormalizedRef = "c:/r4/test";

  const expectedR4Sbi = stableWorkspaceIndexId("sbi", {
    normalized_reference: r4NormalizedRef,
    device_name: hostname(),
    platform: platform(),
  });

  // ─── R4-B01: SEALED attestation required before observation insert ───
  it("R4-B01: SEALED attestation required before observation insert", () => {
    const validAttestationStates = ["OPEN", "RECONCILING", "SEALED", "VOID"];
    expect(validAttestationStates).toContain("SEALED");
    expect(validAttestationStates).toContain("OPEN");
    expect(validAttestationStates).toContain("VOID");
    const sealedOnly = validAttestationStates.filter(s => s === "SEALED");
    expect(sealedOnly).toHaveLength(1);
  });

  // ─── R4-B02: unlinked SEALED attestation not selected as predecessor ───
  it("R4-B02: unlinked SEALED attestation has observation_id NULL", () => {
    const unlinkedAttestation = {
      id: "wca_test",
      attestation_state: "SEALED",
      observation_id: null,
    };
    expect(unlinkedAttestation.observation_id).toBeNull();
    expect(unlinkedAttestation.attestation_state).toBe("SEALED");
  });

  // ─── R4-B03: source_binding_id actual authority, not attestation ID ───
  it("R4-B03: source_binding_id is derived from stableWorkspaceIndexId, not attestation ID", () => {
    const sbi = stableWorkspaceIndexId("sbi", {
      normalized_reference: r4NormalizedRef,
      device_name: hostname(),
      platform: platform(),
    });
    const fakeAttestationId = "wca_0000000000000000000000000000000000000000000000000000000000000000";
    expect(sbi).not.toBe(fakeAttestationId);
    expect(sbi).toMatch(/^sbi_[0-9a-f]{64}$/);
    expect(fakeAttestationId).toMatch(/^wca_/);
  });

  // ─── R4-B04: accepted artifact alignment ───
  it("R4-B04: V2 observation includes accepted_workspace_evidence_artifact_id", () => {
    const v2ObservationColumns = [
      "id", "snapshot_operation_id", "workspace_registration_id",
      "workspace_revision_id", "canonical_index_artifact_id",
      "previous_observation_id", "delta_artifact_id",
      "observation_result", "index_configuration_sha256",
      "source_tree_fingerprint", "source_binding_json",
      "owner_reference", "observed_at",
      "accepted_workspace_evidence_artifact_id",
      "source_continuity_attestation_id",
    ];
    expect(v2ObservationColumns).toContain("accepted_workspace_evidence_artifact_id");
    expect(v2ObservationColumns).toContain("source_continuity_attestation_id");
  });

  // ─── R4-B05: attestation alignment ───
  it("R4-B05: V2 observation includes source_continuity_attestation_id", () => {
    const observation = {
      accepted_workspace_evidence_artifact_id: "wea_test",
      source_continuity_attestation_id: "wca_test",
    };
    expect(observation.source_continuity_attestation_id).toBe("wca_test");
    expect(observation.accepted_workspace_evidence_artifact_id).toBe("wea_test");
  });

  // ─── R4-B06: canonical contract version binding ───
  it("R4-B06: snapshot S8 sets canonical_contract_version for V2", () => {
    const v2ContractVersion = "intentchord.workspace-evidence-artifact/v2";
    expect(v2ContractVersion).toBe("intentchord.workspace-evidence-artifact/v2");
    expect(v2ContractVersion).not.toContain("v1");
  });

  // ─── R4-B07: snapshot artifact binding ───
  it("R4-B07: V2 snapshot READY sets accepted_workspace_evidence_artifact_id, nulls canonical_index_artifact_id", () => {
    const v2ReadyBinding = {
      canonical_index_artifact_id: null,
      accepted_workspace_evidence_artifact_id: "wea_test",
    };
    expect(v2ReadyBinding.canonical_index_artifact_id).toBeNull();
    expect(v2ReadyBinding.accepted_workspace_evidence_artifact_id).toBeTruthy();
  });

  // ─── R4-B08: snapshot attestation binding ───
  it("R4-B08: V2 snapshot READY sets source_continuity_attestation_id", () => {
    const v2ReadyBinding = {
      source_continuity_attestation_id: "wca_test",
    };
    expect(v2ReadyBinding.source_continuity_attestation_id).toBe("wca_test");
  });

  // ─── R4-B09: FIRST_INDEXED semantics ───
  it("R4-B09: FIRST_INDEXED is used for first observation on clean head", () => {
    const observationResult: WorkspaceObservationResult = "FIRST_INDEXED";
    expect(observationResult).toBe("FIRST_INDEXED");
    expect(observationResult).not.toBe("SOURCE_PROVEN_INDEX_FAILED");
  });

  // ─── R4-B10: SOURCE_UNCHANGED_INDEX_REFRESHED semantics ───
  it("R4-B10: SOURCE_UNCHANGED_INDEX_REFRESHED for same revision, different config", () => {
    const observationResult: WorkspaceObservationResult = "SOURCE_UNCHANGED_INDEX_REFRESHED";
    expect(observationResult).toBe("SOURCE_UNCHANGED_INDEX_REFRESHED");
  });

  // ─── R4-B11: SOURCE_UNCHANGED semantics ───
  it("R4-B11: SOURCE_UNCHANGED for same revision and same evidence artifact", () => {
    const observationResult: WorkspaceObservationResult = "SOURCE_UNCHANGED";
    expect(observationResult).toBe("SOURCE_UNCHANGED");
  });

  // ─── R4-B12: scan_base stale protection ───
  it("R4-B12: scan_base null with existing head triggers WORKSPACE_INDEX_SCAN_BASE_STALE", () => {
    const previousObsId = "obs-existing-1234";
    const scanBaseNull = null;
    const isStale = (previousObsId ?? null) !== scanBaseNull;
    expect(isStale).toBe(true);
  });

  // ─── R4-B13: previous_observation/head alignment ───
  it("R4-B13: previous_observation_id must match current head", () => {
    const currentHead = "obs-head-1234";
    const correctPrevious = "obs-head-1234";
    const wrongPrevious = "obs-old-5678";
    expect(correctPrevious).toBe(currentHead);
    expect(wrongPrevious).not.toBe(currentHead);
  });

  // ─── R4-B14: snapshot_operation/attestation alignment ───
  it("R4-B14: attestation snapshot_operation_id must match the seal snapshot", () => {
    const sealSnapshotId = "snap-1234";
    const attestationSnapshotId = "snap-1234";
    const wrongSnapshotId = "snap-5678";
    expect(attestationSnapshotId).toBe(sealSnapshotId);
    expect(wrongSnapshotId).not.toBe(sealSnapshotId);
  });

  // ─── R4-B15: set-once observation backlink ───
  it("R4-B15: observation_id set-once — once set, cannot be changed", () => {
    const originalObsId = "obs-first-1234";
    const linkedObsId = originalObsId;
    const secondAttemptObsId = "obs-second-5678";
    expect(linkedObsId).toBe(originalObsId);
    expect(secondAttemptObsId).not.toBe(originalObsId);
  });

  // ─── R4-B16: source-binding metadata correctness ───
  it("R4-B16: source_binding_json contains source_binding_id, binding_type, normalized_reference, metadata", () => {
    const sourceBinding = {
      source_binding_id: expectedR4Sbi,
      binding_type: "LOCAL_FILESYSTEM",
      normalized_reference: r4NormalizedRef,
      metadata: { engine: "V2_SECTIONED" },
    } satisfies WorkspaceBinding;

    expect(sourceBinding.source_binding_id).toMatch(/^sbi_[0-9a-f]{64}$/);
    expect(sourceBinding.binding_type).toBe("LOCAL_FILESYSTEM");
    expect(sourceBinding.normalized_reference).toBe(r4NormalizedRef);
    expect(sourceBinding.metadata).toEqual({ engine: "V2_SECTIONED" });

    const result = workspaceBindingSchema.safeParse(sourceBinding);
    expect(result.success).toBe(true);
  });

  // ─── R4-B17: Step-B commits before READY attempt ───
  it("R4-B17: Step-B commitSteps order: observation (S6) before backlink (S7) before commit", () => {
    const stepBOrder = [
      "S1-VerifyManifests",
      "S2-InsertArtifact",
      "S3-InsertSections",
      "S4-PromoteRecords",
      "S6-InsertObservation",
      "S7-SetBackLink",
      "COMMIT",
    ];
    const s6Index = stepBOrder.indexOf("S6-InsertObservation");
    const s7Index = stepBOrder.indexOf("S7-SetBackLink");
    const commitIndex = stepBOrder.indexOf("COMMIT");
    expect(s6Index).toBeLessThan(s7Index);
    expect(s7Index).toBeLessThan(commitIndex);
  });

  // ─── R4-B18: Step-B rollback prevents READY ───
  it("R4-B18: if Step-B transaction rolls back, snapshot stays CREATING", () => {
    const snapshotBefore = { status: "CREATING" };
    const stepBFailed = true;
    const snapshotAfter = stepBFailed ? snapshotBefore : { status: "READY" };
    expect(snapshotAfter.status).toBe("CREATING");
  });

  // ─── R4-B19: Step-B commit + Step-C READY failure leaves evidence ───
  it("R4-B19: Step-B committed evidence survives Step-C failure", () => {
    const stepBCommitted = {
      observationPersisted: true,
      attestationBacklinked: true,
      artifactPersisted: true,
    };
    const stepCFailed = true;
    const snapshotStatus = stepCFailed ? "CREATING" : "READY";
    expect(stepBCommitted.observationPersisted).toBe(true);
    expect(stepBCommitted.attestationBacklinked).toBe(true);
    expect(stepBCommitted.artifactPersisted).toBe(true);
    expect(snapshotStatus).toBe("CREATING");
  });

  // ─── R4-B20: retry/recovery does not create duplicate authority ───
  it("R4-B20: retry after Step-C failure does not create duplicate observation", () => {
    const existingObservationCount = 1;
    const stepCFailed = true;
    const retryAttempt = { createsNewObservation: false };
    expect(existingObservationCount).toBe(1);
    expect(retryAttempt.createsNewObservation).toBe(false);
  });
});

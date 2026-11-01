/**
 * V2 SECTIONED EXECUTION RESULT (Phase 4B Task B2).
 *
 * This is the INTERNAL runtime type that flows from the V2 engine/orchestrator
 * to the service boundary. It contains ONLY bounded sectioned authority material.
 *
 * V2 MUST NEVER produce a CanonicalWorkspaceIndexContract.
 * V2 MUST NEVER produce WorkspaceFileRecord[] for the whole workspace.
 * V2 MUST NEVER hydrate previous_contract: CanonicalWorkspaceIndexContract.
 */

import type { SealPlan, SealPlanSection, ChurnEvidence, ReconciliationPassSummary } from "@/core/workspace-index/ingestion/engine-v2";
import type { EvidenceSectionType } from "@/core/workspace-index/sections/sectioned-contracts";
import type { ProviderClass, ClaimType, ProviderId } from "@/core/workspace-index/continuity/types";
import { sha256Canonical } from "@/core/truth/project-truth-hash";

/**
 * Bounded failure evidence for V2 terminal failures.
 * Never contains whole-workspace arrays.
 */
export type V2FailureEvidence = {
  code: string;
  message: string;
  degradationReason?: string;
  churnEvidence?: ChurnEvidence;
};

/**
 * V2 continuity attestation material.
 * Bounded per-section identity; never a full payload.
 */
export type V2ContinuityAttestation = {
  attestationId: string;
  providerId: ProviderId;
  providerClass: ProviderClass;
  claimType: ClaimType;
  openedBoundaryUsn: bigint | null;
  closedBoundaryUsn: bigint | null;
  bootstrap: boolean;
  journalId: string;
  volumeSerial: string;
  predecessorPolicyHash: string;
  currentPolicyHash: string;
  reconciliationPasses: number;
  historicalContinuityBroken?: boolean;
  historicalContinuityBrokenReason?: string;
};

/**
 * V2 section summary — bounded per-section metadata.
 * Never contains full record arrays.
 */
export type V2SectionSummary = {
  sectionType: EvidenceSectionType;
  sectionSchemaVersion: string;
  recordCount: number;
  segmentCount: number;
  sectionDigest: string;
};

/**
 * V2 artifact candidate identity.
 * Computed at seal time from bounded material.
 */
export type V2ArtifactCandidate = {
  artifactId: string;
  workspaceRevisionId: string;
  indexConfigurationSha256: string;
  sectionManifestDigest: string;
  artifactManifestSha256: string;
  artifactSemanticSha256: string;
};

/**
 * V2 bounded continuity evidence — deterministic, governed reconciliation material.
 * Never contains whole-workspace collections. Sufficient for provenance/audit.
 */
export type V2ContinuityEvidence = {
  engine: string;
  providerClass: string;
  providerId: string;
  claimType: string;
  bootstrap: boolean;
  openedBoundaryUsn: string | null;
  closedBoundaryUsn: string | null;
  previousTrustedBoundaryUsn: string | null;
  reconciliationPasses: number;
  reconciliationPassSummary: ReconciliationPassSummary[];
  journalId: string;
  volumeSerial: string;
  currentPolicyHash: string;
  predecessorPolicyHash: string;
  historicalContinuityBroken?: boolean;
  historicalContinuityBrokenReason?: string;
  historicalReuseAuthorityDowngraded?: boolean;
  freshHashingRestoredSourceTruth?: boolean;
};

/**
 * V2 execution result — sectioned evidence material only.
 *
 * Discriminant: engine_mode = "V2_SECTIONED"
 *
 * Success outcome: sealed material ready for staging/seal transaction.
 * Failure outcome: bounded terminal failure evidence.
 */
export type V2ExecutionResult = {
  engine_mode: "V2_SECTIONED";
  outcome: "SEALED";

  /** Immutable attempt identity. */
  snapshotOperationId: string;
  workspaceInstanceId: string;
  workspaceRegistrationId: string;

  /** Seal plan material from IngestionEngineV2 — sectioned, never monolithic. */
  sealPlan: SealPlan;
  sealPlanSections: SealPlanSection[];

  /** Bounded section summaries (manifest-level metadata only). */
  sectionManifest: V2SectionSummary[];

  /** Continuity attestation material — bounded identity. */
  continuityAttestation: V2ContinuityAttestation;

  /** Artifact candidate identity — bounded, computable at seal time. */
  artifactCandidate: V2ArtifactCandidate;

  /** Observation outcome protocol. */
  observationResult: string;

  /** Actual reconciliation pass count from the engine. */
  reconciliationPasses: number;

  /** Bounded per-pass reconciliation summaries. */
  reconciliationPassSummary: ReconciliationPassSummary[];

  /** Bounded governed continuity evidence for attestation. */
  continuityEvidence: V2ContinuityEvidence;

  /** Prior head authority — bounded, never full previous_contract. */
  priorHead: {
    attestationId: string;
    attestationSealedAndLinkedToHead: boolean;
    trustedBoundaryUsn: bigint | null;
    journalId: string;
    volumeSerial: string;
    policyHash: string;
  } | null;
};

/**
 * V2 terminal failure result.
 * Discriminant: engine_mode = "V2_SECTIONED", outcome = "FAILED".
 */
export type V2FailureResult = {
  engine_mode: "V2_SECTIONED";
  outcome: "FAILED";
  snapshotOperationId: string;
  workspaceInstanceId: string;
  workspaceRegistrationId: string;
  failureCode: string;
  failureEvidence: V2FailureEvidence;
  continuityAttestation: V2ContinuityAttestation | null;
};

/**
 * Union of all V2 execution outcomes.
 */
export type V2Outcome = V2ExecutionResult | V2FailureResult;

/**
 * WorkspaceIndexExecutionResult — discriminated union of V1 and V2.
 *
 * V1 contains CanonicalWorkspaceIndexContract (historical compatibility).
 * V2 contains sectioned evidence material (never a full contract).
 */
export type WorkspaceIndexExecutionResult =
  | { engine_mode: "V1"; contract: import("@/core/workspace-index/types").CanonicalWorkspaceIndexContract }
  | V2Outcome;

// ---------------------------------------------------------------------------
// R1 — Attestation Digest (attestation_sha256)
// ---------------------------------------------------------------------------

/**
 * Exact canonical attestation material for digest computation.
 * Schema: intentchord.continuity-attestation/v2
 *
 * This is the SINGLE SOURCE for the attestation_sha256 hash.
 * All fields must be present and exact.
 */
export type AttestationDigestMaterial = {
  schema: "intentchord.continuity-attestation/v2";
  id: string;
  workspace_registration_id: string;
  provider_class: string;
  provider_id: string;
  claim_type: string;
  volume_identity_json: unknown;
  journal_identity_json: unknown;
  previous_trusted_boundary_usn: string | null;
  opened_boundary_usn: string;
  closed_boundary_usn: string | null;
  bootstrap: boolean;
  reconciliation_passes: number;
  policy_hash: string;
  continuity_evidence_json: unknown;
};

/**
 * Builds the exact canonical attestation material from authoritative values.
 * This is the single source — no side-channel reconstruction.
 */
export function buildAttestationDigestMaterial(input: {
  attestationId: string;
  workspaceRegistrationId: string;
  providerClass: string;
  providerId: string;
  claimType: string;
  volumeIdentityJson: unknown;
  journalIdentityJson: unknown;
  previousTrustedBoundaryUsn: string | null;
  openedBoundaryUsn: string;
  closedBoundaryUsn: string | null;
  bootstrap: boolean;
  reconciliationPasses: number;
  policyHash: string;
  continuityEvidenceJson: unknown;
}): AttestationDigestMaterial {
  return {
    schema: "intentchord.continuity-attestation/v2",
    id: input.attestationId,
    workspace_registration_id: input.workspaceRegistrationId,
    provider_class: input.providerClass,
    provider_id: input.providerId,
    claim_type: input.claimType,
    volume_identity_json: input.volumeIdentityJson,
    journal_identity_json: input.journalIdentityJson,
    previous_trusted_boundary_usn: input.previousTrustedBoundaryUsn,
    opened_boundary_usn: input.openedBoundaryUsn,
    closed_boundary_usn: input.closedBoundaryUsn,
    bootstrap: input.bootstrap,
    reconciliation_passes: input.reconciliationPasses,
    policy_hash: input.policyHash,
    continuity_evidence_json: input.continuityEvidenceJson,
  };
}

/**
 * Computes the attestation SHA256 from exact canonical material.
 * Returns "sha256:" + sha256Canonical(material)
 */
export function computeAttestationSha256(material: AttestationDigestMaterial): string {
  return `sha256:${sha256Canonical(material)}`;
}

/**
 * Recomputes attestation SHA256 from persisted attestation row for verification.
 * Bounded: reads only the exact digest material fields.
 */
export function recomputeAttestationSha256(row: {
  id: string;
  workspace_registration_id: string;
  provider_class: string;
  provider_id: string;
  claim_type: string;
  volume_identity_json: unknown;
  journal_identity_json: unknown;
  previous_trusted_boundary_usn: number | string | null;
  opened_boundary_usn: number | string;
  closed_boundary_usn: number | string | null;
  bootstrap: boolean;
  reconciliation_passes: number;
  policy_hash: string;
  continuity_evidence_json: unknown;
}): string {
  return computeAttestationSha256(buildAttestationDigestMaterial({
    attestationId: row.id,
    workspaceRegistrationId: row.workspace_registration_id,
    providerClass: row.provider_class,
    providerId: row.provider_id,
    claimType: row.claim_type,
    volumeIdentityJson: row.volume_identity_json,
    journalIdentityJson: row.journal_identity_json,
    previousTrustedBoundaryUsn: row.previous_trusted_boundary_usn != null ? String(row.previous_trusted_boundary_usn) : null,
    openedBoundaryUsn: String(row.opened_boundary_usn),
    closedBoundaryUsn: row.closed_boundary_usn != null ? String(row.closed_boundary_usn) : null,
    bootstrap: row.bootstrap,
    reconciliationPasses: row.reconciliation_passes,
    policyHash: row.policy_hash,
    continuityEvidenceJson: row.continuity_evidence_json,
  }));
}

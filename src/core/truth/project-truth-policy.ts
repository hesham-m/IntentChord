import type { JsonValue } from "@/core/truth/project-truth-hash";
import type { ProjectFactStatus } from "@/core/truth/project-fact-types";

export type FactPolicyRevision = {
  id: string;
  revision: number;
  status: ProjectFactStatus;
  value: JsonValue;
  validFrom: string;
  validUntil?: string;
  sourceProposalRevisionId?: string;
  supersedesRevisionId?: string;
};

export type FactPolicyState = {
  currentRevision: number;
  currentStatus: ProjectFactStatus;
  currentFactRevisionId: string;
  current: FactPolicyRevision;
  unresolvedProposalIds: string[];
};

export type FactProjectionDecision = {
  nextAggregateRevision: number;
  nextCurrentStatus: ProjectFactStatus;
  nextCurrentFactRevisionId: string;
};

export class ProjectTruthPolicyError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}

function parsedTime(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new ProjectTruthPolicyError("INVALID_TEMPORAL_VALUE", `${label} must be a valid timestamp.`);
  }
  return parsed;
}

export function assertTemporalRange(validFrom: string, validUntil?: string): void {
  const from = parsedTime(validFrom, "validFrom");
  if (validUntil !== undefined && parsedTime(validUntil, "validUntil") <= from) {
    throw new ProjectTruthPolicyError("INVALID_TEMPORAL_RANGE", "validUntil must be later than validFrom.");
  }
}

export function assertExpectedFactRevision(actual: number, expected: number): void {
  if (actual !== expected) {
    throw new ProjectTruthPolicyError(
      "REVISION_CONFLICT",
      `Expected Project Fact revision ${expected}, but the authoritative revision is ${actual}.`,
    );
  }
}

export function assertProposalCanBeCreated(state: FactPolicyState | undefined): void {
  if (state?.unresolvedProposalIds.length) {
    throw new ProjectTruthPolicyError(
      "UNRESOLVED_FACT_PROPOSAL_EXISTS",
      "A Project Fact may have only one unresolved proposal at a time.",
    );
  }
}

export function projectionAfterProposal(input: {
  state?: FactPolicyState;
  proposalRevisionId: string;
  nextAggregateRevision: number;
}): FactProjectionDecision {
  if (input.state?.currentStatus === "OWNER_APPROVED") {
    return {
      nextAggregateRevision: input.nextAggregateRevision,
      nextCurrentStatus: input.state.currentStatus,
      nextCurrentFactRevisionId: input.state.currentFactRevisionId,
    };
  }
  return {
    nextAggregateRevision: input.nextAggregateRevision,
    nextCurrentStatus: "PROPOSED",
    nextCurrentFactRevisionId: input.proposalRevisionId,
  };
}

export function assertResolvableProposal(state: FactPolicyState, proposal: FactPolicyRevision): void {
  if (proposal.status !== "PROPOSED") {
    throw new ProjectTruthPolicyError("FACT_REVISION_NOT_PROPOSAL", "The selected revision is not a proposed Project Fact.");
  }
  if (!state.unresolvedProposalIds.includes(proposal.id)) {
    throw new ProjectTruthPolicyError("FACT_PROPOSAL_ALREADY_DECIDED", "The selected Project Fact proposal was already decided.");
  }
}

export function projectionAfterApproval(input: {
  state: FactPolicyState;
  proposal: FactPolicyRevision;
  approvedRevisionId: string;
  nextAggregateRevision: number;
}): FactProjectionDecision {
  assertResolvableProposal(input.state, input.proposal);
  if (input.state.currentStatus === "OWNER_APPROVED") {
    throw new ProjectTruthPolicyError(
      "CURRENT_APPROVED_FACT_REQUIRES_SUPERSEDE",
      "An existing owner-approved Project Fact must be replaced through the explicit supersede command.",
    );
  }
  return {
    nextAggregateRevision: input.nextAggregateRevision,
    nextCurrentStatus: "OWNER_APPROVED",
    nextCurrentFactRevisionId: input.approvedRevisionId,
  };
}

export function projectionAfterRejection(input: {
  state: FactPolicyState;
  proposal: FactPolicyRevision;
  rejectedRevisionId: string;
  nextAggregateRevision: number;
}): FactProjectionDecision {
  assertResolvableProposal(input.state, input.proposal);
  if (input.state.currentStatus === "OWNER_APPROVED") {
    return {
      nextAggregateRevision: input.nextAggregateRevision,
      nextCurrentStatus: input.state.currentStatus,
      nextCurrentFactRevisionId: input.state.currentFactRevisionId,
    };
  }
  return {
    nextAggregateRevision: input.nextAggregateRevision,
    nextCurrentStatus: "REJECTED",
    nextCurrentFactRevisionId: input.rejectedRevisionId,
  };
}

export function projectionAfterSupersede(input: {
  state: FactPolicyState;
  expectedCurrentApprovedRevisionId: string;
  replacementProposal?: FactPolicyRevision;
  replacementApprovedRevisionId?: string;
  supersededMarkerRevisionId?: string;
  nextAggregateRevision: number;
  effectiveAt: string;
}): FactProjectionDecision {
  if (
    input.state.currentStatus !== "OWNER_APPROVED"
    || input.state.currentFactRevisionId !== input.expectedCurrentApprovedRevisionId
  ) {
    throw new ProjectTruthPolicyError(
      "CURRENT_APPROVED_FACT_MISMATCH",
      "The expected owner-approved Project Fact revision is not the current authoritative revision.",
    );
  }
  assertTemporalRange(input.effectiveAt);
  if (Date.parse(input.effectiveAt) < Date.parse(input.state.current.validFrom)) {
    throw new ProjectTruthPolicyError(
      "SUPERSEDE_TIME_PRECEDES_CURRENT_FACT",
      "A Project Fact cannot be superseded before its current approved validity begins.",
    );
  }
  if (input.state.current.validUntil && Date.parse(input.effectiveAt) > Date.parse(input.state.current.validUntil)) {
    throw new ProjectTruthPolicyError(
      "SUPERSEDE_TIME_AFTER_CURRENT_FACT",
      "The supersede time cannot be later than the current fact's explicit validity end.",
    );
  }

  if (input.replacementProposal) {
    assertResolvableProposal(input.state, input.replacementProposal);
    if (!input.replacementApprovedRevisionId) {
      throw new ProjectTruthPolicyError("REPLACEMENT_REVISION_REQUIRED", "A replacement approval revision identity is required.");
    }
    return {
      nextAggregateRevision: input.nextAggregateRevision,
      nextCurrentStatus: "OWNER_APPROVED",
      nextCurrentFactRevisionId: input.replacementApprovedRevisionId,
    };
  }

  if (!input.supersededMarkerRevisionId) {
    throw new ProjectTruthPolicyError("SUPERSEDED_MARKER_REQUIRED", "A superseded marker revision identity is required.");
  }
  return {
    nextAggregateRevision: input.nextAggregateRevision,
    nextCurrentStatus: "SUPERSEDED",
    nextCurrentFactRevisionId: input.supersededMarkerRevisionId,
  };
}

export function approvedFactCanEnterSnapshot(input: {
  factCurrentStatus: ProjectFactStatus;
  factCurrentRevisionId: string;
  revision: FactPolicyRevision;
}): boolean {
  return input.factCurrentStatus === "OWNER_APPROVED"
    && input.factCurrentRevisionId === input.revision.id
    && input.revision.status === "OWNER_APPROVED";
}

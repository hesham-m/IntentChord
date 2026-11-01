import { describe, expect, it } from "vitest";
import {
  assertProposalCanBeCreated,
  projectionAfterApproval,
  projectionAfterProposal,
  projectionAfterRejection,
  projectionAfterSupersede,
  ProjectTruthPolicyError,
  type FactPolicyRevision,
  type FactPolicyState,
} from "@/core/truth/project-truth-policy";

const approved: FactPolicyRevision = {
  id: "10000000-0000-4000-8000-000000000001",
  revision: 2,
  status: "OWNER_APPROVED",
  value: { version: "1.5.3" },
  validFrom: "2026-07-01T00:00:00.000Z",
};
const proposal: FactPolicyRevision = {
  id: "10000000-0000-4000-8000-000000000002",
  revision: 3,
  status: "PROPOSED",
  value: { version: "1.5.4" },
  validFrom: "2026-07-28T00:00:00.000Z",
};

function state(overrides: Partial<FactPolicyState> = {}): FactPolicyState {
  return {
    currentRevision: 3,
    currentStatus: "OWNER_APPROVED",
    currentFactRevisionId: approved.id,
    current: approved,
    unresolvedProposalIds: [proposal.id],
    ...overrides,
  };
}

describe("Project Truth deterministic policy", () => {
  it("does not let a proposal displace an owner-approved current fact", () => {
    expect(projectionAfterProposal({
      state: state({ unresolvedProposalIds: [] }),
      proposalRevisionId: proposal.id,
      nextAggregateRevision: 4,
    })).toEqual({
      nextAggregateRevision: 4,
      nextCurrentStatus: "OWNER_APPROVED",
      nextCurrentFactRevisionId: approved.id,
    });
  });

  it("requires explicit supersede instead of silently approving over current truth", () => {
    expect(() => projectionAfterApproval({
      state: state(),
      proposal,
      approvedRevisionId: "10000000-0000-4000-8000-000000000003",
      nextAggregateRevision: 4,
    })).toThrowError(expect.objectContaining({ code: "CURRENT_APPROVED_FACT_REQUIRES_SUPERSEDE" }));
  });

  it("keeps current approved truth after rejecting a candidate replacement", () => {
    expect(projectionAfterRejection({
      state: state(),
      proposal,
      rejectedRevisionId: "10000000-0000-4000-8000-000000000004",
      nextAggregateRevision: 4,
    })).toEqual({
      nextAggregateRevision: 4,
      nextCurrentStatus: "OWNER_APPROVED",
      nextCurrentFactRevisionId: approved.id,
    });
  });

  it("replaces current truth only through an explicit owner supersede transition", () => {
    const replacementId = "10000000-0000-4000-8000-000000000005";
    expect(projectionAfterSupersede({
      state: state(),
      expectedCurrentApprovedRevisionId: approved.id,
      replacementProposal: proposal,
      replacementApprovedRevisionId: replacementId,
      nextAggregateRevision: 4,
      effectiveAt: "2026-07-28T00:00:00.000Z",
    })).toEqual({
      nextAggregateRevision: 4,
      nextCurrentStatus: "OWNER_APPROVED",
      nextCurrentFactRevisionId: replacementId,
    });
  });

  it("blocks a second unresolved proposal", () => {
    expect(() => assertProposalCanBeCreated(state())).toThrowError(ProjectTruthPolicyError);
    expect(() => assertProposalCanBeCreated(state({ unresolvedProposalIds: [] }))).not.toThrow();
  });

  it("rejects stale current-approved identity during supersede", () => {
    expect(() => projectionAfterSupersede({
      state: state(),
      expectedCurrentApprovedRevisionId: "10000000-0000-4000-8000-000000000099",
      supersededMarkerRevisionId: "10000000-0000-4000-8000-000000000006",
      nextAggregateRevision: 4,
      effectiveAt: "2026-07-28T00:00:00.000Z",
    })).toThrowError(expect.objectContaining({ code: "CURRENT_APPROVED_FACT_MISMATCH" }));
  });
});

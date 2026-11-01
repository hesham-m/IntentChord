import { describe, expect, it } from "vitest";
import {
  freezeProjectTruthSnapshot,
  ProjectTruthSnapshotError,
  type SnapshotFactCandidate,
} from "@/core/truth/project-truth-snapshot";

const approved: SnapshotFactCandidate = {
  factKey: "EIT.UPDATE_CHANNEL.CURRENT_VERSION",
  factType: "CURRENT_VERSION",
  projectFactId: "10000000-0000-4000-8000-000000000001",
  projectFactRevisionId: "10000000-0000-4000-8000-000000000002",
  revision: 2,
  contentSha256: "a".repeat(64),
  revisionStatus: "OWNER_APPROVED",
  validFrom: "2026-07-01T00:00:00.000Z",
};

const proposal: SnapshotFactCandidate = {
  ...approved,
  factKey: "EIT.UPDATE_CHANNEL.CANDIDATE_VERSION",
  projectFactId: "10000000-0000-4000-8000-000000000003",
  projectFactRevisionId: "10000000-0000-4000-8000-000000000004",
  revisionStatus: "PROPOSED",
  contentSha256: "b".repeat(64),
};

const baseInput = {
  projectContextId: "10000000-0000-4000-8000-000000000010",
  snapshotVersion: "truth/v1",
  effectiveAt: "2026-07-28T00:00:00.000Z",
};

describe("Project Truth snapshot", () => {
  it("freezes only owner-approved revisions effective at the snapshot time", () => {
    const frozen = freezeProjectTruthSnapshot({
      ...baseInput,
      candidates: [proposal, approved],
    });
    expect(frozen.effectiveAt).toBe(baseInput.effectiveAt);
    expect(frozen.selectedFactRevisionIds).toEqual([approved.projectFactRevisionId]);
    expect(frozen.contentSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("fails closed when a requested revision is proposed instead of owner-approved", () => {
    expect(() => freezeProjectTruthSnapshot({
      ...baseInput,
      candidates: [proposal, approved],
      requestedFactRevisionIds: [proposal.projectFactRevisionId],
    })).toThrowError(ProjectTruthSnapshotError);
  });

  it("excludes future and expired owner-approved facts", () => {
    const future = {
      ...approved,
      factKey: "EIT.FUTURE.VERSION",
      projectFactId: "10000000-0000-4000-8000-000000000020",
      projectFactRevisionId: "10000000-0000-4000-8000-000000000021",
      validFrom: "2026-08-01T00:00:00.000Z",
    };
    const expired = {
      ...approved,
      factKey: "EIT.EXPIRED.VERSION",
      projectFactId: "10000000-0000-4000-8000-000000000030",
      projectFactRevisionId: "10000000-0000-4000-8000-000000000031",
      validUntil: "2026-07-20T00:00:00.000Z",
    };
    const frozen = freezeProjectTruthSnapshot({
      ...baseInput,
      candidates: [future, expired, approved],
    });
    expect(frozen.selectedFactRevisionIds).toEqual([approved.projectFactRevisionId]);
  });

  it("selects the historical approved revision before a future replacement becomes effective", () => {
    const replacement: SnapshotFactCandidate = {
      ...approved,
      projectFactRevisionId: "10000000-0000-4000-8000-000000000005",
      revision: 4,
      contentSha256: "c".repeat(64),
      validFrom: "2026-08-01T00:00:00.000Z",
      supersedesRevisionId: approved.projectFactRevisionId,
    };
    const before = freezeProjectTruthSnapshot({ ...baseInput, candidates: [approved, replacement] });
    const after = freezeProjectTruthSnapshot({
      ...baseInput,
      effectiveAt: "2026-08-01T00:00:00.000Z",
      candidates: [approved, replacement],
    });
    expect(before.selectedFactRevisionIds).toEqual([approved.projectFactRevisionId]);
    expect(after.selectedFactRevisionIds).toEqual([replacement.projectFactRevisionId]);
  });

  it("closes an approved fact at a superseded marker without inventing a replacement", () => {
    const marker: SnapshotFactCandidate = {
      ...approved,
      projectFactRevisionId: "10000000-0000-4000-8000-000000000006",
      revision: 4,
      revisionStatus: "SUPERSEDED",
      contentSha256: "d".repeat(64),
      validFrom: "2026-08-01T00:00:00.000Z",
      supersedesRevisionId: approved.projectFactRevisionId,
    };
    expect(freezeProjectTruthSnapshot({ ...baseInput, candidates: [approved, marker] }).selectedFactRevisionIds)
      .toEqual([approved.projectFactRevisionId]);
    expect(() => freezeProjectTruthSnapshot({
      ...baseInput,
      effectiveAt: "2026-08-01T00:00:00.000Z",
      candidates: [approved, marker],
    })).toThrowError(/requires at least one owner-approved fact/);
  });

  it("fails closed when temporal history yields two effective approved revisions for one fact", () => {
    const fork: SnapshotFactCandidate = {
      ...approved,
      projectFactRevisionId: "10000000-0000-4000-8000-000000000007",
      revision: 5,
      contentSha256: "e".repeat(64),
    };
    expect(() => freezeProjectTruthSnapshot({ ...baseInput, candidates: [approved, fork] }))
      .toThrowError(/more than one owner-approved revision/);
  });

  it("binds the effective time into snapshot identity", () => {
    const first = freezeProjectTruthSnapshot({ ...baseInput, candidates: [approved] });
    const second = freezeProjectTruthSnapshot({
      ...baseInput,
      effectiveAt: "2026-07-29T00:00:00.000Z",
      candidates: [approved],
    });
    expect(second.contentSha256).not.toBe(first.contentSha256);
  });

  it("is stable for the same selected fact set and effective time", () => {
    const input = { ...baseInput, candidates: [approved] };
    expect(freezeProjectTruthSnapshot(input).contentSha256)
      .toBe(freezeProjectTruthSnapshot(input).contentSha256);
  });
});

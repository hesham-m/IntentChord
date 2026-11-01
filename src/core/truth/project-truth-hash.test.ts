import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  projectFactRevisionHash,
  projectTruthSnapshotHash,
} from "@/core/truth/project-truth-hash";

describe("Project Truth canonical hashing", () => {
  it("is stable across object key ordering", () => {
    expect(canonicalJson({ b: 2, a: { y: true, x: "v" } }))
      .toBe(canonicalJson({ a: { x: "v", y: true }, b: 2 }));
  });

  it("binds status, temporal validity, provenance, and Owner decision identity", () => {
    const base = {
      schemaVersion: "project-fact-revision/v1" as const,
      projectContextId: "10000000-0000-4000-8000-000000000001",
      projectFactId: "10000000-0000-4000-8000-000000000002",
      factKey: "EIT.UPDATE_CHANNEL.CURRENT_VERSION",
      factType: "CURRENT_VERSION",
      revision: 2,
      value: { version: "1.5.3" },
      status: "OWNER_APPROVED" as const,
      validFrom: "2026-07-28T00:00:00.000Z",
      sourceProposalRevisionId: "10000000-0000-4000-8000-000000000003",
      provenance: { source: "OWNER_DECISION" },
      ownerDecisionId: "10000000-0000-4000-8000-000000000004",
    };
    const hash = projectFactRevisionHash(base);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(projectFactRevisionHash({ ...base, status: "REJECTED" })).not.toBe(hash);
    expect(projectFactRevisionHash({ ...base, value: { version: "1.5.2" } })).not.toBe(hash);
    expect(projectFactRevisionHash({ ...base, validFrom: "2026-07-29T00:00:00.000Z" })).not.toBe(hash);
  });

  it("rejects values outside the JSON data model instead of hashing them ambiguously", () => {
    expect(() => canonicalJson(undefined)).toThrow(/CANONICAL_JSON_UNSUPPORTED_TYPE/);
    expect(() => canonicalJson({ unsupported: undefined })).toThrow(/CANONICAL_JSON_UNSUPPORTED_TYPE/);
    expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow(/CANONICAL_JSON_NON_FINITE_NUMBER/);
  });

  it("sorts snapshot entries before hashing", () => {
    const first = {
      factKey: "B.VERSION",
      factType: "CURRENT_VERSION",
      projectFactId: "10000000-0000-4000-8000-000000000010",
      projectFactRevisionId: "10000000-0000-4000-8000-000000000011",
      revision: 2,
      contentSha256: "a".repeat(64),
    };
    const second = {
      factKey: "A.VERSION",
      factType: "CURRENT_VERSION",
      projectFactId: "10000000-0000-4000-8000-000000000012",
      projectFactRevisionId: "10000000-0000-4000-8000-000000000013",
      revision: 2,
      contentSha256: "b".repeat(64),
    };
    const input = {
      schemaVersion: "project-truth-snapshot/v1" as const,
      projectContextId: "10000000-0000-4000-8000-000000000001",
      snapshotVersion: "truth/v1",
      effectiveAt: "2026-07-28T00:00:00.000Z",
    };
    expect(projectTruthSnapshotHash({ ...input, facts: [first, second] }))
      .toBe(projectTruthSnapshotHash({ ...input, facts: [second, first] }));
  });
});

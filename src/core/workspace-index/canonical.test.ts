import { describe, expect, it } from "vitest";
import { canonicalJson, canonicalWorkspaceIndexHash, sha256Canonical } from "@/core/workspace-index/canonical";
import { indexWorkspace } from "@/core/workspace-index/indexer";
import { createWorkspaceIndexFixture } from "@/test/workspace-index-helpers";

describe("Workspace Index canonical serialization and integrity", () => {
  it("produces the same bytes and hash for property-order changes", () => {
    expect(canonicalJson({ b: 2, a: { d: 4, c: 3 } })).toBe(canonicalJson({ a: { c: 3, d: 4 }, b: 2 }));
    expect(sha256Canonical({ b: 2, a: 1 })).toBe(sha256Canonical({ a: 1, b: 2 }));
  });

  it("changes the hash when a semantic field changes", () => {
    expect(sha256Canonical({ state: "A" })).not.toBe(sha256Canonical({ state: "B" }));
  });

  it("produces a deterministic Contract hash for the same logical request", async () => {
    const root = await createWorkspaceIndexFixture();
    const request = {
      workspace_instance_id: "wsi_determinism_fixture",
      root_path: root,
      binding_type: "FIXTURE" as const,
      indexing_session_id: "wis_determinism_fixture",
      started_at: "2026-08-02T18:00:00.000Z",
      completed_at: "2026-08-02T18:00:01.000Z",
    };
    const first = await indexWorkspace(request);
    const second = await indexWorkspace(request);
    expect(first.integrity.canonical_payload_hash).toBe(second.integrity.canonical_payload_hash);
    expect(canonicalWorkspaceIndexHash(first)).toBe(first.integrity.canonical_payload_hash);
  });

  it("accepts logically identical Contracts regardless of snapshot array order", async () => {
    const value = await indexWorkspace({
      workspace_instance_id: "wsi_order_fixture",
      root_path: await createWorkspaceIndexFixture(),
      binding_type: "FIXTURE",
      indexing_session_id: "wis_order_fixture",
      started_at: "2026-08-02T18:00:00.000Z",
      completed_at: "2026-08-02T18:00:01.000Z",
    });
    const reordered = structuredClone(value);
    reordered.snapshot.files.reverse();
    reordered.snapshot.facts.reverse();
    reordered.snapshot.relations.reverse();
    reordered.snapshot.content_references.reverse();
    const { validateCanonicalWorkspaceIndexContract } = await import("@/core/workspace-index/validator");
    const result = validateCanonicalWorkspaceIndexContract(reordered);
    expect(result.status).not.toBe("REJECTED");
    expect(result.diagnostics.some(item => item.code === "COVERAGE_SUMMARY_MISMATCH")).toBe(false);
  });

  it("rejects count tampering", async () => {
    const value = await indexWorkspace({
      workspace_instance_id: "wsi_count_fixture",
      root_path: await createWorkspaceIndexFixture(),
      binding_type: "FIXTURE",
      indexing_session_id: "wis_count_fixture",
      started_at: "2026-08-02T18:00:00.000Z",
      completed_at: "2026-08-02T18:00:01.000Z",
    });
    value.integrity.file_count += 1;
    const { validateCanonicalWorkspaceIndexContract } = await import("@/core/workspace-index/validator");
    expect(validateCanonicalWorkspaceIndexContract(value).diagnostics.some(item => item.code === "COUNT_MISMATCH")).toBe(true);
  });
});

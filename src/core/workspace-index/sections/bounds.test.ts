import { describe, expect, it } from "vitest";
import {
  WorkspaceSectionBoundError,
  assertHeaderWithinBounds,
  assertRecordWithinBounds,
  assertSegmentRecordCount,
  assertSectionManifestWithinBounds,
} from "@/core/workspace-index/sections/bounds";

describe("section bounds fail-closed behavior (SPEC V3 1.3)", () => {
  it("accepts records at the bound and rejects beyond it without splitting", () => {
    const filler = "x".repeat(262_100); // under bound after JSON wrapping overhead
    expect(() => assertRecordWithinBounds({ filler })).not.toThrow();
    const oversized = { filler: "x".repeat(300_000) };
    try {
      assertRecordWithinBounds(oversized);
      expect.unreachable("bound must reject oversize");
    } catch (error) {
      expect(error).toBeInstanceOf(WorkspaceSectionBoundError);
      expect((error as WorkspaceSectionBoundError).code).toBe("WORKSPACE_SECTION_RECORD_OVERBOUND");
    }
  });

  it("rejects oversized headers and manifests with distinct codes", () => {
    expect(() => assertHeaderWithinBounds({ blob: "h".repeat(70_000) })).toThrow(
      /WORKSPACE_ARTIFACT_HEADER_OVERBOUND/,
    );
    expect(() => assertSectionManifestWithinBounds({ blob: "m".repeat(20_000) })).toThrow(
      /WORKSPACE_SECTION_MANIFEST_OVERBOUND/,
    );
    expect(() => assertHeaderWithinBounds({ ok: true })).not.toThrow();
  });

  it("enforces the closed segment record-count range", () => {
    expect(() => assertSegmentRecordCount(0)).toThrow(/RECORD_COUNT_INVALID/);
    expect(() => assertSegmentRecordCount(513)).toThrow(/RECORD_COUNT_INVALID/);
    expect(() => assertSegmentRecordCount(512)).not.toThrow();
  });
});

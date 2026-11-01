import { describe, expect, it } from "vitest";
import { HttpCommandError } from "@/server/errors";
import { workspaceIndexRequestError } from "@/server/workspace-index-route-error";

describe("Workspace Index governed route errors", () => {
  it("preserves already-governed errors", () => {
    const original = new HttpCommandError(422, "WORKSPACE_INDEX_TIMEOUT", "timeout");
    expect(workspaceIndexRequestError(original)).toBe(original);
  });

  it.each([
    "WORKSPACE_INDEX_SNAPSHOT_RESERVATION_MISSING",
    "CANONICAL_INDEX_ARTIFACT_RESOLUTION_MISSING",
    "WORKSPACE_INDEX_DELTA_ARTIFACT_RESOLUTION_MISSING",
  ])("maps source-proven persistence sentinel %s to a specific governed failure", (code: string) => {
    expect(workspaceIndexRequestError(new Error(code))).toMatchObject({ status: 409, code });
  });

  it("does not invent an unknown runtime root cause", () => {
    expect(workspaceIndexRequestError(new Error("socket closed"))).toMatchObject({
      status: 500,
      code: "WORKSPACE_INDEX_UNCLASSIFIED_FAILURE",
    });
  });
});

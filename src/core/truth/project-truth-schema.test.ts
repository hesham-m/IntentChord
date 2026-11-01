import { describe, expect, it } from "vitest";
import {
  factKeySchema,
  createProjectTruthSnapshotCommandSchema,
  factTypeSchema,
  proposeProjectFactCommandSchema,
} from "@/core/truth/project-fact-schema";
import { projectContextSlug } from "@/core/truth/project-context-schema";

describe("Project Truth command schemas", () => {
  it("normalizes fact keys and types without restricting future registered types", () => {
    expect(factKeySchema.parse("eit.update_channel.current_version")).toBe("EIT.UPDATE_CHANNEL.CURRENT_VERSION");
    expect(factTypeSchema.parse("custom_release_identity")).toBe("CUSTOM_RELEASE_IDENTITY");
  });

  it("accepts structured JSON and rejects invalid temporal ranges", () => {
    expect(proposeProjectFactCommandSchema.parse({
      expectedFactRevision: 0,
      factKey: "EIT.VERSION",
      factType: "CURRENT_VERSION",
      value: { version: "1.5.3" },
      provenance: { source: "OWNER_INPUT" },
    }).value).toEqual({ version: "1.5.3" });
    expect(() => proposeProjectFactCommandSchema.parse({
      expectedFactRevision: 0,
      factKey: "EIT.VERSION",
      factType: "CURRENT_VERSION",
      value: { version: "1.5.3" },
      validFrom: "2026-07-29T00:00:00.000Z",
      validUntil: "2026-07-28T00:00:00.000Z",
      provenance: {},
    })).toThrow();
  });

  it("accepts a bounded explicit truth-snapshot effective time", () => {
    expect(createProjectTruthSnapshotCommandSchema.parse({
      snapshotVersion: "truth/v1",
      effectiveAt: "2026-07-28T00:00:00.000Z",
    }).effectiveAt).toBe("2026-07-28T00:00:00.000Z");
  });

  it("creates a bounded fallback slug for non-Latin display names", () => {
    expect(projectContextSlug("مشروع التحكم", "ABC-123")).toBe("project-abc123");
  });
});

import { describe, expect, it } from "vitest";
import { parseWorkspaceIndexEngine } from "@/core/workspace-index/engine-router";

describe("Phase 4B Task B — Governed Engine Router", () => {

  // B01: absent → V1
  it("B01 absent WORKSPACE_INDEX_ENGINE defaults to V1", () => {
    expect(parseWorkspaceIndexEngine({})).toBe("V1");
  });

  // B02: "V1" → V1
  it("B02 explicit V1 selects V1", () => {
    expect(parseWorkspaceIndexEngine({ WORKSPACE_INDEX_ENGINE: "V1" })).toBe("V1");
  });

  // B03: "V2" → V2
  it("B03 explicit V2 selects V2", () => {
    expect(parseWorkspaceIndexEngine({ WORKSPACE_INDEX_ENGINE: "V2" })).toBe("V2");
  });

  // B04: invalid → throw
  it("B04 invalid engine string throws fail-closed", () => {
    expect(() => parseWorkspaceIndexEngine({ WORKSPACE_INDEX_ENGINE: "V3" })).toThrow("INVALID_WORKSPACE_INDEX_ENGINE");
  });

  // B05: undefined → V1
  it("B05 undefined value defaults to V1", () => {
    expect(parseWorkspaceIndexEngine({ WORKSPACE_INDEX_ENGINE: undefined })).toBe("V1");
  });

  // B06: empty string → V1
  it("B06 empty string defaults to V1", () => {
    expect(parseWorkspaceIndexEngine({ WORKSPACE_INDEX_ENGINE: "" })).toBe("V1");
  });

  // B07: lowercase "v1" → throw
  it("B07 lowercase v1 is rejected (case-sensitive)", () => {
    expect(() => parseWorkspaceIndexEngine({ WORKSPACE_INDEX_ENGINE: "v1" })).toThrow("INVALID_WORKSPACE_INDEX_ENGINE");
  });

  // B08: lowercase "v2" → throw
  it("B08 lowercase v2 is rejected (case-sensitive)", () => {
    expect(() => parseWorkspaceIndexEngine({ WORKSPACE_INDEX_ENGINE: "v2" })).toThrow("INVALID_WORKSPACE_INDEX_ENGINE");
  });

  // B09: garbage string → throw
  it("B09 garbage string throws with descriptive error", () => {
    expect(() => parseWorkspaceIndexEngine({ WORKSPACE_INDEX_ENGINE: "not-an-engine" })).toThrow(/INVALID_WORKSPACE_INDEX_ENGINE:"not-an-engine"/);
  });

  // B10: random UUID → throw
  it("B10 UUID string throws fail-closed", () => {
    expect(() => parseWorkspaceIndexEngine({ WORKSPACE_INDEX_ENGINE: "550e8400-e29b-41d4-a716-446655440000" })).toThrow("INVALID_WORKSPACE_INDEX_ENGINE");
  });

  // B11: "V1 extra" → throw
  it("B11 string with trailing content is rejected", () => {
    expect(() => parseWorkspaceIndexEngine({ WORKSPACE_INDEX_ENGINE: "V1 " })).toThrow("INVALID_WORKSPACE_INDEX_ENGINE");
  });

  // B12: "  V2  " → throw
  it("B12 whitespace-padded V2 is rejected", () => {
    expect(() => parseWorkspaceIndexEngine({ WORKSPACE_INDEX_ENGINE: "  V2  " })).toThrow("INVALID_WORKSPACE_INDEX_ENGINE");
  });

  // B13: null value → V1 (raw is string|undefined, null cast)
  it("B13 treated as undefined when key missing", () => {
    const env: Record<string, string | undefined> = {};
    delete env.WORKSPACE_INDEX_ENGINE;
    expect(parseWorkspaceIndexEngine(env)).toBe("V1");
  });

  // B14: multiple env keys only reads WORKSPACE_INDEX_ENGINE
  it("B14 ignores unrelated env keys", () => {
    expect(parseWorkspaceIndexEngine({ WORKSPACE_INDEX_ENGINE: "V2", OTHER: "V1" })).toBe("V2");
  });

  // B15: pure function — no side effects on env
  it("B15 parse does not mutate the input env", () => {
    const env = { WORKSPACE_INDEX_ENGINE: "V2" };
    parseWorkspaceIndexEngine(env);
    expect(env.WORKSPACE_INDEX_ENGINE).toBe("V2");
  });

  // B16: called twice returns same result (deterministic)
  it("B16 deterministic — same input yields same output", () => {
    const env = { WORKSPACE_INDEX_ENGINE: "V2" };
    expect(parseWorkspaceIndexEngine(env)).toBe(parseWorkspaceIndexEngine(env));
  });

  // B17: "V1" and "V2" are the ONLY accepted values
  it("B17 only V1 and V2 are accepted — all others rejected", () => {
    const rejected = ["v1", "v2", "V3", "3", "true", "false", "1", "2", "yes", "no", "auto", "legacy"];
    for (const val of rejected) {
      expect(() => parseWorkspaceIndexEngine({ WORKSPACE_INDEX_ENGINE: val })).toThrow("INVALID_WORKSPACE_INDEX_ENGINE");
    }
    expect(parseWorkspaceIndexEngine({ WORKSPACE_INDEX_ENGINE: "V1" })).toBe("V1");
    expect(parseWorkspaceIndexEngine({ WORKSPACE_INDEX_ENGINE: "V2" })).toBe("V2");
  });
});

describe("Phase 4B Task B — V2 Engine Routing Source Audit", () => {

  // B18: engine-router.ts must NOT import continuity/authority.ts (import statements only)
  it("B18 engine-router has no continuity imports", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync(
      "src/core/workspace-index/engine-router.ts", "utf8"
    );
    const importLines = src.split("\n").filter(l => l.startsWith("import "));
    const importsJoined = importLines.join("\n");
    expect(importsJoined.includes("continuity/authority")).toBe(false);
    expect(importsJoined.includes("selectContinuityAuthority")).toBe(false);
  });

  // B19: engine-router.ts must NOT import indexer.ts
  it("B19 engine-router has no indexer imports", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync(
      "src/core/workspace-index/engine-router.ts", "utf8"
    );
    expect(src.includes("indexer")).toBe(false);
    expect(src.includes("indexWorkspace")).toBe(false);
  });

  // B20: workspace-index-snapshot-service.ts wires V2 branching via engine router
  it("B20 production service imports and uses engine router", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync(
      "src/server/workspace-index-snapshot-service.ts", "utf8"
    );
    expect(src.includes("parseWorkspaceIndexEngine")).toBe(true);
    expect(src.includes("indexWorkspaceV2")).toBe(true);
    expect(src.includes('engineChoice === "V2"')).toBe(true);
  });
});

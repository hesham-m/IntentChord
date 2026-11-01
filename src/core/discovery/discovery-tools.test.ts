import { mkdtemp, mkdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  LocalBoundedDiscoveryTools,
  normalizeDiscoveryRelativePath,
  type DiscoveryWorkspaceBoundary,
} from "@/core/discovery/discovery-tools";
import { createWorkspaceFilesystemObjectAuthority } from "@/core/workspace-index/filesystem-object-authority";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function workspace(): Promise<{ root: string; boundary: DiscoveryWorkspaceBoundary }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "intentchord-discovery-"));
  roots.push(root);
  const authority = createWorkspaceFilesystemObjectAuthority();
  const proof = await authority.probeDirectory(root);
  await authority.close();
  return {
    root,
    boundary: {
      id: "11111111-1111-4111-8111-111111111111",
      displayName: "test-workspace",
      rootReference: root,
      authorizedRootRealPath: proof.resolved_real_path,
      authorizedRootObjectIdentity: proof.identity,
      discoveryScopeMode: "FULL_WORKSPACE",
      allowedPaths: [],
      excludedPaths: [],
    },
  };
}

describe("LocalBoundedDiscoveryTools", () => {
  it("rejects traversal and absolute paths", () => {
    expect(() => normalizeDiscoveryRelativePath("../outside.txt")).toThrow("DISCOVERY_PATH_OUTSIDE_WORKSPACE");
    expect(() => normalizeDiscoveryRelativePath("C:\\outside.txt")).toThrow("DISCOVERY_PATH_OUTSIDE_WORKSPACE");
    expect(() => normalizeDiscoveryRelativePath("/outside.txt")).toThrow("DISCOVERY_PATH_OUTSIDE_WORKSPACE");
  });

  it("searches approved text files, preserves semantic versions, and skips secrets/build trees", async () => {
    const { root, boundary } = await workspace();
    await mkdir(path.join(root, "src", "update"), { recursive: true });
    await mkdir(path.join(root, "node_modules", "ignored"), { recursive: true });
    await writeFile(
      path.join(root, "src", "update", "readiness.ts"),
      "export const targetVersion = '1.5.3';\nexport const readiness = 'native release manifest';\n",
    );
    await writeFile(path.join(root, ".env.local"), "OPENAI_API_KEY=do-not-read\n");
    await writeFile(path.join(root, "node_modules", "ignored", "version.ts"), "1.5.3\n");

    const tools = new LocalBoundedDiscoveryTools();
    const hits = await tools.searchWorkspaceText(boundary, ["1.5.3", "native release", "manifest"]);

    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      workspaceId: boundary.id,
      relativePath: "src/update/readiness.ts",
    });
    expect(hits[0].matchedConcepts).toEqual(expect.arrayContaining(["1.5.3", "native release", "manifest"]));
    expect(hits[0].contentSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("enforces selected-path and exclusion boundaries", async () => {
    const { root, boundary } = await workspace();
    await mkdir(path.join(root, "allowed"), { recursive: true });
    await mkdir(path.join(root, "excluded"), { recursive: true });
    await writeFile(path.join(root, "allowed", "manifest.ts"), "manifest version 1.5.3");
    await writeFile(path.join(root, "excluded", "manifest.ts"), "manifest version 1.5.3");

    const tools = new LocalBoundedDiscoveryTools();
    const hits = await tools.searchWorkspaceText({
      ...boundary,
      discoveryScopeMode: "SELECTED_PATHS",
      allowedPaths: ["allowed"],
      excludedPaths: ["allowed/private"],
    }, ["manifest", "1.5.3"]);

    expect(hits.map(hit => hit.relativePath)).toEqual(["allowed/manifest.ts"]);
  });
  it("T63 governed Discovery child read stays bound to the verified parent when the parent path is replaced", async () => {
    if (process.platform !== "linux") return;
    const { root, boundary } = await workspace();
    const src = path.join(root, "src");
    const displaced = path.join(root, "src-authorized");
    const replacement = path.join(root, "src-replacement");
    await mkdir(src, { recursive: true });
    await mkdir(replacement, { recursive: true });
    await writeFile(path.join(src, "same.txt"), "AUTHORIZED-DISCOVERY-T63");
    await writeFile(path.join(replacement, "same.txt"), "REPLACEMENT-DISCOVERY-T63");
    let swapped = false;
    const authority = createWorkspaceFilesystemObjectAuthority({
      afterFileMetadataBeforeOpen: async ({ relativeFilePath }) => {
        if (swapped || relativeFilePath !== "src/same.txt") return;
        swapped = true;
        await rename(src, displaced);
        await rename(replacement, src);
      },
    });
    const tools = new LocalBoundedDiscoveryTools({}, authority);
    try {
      const result = await tools.readWorkspaceFile(boundary, "src/same.txt");
      expect(swapped).toBe(true);
      expect(result.content).toBe("AUTHORIZED-DISCOVERY-T63");
      expect(result.content).not.toContain("REPLACEMENT-DISCOVERY-T63");
    } finally {
      await tools.close().catch(() => undefined);
      if (swapped) {
        await rename(src, replacement).catch(() => undefined);
        await rename(displaced, src).catch(() => undefined);
      }
    }
  });

  it("T76 governed Discovery Windows read aborts mid-operation through the shared capture authority", async () => {
    if (process.platform !== "win32") return;
    const { root, boundary } = await workspace();
    await writeFile(path.join(root, "large.txt"), "D".repeat(8 * 1024 * 1024));
    const controller = new AbortController();
    let progress = 0; let spawned = 0; let closed = 0;
    const authority = createWorkspaceFilesystemObjectAuthority({
      windowsCaptureChunkDelayMs: 30,
      onWindowsCaptureHelperSpawned: pid => { spawned = pid; },
      onWindowsCaptureHelperClosed: pid => { closed = pid; },
      onWindowsCaptureProgress: () => { progress += 1; if (progress === 1) controller.abort(); },
    });
    const tools = new LocalBoundedDiscoveryTools({ maxFileBytes: 16 * 1024 * 1024 }, authority);
    try {
      await expect(tools.readWorkspaceFile(boundary, "large.txt", { signal: controller.signal })).rejects.toMatchObject({ code: "WORKSPACE_INDEX_ABORTED" });
      expect(progress).toBeGreaterThan(0); expect(closed).toBe(spawned);
    } finally { await tools.close().catch(() => undefined); }
  });

  it("T79 real Discovery search propagates a mid-read Abort as terminal governance", async () => {
    if (process.platform !== "linux" && process.platform !== "win32") return;
    const { root, boundary } = await workspace();
    await writeFile(path.join(root, "abort-search.txt"), "terminal-governance ".repeat(128 * 1024));
    const controller = new AbortController();
    let captureProgress = 0;
    const onProgress = () => {
      captureProgress += 1;
      if (captureProgress === 1) controller.abort();
    };
    const authority = createWorkspaceFilesystemObjectAuthority({
      onNonWindowsCaptureProgress: onProgress,
      onWindowsCaptureProgress: onProgress,
      windowsCaptureChunkDelayMs: 30,
    });
    const tools = new LocalBoundedDiscoveryTools({ maxFileBytes: 8 * 1024 * 1024 }, authority);
    try {
      await expect(tools.searchWorkspaceText(boundary, ["terminal-governance"], { signal: controller.signal }))
        .rejects.toMatchObject({ code: "WORKSPACE_INDEX_ABORTED" });
      expect(captureProgress).toBeGreaterThan(0);
    } finally {
      await tools.close().catch(() => undefined);
    }
  }, 20_000);

  it("T80 real Discovery search propagates a mid-read Deadline as terminal governance", async () => {
    if (process.platform !== "linux" && process.platform !== "win32") return;
    const { root, boundary } = await workspace();
    await writeFile(path.join(root, "deadline-search.txt"), "terminal-deadline ".repeat(256 * 1024));
    let captureProgress = 0;
    let spawnedCaptureHelper = 0;
    let closedCaptureHelper = 0;
    const authority = createWorkspaceFilesystemObjectAuthority({
      nonWindowsCaptureChunkDelayMs: 650,
      windowsCaptureChunkDelayMs: 250,
      onNonWindowsCaptureProgress: () => { captureProgress += 1; },
      onWindowsCaptureProgress: () => { captureProgress += 1; },
      onWindowsCaptureHelperSpawned: pid => { spawnedCaptureHelper = pid; },
      onWindowsCaptureHelperClosed: pid => { closedCaptureHelper = pid; },
    });
    const tools = new LocalBoundedDiscoveryTools({ maxFileBytes: 8 * 1024 * 1024 }, authority);
    const deadlineDelayMs = process.platform === "win32" ? 8_000 : 500;
    let acceptedHits: Awaited<ReturnType<LocalBoundedDiscoveryTools["searchWorkspaceText"]>> | undefined;
    let terminalError: unknown;
    try {
      try {
        acceptedHits = await tools.searchWorkspaceText(boundary, ["terminal-deadline"], { deadlineAt: Date.now() + deadlineDelayMs });
      } catch (error) {
        terminalError = error;
      }
      expect(terminalError).toMatchObject({ code: "WORKSPACE_INDEX_TIMEOUT" });
      expect(acceptedHits).toBeUndefined();
      expect(captureProgress).toBeGreaterThan(0);
      if (process.platform === "win32") {
        expect(spawnedCaptureHelper).toBeGreaterThan(0);
        expect(closedCaptureHelper).toBe(spawnedCaptureHelper);
      }

      await writeFile(path.join(root, "healthy-after-deadline.txt"), "HEALTHY-AFTER-T80");
      const healthy = await tools.readWorkspaceFile(boundary, "healthy-after-deadline.txt", { deadlineAt: Date.now() + 10_000 });
      expect(healthy.content).toBe("HEALTHY-AFTER-T80");
    } finally {
      await tools.close().catch(() => undefined);
    }
  }, 20_000);

});

describe("R3 Discovery platform path authority", () => {
  it("keeps same-spelling-different-case paths distinct on case-sensitive platforms and out of each other's cache/scope", async () => {
    if (process.platform === "win32") return;
    const { root, boundary } = await workspace();
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src", "Foo.ts"), "UPPER_CASE_ONLY");
    await writeFile(path.join(root, "src", "foo.ts"), "lower_case_only");
    const tools = new LocalBoundedDiscoveryTools();
    try {
      const selectedBoundary = { ...boundary, discoveryScopeMode: "SELECTED_PATHS" as const, allowedPaths: ["src/Foo.ts"], excludedPaths: [] };
      const upper = await tools.readWorkspaceFile(selectedBoundary, "src/Foo.ts");
      expect(upper.content).toContain("UPPER_CASE_ONLY");
      await expect(tools.readWorkspaceFile(selectedBoundary, "src/foo.ts")).rejects.toThrow("DISCOVERY_PATH_NOT_AUTHORIZED");
      const unrestrictedUpper = await tools.readWorkspaceFile(boundary, "src/Foo.ts");
      const unrestrictedLower = await tools.readWorkspaceFile(boundary, "src/foo.ts");
      expect(unrestrictedUpper.content).not.toBe(unrestrictedLower.content);
    } finally {
      await tools.close();
    }
  });
});

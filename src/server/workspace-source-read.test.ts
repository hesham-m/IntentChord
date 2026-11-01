import { mkdtemp, mkdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createWorkspaceFilesystemObjectAuthority } from "@/core/workspace-index/filesystem-object-authority";
import { captureRegisteredWorkspaceSourceFile } from "@/server/workspace-source-read";
import type { AuthorizedWorkspaceSource } from "@/server/workspace-connector";

describe("Registered Workspace Source Evidence child authority", () => {
  it("T64 governed Source Evidence read stays parent-bound during nested parent substitution", async () => {
    if (process.platform !== "linux") return;
    const root = await mkdtemp(path.join(os.tmpdir(), "intentchord-source-evidence-t64-"));
    const src = path.join(root, "src");
    const displaced = path.join(root, "src-authorized");
    const replacement = path.join(root, "src-replacement");
    await mkdir(src, { recursive: true });
    await mkdir(replacement, { recursive: true });
    await writeFile(path.join(src, "evidence.txt"), "AUTHORIZED-SOURCE-EVIDENCE-T64");
    await writeFile(path.join(replacement, "evidence.txt"), "REPLACEMENT-SOURCE-EVIDENCE-T64");
    const bootstrap = createWorkspaceFilesystemObjectAuthority();
    const rootProof = await bootstrap.probeDirectory(root);
    await bootstrap.close();
    const authorized = {
      registration: {
        id: "11111111-1111-4111-8111-111111111111",
        normalizedReference: root,
        verifiedRootObjectIdentity: rootProof.identity,
        verificationStatus: "VERIFIED",
        referenceType: "LOCAL_PATH",
      },
      currentIdentity: {
        realPath: rootProof.resolved_real_path,
        rootObjectIdentity: rootProof.identity,
      },
    } as unknown as AuthorizedWorkspaceSource;
    let swapped = false;
    const objectAuthority = createWorkspaceFilesystemObjectAuthority({
      afterFileMetadataBeforeOpen: async ({ relativeFilePath }) => {
        if (swapped || relativeFilePath !== "src/evidence.txt") return;
        swapped = true;
        await rename(src, displaced);
        await rename(replacement, src);
      },
    });
    try {
      const result = await captureRegisteredWorkspaceSourceFile({
        workspaceId: authorized.registration.id,
        relativePath: "src/evidence.txt",
        maxPrefixBytes: 4096,
      }, {
        resolveAuthority: async () => authorized,
        objectAuthority,
      });
      expect(swapped).toBe(true);
      expect(result.captured.prefix_bytes.toString("utf8")).toBe("AUTHORIZED-SOURCE-EVIDENCE-T64");
      expect(result.captured.prefix_bytes.toString("utf8")).not.toContain("REPLACEMENT-SOURCE-EVIDENCE-T64");
    } finally {
      await objectAuthority.close().catch(() => undefined);
      if (swapped) {
        await rename(src, replacement).catch(() => undefined);
        await rename(displaced, src).catch(() => undefined);
      }
      await rm(root, { recursive: true, force: true });
    }
  });
  it("T77 governed Source Evidence Windows read enforces the shared absolute deadline and rejects partial evidence", async () => {
    if (process.platform !== "win32") return;
    const root = await mkdtemp(path.join(os.tmpdir(), "intentchord-source-evidence-t77-"));
    await writeFile(path.join(root, "evidence.txt"), "E".repeat(16 * 1024 * 1024));
    const bootstrap = createWorkspaceFilesystemObjectAuthority();
    const rootProof = await bootstrap.probeDirectory(root);
    await bootstrap.close();
    const authorized = {
      registration: { id: "77777777-7777-4777-8777-777777777777", normalizedReference: root, verifiedRootObjectIdentity: rootProof.identity, verificationStatus: "VERIFIED", referenceType: "LOCAL_PATH" },
      currentIdentity: { realPath: rootProof.resolved_real_path, rootObjectIdentity: rootProof.identity },
    } as unknown as AuthorizedWorkspaceSource;
    let progress = 0;
    const authority = createWorkspaceFilesystemObjectAuthority({ windowsCaptureChunkDelayMs: 50, onWindowsCaptureProgress: () => { progress += 1; } });
    try {
      await expect(captureRegisteredWorkspaceSourceFile({
        workspaceId: authorized.registration.id,
        relativePath: "evidence.txt",
        maxPrefixBytes: 0,
        deadlineAt: Date.now() + 8_000,
      }, { resolveAuthority: async () => authorized, objectAuthority: authority })).rejects.toMatchObject({ code: "WORKSPACE_INDEX_TIMEOUT" });
      expect(progress).toBeGreaterThan(0);
    } finally {
      await authority.close().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);

});

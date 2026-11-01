import path from "node:path";
import { captureWorkspaceFile, type CapturedWorkspaceFile } from "@/core/workspace-index/adapters/filesystem";
import {
  createWorkspaceFilesystemObjectAuthority,
  type WorkspaceFilesystemObjectAuthority,
} from "@/core/workspace-index/filesystem-object-authority";
import type { AuthorizedWorkspaceSource } from "@/server/workspace-connector";

export type RegisteredWorkspaceSourceAuthorityResolver = (workspaceId: string, governance?: { signal?: AbortSignal; deadlineAt?: number }) => Promise<AuthorizedWorkspaceSource>;

function normalizeRelativeSourcePath(value: string): string {
  const normalized = value.trim().replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+/g, "/").replace(/\/$/, "");
  if (
    !normalized
    || normalized.startsWith("/")
    || /^[A-Za-z]:\//.test(normalized)
    || normalized.split("/").some(segment => !segment || segment === "." || segment === "..")
    || normalized.includes("\0")
  ) {
    throw new Error("WORKSPACE_SOURCE_RELATIVE_PATH_INVALID");
  }
  return normalized;
}

/**
 * Shared Backend bridge from Registered Workspace authority to the core verified-child read primitive.
 * The absolute path is display/provenance only; authority is the persisted verified Root Object plus
 * parent-bound relative traversal in WorkspaceFilesystemObjectAuthority.
 */
export async function captureRegisteredWorkspaceSourceFile(
  input: {
    workspaceId: string;
    relativePath: string;
    maxPrefixBytes: number;
    countLines?: boolean;
    expectedFileIdentity?: { device_id: string; file_id: string; proof_method: "NODE_BIGINT_DEV_INO_V1" | "WINDOWS_FILE_ID_128_V1" };
    expectedSizeBytes?: number;
    signal?: AbortSignal;
    deadlineAt?: number;
    maxBytes?: number;
    byteBudgetCode?: string;
  },
  dependencies: {
    resolveAuthority?: RegisteredWorkspaceSourceAuthorityResolver;
    objectAuthority?: WorkspaceFilesystemObjectAuthority;
  } = {},
): Promise<{ captured: CapturedWorkspaceFile; authority: AuthorizedWorkspaceSource; normalizedRelativePath: string }> {
  const normalizedRelativePath = normalizeRelativeSourcePath(input.relativePath);
  const resolveAuthority = dependencies.resolveAuthority ?? (async (workspaceId: string, governance?: { signal?: AbortSignal; deadlineAt?: number }) => {
    const { assertRegisteredWorkspaceSourceAuthority } = await import("@/server/workspace-connector");
    return assertRegisteredWorkspaceSourceAuthority(workspaceId, governance);
  });
  const authority = await resolveAuthority(input.workspaceId, { signal: input.signal, deadlineAt: input.deadlineAt });
  const objectAuthority = dependencies.objectAuthority ?? createWorkspaceFilesystemObjectAuthority();
  const ownsObjectAuthority = !dependencies.objectAuthority;
  try {
    const displayAbsolutePath = path.resolve(authority.currentIdentity.realPath, ...normalizedRelativePath.split("/"));
    const captured = await captureWorkspaceFile(displayAbsolutePath, {
      maxPrefixBytes: input.maxPrefixBytes,
      countLines: input.countLines,
      authorizedRootPath: authority.registration.normalizedReference,
      authorizedRootRealPath: authority.currentIdentity.realPath,
      authorizedRootIdentity: authority.currentIdentity.rootObjectIdentity,
      relativePath: normalizedRelativePath,
      ...(input.expectedFileIdentity ? {
        expectedDeviceId: input.expectedFileIdentity.device_id,
        expectedInode: input.expectedFileIdentity.file_id,
        expectedProofMethod: input.expectedFileIdentity.proof_method,
      } : {}),
      expectedSizeBytes: input.expectedSizeBytes,
      signal: input.signal,
      deadlineAt: input.deadlineAt,
      maxBytes: input.maxBytes,
      byteBudgetCode: input.byteBudgetCode,
      objectAuthority,
    });
    return { captured, authority, normalizedRelativePath };
  } finally {
    if (ownsObjectAuthority) await objectAuthority.close().catch(() => undefined);
  }
}

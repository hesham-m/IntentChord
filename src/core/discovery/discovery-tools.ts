import path from "node:path";
import { captureWorkspaceFile } from "@/core/workspace-index/adapters/filesystem";
import { WorkspaceIndexBoundedError, isGlobalRuntimeGovernanceError } from "@/core/workspace-index/adapters/filesystem-errors";
import { localRelativePathIsWithin, localRelativePathKey, sameLocalAbsolutePath } from "@/core/workspace-index/local-path-semantics";
import {
  createWorkspaceFilesystemObjectAuthority,
  sameProofGradeFilesystemObject,
  type ProofGradeFilesystemObjectIdentity,
  type WorkspaceFilesystemObjectAuthority,
} from "@/core/workspace-index/filesystem-object-authority";

export type DiscoveryScopeMode = "FULL_WORKSPACE" | "SELECTED_PATHS" | "NONE";

export type DiscoveryWorkspaceBoundary = {
  id: string;
  displayName: string;
  rootReference: string;
  authorizedRootRealPath: string;
  authorizedRootObjectIdentity: ProofGradeFilesystemObjectIdentity;
  discoveryScopeMode: DiscoveryScopeMode;
  allowedPaths: string[];
  excludedPaths: string[];
};

export type DiscoverySearchHit = {
  workspaceId: string;
  relativePath: string;
  lineStart?: number;
  lineEnd?: number;
  contentSha256: string;
  matchedConcepts: string[];
  score: number;
  excerpt?: string;
};

export type DiscoveryFileRead = {
  workspaceId: string;
  relativePath: string;
  content: string;
  contentSha256: string;
  lineCount: number;
};

export type DiscoveryToolLimits = {
  maxFiles: number;
  maxFileBytes: number;
  maxResults: number;
  maxDepth: number;
};

export type DiscoveryReadGovernance = {
  signal?: AbortSignal;
  deadlineAt?: number;
};

const defaultLimits: DiscoveryToolLimits = {
  maxFiles: 5_000,
  maxFileBytes: 1_500_000,
  maxResults: 250,
  maxDepth: 18,
};

const textExtensions = new Set([
  ".c", ".cc", ".cpp", ".cs", ".css", ".csv", ".go", ".graphql", ".h", ".hpp",
  ".html", ".ini", ".java", ".js", ".json", ".jsonc", ".jsx", ".kt", ".kts", ".md",
  ".mjs", ".ps1", ".py", ".rb", ".rs", ".scss", ".sh", ".sql", ".toml", ".ts", ".tsx",
  ".txt", ".vue", ".xml", ".yaml", ".yml",
]);

const textFileNames = new Set([
  "dockerfile", "makefile", "procfile", "license", "readme", "agents.md",
]);

const ignoredSegments = new Set([
  ".git", ".next", ".next-dev", ".turbo", ".cache", "node_modules", "coverage", "dist", "build",
  "target", "vendor", "bin", "obj", "__pycache__", ".pytest_cache", ".mypy_cache",
]);

const sensitiveNames = [
  /^\.env(?:\..+)?$/i,
  /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$/i,
  /(?:^|[-_.])(credential|credentials|secret|secrets|token|tokens|password|passwords)(?:[-_.]|$)/i,
  /\.(?:p12|pfx|pem|key|keystore|jks)$/i,
];


export function normalizeDiscoveryRelativePath(value: string): string {
  const normalized = value.trim().replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+/g, "/");
  if (!normalized || normalized === ".") return "";
  if (
    normalized.startsWith("/")
    || /^[A-Za-z]:\//.test(normalized)
    || normalized.split("/").includes("..")
    || normalized.includes("\0")
  ) {
    throw new Error("DISCOVERY_PATH_OUTSIDE_WORKSPACE");
  }
  return normalized.replace(/\/$/, "");
}

function pathKey(value: string): string {
  return localRelativePathKey(normalizeDiscoveryRelativePath(value));
}

function isWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function pathIsWithin(relativePath: string, boundaryPath: string): boolean {
  return localRelativePathIsWithin(normalizeDiscoveryRelativePath(relativePath), normalizeDiscoveryRelativePath(boundaryPath));
}

function isExcluded(relativePath: string, excludedPaths: string[]): boolean {
  return excludedPaths.some(excluded => pathIsWithin(relativePath, excluded));
}

function isHardIgnored(relativePath: string): boolean {
  const segments = normalizeDiscoveryRelativePath(relativePath).split("/").filter(Boolean);
  if (segments.some(segment => ignoredSegments.has(segment.toLowerCase()))) return true;
  const name = segments.at(-1) ?? "";
  return sensitiveNames.some(pattern => pattern.test(name));
}

function isTextCandidate(relativePath: string): boolean {
  const base = path.basename(relativePath).toLowerCase();
  if (textFileNames.has(base)) return true;
  return textExtensions.has(path.extname(base));
}

function allowedByOwnerScope(boundary: DiscoveryWorkspaceBoundary, relativePath: string): boolean {
  if (boundary.discoveryScopeMode === "NONE") return false;
  if (isExcluded(relativePath, boundary.excludedPaths)) return false;
  if (boundary.discoveryScopeMode === "FULL_WORKSPACE") return true;
  return boundary.allowedPaths.some(allowed => pathIsWithin(relativePath, allowed));
}

function termVariants(term: string): string[] {
  const trimmed = term.trim().toLowerCase();
  if (!trimmed) return [];
  const variants = new Set<string>([trimmed]);
  variants.add(trimmed.replaceAll("-", " "));
  variants.add(trimmed.replaceAll("_", " "));
  variants.add(trimmed.replace(/\s+/g, "-"));
  variants.add(trimmed.replace(/\s+/g, "_"));
  return [...variants].filter(value => value.length >= 2);
}

function boundaryCacheKey(boundary: DiscoveryWorkspaceBoundary): string {
  return JSON.stringify({
    id: boundary.id,
    rootReference: boundary.rootReference,
    authorizedRootRealPath: boundary.authorizedRootRealPath,
    authorizedRootObjectIdentity: boundary.authorizedRootObjectIdentity,
    discoveryScopeMode: boundary.discoveryScopeMode,
    allowedPaths: [...boundary.allowedPaths].sort(),
    excludedPaths: [...boundary.excludedPaths].sort(),
  });
}

export class LocalBoundedDiscoveryTools {
  readonly limits: DiscoveryToolLimits;
  private readonly fileListCache = new Map<string, Promise<string[]>>();
  private readonly fileReadCache = new Map<string, Promise<DiscoveryFileRead>>();
  private readonly objectAuthority: WorkspaceFilesystemObjectAuthority;
  private readonly ownsObjectAuthority: boolean;

  constructor(
    limits: Partial<DiscoveryToolLimits> = {},
    objectAuthority?: WorkspaceFilesystemObjectAuthority,
  ) {
    this.limits = { ...defaultLimits, ...limits };
    this.objectAuthority = objectAuthority ?? createWorkspaceFilesystemObjectAuthority();
    this.ownsObjectAuthority = !objectAuthority;
  }

  async close(): Promise<void> {
    if (this.ownsObjectAuthority) await this.objectAuthority.close();
  }

  private async proveRoot(boundary: DiscoveryWorkspaceBoundary, governance: DiscoveryReadGovernance = {}): Promise<{ root: string; identity: ProofGradeFilesystemObjectIdentity }> {
    if (boundary.discoveryScopeMode === "NONE") throw new Error("DISCOVERY_WORKSPACE_READ_NOT_AUTHORIZED");
    if (!boundary.authorizedRootRealPath || !boundary.authorizedRootObjectIdentity) {
      throw new Error("DISCOVERY_WORKSPACE_ROOT_AUTHORITY_REQUIRED");
    }
    const current = await this.objectAuthority.probeDirectory(boundary.rootReference, governance);
    const expectedRealPath = path.normalize(boundary.authorizedRootRealPath);
    const currentRealPath = path.normalize(current.resolved_real_path);
    const samePath = sameLocalAbsolutePath(currentRealPath, expectedRealPath);
    if (!samePath || !sameProofGradeFilesystemObject(current.identity, boundary.authorizedRootObjectIdentity)) {
      throw new Error("DISCOVERY_WORKSPACE_ROOT_AUTHORITY_STALE");
    }
    return { root: currentRealPath, identity: current.identity };
  }

  private async resolveAuthorizedPath(
    boundary: DiscoveryWorkspaceBoundary,
    relativePath: string,
    governance: DiscoveryReadGovernance = {},
  ): Promise<{ root: string; rootIdentity: ProofGradeFilesystemObjectIdentity; absolutePath: string; normalizedRelativePath: string }> {
    const rootProof = await this.proveRoot(boundary, governance);
    const root = rootProof.root;
    const normalizedRelativePath = normalizeDiscoveryRelativePath(relativePath);
    if (!allowedByOwnerScope(boundary, normalizedRelativePath) || isHardIgnored(normalizedRelativePath)) {
      throw new Error("DISCOVERY_PATH_NOT_AUTHORIZED");
    }
    const joined = path.resolve(root, normalizedRelativePath || ".");
    if (!isWithinRoot(root, joined)) throw new Error("DISCOVERY_PATH_OUTSIDE_WORKSPACE");
    return { root, rootIdentity: rootProof.identity, absolutePath: joined, normalizedRelativePath };
  }

  async readWorkspaceFile(
    boundary: DiscoveryWorkspaceBoundary,
    relativePath: string,
    governance: DiscoveryReadGovernance = {},
  ): Promise<DiscoveryFileRead> {
    const normalizedRelativePath = normalizeDiscoveryRelativePath(relativePath);
    // Runtime-bounded reads are not cached: an aborted/deadline attempt must never poison a later governed retry.
    if (governance.signal || governance.deadlineAt !== undefined) {
      return this.readWorkspaceFileUncached(boundary, normalizedRelativePath, governance);
    }
    const cacheKey = `${boundaryCacheKey(boundary)}|${localRelativePathKey(normalizedRelativePath)}`;
    const cached = this.fileReadCache.get(cacheKey);
    if (cached) return cached;
    const pending = this.readWorkspaceFileUncached(boundary, normalizedRelativePath, governance).catch(error => {
      this.fileReadCache.delete(cacheKey);
      throw error;
    });
    this.fileReadCache.set(cacheKey, pending);
    return pending;
  }

  private async readWorkspaceFileUncached(
    boundary: DiscoveryWorkspaceBoundary,
    relativePath: string,
    governance: DiscoveryReadGovernance,
  ): Promise<DiscoveryFileRead> {
    const resolved = await this.resolveAuthorizedPath(boundary, relativePath, governance);
    if (!isTextCandidate(resolved.normalizedRelativePath)) throw new Error("DISCOVERY_BINARY_OR_UNSUPPORTED_FILE");
    let streamedBytes = 0;
    const captured = await captureWorkspaceFile(resolved.absolutePath, {
      maxPrefixBytes: this.limits.maxFileBytes + 1,
      authorizedRootPath: boundary.rootReference,
      authorizedRootRealPath: resolved.root,
      authorizedRootIdentity: resolved.rootIdentity,
      relativePath: resolved.normalizedRelativePath,
      objectAuthority: this.objectAuthority,
      countLines: true,
      signal: governance.signal,
      deadlineAt: governance.deadlineAt,
      maxBytes: this.limits.maxFileBytes,
      byteBudgetCode: "DISCOVERY_FILE_TOO_LARGE",
      onBytes: bytes => {
        streamedBytes += bytes;
        if (streamedBytes > this.limits.maxFileBytes) throw new Error("DISCOVERY_FILE_TOO_LARGE");
      },
    });
    if (captured.bytes_read > this.limits.maxFileBytes || !captured.prefix_complete_file) throw new Error("DISCOVERY_FILE_TOO_LARGE");
    const bytes = captured.prefix_bytes;
    if (bytes.includes(0)) throw new Error("DISCOVERY_BINARY_OR_UNSUPPORTED_FILE");
    const content = bytes.toString("utf8");
    return {
      workspaceId: boundary.id,
      relativePath: resolved.normalizedRelativePath,
      content,
      contentSha256: captured.content_hash.replace(/^sha256:/, ""),
      lineCount: content.length ? (captured.line_count ?? content.split(/\r?\n/).length) : 0,
    };
  }

  async listTextFiles(boundary: DiscoveryWorkspaceBoundary, governance: DiscoveryReadGovernance = {}): Promise<string[]> {
    if (governance.signal?.aborted) throw new WorkspaceIndexBoundedError("WORKSPACE_INDEX_ABORTED", { phase: "DISCOVERY" });
    if (governance.deadlineAt !== undefined && Date.now() >= governance.deadlineAt) throw new WorkspaceIndexBoundedError("WORKSPACE_INDEX_TIMEOUT", { phase: "DISCOVERY", deadlineAt: governance.deadlineAt });
    if (governance.signal || governance.deadlineAt !== undefined) return this.listTextFilesUncached(boundary, governance);
    const cacheKey = boundaryCacheKey(boundary);
    const cached = this.fileListCache.get(cacheKey);
    if (cached) return cached;
    const pending = this.listTextFilesUncached(boundary, governance).catch(error => {
      this.fileListCache.delete(cacheKey);
      throw error;
    });
    this.fileListCache.set(cacheKey, pending);
    return pending;
  }

  private async listTextFilesUncached(boundary: DiscoveryWorkspaceBoundary, governance: DiscoveryReadGovernance): Promise<string[]> {
    const rootProof = await this.proveRoot(boundary, governance);
    const root = rootProof.root;
    const files: string[] = [];
    const queue: Array<{ relativePath: string; depth: number; identity: ProofGradeFilesystemObjectIdentity }> = [
      { relativePath: "", depth: 0, identity: rootProof.identity },
    ];
    const seen = new Set<string>();

    while (queue.length && files.length < this.limits.maxFiles) {
      if (governance.signal?.aborted) throw new WorkspaceIndexBoundedError("WORKSPACE_INDEX_ABORTED", { phase: "DISCOVERY" });
      if (governance.deadlineAt !== undefined && Date.now() >= governance.deadlineAt) throw new WorkspaceIndexBoundedError("WORKSPACE_INDEX_TIMEOUT", { phase: "DISCOVERY", deadlineAt: governance.deadlineAt });
      const current = queue.shift()!;
      const currentKey = pathKey(current.relativePath);
      if (seen.has(currentKey)) continue;
      seen.add(currentKey);
      if (current.depth > this.limits.maxDepth) continue;

      // For SELECTED_PATHS, ancestors are traversed only to reach the approved subtree; unrelated branches are never queued.
      if (current.relativePath && boundary.discoveryScopeMode === "SELECTED_PATHS") {
        const currentNormalized = normalizeDiscoveryRelativePath(current.relativePath);
        const intersectsApproved = boundary.allowedPaths.some(allowed => {
          const approved = normalizeDiscoveryRelativePath(allowed);
          return pathIsWithin(currentNormalized, approved) || pathIsWithin(approved, currentNormalized);
        });
        if (!intersectsApproved) continue;
      }
      if (current.relativePath && isExcluded(current.relativePath, boundary.excludedPaths)) continue;

      const absolute = path.resolve(root, current.relativePath || ".");
      if (!isWithinRoot(root, absolute)) throw new Error("DISCOVERY_PATH_OUTSIDE_WORKSPACE");
      let enumerated;
      try {
        enumerated = await this.objectAuthority.enumerateRelativeDirectory({
          rootPath: boundary.rootReference,
          rootIdentity: rootProof.identity,
          relativeDirectoryPath: current.relativePath,
          expectedDirectoryIdentity: current.identity,
          signal: governance.signal,
          deadlineAt: governance.deadlineAt,
        });
      } catch (error) {
        if (isGlobalRuntimeGovernanceError(error)) throw error;
        throw new Error("DISCOVERY_DIRECTORY_AUTHORITY_FAILED");
      }
      if (!sameProofGradeFilesystemObject(enumerated.identity, current.identity) || !isWithinRoot(root, enumerated.resolved_real_path)) {
        throw new Error("DISCOVERY_DIRECTORY_AUTHORITY_FAILED");
      }

      for (const child of enumerated.entries) {
        const relativePath = normalizeDiscoveryRelativePath(current.relativePath ? `${current.relativePath}/${child.name}` : child.name);
        if (isHardIgnored(relativePath) || isExcluded(relativePath, boundary.excludedPaths)) continue;
        const potentiallyApproved = boundary.discoveryScopeMode === "FULL_WORKSPACE" || boundary.allowedPaths.some(allowed => {
          const approved = normalizeDiscoveryRelativePath(allowed);
          return pathIsWithin(relativePath, approved) || pathIsWithin(approved, relativePath);
        });
        if (!potentiallyApproved) continue;
        if (child.object_type === "BOUNDARY" || child.object_type === "OTHER") continue;
        if (child.object_type === "DIRECTORY") {
          if (!child.identity) throw new Error("DISCOVERY_DIRECTORY_AUTHORITY_FAILED");
          queue.push({ relativePath, depth: current.depth + 1, identity: child.identity });
          continue;
        }
        if (child.object_type !== "FILE" || child.size_bytes === undefined) continue;
        const size = child.size_bytes;
        if (!Number.isSafeInteger(size) || size > this.limits.maxFileBytes) continue;
        if (allowedByOwnerScope(boundary, relativePath) && isTextCandidate(relativePath)) files.push(relativePath);
      }
    }
    // Re-prove the Registered Root Object before accepting the discovered file list.
    await this.proveRoot(boundary, governance);
    return [...new Set(files)].sort((left, right) => left.localeCompare(right));
  }

  async searchWorkspaceText(
    boundary: DiscoveryWorkspaceBoundary,
    concepts: string[],
    governance: DiscoveryReadGovernance = {},
  ): Promise<DiscoverySearchHit[]> {
    const normalizedConcepts = [...new Set(concepts.map(item => item.trim()).filter(Boolean))].slice(0, 100);
    const conceptVariants = normalizedConcepts.map(concept => ({
      concept,
      variants: termVariants(concept),
    })).filter(item => item.variants.length);
    if (!conceptVariants.length) return [];

    const files = await this.listTextFiles(boundary, governance);
    const hits: DiscoverySearchHit[] = [];
    for (const relativePath of files) {
      let read;
      try {
        read = await this.readWorkspaceFile(boundary, relativePath, governance);
      } catch (error) {
        if (isGlobalRuntimeGovernanceError(error)) throw error;
        continue;
      }
      const lowerPath = relativePath.toLowerCase();
      const lowerContent = read.content.toLowerCase();
      const matchedConcepts: string[] = [];
      let score = 0;
      let firstLine: number | undefined;
      for (const item of conceptVariants) {
        const pathMatched = item.variants.some(variant => lowerPath.includes(variant));
        let contentIndex = -1;
        for (const variant of item.variants) {
          const index = lowerContent.indexOf(variant);
          if (index >= 0 && (contentIndex < 0 || index < contentIndex)) contentIndex = index;
        }
        if (!pathMatched && contentIndex < 0) continue;
        matchedConcepts.push(item.concept);
        if (pathMatched) score += 12;
        if (contentIndex >= 0) {
          score += 5;
          const before = read.content.slice(0, contentIndex);
          const line = before.split(/\r?\n/).length;
          if (firstLine === undefined || line < firstLine) firstLine = line;
          const occurrenceCount = item.variants.reduce((count, variant) => {
            let offset = 0;
            let occurrences = 0;
            while (occurrences < 5) {
              const found = lowerContent.indexOf(variant, offset);
              if (found < 0) break;
              occurrences += 1;
              offset = found + Math.max(variant.length, 1);
            }
            return count + occurrences;
          }, 0);
          score += Math.min(occurrenceCount, 10);
        }
      }
      if (!matchedConcepts.length) continue;
      const lines = read.content.split(/\r?\n/);
      const excerpt = firstLine
        ? lines.slice(Math.max(0, firstLine - 2), Math.min(lines.length, firstLine + 1)).join("\n").slice(0, 1_000)
        : undefined;
      hits.push({
        workspaceId: boundary.id,
        relativePath,
        ...(firstLine ? { lineStart: firstLine, lineEnd: firstLine } : {}),
        contentSha256: read.contentSha256,
        matchedConcepts: [...new Set(matchedConcepts)],
        score,
        ...(excerpt ? { excerpt } : {}),
      });
    }
    return hits
      .sort((left, right) => right.score - left.score || left.relativePath.localeCompare(right.relativePath))
      .slice(0, this.limits.maxResults);
  }
}

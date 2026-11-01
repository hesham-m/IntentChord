import { createHash } from "node:crypto";
import { constants as fsConstants, type BigIntStats } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface as ReadLineInterface } from "node:readline";
import path from "node:path";
import { WorkspaceIndexBoundedError } from "@/core/workspace-index/adapters/filesystem-errors";

export type ProofGradeFilesystemObjectIdentity = {
  device_id: string;
  file_id: string;
  proof_method: "NODE_BIGINT_DEV_INO_V1" | "WINDOWS_FILE_ID_128_V1";
};

export type VerifiedDirectoryObject = {
  resolved_real_path: string;
  identity: ProofGradeFilesystemObjectIdentity;
};

export type AuthorizedChildObject = {
  name: string;
  object_type: "FILE" | "DIRECTORY" | "BOUNDARY" | "OTHER";
  identity?: ProofGradeFilesystemObjectIdentity;
  size_bytes?: number;
  mode?: number;
  modified_at_ms?: number;
  created_at_ms?: number;
  boundary_code?: "SYMLINK_NOT_FOLLOWED" | "REPARSE_POINT_NOT_FOLLOWED";
};

export type EnumeratedDirectoryObject = VerifiedDirectoryObject & {
  entries: AuthorizedChildObject[];
};

export type CapturedAuthorizedFile = {
  identity: ProofGradeFilesystemObjectIdentity;
  content_hash: string;
  bytes_read: number;
  prefix_bytes: Buffer;
  prefix_complete_file: boolean;
  line_count?: number;
};

export type WorkspaceOperationRuntimeGovernance = {
  signal?: AbortSignal;
  deadlineAt?: number;
};

export type WorkspaceFilesystemAuthorityTestHooks = {
  afterDirectoryNamesEnumerated?: (input: { rootPath: string; relativeDirectoryPath: string; names: string[] }) => void | Promise<void>;
  afterFileMetadataBeforeOpen?: (input: { rootPath: string; relativeFilePath: string }) => void | Promise<void>;
  /** Windows-only deterministic test delay before the single-request helper starts capture. */
  windowsCaptureStartupDelayMs?: number;
  /** Windows-only deterministic per-chunk delay used to prove mid-file cancellation/deadline. */
  windowsCaptureChunkDelayMs?: number;
  /** Windows-only deterministic response delay used to prove cancellation remains active through response transfer. */
  windowsCaptureResponseDelayMs?: number;
  onWindowsCaptureHelperSpawned?: (pid: number) => void;
  onWindowsCaptureHelperClosed?: (pid: number) => void;
  onWindowsCaptureProgress?: (input: { pid: number; bytes: number }) => void;
  /** Windows-only deterministic startup delay used to prove governed Root probe cancellation/deadline. */
  windowsRootProbeStartupDelayMs?: number;
  onWindowsRootProbeHelperSpawned?: (pid: number) => void;
  onWindowsRootProbeHelperClosed?: (pid: number) => void;
  /** Windows-only persistent metadata helper lifecycle (Root probe + directory enumeration). */
  onWindowsMetadataHelperSpawned?: (pid: number) => void;
  onWindowsMetadataHelperClosed?: (pid: number) => void;
  onWindowsMetadataRequest?: (input: { pid: number; operation: "probe" | "enumerate_relative" }) => void;
  /** Windows-only deterministic per-batch delay used to prove mid-directory cancellation/deadline. */
  windowsEnumerationChunkDelayMs?: number;
  onWindowsEnumerationHelperSpawned?: (pid: number) => void;
  onWindowsEnumerationHelperClosed?: (pid: number) => void;
  onWindowsEnumerationProgress?: (input: { pid: number; entries: number }) => void;
  /** Non-Windows deterministic hooks used to prove active-operation terminal governance. */
  nonWindowsRootProbeDelayMs?: number;
  onNonWindowsRootProbeStarted?: () => void;
  nonWindowsCaptureChunkDelayMs?: number;
  onNonWindowsCaptureProgress?: (bytes: number) => void;
  nonWindowsEnumerationChunkDelayMs?: number;
  onNonWindowsEnumerationProgress?: (entries: number) => void;
};
export interface WorkspaceFilesystemObjectAuthority {
  probeDirectory(absolutePath: string, governance?: WorkspaceOperationRuntimeGovernance): Promise<VerifiedDirectoryObject>;
  enumerateRelativeDirectory(input: {
    rootPath: string;
    rootIdentity: ProofGradeFilesystemObjectIdentity;
    relativeDirectoryPath: string;
    expectedDirectoryIdentity?: ProofGradeFilesystemObjectIdentity;
    signal?: AbortSignal;
    deadlineAt?: number;
  }): Promise<EnumeratedDirectoryObject>;
  captureRelativeFile(input: {
    rootPath: string;
    rootIdentity: ProofGradeFilesystemObjectIdentity;
    relativeFilePath: string;
    expectedFileIdentity?: ProofGradeFilesystemObjectIdentity;
    expectedSizeBytes?: number;
    maxPrefixBytes: number;
    countLines?: boolean;
    signal?: AbortSignal;
    deadlineAt?: number;
    /** Existing governed byte allowance for this capture. Undefined means no additional capture-byte cap. */
    maxBytes?: number;
    /** Existing caller classification for byte-budget exhaustion. */
    byteBudgetCode?: string;
    onBytes?: (bytes: number) => void;
  }): Promise<CapturedAuthorizedFile>;
  close(): Promise<void>;
}

function normalizeRealPath(value: string): string {
  if (process.platform === "win32") {
    if (value.startsWith("\\\\?\\UNC\\")) return `\\\\${value.slice(8)}`;
    if (value.startsWith("\\\\?\\")) return value.slice(4);
  }
  return path.normalize(value);
}

export function sameProofGradeFilesystemObject(
  left: ProofGradeFilesystemObjectIdentity,
  right: ProofGradeFilesystemObjectIdentity,
): boolean {
  return left.proof_method === right.proof_method
    && left.device_id === right.device_id
    && left.file_id === right.file_id;
}

export function proofGradeNodeObjectIdentityFromStats(stats: BigIntStats): ProofGradeFilesystemObjectIdentity {
  const candidate = stats as { dev: bigint; ino: bigint };
  if (typeof candidate.dev !== "bigint" || typeof candidate.ino !== "bigint" || candidate.ino === BigInt(0)) {
    throw new WorkspaceIndexBoundedError("WORKSPACE_OBJECT_IDENTITY_UNPROVABLE", { phase: "SOURCE_AUTHORITY" });
  }
  return {
    device_id: candidate.dev.toString(10),
    file_id: candidate.ino.toString(10),
    proof_method: "NODE_BIGINT_DEV_INO_V1",
  };
}

function normalizeRelativeObjectPath(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
  if (!normalized || normalized === ".") return "";
  const segments = normalized.split("/");
  if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized) || segments.some(segment => !segment || segment === "." || segment === "..") || normalized.includes("\0")) {
    throw new WorkspaceIndexBoundedError("WORKSPACE_SOURCE_RELATIVE_PATH_INVALID", { phase: "SOURCE_AUTHORITY", path: value });
  }
  return segments.join("/");
}

function configureWindowsAuthorityUtf8Protocol(child: ChildProcessWithoutNullStreams): void {
  child.stdin.setDefaultEncoding("utf8");
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
}

function safeBigIntNumber(value: bigint, code: string): number {
  const converted = Number(value);
  if (!Number.isSafeInteger(converted)) throw new WorkspaceIndexBoundedError(code, { phase: "SOURCE_AUTHORITY" });
  return converted;
}

function linuxDirectoryFlags(): number {
  return fsConstants.O_RDONLY
    | (typeof fsConstants.O_DIRECTORY === "number" ? fsConstants.O_DIRECTORY : 0)
    | (typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0);
}

async function openLinuxDirectory(pathValue: string) {
  return open(pathValue, linuxDirectoryFlags());
}

async function openVerifiedLinuxRoot(rootPath: string, rootIdentity: ProofGradeFilesystemObjectIdentity) {
  if (rootIdentity.proof_method !== "NODE_BIGINT_DEV_INO_V1") {
    throw new WorkspaceIndexBoundedError("WORKSPACE_OBJECT_IDENTITY_UNPROVABLE", { phase: "SOURCE_AUTHORITY", path: rootPath });
  }
  const handle = await openLinuxDirectory(rootPath);
  const stat = await handle.stat({ bigint: true });
  if (!stat.isDirectory()) {
    await handle.close();
    throw new WorkspaceIndexBoundedError("WORKSPACE_ROOT_NOT_DIRECTORY", { phase: "SOURCE_AUTHORITY", path: rootPath });
  }
  const identity = proofGradeNodeObjectIdentityFromStats(stat);
  if (!sameProofGradeFilesystemObject(identity, rootIdentity)) {
    await handle.close();
    throw new WorkspaceIndexBoundedError("WORKSPACE_ROOT_AUTHORITY_CHANGED", { phase: "SOURCE_AUTHORITY", path: rootPath });
  }
  return handle;
}

async function traverseLinuxDirectoryFromVerifiedRoot(
  rootPath: string,
  rootIdentity: ProofGradeFilesystemObjectIdentity,
  relativeDirectoryPath: string,
) {
  const relative = normalizeRelativeObjectPath(relativeDirectoryPath);
  let current = await openVerifiedLinuxRoot(rootPath, rootIdentity);
  try {
    for (const segment of relative ? relative.split("/") : []) {
      const childPath = `/proc/self/fd/${current.fd}/${segment}`;
      const metadata = await lstat(childPath, { bigint: true });
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new WorkspaceIndexBoundedError("WORKSPACE_DIRECTORY_REPARSE_POINT", { phase: "SOURCE_AUTHORITY", path: relativeDirectoryPath });
      }
      const child = await openLinuxDirectory(childPath);
      const childStat = await child.stat({ bigint: true });
      const metadataIdentity = proofGradeNodeObjectIdentityFromStats(metadata);
      const openedIdentity = proofGradeNodeObjectIdentityFromStats(childStat);
      if (!childStat.isDirectory() || !sameProofGradeFilesystemObject(metadataIdentity, openedIdentity)) {
        await child.close();
        throw new WorkspaceIndexBoundedError("WORKSPACE_DIRECTORY_OBJECT_IDENTITY_CHANGED", { phase: "SOURCE_AUTHORITY", path: relativeDirectoryPath });
      }
      await current.close();
      current = child;
    }
    return current;
  } catch (error) {
    await current.close().catch(() => undefined);
    throw error;
  }
}

async function describeLinuxChild(parentFd: number, name: string): Promise<AuthorizedChildObject> {
  const childPath = `/proc/self/fd/${parentFd}/${name}`;
  const metadata = await lstat(childPath, { bigint: true });
  if (metadata.isSymbolicLink()) {
    return { name, object_type: "BOUNDARY", boundary_code: "SYMLINK_NOT_FOLLOWED" };
  }
  if (!metadata.isFile() && !metadata.isDirectory()) return { name, object_type: "OTHER" };
  const handle = metadata.isDirectory()
    ? await openLinuxDirectory(childPath)
    : await open(childPath, fsConstants.O_RDONLY | (typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0));
  try {
    const opened = await handle.stat({ bigint: true });
    const metadataIdentity = proofGradeNodeObjectIdentityFromStats(metadata);
    const openedIdentity = proofGradeNodeObjectIdentityFromStats(opened);
    if (!sameProofGradeFilesystemObject(metadataIdentity, openedIdentity)) {
      throw new WorkspaceIndexBoundedError("WORKSPACE_CHILD_OBJECT_IDENTITY_CHANGED", { phase: "SOURCE_AUTHORITY", path: name });
    }
    const common = {
      name,
      identity: openedIdentity,
      size_bytes: safeBigIntNumber(opened.size, "WORKSPACE_FILE_SIZE_UNREPRESENTABLE"),
      mode: safeBigIntNumber(opened.mode, "WORKSPACE_FILE_MODE_UNREPRESENTABLE"),
      modified_at_ms: safeBigIntNumber(opened.mtimeNs / BigInt(1_000_000), "WORKSPACE_FILE_TIME_UNREPRESENTABLE"),
      created_at_ms: safeBigIntNumber(opened.birthtimeNs / BigInt(1_000_000), "WORKSPACE_FILE_TIME_UNREPRESENTABLE"),
    };
    return metadata.isDirectory()
      ? { ...common, object_type: "DIRECTORY" }
      : { ...common, object_type: "FILE" };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function captureLinuxRelativeFile(input: Parameters<WorkspaceFilesystemObjectAuthority["captureRelativeFile"]>[0], hooks: WorkspaceFilesystemAuthorityTestHooks = {}): Promise<CapturedAuthorizedFile> {
  const relative = normalizeRelativeObjectPath(input.relativeFilePath);
  if (!relative) throw new WorkspaceIndexBoundedError("WORKSPACE_SOURCE_RELATIVE_PATH_INVALID", { phase: "SOURCE_AUTHORITY" });
  const segments = relative.split("/");
  const fileName = segments.pop()!;
  const parent = await traverseLinuxDirectoryFromVerifiedRoot(input.rootPath, input.rootIdentity, segments.join("/"));
  let fileHandle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const childPath = `/proc/self/fd/${parent.fd}/${fileName}`;
    const metadata = await lstat(childPath, { bigint: true });
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new WorkspaceIndexBoundedError("WORKSPACE_SOURCE_PATH_SUBSTITUTION", { phase: "SOURCE_AUTHORITY", path: input.relativeFilePath });
    }
    await hooks.afterFileMetadataBeforeOpen?.({ rootPath: input.rootPath, relativeFilePath: input.relativeFilePath });
    fileHandle = await open(childPath, fsConstants.O_RDONLY | (typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0));
    const opened = await fileHandle.stat({ bigint: true });
    const metadataIdentity = proofGradeNodeObjectIdentityFromStats(metadata);
    const openedIdentity = proofGradeNodeObjectIdentityFromStats(opened);
    if (!opened.isFile() || !sameProofGradeFilesystemObject(metadataIdentity, openedIdentity)) {
      throw new WorkspaceIndexBoundedError("WORKSPACE_CHILD_OBJECT_IDENTITY_CHANGED", { phase: "SOURCE_AUTHORITY", path: input.relativeFilePath });
    }
    if (input.expectedFileIdentity && !sameProofGradeFilesystemObject(openedIdentity, input.expectedFileIdentity)) {
      throw new WorkspaceIndexBoundedError("WORKSPACE_SOURCE_OBJECT_IDENTITY_CHANGED", { phase: "SOURCE_AUTHORITY", path: input.relativeFilePath });
    }
    if (input.expectedSizeBytes !== undefined && BigInt(input.expectedSizeBytes) !== opened.size) {
      throw new WorkspaceIndexBoundedError("WORKSPACE_SOURCE_OBJECT_SIZE_CHANGED", { phase: "SOURCE_AUTHORITY", path: input.relativeFilePath });
    }
    const stream = fileHandle.createReadStream({ autoClose: false, highWaterMark: 64 * 1024 });
    const hash = createHash("sha256");
    const chunks: Buffer[] = [];
    let prefixBytes = 0;
    let totalBytes = 0;
    let newlineCount = 0;
    for await (const rawChunk of stream) {
      if (input.signal?.aborted) throw new WorkspaceIndexBoundedError("WORKSPACE_INDEX_ABORTED", { phase: "CAPTURE" });
      if (input.deadlineAt !== undefined && Date.now() >= input.deadlineAt) throw new WorkspaceIndexBoundedError("WORKSPACE_INDEX_TIMEOUT", { phase: "CAPTURE" });
      const chunk = Buffer.from(rawChunk as Uint8Array);
      hooks.onNonWindowsCaptureProgress?.(chunk.length);
      if ((hooks.nonWindowsCaptureChunkDelayMs ?? 0) > 0) await new Promise(resolve => setTimeout(resolve, hooks.nonWindowsCaptureChunkDelayMs));
      if (input.signal?.aborted) throw new WorkspaceIndexBoundedError("WORKSPACE_INDEX_ABORTED", { phase: "CAPTURE" });
      if (input.deadlineAt !== undefined && Date.now() >= input.deadlineAt) throw new WorkspaceIndexBoundedError("WORKSPACE_INDEX_TIMEOUT", { phase: "CAPTURE" });
      if (input.maxBytes !== undefined && totalBytes + chunk.length > input.maxBytes) {
        throw new WorkspaceIndexBoundedError(input.byteBudgetCode ?? "WORKSPACE_CAPTURE_BYTE_BUDGET_EXCEEDED", {
          phase: "CAPTURE",
          bytesRead: totalBytes,
          nextChunkBytes: chunk.length,
          maxBytes: input.maxBytes,
        });
      }
      hash.update(chunk);
      totalBytes += chunk.length;
      input.onBytes?.(chunk.length);
      if (input.countLines) for (const byte of chunk) if (byte === 0x0a) newlineCount += 1;
      const remaining = input.maxPrefixBytes - prefixBytes;
      if (remaining > 0) {
        const taken = chunk.subarray(0, Math.min(remaining, chunk.length));
        chunks.push(taken);
        prefixBytes += taken.length;
      }
    }
    const after = proofGradeNodeObjectIdentityFromStats(await fileHandle.stat({ bigint: true }));
    if (!sameProofGradeFilesystemObject(after, openedIdentity)) {
      throw new WorkspaceIndexBoundedError("WORKSPACE_SOURCE_OBJECT_IDENTITY_CHANGED", { phase: "SOURCE_AUTHORITY", path: input.relativeFilePath });
    }
    return {
      identity: openedIdentity,
      content_hash: `sha256:${hash.digest("hex")}`,
      bytes_read: totalBytes,
      prefix_bytes: Buffer.concat(chunks, prefixBytes),
      prefix_complete_file: prefixBytes === totalBytes,
      ...(input.countLines ? { line_count: totalBytes === 0 ? 0 : newlineCount + 1 } : {}),
    };
  } finally {
    await fileHandle?.close().catch(() => undefined);
    await parent.close().catch(() => undefined);
  }
}

class LinuxFilesystemObjectAuthority implements WorkspaceFilesystemObjectAuthority {
  constructor(private readonly hooks: WorkspaceFilesystemAuthorityTestHooks = {}) {}
  async probeDirectory(absolutePath: string, governance: WorkspaceOperationRuntimeGovernance = {}): Promise<VerifiedDirectoryObject> {
    if (governance.signal?.aborted) throw new WorkspaceIndexBoundedError("WORKSPACE_INDEX_ABORTED", { phase: "SOURCE_AUTHORITY", path: absolutePath });
    if (governance.deadlineAt !== undefined && Date.now() >= governance.deadlineAt) {
      throw new WorkspaceIndexBoundedError("WORKSPACE_INDEX_TIMEOUT", { phase: "SOURCE_AUTHORITY", path: absolutePath, deadlineAt: governance.deadlineAt });
    }
    const operation = (async () => {
      const handle = await openLinuxDirectory(absolutePath);
      this.hooks.onNonWindowsRootProbeStarted?.();
      try {
        if ((this.hooks.nonWindowsRootProbeDelayMs ?? 0) > 0) await new Promise(resolve => setTimeout(resolve, this.hooks.nonWindowsRootProbeDelayMs));
        const stat = await handle.stat({ bigint: true });
        if (!stat.isDirectory()) throw new WorkspaceIndexBoundedError("WORKSPACE_ROOT_NOT_DIRECTORY", { phase: "SOURCE_AUTHORITY", path: absolutePath });
        return { resolved_real_path: await realpath(`/proc/self/fd/${handle.fd}`), identity: proofGradeNodeObjectIdentityFromStats(stat) };
      } finally {
        await handle.close().catch(() => undefined);
      }
    })();
    return await new Promise<VerifiedDirectoryObject>((resolve, reject) => {
      let settled = false;
      let deadlineTimer: NodeJS.Timeout | undefined;
      const cleanup = () => {
        if (deadlineTimer) clearTimeout(deadlineTimer);
        governance.signal?.removeEventListener("abort", onAbort);
      };
      const settleReject = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const onAbort = () => settleReject(new WorkspaceIndexBoundedError("WORKSPACE_INDEX_ABORTED", { phase: "SOURCE_AUTHORITY", path: absolutePath }));
      governance.signal?.addEventListener("abort", onAbort, { once: true });
      if (governance.signal?.aborted) onAbort();
      if (governance.deadlineAt !== undefined && !settled) {
        const remainingMs = governance.deadlineAt - Date.now();
        if (remainingMs <= 0) settleReject(new WorkspaceIndexBoundedError("WORKSPACE_INDEX_TIMEOUT", { phase: "SOURCE_AUTHORITY", path: absolutePath, deadlineAt: governance.deadlineAt }));
        else {
          deadlineTimer = setTimeout(() => settleReject(new WorkspaceIndexBoundedError("WORKSPACE_INDEX_TIMEOUT", { phase: "SOURCE_AUTHORITY", path: absolutePath, deadlineAt: governance.deadlineAt })), remainingMs);
          deadlineTimer.unref?.();
        }
      }
      operation.then(value => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      }, error => settleReject(error instanceof Error ? error : new Error(String(error))));
    });
  }

  async enumerateRelativeDirectory(input: {
    rootPath: string;
    rootIdentity: ProofGradeFilesystemObjectIdentity;
    relativeDirectoryPath: string;
    expectedDirectoryIdentity?: ProofGradeFilesystemObjectIdentity;
    signal?: AbortSignal;
    deadlineAt?: number;
  }): Promise<EnumeratedDirectoryObject> {
    if (input.signal?.aborted) throw new WorkspaceIndexBoundedError("WORKSPACE_INDEX_ABORTED", { phase: "DISCOVERING", path: input.relativeDirectoryPath });
    if (input.deadlineAt !== undefined && Date.now() >= input.deadlineAt) throw new WorkspaceIndexBoundedError("WORKSPACE_INDEX_TIMEOUT", { phase: "DISCOVERING", path: input.relativeDirectoryPath, deadlineAt: input.deadlineAt });
    const handle = await traverseLinuxDirectoryFromVerifiedRoot(input.rootPath, input.rootIdentity, input.relativeDirectoryPath);
    try {
      const before = await handle.stat({ bigint: true });
      const identity = proofGradeNodeObjectIdentityFromStats(before);
      if (input.expectedDirectoryIdentity && !sameProofGradeFilesystemObject(identity, input.expectedDirectoryIdentity)) {
        throw new WorkspaceIndexBoundedError("WORKSPACE_DIRECTORY_OBJECT_IDENTITY_CHANGED", { phase: "SOURCE_AUTHORITY", path: input.relativeDirectoryPath });
      }
      const procPath = `/proc/self/fd/${handle.fd}`;
      const dir = await opendir(procPath);
      const names: string[] = [];
      let deadlineTimer: NodeJS.Timeout | undefined;
      const closeForAbort = () => { void dir.close().catch(() => undefined); };
      input.signal?.addEventListener("abort", closeForAbort, { once: true });
      if (input.deadlineAt !== undefined) {
        const remainingMs = input.deadlineAt - Date.now();
        if (remainingMs <= 0) {
          input.signal?.removeEventListener("abort", closeForAbort);
          await dir.close().catch(() => undefined);
          throw new WorkspaceIndexBoundedError("WORKSPACE_INDEX_TIMEOUT", { phase: "DISCOVERING", path: input.relativeDirectoryPath, deadlineAt: input.deadlineAt });
        }
        deadlineTimer = setTimeout(closeForAbort, remainingMs);
        deadlineTimer.unref?.();
      }
      try {
        try {
          for await (const entry of dir) {
            if (input.signal?.aborted) throw new WorkspaceIndexBoundedError("WORKSPACE_INDEX_ABORTED", { phase: "DISCOVERING", path: input.relativeDirectoryPath });
            if (input.deadlineAt !== undefined && Date.now() >= input.deadlineAt) throw new WorkspaceIndexBoundedError("WORKSPACE_INDEX_TIMEOUT", { phase: "DISCOVERING", path: input.relativeDirectoryPath, deadlineAt: input.deadlineAt });
            names.push(entry.name);
            this.hooks.onNonWindowsEnumerationProgress?.(names.length);
            if ((this.hooks.nonWindowsEnumerationChunkDelayMs ?? 0) > 0) await new Promise(resolve => setTimeout(resolve, this.hooks.nonWindowsEnumerationChunkDelayMs));
            if (input.signal?.aborted) throw new WorkspaceIndexBoundedError("WORKSPACE_INDEX_ABORTED", { phase: "DISCOVERING", path: input.relativeDirectoryPath });
            if (input.deadlineAt !== undefined && Date.now() >= input.deadlineAt) throw new WorkspaceIndexBoundedError("WORKSPACE_INDEX_TIMEOUT", { phase: "DISCOVERING", path: input.relativeDirectoryPath, deadlineAt: input.deadlineAt });
          }
        } catch (error) {
          if (input.signal?.aborted) throw new WorkspaceIndexBoundedError("WORKSPACE_INDEX_ABORTED", { phase: "DISCOVERING", path: input.relativeDirectoryPath });
          if (input.deadlineAt !== undefined && Date.now() >= input.deadlineAt) throw new WorkspaceIndexBoundedError("WORKSPACE_INDEX_TIMEOUT", { phase: "DISCOVERING", path: input.relativeDirectoryPath, deadlineAt: input.deadlineAt });
          throw error;
        }
      } finally {
        if (deadlineTimer) clearTimeout(deadlineTimer);
        input.signal?.removeEventListener("abort", closeForAbort);
        await dir.close().catch(() => undefined);
      }
      await this.hooks.afterDirectoryNamesEnumerated?.({ rootPath: input.rootPath, relativeDirectoryPath: input.relativeDirectoryPath, names: [...names] });
      const entries: AuthorizedChildObject[] = [];
      for (const name of names.sort((a, b) => a.localeCompare(b))) {
        if (input.signal?.aborted) throw new WorkspaceIndexBoundedError("WORKSPACE_INDEX_ABORTED", { phase: "DISCOVERING", path: input.relativeDirectoryPath });
        if (input.deadlineAt !== undefined && Date.now() >= input.deadlineAt) throw new WorkspaceIndexBoundedError("WORKSPACE_INDEX_TIMEOUT", { phase: "DISCOVERING", path: input.relativeDirectoryPath, deadlineAt: input.deadlineAt });
        entries.push(await describeLinuxChild(handle.fd, name));
      }
      const after = proofGradeNodeObjectIdentityFromStats(await handle.stat({ bigint: true }));
      if (!sameProofGradeFilesystemObject(identity, after)) {
        throw new WorkspaceIndexBoundedError("WORKSPACE_DIRECTORY_OBJECT_IDENTITY_CHANGED", { phase: "SOURCE_AUTHORITY", path: input.relativeDirectoryPath });
      }
      return { resolved_real_path: await realpath(procPath), identity, entries };
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  async captureRelativeFile(input: Parameters<WorkspaceFilesystemObjectAuthority["captureRelativeFile"]>[0]): Promise<CapturedAuthorizedFile> {
    return captureLinuxRelativeFile(input, this.hooks);
  }

  async close(): Promise<void> {}
}

type WindowsAuthorityResponse = {
  ok: boolean;
  code: string;
  message?: string;
  resolved_real_path?: string;
  identity?: ProofGradeFilesystemObjectIdentity;
  entries?: Array<{
    name: string;
    object_type: AuthorizedChildObject["object_type"];
    identity?: ProofGradeFilesystemObjectIdentity;
    size_bytes?: number;
    mode?: number;
    modified_at_ms?: number;
    created_at_ms?: number;
    boundary_code?: AuthorizedChildObject["boundary_code"];
  }>;
  content_hash?: string;
  bytes_read?: number;
  prefix_base64?: string;
  prefix_complete_file?: boolean;
  line_count?: number;
  progress_bytes?: number;
};

class WindowsFilesystemObjectAuthority implements WorkspaceFilesystemObjectAuthority {
  private metadataChild?: ChildProcessWithoutNullStreams;
  private metadataLines?: ReadLineInterface;
  private metadataPending?: {
    resolve: (value: WindowsAuthorityResponse) => void;
    reject: (error: Error) => void;
    sourcePath: string;
    phase: "SOURCE_AUTHORITY" | "DISCOVERING";
    operation: "probe" | "enumerate_relative";
    signal?: AbortSignal;
    onAbort?: () => void;
    deadlineTimer?: NodeJS.Timeout;
    forceTimer?: NodeJS.Timeout;
    cancelCode?: "WORKSPACE_INDEX_ABORTED" | "WORKSPACE_INDEX_TIMEOUT";
    cancelEvidence?: Record<string, unknown>;
    protocolError?: Error;
  };
  private metadataSerial: Promise<void> = Promise.resolve();
  private metadataStderr = "";
  private captureChild?: ChildProcessWithoutNullStreams;
  private captureLines?: ReadLineInterface;
  private capturePending?: {
    resolve: (value: WindowsAuthorityResponse) => void;
    reject: (error: Error) => void;
    sourcePath: string;
    onBytes?: (bytes: number) => void;
    signal?: AbortSignal;
    deadlineAt?: number;
    onAbort?: () => void;
    deadlineTimer?: NodeJS.Timeout;
    forceTimer?: NodeJS.Timeout;
    cancelCode?: "WORKSPACE_INDEX_ABORTED" | "WORKSPACE_INDEX_TIMEOUT";
    cancelEvidence?: Record<string, unknown>;
    callbackError?: Error;
  };

  constructor(private readonly hooks: WorkspaceFilesystemAuthorityTestHooks = {}) {}

  private ensureMetadataHelper(): ChildProcessWithoutNullStreams {
    if (this.metadataChild && this.metadataChild.exitCode === null && this.metadataChild.signalCode === null) return this.metadataChild;
    const helper = path.resolve(process.cwd(), "scripts", "windows-filesystem-object-authority.ps1");
    const child = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", helper], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    configureWindowsAuthorityUtf8Protocol(child);
    this.metadataChild = child;
    this.metadataStderr = "";
    const pid = child.pid;
    if (pid !== undefined) this.hooks.onWindowsMetadataHelperSpawned?.(pid);
    child.stderr.on("data", (chunk: string | Buffer) => { this.metadataStderr = `${this.metadataStderr}${String(chunk)}`.slice(-8192); });
    const lines = createInterface({ input: child.stdout });
    this.metadataLines = lines;
    lines.on("line", (line: string) => {
      const pending = this.metadataPending;
      if (!pending || !line.trim()) return;
      try {
        const parsed = JSON.parse(line) as WindowsAuthorityResponse & { progress_entries?: number };
        if (typeof parsed.progress_entries === "number") {
          if (pid !== undefined) this.hooks.onWindowsEnumerationProgress?.({ pid, entries: parsed.progress_entries });
          return;
        }
        if (pending.cancelCode) return;
        this.metadataPending = undefined;
        this.cleanupMetadataPending(pending);
        pending.resolve(parsed);
      } catch {
        pending.protocolError = new Error("WORKSPACE_FILESYSTEM_AUTHORITY_PROTOCOL_ERROR");
        this.cancelMetadataHelper("WORKSPACE_INDEX_ABORTED", { phase: pending.phase, path: pending.sourcePath, reason: "PROTOCOL_ERROR" });
      }
    });
    child.once("close", (exitCode: number | null) => {
      if (pid !== undefined) this.hooks.onWindowsMetadataHelperClosed?.(pid);
      lines.close();
      if (this.metadataChild === child) { this.metadataChild = undefined; this.metadataLines = undefined; }
      const pending = this.metadataPending;
      if (!pending) return;
      this.metadataPending = undefined;
      this.cleanupMetadataPending(pending);
      if (pid !== undefined) {
        if (pending.operation === "probe") this.hooks.onWindowsRootProbeHelperClosed?.(pid);
        else this.hooks.onWindowsEnumerationHelperClosed?.(pid);
      }
      if (pending.protocolError) pending.reject(pending.protocolError);
      else if (pending.cancelCode) pending.reject(new WorkspaceIndexBoundedError(pending.cancelCode, pending.cancelEvidence ?? { phase: pending.phase, path: pending.sourcePath }));
      else pending.reject(new Error(`WORKSPACE_FILESYSTEM_AUTHORITY_HELPER_EXITED:${exitCode}:${this.metadataStderr}`));
    });
    child.once("error", (error: Error) => {
      if (this.metadataChild === child) { this.metadataChild = undefined; this.metadataLines = undefined; }
      const pending = this.metadataPending;
      if (!pending) return;
      this.metadataPending = undefined;
      this.cleanupMetadataPending(pending);
      if (pid !== undefined) {
        if (pending.operation === "probe") this.hooks.onWindowsRootProbeHelperClosed?.(pid);
        else this.hooks.onWindowsEnumerationHelperClosed?.(pid);
      }
      if (pending.protocolError) pending.reject(pending.protocolError);
      else if (pending.cancelCode) pending.reject(new WorkspaceIndexBoundedError(pending.cancelCode, pending.cancelEvidence ?? { phase: pending.phase, path: pending.sourcePath }));
      else pending.reject(error);
    });
    return child;
  }

  private cleanupMetadataPending(pending: NonNullable<WindowsFilesystemObjectAuthority["metadataPending"]>): void {
    if (pending.deadlineTimer) clearTimeout(pending.deadlineTimer);
    if (pending.forceTimer) clearTimeout(pending.forceTimer);
    if (pending.signal && pending.onAbort) pending.signal.removeEventListener("abort", pending.onAbort);
  }

  private cancelMetadataHelper(code: "WORKSPACE_INDEX_ABORTED" | "WORKSPACE_INDEX_TIMEOUT", evidence: Record<string, unknown>): void {
    const pending = this.metadataPending;
    const child = this.metadataChild;
    if (!pending || !child || pending.cancelCode) return;
    pending.cancelCode = code;
    pending.cancelEvidence = evidence;
    child.stdin.destroy();
    child.kill();
    pending.forceTimer = setTimeout(() => {
      if (this.metadataChild !== child || child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGKILL");
    }, 1_000);
    pending.forceTimer.unref?.();
  }

  private requestGovernedMetadata(
    payload: Record<string, string | number | boolean>,
    input: { signal?: AbortSignal; deadlineAt?: number; sourcePath: string; phase: "SOURCE_AUTHORITY" | "DISCOVERING"; operation: "probe" | "enumerate_relative" },
  ): Promise<WindowsAuthorityResponse> {
    const run = this.metadataSerial.then(async () => {
      if (input.signal?.aborted) throw new WorkspaceIndexBoundedError("WORKSPACE_INDEX_ABORTED", { phase: input.phase, path: input.sourcePath });
      if (input.deadlineAt !== undefined && Date.now() >= input.deadlineAt) throw new WorkspaceIndexBoundedError("WORKSPACE_INDEX_TIMEOUT", { phase: input.phase, path: input.sourcePath, deadlineAt: input.deadlineAt });
      const child = this.ensureMetadataHelper();
      const pid = child.pid;
      if (pid !== undefined) {
        this.hooks.onWindowsMetadataRequest?.({ pid, operation: input.operation });
        if (input.operation === "probe") this.hooks.onWindowsRootProbeHelperSpawned?.(pid);
        else this.hooks.onWindowsEnumerationHelperSpawned?.(pid);
      }
      return await new Promise<WindowsAuthorityResponse>((resolve, reject) => {
        const pending: NonNullable<WindowsFilesystemObjectAuthority["metadataPending"]> = {
          resolve, reject, sourcePath: input.sourcePath, phase: input.phase, operation: input.operation, signal: input.signal,
        };
        this.metadataPending = pending;
        pending.onAbort = () => this.cancelMetadataHelper("WORKSPACE_INDEX_ABORTED", { phase: input.phase, path: input.sourcePath });
        input.signal?.addEventListener("abort", pending.onAbort, { once: true });
        if (input.signal?.aborted) { pending.onAbort(); return; }
        if (input.deadlineAt !== undefined) {
          const remainingMs = input.deadlineAt - Date.now();
          if (remainingMs <= 0) {
            this.cancelMetadataHelper("WORKSPACE_INDEX_TIMEOUT", { phase: input.phase, path: input.sourcePath, deadlineAt: input.deadlineAt });
            return;
          }
          pending.deadlineTimer = setTimeout(() => this.cancelMetadataHelper("WORKSPACE_INDEX_TIMEOUT", { phase: input.phase, path: input.sourcePath, deadlineAt: input.deadlineAt }), remainingMs);
          pending.deadlineTimer.unref?.();
        }
        child.stdin.write(`${JSON.stringify(payload)}\n`, (error?: Error | null) => {
          if (!error || this.metadataPending !== pending) return;
          pending.protocolError = error;
          this.cancelMetadataHelper("WORKSPACE_INDEX_ABORTED", { phase: input.phase, path: input.sourcePath, reason: "HELPER_REQUEST_WRITE_FAILED" });
        });
      });
    });
    this.metadataSerial = run.then(() => undefined, () => undefined);
    return run;
  }

  private ensureCaptureHelper(): ChildProcessWithoutNullStreams {
    if (this.captureChild && this.captureChild.exitCode === null && this.captureChild.signalCode === null) return this.captureChild;
    const helper = path.resolve(process.cwd(), "scripts", "windows-filesystem-object-authority.ps1");
    const child = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", helper], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    configureWindowsAuthorityUtf8Protocol(child);
    this.captureChild = child;
    const pid = child.pid;
    if (pid !== undefined) this.hooks.onWindowsCaptureHelperSpawned?.(pid);
    const lines = createInterface({ input: child.stdout });
    this.captureLines = lines;
    let stderr = "";
    child.stderr.on("data", (chunk: string | Buffer) => { stderr = `${stderr}${String(chunk)}`.slice(-8192); });
    lines.on("line", (line: string) => {
      const pending = this.capturePending;
      if (!pending || !line.trim()) return;
      try {
        const parsed = JSON.parse(line) as WindowsAuthorityResponse;
        if (typeof parsed.progress_bytes === "number") {
          if (pid !== undefined) this.hooks.onWindowsCaptureProgress?.({ pid, bytes: parsed.progress_bytes });
          try { pending.onBytes?.(parsed.progress_bytes); }
          catch (error) {
            pending.callbackError = error instanceof Error ? error : new Error(String(error));
            this.cancelCaptureHelper("WORKSPACE_INDEX_ABORTED", { phase: "CAPTURE", path: pending.sourcePath, reason: "CALLER_BUDGET_TERMINATION" });
          }
          return;
        }
        this.capturePending = undefined;
        this.cleanupCapturePending(pending);
        const terminal = this.capturePendingTerminalGovernanceError(pending);
        if (terminal) { pending.reject(terminal); return; }
        pending.resolve(parsed);
      } catch {
        pending.callbackError = new Error("WORKSPACE_FILESYSTEM_AUTHORITY_PROTOCOL_ERROR");
        this.cancelCaptureHelper("WORKSPACE_INDEX_ABORTED", { phase: "CAPTURE", path: pending.sourcePath, reason: "PROTOCOL_ERROR" });
      }
    });
    child.once("close", (exitCode: number | null) => {
      if (pid !== undefined) this.hooks.onWindowsCaptureHelperClosed?.(pid);
      lines.close();
      if (this.captureChild === child) {
        this.captureChild = undefined;
        this.captureLines = undefined;
      }
      const pending = this.capturePending;
      if (!pending) return;
      this.capturePending = undefined;
      this.cleanupCapturePending(pending);
      const terminal = this.capturePendingTerminalGovernanceError(pending);
      if (terminal) { pending.reject(terminal); return; }
      if (pending.callbackError) { pending.reject(pending.callbackError); return; }
      if (pending.cancelCode) {
        pending.reject(new WorkspaceIndexBoundedError(pending.cancelCode, pending.cancelEvidence ?? { phase: "CAPTURE", path: pending.sourcePath }));
        return;
      }
      pending.reject(new Error(`WORKSPACE_FILESYSTEM_AUTHORITY_HELPER_EXITED:${exitCode}:${stderr}`));
    });
    child.once("error", (error: Error) => {
      const pending = this.capturePending;
      if (this.captureChild === child) {
        this.captureChild = undefined;
        this.captureLines = undefined;
      }
      if (!pending) return;
      this.capturePending = undefined;
      this.cleanupCapturePending(pending);
      const terminal = this.capturePendingTerminalGovernanceError(pending);
      if (terminal) pending.reject(terminal);
      else if (pending.callbackError) pending.reject(pending.callbackError);
      else if (pending.cancelCode) pending.reject(new WorkspaceIndexBoundedError(pending.cancelCode, pending.cancelEvidence ?? { phase: "CAPTURE", path: pending.sourcePath }));
      else pending.reject(error);
    });
    return child;
  }

  private capturePendingTerminalGovernanceError(
    pending: NonNullable<WindowsFilesystemObjectAuthority["capturePending"]>,
  ): WorkspaceIndexBoundedError | undefined {
    if (pending.signal?.aborted) {
      return new WorkspaceIndexBoundedError("WORKSPACE_INDEX_ABORTED", { phase: "CAPTURE", path: pending.sourcePath });
    }
    if (pending.deadlineAt !== undefined && Date.now() >= pending.deadlineAt) {
      return new WorkspaceIndexBoundedError("WORKSPACE_INDEX_TIMEOUT", {
        phase: "CAPTURE",
        path: pending.sourcePath,
        deadlineAt: pending.deadlineAt,
      });
    }
    return undefined;
  }

  private cleanupCapturePending(pending: NonNullable<WindowsFilesystemObjectAuthority["capturePending"]>): void {
    if (pending.deadlineTimer) clearTimeout(pending.deadlineTimer);
    if (pending.forceTimer) clearTimeout(pending.forceTimer);
    if (pending.signal && pending.onAbort) pending.signal.removeEventListener("abort", pending.onAbort);
  }

  private cancelCaptureHelper(
    code: "WORKSPACE_INDEX_ABORTED" | "WORKSPACE_INDEX_TIMEOUT",
    evidence: Record<string, unknown>,
  ): void {
    const pending = this.capturePending;
    const child = this.captureChild;
    if (!pending || !child || pending.cancelCode) return;
    pending.cancelCode = code;
    pending.cancelEvidence = evidence;
    child.stdin.destroy();
    child.kill();
    // Escalation remains on the exact spawned ChildProcess handle; no global PowerShell enumeration/kill.
    pending.forceTimer = setTimeout(() => {
      if (this.captureChild !== child || child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGKILL");
    }, 1_000);
    pending.forceTimer.unref?.();
  }

  private requestGovernedCapture(
    payload: Record<string, string | number | boolean>,
    input: { signal?: AbortSignal; deadlineAt?: number; sourcePath: string; onBytes?: (bytes: number) => void },
  ): Promise<WindowsAuthorityResponse> {
    if (this.capturePending) {
      return Promise.reject(new WorkspaceIndexBoundedError("WORKSPACE_FILESYSTEM_AUTHORITY_CAPTURE_CONCURRENT_UNSUPPORTED", { phase: "CAPTURE", path: input.sourcePath }));
    }
    const child = this.ensureCaptureHelper();
    return new Promise((resolve, reject) => {
      const pending: NonNullable<WindowsFilesystemObjectAuthority["capturePending"]> = {
        resolve,
        reject,
        sourcePath: input.sourcePath,
        onBytes: input.onBytes,
        signal: input.signal,
        deadlineAt: input.deadlineAt,
      };
      this.capturePending = pending;
      pending.onAbort = () => this.cancelCaptureHelper("WORKSPACE_INDEX_ABORTED", { phase: "CAPTURE", path: input.sourcePath });
      input.signal?.addEventListener("abort", pending.onAbort, { once: true });
      if (input.signal?.aborted) {
        pending.onAbort();
        return;
      }
      if (input.deadlineAt !== undefined) {
        const remainingMs = input.deadlineAt - Date.now();
        if (remainingMs <= 0) {
          this.cancelCaptureHelper("WORKSPACE_INDEX_TIMEOUT", { phase: "CAPTURE", path: input.sourcePath, deadlineAt: input.deadlineAt });
          return;
        }
        pending.deadlineTimer = setTimeout(() => this.cancelCaptureHelper("WORKSPACE_INDEX_TIMEOUT", { phase: "CAPTURE", path: input.sourcePath, deadlineAt: input.deadlineAt }), remainingMs);
        pending.deadlineTimer.unref?.();
      }
      child.stdin.write(`${JSON.stringify(payload)}\n`, (error?: Error | null) => {
        if (!error) return;
        if (this.capturePending !== pending) return;
        // A broken capture pipe invalidates the owned helper channel. Terminate only that helper
        // and reject after close so no orphan/broken helper can be reused by a later capture.
        pending.callbackError = error;
        this.cancelCaptureHelper("WORKSPACE_INDEX_ABORTED", { phase: "CAPTURE", path: input.sourcePath, reason: "HELPER_REQUEST_WRITE_FAILED" });
      });
    });
  }

  private requireIdentity(
    response: WindowsAuthorityResponse,
    sourcePath: string,
    governedPhase: "SOURCE_AUTHORITY" | "DISCOVERING" | "CAPTURE" = "SOURCE_AUTHORITY",
  ): WindowsAuthorityResponse & { identity: ProofGradeFilesystemObjectIdentity } {
    if (!response.ok || !response.identity) {
      const code = response.code || "WORKSPACE_FILESYSTEM_AUTHORITY_FAILED";
      const phase = code === "WORKSPACE_INDEX_ABORTED"
        || code === "WORKSPACE_INDEX_TIMEOUT"
        || code === "WORKSPACE_INDEX_HASH_BUDGET_EXCEEDED"
        || code === "WORKSPACE_CAPTURE_BYTE_BUDGET_EXCEEDED"
        || code === "DISCOVERY_FILE_TOO_LARGE"
        ? governedPhase
        : "SOURCE_AUTHORITY";
      throw new WorkspaceIndexBoundedError(code, { phase, path: sourcePath });
    }
    if (response.identity.proof_method !== "WINDOWS_FILE_ID_128_V1" || !/^\d+$/.test(response.identity.device_id) || !/^[0-9a-f]{32}$/.test(response.identity.file_id)) {
      throw new WorkspaceIndexBoundedError("WORKSPACE_OBJECT_IDENTITY_UNPROVABLE", { phase: "SOURCE_AUTHORITY", path: sourcePath });
    }
    return response as WindowsAuthorityResponse & { identity: ProofGradeFilesystemObjectIdentity };
  }

  async probeDirectory(absolutePath: string, governance: WorkspaceOperationRuntimeGovernance = {}): Promise<VerifiedDirectoryObject> {
    const response = this.requireIdentity(await this.requestGovernedMetadata({
      op: "probe",
      path: absolutePath,
      deadline_epoch_ms: governance.deadlineAt ?? -1,
      test_startup_delay_ms: this.hooks.windowsRootProbeStartupDelayMs ?? 0,
    }, { signal: governance.signal, deadlineAt: governance.deadlineAt, sourcePath: absolutePath, phase: "SOURCE_AUTHORITY", operation: "probe" }), absolutePath, "SOURCE_AUTHORITY");
    if (!response.resolved_real_path) throw new WorkspaceIndexBoundedError("WORKSPACE_OBJECT_IDENTITY_UNPROVABLE", { phase: "SOURCE_AUTHORITY", path: absolutePath });
    return { resolved_real_path: normalizeRealPath(response.resolved_real_path), identity: response.identity };
  }

  async enumerateRelativeDirectory(input: {
    rootPath: string;
    rootIdentity: ProofGradeFilesystemObjectIdentity;
    relativeDirectoryPath: string;
    expectedDirectoryIdentity?: ProofGradeFilesystemObjectIdentity;
    signal?: AbortSignal;
    deadlineAt?: number;
  }): Promise<EnumeratedDirectoryObject> {
    if (input.rootIdentity.proof_method !== "WINDOWS_FILE_ID_128_V1" || (input.expectedDirectoryIdentity && input.expectedDirectoryIdentity.proof_method !== "WINDOWS_FILE_ID_128_V1")) {
      throw new WorkspaceIndexBoundedError("WORKSPACE_OBJECT_IDENTITY_UNPROVABLE", { phase: "SOURCE_AUTHORITY" });
    }
    const response = this.requireIdentity(await this.requestGovernedMetadata({
      op: "enumerate_relative",
      path: input.rootPath,
      expected_device_id: input.rootIdentity.device_id,
      expected_file_id: input.rootIdentity.file_id,
      relative_path: normalizeRelativeObjectPath(input.relativeDirectoryPath),
      expected_child_device_id: input.expectedDirectoryIdentity?.device_id ?? "",
      expected_child_file_id: input.expectedDirectoryIdentity?.file_id ?? "",
      deadline_epoch_ms: input.deadlineAt ?? -1,
      test_enumeration_chunk_delay_ms: this.hooks.windowsEnumerationChunkDelayMs ?? 0,
      emit_progress: true,
    }, { signal: input.signal, deadlineAt: input.deadlineAt, sourcePath: input.relativeDirectoryPath || input.rootPath, phase: "DISCOVERING", operation: "enumerate_relative" }), input.relativeDirectoryPath || input.rootPath, "DISCOVERING");
    if (!response.resolved_real_path) throw new WorkspaceIndexBoundedError("WORKSPACE_OBJECT_IDENTITY_UNPROVABLE", { phase: "SOURCE_AUTHORITY" });
    if (input.expectedDirectoryIdentity && !sameProofGradeFilesystemObject(response.identity, input.expectedDirectoryIdentity)) {
      throw new WorkspaceIndexBoundedError("WORKSPACE_DIRECTORY_OBJECT_IDENTITY_CHANGED", { phase: "SOURCE_AUTHORITY", path: input.relativeDirectoryPath });
    }
    return {
      resolved_real_path: normalizeRealPath(response.resolved_real_path),
      identity: response.identity,
      entries: (response.entries ?? []).map(entry => ({ ...entry })),
    };
  }

  async captureRelativeFile(input: Parameters<WorkspaceFilesystemObjectAuthority["captureRelativeFile"]>[0]): Promise<CapturedAuthorizedFile> {
    if (input.signal?.aborted) throw new WorkspaceIndexBoundedError("WORKSPACE_INDEX_ABORTED", { phase: "CAPTURE" });
    if (input.deadlineAt !== undefined && Date.now() >= input.deadlineAt) throw new WorkspaceIndexBoundedError("WORKSPACE_INDEX_TIMEOUT", { phase: "CAPTURE" });
    if (input.rootIdentity.proof_method !== "WINDOWS_FILE_ID_128_V1" || (input.expectedFileIdentity && input.expectedFileIdentity.proof_method !== "WINDOWS_FILE_ID_128_V1")) {
      throw new WorkspaceIndexBoundedError("WORKSPACE_OBJECT_IDENTITY_UNPROVABLE", { phase: "SOURCE_AUTHORITY" });
    }
    const rawResponse = await this.requestGovernedCapture({
      op: "capture_relative",
      path: input.rootPath,
      expected_device_id: input.rootIdentity.device_id,
      expected_file_id: input.rootIdentity.file_id,
      relative_path: normalizeRelativeObjectPath(input.relativeFilePath),
      expected_child_device_id: input.expectedFileIdentity?.device_id ?? "",
      expected_child_file_id: input.expectedFileIdentity?.file_id ?? "",
      expected_size_bytes: input.expectedSizeBytes ?? -1,
      max_prefix_bytes: input.maxPrefixBytes,
      count_lines: Boolean(input.countLines),
      deadline_epoch_ms: input.deadlineAt ?? -1,
      max_read_bytes: input.maxBytes ?? -1,
      byte_budget_code: input.byteBudgetCode ?? "WORKSPACE_CAPTURE_BYTE_BUDGET_EXCEEDED",
      test_startup_delay_ms: this.hooks.windowsCaptureStartupDelayMs ?? 0,
      test_chunk_delay_ms: this.hooks.windowsCaptureChunkDelayMs ?? 0,
      test_response_delay_ms: this.hooks.windowsCaptureResponseDelayMs ?? 0,
      emit_progress: true,
    }, { signal: input.signal, deadlineAt: input.deadlineAt, sourcePath: input.relativeFilePath, onBytes: input.onBytes });
    if (input.signal?.aborted) throw new WorkspaceIndexBoundedError("WORKSPACE_INDEX_ABORTED", { phase: "CAPTURE", path: input.relativeFilePath });
    if (input.deadlineAt !== undefined && Date.now() >= input.deadlineAt) {
      throw new WorkspaceIndexBoundedError("WORKSPACE_INDEX_TIMEOUT", { phase: "CAPTURE", path: input.relativeFilePath, deadlineAt: input.deadlineAt });
    }
    const response = this.requireIdentity(rawResponse, input.relativeFilePath, "CAPTURE");
    if (input.expectedFileIdentity && !sameProofGradeFilesystemObject(response.identity, input.expectedFileIdentity)) {
      throw new WorkspaceIndexBoundedError("WORKSPACE_SOURCE_OBJECT_IDENTITY_CHANGED", { phase: "SOURCE_AUTHORITY", path: input.relativeFilePath });
    }
    if (typeof response.content_hash !== "string" || typeof response.bytes_read !== "number" || typeof response.prefix_base64 !== "string" || typeof response.prefix_complete_file !== "boolean") {
      throw new WorkspaceIndexBoundedError("WORKSPACE_FILESYSTEM_AUTHORITY_PROTOCOL_ERROR", { phase: "SOURCE_AUTHORITY" });
    }
    return {
      identity: response.identity,
      content_hash: response.content_hash,
      bytes_read: response.bytes_read,
      prefix_bytes: Buffer.from(response.prefix_base64, "base64"),
      prefix_complete_file: response.prefix_complete_file,
      ...(input.countLines ? { line_count: response.line_count ?? 0 } : {}),
    };
  }

  async close(): Promise<void> {
    if (this.metadataPending) {
      this.cancelMetadataHelper("WORKSPACE_INDEX_ABORTED", {
        phase: this.metadataPending.phase,
        path: this.metadataPending.sourcePath,
        reason: "AUTHORITY_CLOSED",
      });
    }
    if (this.capturePending) {
      this.cancelCaptureHelper("WORKSPACE_INDEX_ABORTED", {
        phase: "CAPTURE",
        path: this.capturePending.sourcePath,
        reason: "AUTHORITY_CLOSED",
      });
    }
    await this.metadataSerial.catch(() => undefined);

    const metadata = this.metadataChild;
    this.metadataLines?.close();
    if (metadata) {
      metadata.stdin.end();
      if (metadata.exitCode === null && metadata.signalCode === null) {
        await new Promise<void>(resolve => {
          metadata.once("close", () => resolve());
          metadata.kill();
        });
      }
    }

    const capture = this.captureChild;
    this.captureLines?.close();
    if (capture) {
      capture.stdin.end();
      if (capture.exitCode === null && capture.signalCode === null) {
        await new Promise<void>(resolve => {
          capture.once("close", () => resolve());
          capture.kill();
        });
      }
    }
  }
}

export function createWorkspaceFilesystemObjectAuthority(testHooks: WorkspaceFilesystemAuthorityTestHooks = {}): WorkspaceFilesystemObjectAuthority {
  if (process.platform === "win32") return new WindowsFilesystemObjectAuthority(testHooks);
  if (process.platform === "linux") return new LinuxFilesystemObjectAuthority(testHooks);
  throw new WorkspaceIndexBoundedError("WORKSPACE_OBJECT_IDENTITY_UNPROVABLE", { phase: "SOURCE_AUTHORITY", platform: process.platform });
}

import { createHash } from "node:crypto";
import path from "node:path";
import type { Readable } from "node:stream";
import type { FileEncoding, FileKind, SensitivityState, WorkspaceIndexFailure } from "@/core/workspace-index/types";
import { stableWorkspaceIndexId } from "@/core/workspace-index/canonical";
import { WorkspaceIndexBoundedError, isGlobalRuntimeGovernanceError } from "@/core/workspace-index/adapters/filesystem-errors";
import {
  createWorkspaceFilesystemObjectAuthority,
  sameProofGradeFilesystemObject,
  type ProofGradeFilesystemObjectIdentity,
  type WorkspaceFilesystemObjectAuthority,
} from "@/core/workspace-index/filesystem-object-authority";
import { localRelativePathIsWithin, sameLocalAbsolutePath } from "@/core/workspace-index/local-path-semantics";
import { DEFAULT_WORKSPACE_DURATION_GOVERNANCE, type WorkspaceDurationGovernancePhase } from "@/core/workspace-index/duration-governance";

export { WorkspaceIndexBoundedError } from "@/core/workspace-index/adapters/filesystem-errors";

export const WORKSPACE_TRAVERSAL_POLICY_ID = "intentchord.workspace-traversal-policy/v2" as const;
export const WORKSPACE_FILE_CLASSIFICATION_POLICY_ID = "intentchord.workspace-file-classification/v1" as const;
export const WORKSPACE_SENSITIVITY_POLICY_ID = "intentchord.workspace-sensitivity-classification/v1" as const;

export type WorkspaceIndexBudgets = {
  maxDiscoveredFiles: number;
  maxDiscoveredBytes: number;
  maxHashedFiles: number;
  maxHashedBytes: number;
  maxRetainedTextBytesPerFile: number;
  maxAggregateRetainedTextBytes: number;
  maxCsvSampleBytes: number;
};

export const DEFAULT_WORKSPACE_INDEX_BUDGETS: WorkspaceIndexBudgets = {
  maxDiscoveredFiles: 50_000,
  maxDiscoveredBytes: 20 * 1024 * 1024 * 1024,
  maxHashedFiles: 50_000,
  maxHashedBytes: 20 * 1024 * 1024 * 1024,
  maxRetainedTextBytesPerFile: 128 * 1024 * 1024,
  maxAggregateRetainedTextBytes: 512 * 1024 * 1024,
  maxCsvSampleBytes: 1024 * 1024,
};

export type WorkspaceTraversalPhase = "DISCOVERING" | "HASHING" | "PARSING" | "ASSEMBLING" | "VALIDATING" | "PERSISTING";
export type WorkspaceProgressEvidence = {
  phase: WorkspaceTraversalPhase;
  discoveredFiles: number;
  discoveredBytes: number;
  hashedFiles: number;
  hashedBytes: number;
  parsedFiles: number;
  aggregateRetainedTextBytes: number;
  csvSampledBytes: number;
  excludedTrees: number;
  elapsedMs: number;
  durationPolicyId?: string;
  governancePhase?: WorkspaceDurationGovernancePhase;
  byteAllowanceMs?: number;
  fileAllowanceMs?: number;
  rawProcessingBudgetMs?: number;
  derivedProcessingBudgetMs?: number;
  phaseElapsedMs?: number;
  phaseBudgetMs?: number;
  absoluteOperationMaxMs?: number;
  absoluteElapsedMs?: number;
};
export type WorkspaceExcludedBoundary = {
  relative_path: string;
  exclusion_reason: "TECHNICAL_GENERATED_TREE" | "OWNER_RESTRICTED_PATH";
  governing_policy_id: string;
};

export type FilesystemInventoryEntry = {
  absolute_path: string;
  relative_path: string;
  file_name: string;
  size_bytes: number;
  mode: number;
  modified_at_ms: number;
  created_at_ms: number;
  file_kind: FileKind;
  language?: string;
  media_type: string;
  sensitivity_state: SensitivityState;
  /** Exact child-object identity reached through the verified parent/root chain; excluded from canonical Source fingerprint material. */
  device_id: string;
  inode: string;
  object_identity_proof_method: ProofGradeFilesystemObjectIdentity["proof_method"];
  authorized_root_reference_path: string;
  authorized_root_real_path: string;
  authorized_root_identity: ProofGradeFilesystemObjectIdentity;
};
export type FilesystemInventoryResult = {
  root_path: string;
  files: FilesystemInventoryEntry[];
  failures: WorkspaceIndexFailure[];
  excluded_boundaries: WorkspaceExcludedBoundary[];
  totals: { discovered_files: number; discovered_bytes: number };
};

const sourceExtensions: Record<string, string> = {
  ".ts":"typescript", ".tsx":"typescript", ".mts":"typescript", ".cts":"typescript", ".js":"javascript", ".jsx":"javascript", ".mjs":"javascript", ".cjs":"javascript",
  ".py":"python", ".rs":"rust", ".go":"go", ".java":"java", ".cs":"csharp", ".cpp":"cpp", ".c":"c", ".h":"c", ".sql":"sql", ".css":"css", ".scss":"scss", ".html":"html",
};
const scriptExtensions: Record<string, string> = { ".sh":"bash", ".bash":"bash", ".zsh":"zsh", ".ps1":"powershell", ".psm1":"powershell", ".cmd":"batch", ".bat":"batch" };
const manifestNames = new Set(["package.json","package-lock.json","npm-shrinkwrap.json","cargo.toml","cargo.lock","go.mod","go.sum","pom.xml"]);
const configNames = new Set(["tsconfig.json","jsconfig.json","eslint.config.mjs",".editorconfig",".gitignore",".npmrc",".nvmrc",".node-version"]);
const technicalExact = new Set([".git","node_modules","dist","build","out","coverage",".turbo",".cache","tmp","temp"]);

export function isTechnicalExcludedDirectory(name: string): boolean {
  const lower = name.toLowerCase();
  return technicalExact.has(lower) || lower === ".next" || lower.startsWith(".next-");
}
export function classifyWorkspaceFile(relativePath: string): { file_kind: FileKind; language?: string; media_type: string } {
  const lower=relativePath.toLowerCase(), name=path.posix.basename(lower), extension=path.posix.extname(lower);
  if (manifestNames.has(name)) return { file_kind:"MANIFEST", language:extension===".json"?"json":undefined, media_type:extension===".json"?"application/json":"text/plain" };
  if (configNames.has(name)) return { file_kind:"CONFIGURATION", language:sourceExtensions[extension]??scriptExtensions[extension], media_type:"text/plain" };
  if (sourceExtensions[extension]) return { file_kind:"SOURCE_CODE", language:sourceExtensions[extension], media_type:"text/plain" };
  if (scriptExtensions[extension]) return { file_kind:"SCRIPT", language:scriptExtensions[extension], media_type:"text/plain" };
  if ([".md",".mdx"].includes(extension)) return { file_kind:"MARKDOWN", language:"markdown", media_type:"text/markdown" };
  if (extension===".csv") return { file_kind:"CSV", language:"csv", media_type:"text/csv" };
  if (extension===".json") return { file_kind:"JSON", language:"json", media_type:"application/json" };
  if ([".yaml",".yml"].includes(extension)) return { file_kind:"YAML", language:"yaml", media_type:"application/yaml" };
  if (extension===".toml") return { file_kind:"TOML", language:"toml", media_type:"application/toml" };
  if (extension===".xml") return { file_kind:"XML", language:"xml", media_type:"application/xml" };
  if (new Set([".png",".jpg",".jpeg",".gif",".webp",".ico",".pdf",".zip",".gz",".7z",".exe",".dll",".so",".dylib",".woff",".woff2",".ttf",".mp3",".mp4",".mov"]).has(extension)) return { file_kind:"BINARY", media_type:"application/octet-stream" };
  return { file_kind:"UNKNOWN", media_type:"application/octet-stream" };
}
export function classifySensitivity(relativePath: string, ownerRestrictedPaths: string[]=[]): SensitivityState {
  const normalized=relativePath.replaceAll("\\","/");
  if (ownerRestrictedPaths.some(item=>localRelativePathIsWithin(normalized,item))) return "OWNER_RESTRICTED";
  const name=path.posix.basename(normalized);
  if (/^\.env(?:\.|$)/i.test(name)||/(?:^|[-_.])(secret|secrets|credential|credentials|private[-_]?key|token)(?:[-_.]|$)/i.test(name)) return "SECRET";
  if (/(?:password|passwd|api[-_]?key|access[-_]?key|client[-_]?secret)/i.test(name)) return "CREDENTIAL_LIKE";
  if (/(?:certificate|cert|license|customer|personal|sensitive)/i.test(name)) return "SENSITIVE";
  return "NORMAL";
}

function normalizedRelative(root:string, absolute:string):string { return path.relative(root,absolute).split(path.sep).join("/"); }
function failure(now:string,input:{stage:WorkspaceIndexFailure["stage"];code:string;message:string;impact?:WorkspaceIndexFailure["impact"]}):WorkspaceIndexFailure { return { failure_id:stableWorkspaceIndexId("wif",{now,...input}), stage:input.stage, failure_type:"FILESYSTEM_ACCESS", error_code:input.code, sanitized_message:input.message, occurred_at:now, recoverability:"RETRYABLE", impact:input.impact??"LOCAL" }; }
function checkBounded(input:{signal?:AbortSignal;deadlineAt:number;startedAt:number;progress:WorkspaceProgressEvidence}):void {
  if (input.signal?.aborted) throw new WorkspaceIndexBoundedError("WORKSPACE_INDEX_ABORTED",{phase:input.progress.phase});
  const now=Date.now(); input.progress.elapsedMs=now-input.startedAt;
  if (now>=input.deadlineAt) throw new WorkspaceIndexBoundedError("WORKSPACE_INDEX_TIMEOUT",{phase:input.progress.phase,elapsedMs:input.progress.elapsedMs,phaseBudgetMs:Math.max(0,input.deadlineAt-input.startedAt)});
}
function isOwnerRestrictedTree(relative:string, ownerRestrictedPaths:string[]):boolean { return ownerRestrictedPaths.some(item=>localRelativePathIsWithin(relative,item)); }

function isPathInsideRoot(rootRealPath: string, candidateRealPath: string): boolean {
  const relative = path.relative(rootRealPath, candidateRealPath);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function boundaryError(code: string, absolutePath: string, rootRealPath: string): WorkspaceIndexBoundedError {
  return new WorkspaceIndexBoundedError(code, { phase: "SOURCE_BOUNDARY", path: absolutePath, authorized_root: rootRealPath });
}

export function normalizeAuthorityRelativePath(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+/g, "/").replace(/\/$/, "");
  if (!normalized || normalized === ".") return "";
  if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized) || normalized.split("/").some(segment => !segment || segment === "." || segment === "..") || normalized.includes("\0")) {
    throw new WorkspaceIndexBoundedError("WORKSPACE_SOURCE_RELATIVE_PATH_INVALID", { phase: "SOURCE_AUTHORITY", path: value });
  }
  return normalized;
}

export async function inventoryWorkspaceFiles(
  rootPath:string,
  ownerRestrictedPaths:string[]=[] ,
  occurredAt: string | (() => string) = () => new Date().toISOString(),
  options:{
    budgets?:Partial<WorkspaceIndexBudgets>;
    signal?:AbortSignal;
    onProgress?:(p:WorkspaceProgressEvidence)=>void;
    startedAtMs?:number;
    deadlineAt?:number;
    /** Internal deterministic race-test hook; production callers leave undefined. */
    beforeDirectoryOpen?:(absolutePath:string)=>void|Promise<void>;
    expectedRoot?: { realPath: string; identity: ProofGradeFilesystemObjectIdentity };
    objectAuthority?: WorkspaceFilesystemObjectAuthority;
  }={},
):Promise<FilesystemInventoryResult> {
  const occurrenceNow = typeof occurredAt === "function" ? occurredAt : () => occurredAt;
  const budgets={...DEFAULT_WORKSPACE_INDEX_BUDGETS,...options.budgets};
  const startedAt=options.startedAtMs??Date.now();
  const deadlineAt=options.deadlineAt??(startedAt+DEFAULT_WORKSPACE_DURATION_GOVERNANCE.discoveryMaxMs);
  const progress:WorkspaceProgressEvidence={phase:"DISCOVERING",discoveredFiles:0,discoveredBytes:0,hashedFiles:0,hashedBytes:0,parsedFiles:0,aggregateRetainedTextBytes:0,csvSampledBytes:0,excludedTrees:0,elapsedMs:0};
  const authority=options.objectAuthority??createWorkspaceFilesystemObjectAuthority();
  const ownsAuthority=!options.objectAuthority;
  const registeredRootPath=path.resolve(rootPath);
  try {
    checkBounded({signal:options.signal,deadlineAt,startedAt,progress});
    const rootProbe=await authority.probeDirectory(registeredRootPath,{signal:options.signal,deadlineAt});
    checkBounded({signal:options.signal,deadlineAt,startedAt,progress});
    const root=path.normalize(rootProbe.resolved_real_path);
    if (options.expectedRoot) {
      if (!sameLocalAbsolutePath(root,options.expectedRoot.realPath) || !sameProofGradeFilesystemObject(rootProbe.identity, options.expectedRoot.identity)) {
        throw boundaryError("WORKSPACE_ROOT_AUTHORITY_CHANGED", root, options.expectedRoot.realPath);
      }
    }
    const files:FilesystemInventoryEntry[]=[];
    const failures:WorkspaceIndexFailure[]=[];
    const excluded_boundaries:WorkspaceExcludedBoundary[]=[];
    const queue:Array<{relativePath:string;identity:ProofGradeFilesystemObjectIdentity}>=[{relativePath:"",identity:rootProbe.identity}];
    while(queue.length){
      checkBounded({signal:options.signal,deadlineAt,startedAt,progress});
      const queued=queue.shift()!;
      const displayAbsolute=path.join(root,...(queued.relativePath?queued.relativePath.split("/"):[]));
      try {
        await options.beforeDirectoryOpen?.(displayAbsolute);
        const enumerated=await authority.enumerateRelativeDirectory({
          rootPath:registeredRootPath,
          rootIdentity:rootProbe.identity,
          relativeDirectoryPath:queued.relativePath,
          expectedDirectoryIdentity:queued.identity,
          signal:options.signal,
          deadlineAt,
        });
        if (!sameProofGradeFilesystemObject(enumerated.identity,queued.identity)) throw boundaryError("WORKSPACE_DIRECTORY_OBJECT_IDENTITY_CHANGED",displayAbsolute,root);
        if (!isPathInsideRoot(root,enumerated.resolved_real_path)) throw boundaryError("WORKSPACE_SOURCE_BOUNDARY_ESCAPE",displayAbsolute,root);
        for(const child of enumerated.entries){
          checkBounded({signal:options.signal,deadlineAt,startedAt,progress});
          const relative=normalizeAuthorityRelativePath(queued.relativePath?`${queued.relativePath}/${child.name}`:child.name);
          const absolute=path.join(root,...relative.split("/"));
          if(child.object_type==="BOUNDARY"){
            const boundaryCode=child.boundary_code??"SYMLINK_NOT_FOLLOWED";
            failures.push({failure_id:stableWorkspaceIndexId("wif",{relative,type:boundaryCode}),stage:"DISCOVERY",failure_type:"SYMLINK_NOT_FOLLOWED",error_code:boundaryCode,sanitized_message:`Symbolic link/reparse boundary ${relative} was observed and deliberately not followed.`,occurred_at:occurrenceNow(),recoverability:"PERMANENT_FOR_THIS_REVISION",impact:"LOCAL"});
            continue;
          }
          if(child.object_type==="DIRECTORY" && isTechnicalExcludedDirectory(child.name)){excluded_boundaries.push({relative_path:relative,exclusion_reason:"TECHNICAL_GENERATED_TREE",governing_policy_id:WORKSPACE_TRAVERSAL_POLICY_ID});progress.excludedTrees++;options.onProgress?.({...progress});continue;}
          if(child.object_type==="DIRECTORY" && isOwnerRestrictedTree(relative,ownerRestrictedPaths)){excluded_boundaries.push({relative_path:relative,exclusion_reason:"OWNER_RESTRICTED_PATH",governing_policy_id:"intentchord.owner-restricted-paths/v1"});progress.excludedTrees++;options.onProgress?.({...progress});continue;}
          if(child.object_type==="DIRECTORY"){
            if(!child.identity){failures.push(failure(occurrenceNow(),{stage:"DISCOVERY",code:"WORKSPACE_DIRECTORY_IDENTITY_UNPROVABLE",message:`Could not prove directory authority for ${relative}.`,impact:"REVISION_INCOMPLETE"}));continue;}
            queue.push({relativePath:relative,identity:child.identity});
            continue;
          }
          if(child.object_type!=="FILE") continue;
          if(!child.identity || child.size_bytes===undefined || child.mode===undefined || child.modified_at_ms===undefined || child.created_at_ms===undefined){
            failures.push(failure(occurrenceNow(),{stage:"METADATA",code:"WORKSPACE_CHILD_OBJECT_IDENTITY_UNPROVABLE",message:`Could not prove child object metadata for ${relative}.`,impact:"REVISION_INCOMPLETE"}));
            continue;
          }
          const size=child.size_bytes;
          if(!Number.isSafeInteger(size) || size<0){failures.push(failure(occurrenceNow(),{stage:"METADATA",code:"WORKSPACE_FILE_SIZE_UNREPRESENTABLE",message:`Could not represent file size for ${relative}.`,impact:"REVISION_INCOMPLETE"}));continue;}
          progress.discoveredFiles++; progress.discoveredBytes+=size;
          if(progress.discoveredFiles>budgets.maxDiscoveredFiles) throw new WorkspaceIndexBoundedError("WORKSPACE_INDEX_FILE_BUDGET_EXCEEDED",{discoveredFiles:progress.discoveredFiles,maxDiscoveredFiles:budgets.maxDiscoveredFiles});
          if(progress.discoveredBytes>budgets.maxDiscoveredBytes) throw new WorkspaceIndexBoundedError("WORKSPACE_INDEX_BYTE_BUDGET_EXCEEDED",{discoveredBytes:progress.discoveredBytes,maxDiscoveredBytes:budgets.maxDiscoveredBytes});
          const c=classifyWorkspaceFile(relative);
          files.push({
            absolute_path:absolute,
            relative_path:relative,
            file_name:child.name,
            size_bytes:size,
            mode:child.mode,
            modified_at_ms:child.modified_at_ms,
            created_at_ms:child.created_at_ms,
            file_kind:c.file_kind,
            language:c.language,
            media_type:c.media_type,
            sensitivity_state:classifySensitivity(relative,ownerRestrictedPaths),
            device_id:child.identity.device_id,
            inode:child.identity.file_id,
            object_identity_proof_method:child.identity.proof_method,
            authorized_root_reference_path:registeredRootPath,
            authorized_root_real_path:root,
            authorized_root_identity:rootProbe.identity,
          });
          options.onProgress?.({...progress});
        }
      }catch(error){
        if (isGlobalRuntimeGovernanceError(error)) throw error;
        const code=(error as WorkspaceIndexBoundedError)?.code;
        if(code?.startsWith("WORKSPACE_")){
          failures.push(failure(occurrenceNow(),{stage:"DISCOVERY",code,message:`Governed directory traversal failed closed for ${queued.relativePath||"."}.`,impact:"REVISION_INCOMPLETE"}));
          continue;
        }
        failures.push(failure(occurrenceNow(),{stage:"DISCOVERY",code:"DIRECTORY_READ_FAILED",message:`Could not enumerate ${queued.relativePath||"."}.`,impact:"REVISION_INCOMPLETE"}));
      }
    }
    return {root_path:root,files:files.sort((a,b)=>a.relative_path.localeCompare(b.relative_path)),failures,excluded_boundaries:excluded_boundaries.sort((a,b)=>a.relative_path.localeCompare(b.relative_path)),totals:{discovered_files:progress.discoveredFiles,discovered_bytes:progress.discoveredBytes}};
  } finally {
    if (ownsAuthority) await authority.close().catch(()=>undefined);
  }
}

export async function sha256File(
  absolutePath: string,
  options: {
    signal?: AbortSignal;
    deadlineAt?: number;
    maxBytes?: number;
    byteBudgetCode?: string;
    onBytes?: (bytes: number) => void;
    authorizedRootPath?: string;
    authorizedRootRealPath?: string;
    authorizedRootIdentity?: ProofGradeFilesystemObjectIdentity;
    relativePath?: string;
    expectedDeviceId?: string;
    expectedInode?: string;
    expectedProofMethod?: ProofGradeFilesystemObjectIdentity["proof_method"];
    expectedSizeBytes?: number;
    objectAuthority?: WorkspaceFilesystemObjectAuthority;
  } = {},
): Promise<string> {
  const captured = await captureWorkspaceFile(absolutePath, {
    maxPrefixBytes: 0,
    signal: options.signal,
    deadlineAt: options.deadlineAt,
    onBytes: options.onBytes,
    maxBytes: options.maxBytes,
    byteBudgetCode: options.byteBudgetCode,
    authorizedRootPath: options.authorizedRootPath,
    authorizedRootRealPath: options.authorizedRootRealPath,
    authorizedRootIdentity: options.authorizedRootIdentity,
    relativePath: options.relativePath,
    expectedDeviceId: options.expectedDeviceId,
    expectedInode: options.expectedInode,
    expectedProofMethod: options.expectedProofMethod,
    expectedSizeBytes: options.expectedSizeBytes,
    objectAuthority: options.objectAuthority,
  });
  return captured.content_hash;
}

export type CapturedWorkspaceFile = {
  content_hash: string;
  bytes_read: number;
  prefix_bytes: Buffer;
  prefix_complete_file: boolean;
  line_count?: number;
};

export type WorkspaceCaptureStreamFactory = (absolutePath: string) => Readable;

async function captureInjectedStream(
  absolutePath: string,
  streamFactory: WorkspaceCaptureStreamFactory,
  options: { maxPrefixBytes:number; signal?:AbortSignal; deadlineAt?:number; maxBytes?:number; byteBudgetCode?:string; onBytes?:(bytes:number)=>void; countLines?:boolean },
): Promise<CapturedWorkspaceFile> {
  const stream=streamFactory(absolutePath);
  const hash=createHash("sha256");
  const prefixChunks:Buffer[]=[];
  let prefixBytes=0,totalBytes=0,newlineCount=0;
  const abort=()=>{ if("destroy" in stream&&typeof stream.destroy==="function") stream.destroy(new WorkspaceIndexBoundedError("WORKSPACE_INDEX_ABORTED",{phase:"CAPTURE"})); };
  options.signal?.addEventListener("abort",abort,{once:true});
  try{
    for await(const rawChunk of stream){
      if(options.signal?.aborted) throw new WorkspaceIndexBoundedError("WORKSPACE_INDEX_ABORTED",{phase:"CAPTURE"});
      if(options.deadlineAt!==undefined&&Date.now()>=options.deadlineAt) throw new WorkspaceIndexBoundedError("WORKSPACE_INDEX_TIMEOUT",{phase:"CAPTURE"});
      const chunk=typeof rawChunk==="string"?Buffer.from(rawChunk):Buffer.from(rawChunk as Uint8Array);
      if(options.maxBytes!==undefined&&totalBytes+chunk.length>options.maxBytes) throw new WorkspaceIndexBoundedError(options.byteBudgetCode??"WORKSPACE_CAPTURE_BYTE_BUDGET_EXCEEDED",{phase:"CAPTURE",bytesRead:totalBytes,nextChunkBytes:chunk.length,maxBytes:options.maxBytes});
      hash.update(chunk); totalBytes+=chunk.length; options.onBytes?.(chunk.length);
      if(options.countLines) for(const byte of chunk) if(byte===0x0a) newlineCount++;
      const remaining=options.maxPrefixBytes-prefixBytes;
      if(remaining>0){const taken=chunk.subarray(0,Math.min(remaining,chunk.length));prefixChunks.push(taken);prefixBytes+=taken.length;}
    }
  }finally{ options.signal?.removeEventListener("abort",abort); }
  return {content_hash:`sha256:${hash.digest("hex")}`,bytes_read:totalBytes,prefix_bytes:Buffer.concat(prefixChunks,prefixBytes),prefix_complete_file:prefixBytes===totalBytes,...(options.countLines?{line_count:totalBytes===0?0:newlineCount+1}:{})};
}

function captureTerminalGovernanceError(options: { signal?: AbortSignal; deadlineAt?: number }): WorkspaceIndexBoundedError | undefined {
  if (options.signal?.aborted) return new WorkspaceIndexBoundedError("WORKSPACE_INDEX_ABORTED", { phase: "CAPTURE" });
  if (options.deadlineAt !== undefined && Date.now() >= options.deadlineAt) {
    return new WorkspaceIndexBoundedError("WORKSPACE_INDEX_TIMEOUT", { phase: "CAPTURE", deadlineAt: options.deadlineAt });
  }
  return undefined;
}

export async function captureWorkspaceFile(
  absolutePath: string,
  options: {
    maxPrefixBytes: number;
    signal?: AbortSignal;
    deadlineAt?: number;
    maxBytes?: number;
    byteBudgetCode?: string;
    onBytes?: (bytes: number) => void;
    /** Test-only injected byte stream. Production governed source reads must use the verified-child authority fields below. */
    streamFactory?: WorkspaceCaptureStreamFactory;
    authorizedRootPath?: string;
    authorizedRootRealPath?: string;
    authorizedRootIdentity?: ProofGradeFilesystemObjectIdentity;
    relativePath?: string;
    expectedDeviceId?: string;
    expectedInode?: string;
    expectedProofMethod?: ProofGradeFilesystemObjectIdentity["proof_method"];
    expectedSizeBytes?: number;
    objectAuthority?: WorkspaceFilesystemObjectAuthority;
    /** Count text lines from the same captured byte stream used for hashing. */
    countLines?: boolean;
    /** Internal deterministic race-test hook; production callers leave undefined. */
    beforeOpen?: (absolutePath: string) => void | Promise<void>;
  },
): Promise<CapturedWorkspaceFile> {
  if (!Number.isSafeInteger(options.maxPrefixBytes) || options.maxPrefixBytes < 0) throw new Error("WORKSPACE_CAPTURE_PREFIX_LIMIT_INVALID");
  if (options.maxBytes !== undefined && (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0)) throw new Error("WORKSPACE_CAPTURE_BYTE_LIMIT_INVALID");
  const terminalBeforeCapture = captureTerminalGovernanceError(options);
  if (terminalBeforeCapture) throw terminalBeforeCapture;
  try {
    if (options.streamFactory) return await captureInjectedStream(absolutePath,options.streamFactory,options);

    if (!options.authorizedRootPath || !options.authorizedRootIdentity || options.relativePath===undefined) {
    throw new Error("WORKSPACE_CAPTURE_VERIFIED_CHILD_AUTHORITY_REQUIRED");
  }
  const normalizedRelative=normalizeAuthorityRelativePath(options.relativePath);
  if(!normalizedRelative) throw new Error("WORKSPACE_CAPTURE_RELATIVE_FILE_REQUIRED");
  const expectedIdentity = options.expectedDeviceId!==undefined && options.expectedInode!==undefined
    ? {
      device_id:options.expectedDeviceId,
      file_id:options.expectedInode,
      proof_method:options.expectedProofMethod??options.authorizedRootIdentity.proof_method,
    } satisfies ProofGradeFilesystemObjectIdentity
    : undefined;
  await options.beforeOpen?.(absolutePath);
  const authority=options.objectAuthority??createWorkspaceFilesystemObjectAuthority();
  const ownsAuthority=!options.objectAuthority;
  try{
    const captured=await authority.captureRelativeFile({
      rootPath:path.resolve(options.authorizedRootPath),
      rootIdentity:options.authorizedRootIdentity,
      relativeFilePath:normalizedRelative,
      expectedFileIdentity:expectedIdentity,
      expectedSizeBytes:options.expectedSizeBytes,
      maxPrefixBytes:options.maxPrefixBytes,
      countLines:options.countLines,
      signal:options.signal,
      deadlineAt:options.deadlineAt,
      maxBytes:options.maxBytes,
      byteBudgetCode:options.byteBudgetCode,
      onBytes:options.onBytes,
    });
    return {
      content_hash:captured.content_hash,
      bytes_read:captured.bytes_read,
      prefix_bytes:captured.prefix_bytes,
      prefix_complete_file:captured.prefix_complete_file,
      ...(options.countLines?{line_count:captured.line_count??0}:{}),
    };
  }finally{
    if(ownsAuthority) await authority.close().catch(()=>undefined);
  }
  } catch (error) {
    const terminal = captureTerminalGovernanceError(options);
    if (terminal) throw terminal;
    throw error;
  }
}

export async function readTextForIndexing(entry:FilesystemInventoryEntry,maxParseBytes:number, options:{signal?:AbortSignal;deadlineAt?:number}={}):Promise<{content?:string;encoding:FileEncoding;binary:boolean;tooLarge:boolean}>{
  if(options.signal?.aborted) throw new WorkspaceIndexBoundedError("WORKSPACE_INDEX_ABORTED",{}); if(options.deadlineAt&&Date.now()>=options.deadlineAt) throw new WorkspaceIndexBoundedError("WORKSPACE_INDEX_TIMEOUT",{});
  if(entry.file_kind==="BINARY") return {encoding:"BINARY",binary:true,tooLarge:false}; if(entry.size_bytes>maxParseBytes) return {encoding:"UNKNOWN",binary:false,tooLarge:true};
  const captured=await captureWorkspaceFile(entry.absolute_path,{maxPrefixBytes:maxParseBytes+1,signal:options.signal,deadlineAt:options.deadlineAt,authorizedRootPath:entry.authorized_root_reference_path,authorizedRootRealPath:entry.authorized_root_real_path,authorizedRootIdentity:entry.authorized_root_identity,relativePath:entry.relative_path,expectedDeviceId:entry.device_id,expectedInode:entry.inode,expectedProofMethod:entry.object_identity_proof_method,expectedSizeBytes:entry.size_bytes});
  return decodeCapturedTextForIndexing(entry,captured,maxParseBytes);
}

export function decodeCapturedTextForIndexing(
  entry: FilesystemInventoryEntry,
  captured: CapturedWorkspaceFile,
  maxParseBytes: number,
): { content?: string; encoding: FileEncoding; binary: boolean; tooLarge: boolean } {
  if (entry.file_kind === "BINARY") return { encoding: "BINARY", binary: true, tooLarge: false };
  if (captured.bytes_read > maxParseBytes || !captured.prefix_complete_file) {
    return { encoding: "UNKNOWN", binary: false, tooLarge: true };
  }
  const bytes = captured.prefix_bytes;
  const sample = bytes.subarray(0, Math.min(bytes.length, 8192));
  if (sample.includes(0) && !(bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe)) {
    return { encoding: "BINARY", binary: true, tooLarge: false };
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { content: bytes.subarray(2).toString("utf16le"), encoding: "UTF16LE", binary: false, tooLarge: false };
  }
  const payload = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
    ? bytes.subarray(3)
    : bytes;
  return { content: payload.toString("utf8"), encoding: "UTF8", binary: false, tooLarge: false };
}

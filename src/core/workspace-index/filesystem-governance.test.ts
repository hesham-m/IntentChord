import { mkdtemp, mkdir, writeFile, rm, rename, symlink, open, opendir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { constants as fsConstants, writeFileSync, type BigIntStats } from "node:fs";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { captureWorkspaceFile, classifySensitivity, inventoryWorkspaceFiles, WorkspaceIndexBoundedError, WORKSPACE_TRAVERSAL_POLICY_ID } from "@/core/workspace-index/adapters/filesystem";
import { createWorkspaceFilesystemObjectAuthority, proofGradeNodeObjectIdentityFromStats, sameProofGradeFilesystemObject, type ProofGradeFilesystemObjectIdentity, type WorkspaceFilesystemObjectAuthority } from "@/core/workspace-index/filesystem-object-authority";
import { indexWorkspace } from "@/core/workspace-index/indexer";
import { canonicalIndexArtifactSemanticSha256 } from "@/core/workspace-index/artifact-identity";
import { DEFAULT_WORKSPACE_DURATION_GOVERNANCE } from "@/core/workspace-index/duration-governance";

async function fixture() { return mkdtemp(path.join(tmpdir(), "intentchord-governed-index-")); }
const execFileAsync = promisify(execFile);
async function createDirectoryBoundaryLink(target: string, linkPath: string) {
  await symlink(target, linkPath, process.platform === "win32" ? "junction" : "dir");
}
async function windowsAuthoritySelfTest(): Promise<{
  ok: boolean;
  same_handle_swap: string;
  relative_child_root_swap: string;
  relative_parent_swap: string;
  relative_child_identity_swap: string;
  outside_marker_enumerated: boolean;
  outside_child_read: boolean;
  file_id_length: number;
}> {
  const { stdout } = await execFileAsync("powershell.exe", [
    "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass",
    "-File", path.resolve("scripts/windows-filesystem-object-authority.ps1"),
    "-SelfTest",
  ], { windowsHide: true, timeout: 30_000 });
  return JSON.parse(stdout.trim());
}

describe("governed Workspace traversal and budgets", () => {
  it("classifies mixed and upper-case sensitive filenames without changing filesystem path identity semantics", () => {
    expect(classifySensitivity(".ENV")).toBe("SECRET");
    expect(classifySensitivity("PASSWORD.txt")).toBe("CREDENTIAL_LIKE");
    expect(classifySensitivity("API_KEY.json")).toBe("CREDENTIAL_LIKE");
    expect(classifySensitivity("CLIENT_SECRET")).toBe("SECRET");
    expect(classifySensitivity("Credentials.JSON")).toBe("SECRET");
    expect(classifySensitivity("Certificate.PEM")).toBe("SENSITIVE");
  });
  it("prunes generated trees before child enumeration and records explicit boundaries", async () => {
    const root=await fixture();
    try {
      await mkdir(path.join(root,"src"),{recursive:true}); await writeFile(path.join(root,"src","a.ts"),"export const a=1");
      await mkdir(path.join(root,"node_modules","pkg","deep"),{recursive:true});
      for(let i=0;i<50;i++) await writeFile(path.join(root,"node_modules","pkg","deep",`${i}.js`),"x");
      await mkdir(path.join(root,".next-cache","chunks"),{recursive:true}); await writeFile(path.join(root,".next-cache","chunks","x.js"),"x");
      const result=await inventoryWorkspaceFiles(root);
      expect(result.files.map(file=>file.relative_path)).toEqual(["src/a.ts"]);
      expect(result.excluded_boundaries).toEqual(expect.arrayContaining([
        {relative_path:"node_modules",exclusion_reason:"TECHNICAL_GENERATED_TREE",governing_policy_id:WORKSPACE_TRAVERSAL_POLICY_ID},
        {relative_path:".next-cache",exclusion_reason:"TECHNICAL_GENERATED_TREE",governing_policy_id:WORKSPACE_TRAVERSAL_POLICY_ID},
      ]));
    } finally { await rm(root,{recursive:true,force:true}); }
  });

  it("preserves owner restricted paths separately from technical exclusions", async () => {
    const root=await fixture();
    try { await mkdir(path.join(root,"private","deep"),{recursive:true}); await writeFile(path.join(root,"private","deep","a.txt"),"secret");
      const result=await inventoryWorkspaceFiles(root,["private"]);
      expect(result.files).toHaveLength(0);
      expect(result.excluded_boundaries[0]).toMatchObject({relative_path:"private",exclusion_reason:"OWNER_RESTRICTED_PATH"});
    } finally { await rm(root,{recursive:true,force:true}); }
  });

  it("fails explicitly on file and aggregate-byte discovery budgets", async () => {
    const root=await fixture();
    try { await writeFile(path.join(root,"a.txt"),"1234"); await writeFile(path.join(root,"b.txt"),"5678");
      await expect(inventoryWorkspaceFiles(root,[],undefined,{budgets:{maxDiscoveredFiles:1}})).rejects.toMatchObject({code:"WORKSPACE_INDEX_FILE_BUDGET_EXCEEDED"});
      await expect(inventoryWorkspaceFiles(root,[],undefined,{budgets:{maxDiscoveredBytes:4}})).rejects.toMatchObject({code:"WORKSPACE_INDEX_BYTE_BUDGET_EXCEEDED"});
    } finally { await rm(root,{recursive:true,force:true}); }
  });

  it("fails explicitly on hash, timeout, abort and retained-text budgets", async () => {
    const root=await fixture();
    try { await writeFile(path.join(root,"large.bin"),Buffer.alloc(4096,1));
      await expect(indexWorkspace({workspace_instance_id:"w",root_path:root,budgets:{maxHashedBytes:1024}})).rejects.toMatchObject({code:"WORKSPACE_INDEX_HASH_BUDGET_EXCEEDED"});
      await expect(indexWorkspace({workspace_instance_id:"w",root_path:root,duration_policy:{...DEFAULT_WORKSPACE_DURATION_GOVERNANCE,discoveryMaxMs:0}})).rejects.toMatchObject({code:"WORKSPACE_INDEX_TIMEOUT"});
      const controller=new AbortController(); controller.abort();
      await expect(indexWorkspace({workspace_instance_id:"w",root_path:root,signal:controller.signal})).rejects.toMatchObject({code:"WORKSPACE_INDEX_ABORTED"});
      await writeFile(path.join(root,"large-a.md"),"x".repeat(800));
      await writeFile(path.join(root,"large-b.md"),"y".repeat(800));
      await expect(indexWorkspace({workspace_instance_id:"w",root_path:root,max_parse_bytes:4096,budgets:{maxRetainedTextBytesPerFile:1024,maxAggregateRetainedTextBytes:1200,maxHashedBytes:10000}})).rejects.toMatchObject({code:"WORKSPACE_INDEX_AGGREGATE_TEXT_BUDGET_EXCEEDED"});
    } finally { await rm(root,{recursive:true,force:true}); }
  });


  it("keeps report directories in scope while generated technical trees remain pruned", async () => {
    const root=await fixture();
    try {
      for (const directory of ["chatgpt report 3", "codex report 3", "gemini report 3"]) {
        await mkdir(path.join(root,directory),{recursive:true});
        await writeFile(path.join(root,directory,"history.md"),`# ${directory}`);
      }
      await mkdir(path.join(root,"node_modules","pkg"),{recursive:true});
      await writeFile(path.join(root,"node_modules","pkg","generated.js"),"generated");
      const result=await inventoryWorkspaceFiles(root);
      expect(result.files.map(file=>file.relative_path)).toEqual(expect.arrayContaining([
        "chatgpt report 3/history.md",
        "codex report 3/history.md",
        "gemini report 3/history.md",
      ]));
      expect(result.files.some(file=>file.relative_path.includes("node_modules"))).toBe(false);
      expect(result.excluded_boundaries.some(item=>item.relative_path==="node_modules")).toBe(true);
    } finally { await rm(root,{recursive:true,force:true}); }
  });

  it("keeps an oversized CSV as a full-hash metadata record with bounded evidence and continues other files", async () => {
    const root=await fixture();
    try {
      await mkdir(path.join(root,"chatgpt report 3"),{recursive:true});
      const csvPath=path.join(root,"chatgpt report 3","R18X_R9D_STAGE12_SOURCE_MATCHES.csv");
      const csv=`name,note\n${Array.from({length:120},(_,index)=>`row-${index},${"evidence".repeat(8)}`).join("\n")}\n`;
      await writeFile(csvPath,csv);
      await writeFile(path.join(root,"README.md"),"# Remaining file continues");
      const expectedHash=`sha256:${createHash("sha256").update(Buffer.from(csv)).digest("hex")}`;
      const contract=await indexWorkspace({
        workspace_instance_id:"workspace-oversized-csv",
        root_path:root,
        max_parse_bytes:16*1024,
        budgets:{
          maxRetainedTextBytesPerFile:512,
          maxAggregateRetainedTextBytes:4096,
          maxCsvSampleBytes:256,
          maxHashedBytes:1024*1024,
        },
      });
      const csvFile=contract.snapshot.files.find(file=>file.relative_path.endsWith("SOURCE_MATCHES.csv"))!;
      const readme=contract.snapshot.files.find(file=>file.relative_path==="README.md")!;
      const profile=contract.snapshot.facts.find(fact=>fact.qualified_name.endsWith("#bounded-csv-profile"))!;
      expect(contract.contract_status).toBe("COMPLETE_WITH_GAPS");
      expect(csvFile.content_hash).toBe(expectedHash);
      expect(csvFile.parse_status).toBe("METADATA_ONLY");
      expect(csvFile.coverage_state).toBe("PARTIAL");
      expect(readme.coverage_state).toBe("COMPLETE");
      expect(profile.source_file_revision_id).toBe(csvFile.file_revision_id);
      expect(profile.fact_revision_id).not.toBe(csvFile.file_revision_id);
      expect(profile.attributes.row_count_scope).toBe("SAMPLE_COMPLETE_RECORDS_ONLY");
      expect(profile.attributes.exact_record_count).toBeUndefined();
      expect(Number(profile.attributes.sample_bytes_read)).toBeLessThanOrEqual(256);
      expect(contract.failures.some(item=>item.error_code==="FILE_EXCEEDS_PER_FILE_RETAINED_TEXT_LIMIT")).toBe(true);
      const serialized=JSON.stringify(contract);
      expect(serialized).not.toContain("row-119");
      expect(serialized.length).toBeLessThan(csv.length * 4);
    } finally { await rm(root,{recursive:true,force:true}); }
  });

  it("T10 binds full-file hash and parsed CSV evidence to the same governed capture stream when the live path changes", async () => {
    const root=await fixture();
    try {
      const csvPath=path.join(root,"evidence.csv");
      const stateA=Buffer.from('nameA,noteA\nalpha,one\n');
      const stateB=Buffer.from('nameB,noteB\nbravo,two\n');
      await writeFile(csvPath,stateA);
      let swapped=false;
      const contract=await indexWorkspace({
        workspace_instance_id:"workspace-capture-consistency",
        root_path:root,
        capture_stream_factory:target=>{
          if(target===csvPath && !swapped){
            swapped=true;
            writeFileSync(csvPath,stateB);
            return Readable.from([stateA]);
          }
          return Readable.from([]);
        },
      });
      const file=contract.snapshot.files.find(item=>item.relative_path==="evidence.csv")!;
      const profile=contract.snapshot.facts.find(item=>item.qualified_name==="evidence.csv#bounded-csv-profile")!;
      const expectedHash=`sha256:${createHash("sha256").update(stateA).digest("hex")}`;
      expect(file.content_hash).toBe(expectedHash);
      expect(file.parse_status).toBe("PARSED");
      expect(profile.attributes.header_columns_json).toContain("nameA");
      expect(profile.attributes.header_columns_json).not.toContain("nameB");
      expect(profile.attributes.exact_record_count).toBe(2);
    } finally { await rm(root,{recursive:true,force:true}); }
  });

  it("keeps valid small Workspace indexing and exposes boundary metadata", async () => {
    const root=await fixture();
    try { await mkdir(path.join(root,"src")); await writeFile(path.join(root,"src","a.ts"),"export const a=1;"); await mkdir(path.join(root,"dist")); await writeFile(path.join(root,"dist","bundle.js"),"generated");
      const contract=await indexWorkspace({workspace_instance_id:"workspace-small",root_path:root});
      expect(contract.snapshot.files.map(file=>file.relative_path)).toEqual(["src/a.ts"]);
      expect(contract.source_binding.metadata.traversal_policy_id).toBe(WORKSPACE_TRAVERSAL_POLICY_ID);
    } finally { await rm(root,{recursive:true,force:true}); }
  });

  it("T36 source-state incomplete capture fails closed before minting a canonical Workspace Revision", async () => {
    const root = await fixture();
    try {
      await writeFile(path.join(root, "A.ts"), "export const A = 1;\n");
      await writeFile(path.join(root, "B.ts"), "export const B = 2;\n");
      await expect(indexWorkspace({
        workspace_instance_id: "workspace-incomplete-capture",
        root_path: root,
        capture_stream_factory: target => {
          if (target.endsWith(`${path.sep}B.ts`)) throw new Error("simulated governed capture failure");
          return Readable.from([Buffer.from("export const A = 1;\n")]);
        },
      })).rejects.toMatchObject({ code: "WORKSPACE_SOURCE_STATE_INCOMPLETE" });
    } finally { await rm(root,{recursive:true,force:true}); }
  });


  it("T46 symlink/reparse presence stays Observation boundary evidence and cannot change intrinsic Artifact bytes under the same Source Revision", async () => {
    const root = await fixture();
    const outside = await fixture();
    try {
      await writeFile(path.join(root, "A.ts"), "export const A = 1;\n");
      await writeFile(path.join(outside, "sentinel.txt"), "OUTSIDE-SENTINEL-T46");
      const stateA = await indexWorkspace({ workspace_instance_id: "workspace-t46", root_path: root, binding_type: "LOCAL_FILESYSTEM" });
      await createDirectoryBoundaryLink(outside, path.join(root, "outside-link"));
      const stateB = await indexWorkspace({ workspace_instance_id: "workspace-t46", root_path: root, binding_type: "LOCAL_FILESYSTEM" });
      expect(stateB.failures.some(item => item.error_code === "SYMLINK_NOT_FOLLOWED" || item.error_code === "REPARSE_POINT_NOT_FOLLOWED")).toBe(true);
      expect(stateB.workspace.workspace_revision_id).toBe(stateA.workspace.workspace_revision_id);
      expect(canonicalIndexArtifactSemanticSha256(stateB)).toBe(canonicalIndexArtifactSemanticSha256(stateA));
      expect(JSON.stringify(stateB.snapshot)).not.toContain("OUTSIDE-SENTINEL-T46");
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("T47 a symlink/junction inside the Workspace never consumes outside target bytes as governed Workspace content", async () => {
    const root = await fixture();
    const outside = await fixture();
    try {
      await writeFile(path.join(root, "inside.txt"), "INSIDE-T47");
      await writeFile(path.join(outside, "outside-secret.txt"), "OUTSIDE-BYTES-MUST-NOT-BE-CONSUMED-T47");
      await createDirectoryBoundaryLink(outside, path.join(root, "boundary-link"));
      const contract = await indexWorkspace({ workspace_instance_id: "workspace-t47", root_path: root, binding_type: "LOCAL_FILESYSTEM" });
      expect(contract.snapshot.files.map(item => item.relative_path)).toContain("inside.txt");
      expect(contract.snapshot.files.some(item => item.relative_path.includes("outside-secret"))).toBe(false);
      expect(contract.failures.some(item => item.error_code === "SYMLINK_NOT_FOLLOWED" || item.error_code === "REPARSE_POINT_NOT_FOLLOWED")).toBe(true);
      expect(JSON.stringify(contract)).not.toContain("OUTSIDE-BYTES-MUST-NOT-BE-CONSUMED-T47");
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("T48 file substitution through a parent symlink/junction fails before outside content can become a canonical Source Revision", async () => {
    const root = await fixture();
    const outside = await fixture();
    try {
      const sourceDir = path.join(root, "src");
      await mkdir(sourceDir, { recursive: true });
      await writeFile(path.join(sourceDir, "a.txt"), "AUTHORIZED-T48");
      await writeFile(path.join(outside, "a.txt"), "OUTSIDE-T48-DO-NOT-READ");
      let substituted = false;
      await expect(indexWorkspace({
        workspace_instance_id: "workspace-t48",
        root_path: root,
        binding_type: "LOCAL_FILESYSTEM",
        capture_before_open: async absolutePath => {
          if (substituted || path.basename(absolutePath) !== "a.txt") return;
          substituted = true;
          await rename(sourceDir, `${sourceDir}-original`);
          await createDirectoryBoundaryLink(outside, sourceDir);
        },
      })).rejects.toMatchObject({ code: "WORKSPACE_SOURCE_STATE_INCOMPLETE" });
      expect(substituted).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("T49 queued directory substitution with a symlink/junction fails closed and never traverses the outside directory", async () => {
    const root = await fixture();
    const outside = await fixture();
    try {
      const nested = path.join(root, "nested");
      await mkdir(nested, { recursive: true });
      await writeFile(path.join(nested, "inside.txt"), "AUTHORIZED-T49");
      await writeFile(path.join(outside, "outside.txt"), "OUTSIDE-T49-DO-NOT-TRAVERSE");
      let substituted = false;
      await expect(indexWorkspace({
        workspace_instance_id: "workspace-t49",
        root_path: root,
        binding_type: "LOCAL_FILESYSTEM",
        inventory_before_directory_open: async absolutePath => {
          if (substituted || path.basename(absolutePath) !== "nested") return;
          substituted = true;
          await rename(nested, `${nested}-original`);
          await createDirectoryBoundaryLink(outside, nested);
        },
      })).rejects.toMatchObject({ code: "WORKSPACE_SOURCE_STATE_INCOMPLETE" });
      expect(substituted).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });


  it("T51 directory object swap after guard verification keeps enumeration bound to the actual verified directory object", async () => {
    if (process.platform === "win32") {
      const { stdout } = await execFileAsync("powershell.exe", [
        "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass",
        "-File", path.resolve("scripts/windows-filesystem-object-authority.ps1"),
        "-SelfTest",
      ], { windowsHide: true, timeout: 30_000 });
      const result = JSON.parse(stdout.trim()) as { ok: boolean; same_handle_swap: string; outside_marker_enumerated: boolean; file_id_length: number };
      expect(result).toMatchObject({ ok: true, same_handle_swap: "PASS", outside_marker_enumerated: false, file_id_length: 32 });
      return;
    }

    if (process.platform !== "linux") {
      expect(() => createWorkspaceFilesystemObjectAuthority()).toThrowError(expect.objectContaining({ code: "WORKSPACE_OBJECT_IDENTITY_UNPROVABLE" }));
      return;
    }

    const base = await fixture();
    const root = path.join(base, "authorized");
    const outside = path.join(base, "outside");
    const displaced = path.join(base, "authorized-displaced");
    await mkdir(root); await mkdir(outside);
    await writeFile(path.join(root, "authorized-marker.txt"), "AUTHORIZED");
    await writeFile(path.join(outside, "outside-marker.txt"), "OUTSIDE");
    const flags = fsConstants.O_RDONLY | (typeof fsConstants.O_DIRECTORY === "number" ? fsConstants.O_DIRECTORY : 0);
    const guard = await open(root, flags);
    try {
      const expected = proofGradeNodeObjectIdentityFromStats(await guard.stat({ bigint: true }));
      await rename(root, displaced);
      await rename(outside, root);
      const dir = await opendir(`/proc/self/fd/${guard.fd}`);
      const entries: string[] = [];
      try { for await (const entry of dir) entries.push(entry.name); }
      finally { await dir.close().catch(() => undefined); }
      const after = proofGradeNodeObjectIdentityFromStats(await guard.stat({ bigint: true }));
      expect(sameProofGradeFilesystemObject(expected, after)).toBe(true);
      expect(entries).toContain("authorized-marker.txt");
      expect(entries).not.toContain("outside-marker.txt");
    } finally {
      await guard.close().catch(() => undefined);
      await rm(base, { recursive: true, force: true });
    }
  });

  it("T52 queued directory substitution rejects a different actual directory object before outside entries are accepted", async () => {
    const root = await fixture();
    try {
      const rootIdentity: ProofGradeFilesystemObjectIdentity = { device_id: "1", file_id: "10", proof_method: "NODE_BIGINT_DEV_INO_V1" };
      const childIdentity: ProofGradeFilesystemObjectIdentity = { device_id: "1", file_id: "20", proof_method: "NODE_BIGINT_DEV_INO_V1" };
      const outsideIdentity: ProofGradeFilesystemObjectIdentity = { device_id: "2", file_id: "99", proof_method: "NODE_BIGINT_DEV_INO_V1" };
      const authority: WorkspaceFilesystemObjectAuthority = {
        async probeDirectory() { return { resolved_real_path: root, identity: rootIdentity }; },
        async enumerateRelativeDirectory(input) {
          if (!input.relativeDirectoryPath) {
            return {
              resolved_real_path: root,
              identity: rootIdentity,
              entries: [{ name: "nested", object_type: "DIRECTORY", identity: childIdentity }],
            };
          }
          if (input.expectedDirectoryIdentity && !sameProofGradeFilesystemObject(input.expectedDirectoryIdentity, outsideIdentity)) {
            const error = Object.assign(new Error("WORKSPACE_DIRECTORY_OBJECT_IDENTITY_CHANGED"), { code: "WORKSPACE_DIRECTORY_OBJECT_IDENTITY_CHANGED" });
            throw error;
          }
          return { resolved_real_path: root, identity: outsideIdentity, entries: [] };
        },
        async captureRelativeFile() { throw new Error("NOT_USED"); },
        async close() {},
      };
      const inventory = await inventoryWorkspaceFiles(root, [], undefined, { objectAuthority: authority });
      expect(inventory.files).toHaveLength(0);
      expect(inventory.failures.some(item => item.error_code === "WORKSPACE_DIRECTORY_OBJECT_IDENTITY_CHANGED")).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("T53 proof-grade object identity has no heuristic fallback when stable identity is unavailable", () => {
    const unprovable = {
      dev: BigInt(123),
      ino: BigInt(0),
      mode: BigInt(0o40755),
      size: BigInt(4096),
      birthtimeMs: BigInt(123456),
    } as unknown as BigIntStats;
    expect(() => proofGradeNodeObjectIdentityFromStats(unprovable)).toThrowError(expect.objectContaining({ code: "WORKSPACE_OBJECT_IDENTITY_UNPROVABLE" }));
  });

  it("T54 proof-grade object identity preserves values above Number.MAX_SAFE_INTEGER without numeric coercion", () => {
    const dev = BigInt("9007199254741999");
    const ino = BigInt("1844674407370955161");
    const stats = { dev, ino } as unknown as BigIntStats;
    const identity = proofGradeNodeObjectIdentityFromStats(stats);
    expect(identity.device_id).toBe(dev.toString(10));
    expect(identity.file_id).toBe(ino.toString(10));
    expect(identity.device_id).not.toBe(String(Number(dev)));
    expect(identity.file_id).not.toBe(String(Number(ino)));
  });

  it("T59 root swap after enumeration before child metadata keeps child resolution bound to the verified Root object", async () => {
    if (process.platform === "win32") {
      const result = await windowsAuthoritySelfTest();
      expect(result).toMatchObject({ ok: true, relative_child_root_swap: "PASS", outside_child_read: false });
      return;
    }
    if (process.platform !== "linux") return;
    const base = await fixture();
    const root = path.join(base, "root");
    const outside = path.join(base, "outside");
    const displaced = path.join(base, "root-displaced");
    await mkdir(root); await mkdir(outside);
    await writeFile(path.join(root, "same.txt"), "AUTHORIZED-T59");
    await writeFile(path.join(outside, "same.txt"), "OUTSIDE-T59");
    const bootstrap = createWorkspaceFilesystemObjectAuthority();
    const rootProof = await bootstrap.probeDirectory(root);
    await bootstrap.close();
    let swapped = false;
    const authority = createWorkspaceFilesystemObjectAuthority({
      afterDirectoryNamesEnumerated: async ({ relativeDirectoryPath }) => {
        if (swapped || relativeDirectoryPath !== "") return;
        swapped = true;
        await rename(root, displaced);
        await rename(outside, root);
      },
    });
    try {
      const enumerated = await authority.enumerateRelativeDirectory({
        rootPath: root,
        rootIdentity: rootProof.identity,
        relativeDirectoryPath: "",
        expectedDirectoryIdentity: rootProof.identity,
      });
      const child = enumerated.entries.find(entry => entry.name === "same.txt");
      expect(swapped).toBe(true);
      expect(child?.object_type).toBe("FILE");
      expect(child?.identity).toBeDefined();
      const replacementAuthority = createWorkspaceFilesystemObjectAuthority();
      const replacementProof = await replacementAuthority.probeDirectory(root);
      await replacementAuthority.close();
      expect(sameProofGradeFilesystemObject(replacementProof.identity, rootProof.identity)).toBe(false);
    } finally {
      await authority.close().catch(() => undefined);
      if (swapped) {
        await rename(root, outside).catch(() => undefined);
        await rename(displaced, root).catch(() => undefined);
      }
      await rm(base, { recursive: true, force: true });
    }
  });

  it("T60 root swap after child metadata before read cannot redirect content capture into a replacement tree", async () => {
    if (process.platform === "win32") {
      const result = await windowsAuthoritySelfTest();
      expect(result).toMatchObject({ ok: true, relative_child_root_swap: "PASS", outside_child_read: false });
      return;
    }
    if (process.platform !== "linux") return;
    const base = await fixture();
    const root = path.join(base, "root");
    const outside = path.join(base, "outside");
    const displaced = path.join(base, "root-displaced");
    await mkdir(root); await mkdir(outside);
    await writeFile(path.join(root, "same.txt"), "AUTHORIZED-T60");
    await writeFile(path.join(outside, "same.txt"), "OUTSIDE-T60");
    const bootstrap = createWorkspaceFilesystemObjectAuthority();
    const rootProof = await bootstrap.probeDirectory(root);
    const listing = await bootstrap.enumerateRelativeDirectory({ rootPath: root, rootIdentity: rootProof.identity, relativeDirectoryPath: "" });
    const expected = listing.entries.find(entry => entry.name === "same.txt")?.identity;
    await bootstrap.close();
    expect(expected).toBeDefined();
    let swapped = false;
    const authority = createWorkspaceFilesystemObjectAuthority({
      afterFileMetadataBeforeOpen: async () => {
        if (swapped) return;
        swapped = true;
        await rename(root, displaced);
        await rename(outside, root);
      },
    });
    try {
      const captured = await authority.captureRelativeFile({
        rootPath: root,
        rootIdentity: rootProof.identity,
        relativeFilePath: "same.txt",
        expectedFileIdentity: expected,
        maxPrefixBytes: 1024,
      });
      expect(captured.prefix_bytes.toString("utf8")).toBe("AUTHORIZED-T60");
      expect(captured.prefix_bytes.toString("utf8")).not.toContain("OUTSIDE-T60");
    } finally {
      await authority.close().catch(() => undefined);
      if (swapped) {
        await rename(root, outside).catch(() => undefined);
        await rename(displaced, root).catch(() => undefined);
      }
      await rm(base, { recursive: true, force: true });
    }
  });

  it("T61 nested parent replacement after enumeration cannot redirect child metadata to the replacement parent", async () => {
    if (process.platform === "win32") {
      const result = await windowsAuthoritySelfTest();
      expect(result).toMatchObject({ ok: true, relative_parent_swap: "PASS", outside_child_read: false });
      return;
    }
    if (process.platform !== "linux") return;
    const base = await fixture();
    const root = path.join(base, "root");
    const src = path.join(root, "src");
    const outside = path.join(base, "outside-src");
    const displaced = path.join(root, "src-displaced");
    await mkdir(src, { recursive: true }); await mkdir(outside);
    await writeFile(path.join(src, "same.txt"), "AUTHORIZED-T61");
    await writeFile(path.join(outside, "same.txt"), "OUTSIDE-T61");
    const bootstrap = createWorkspaceFilesystemObjectAuthority();
    const rootProof = await bootstrap.probeDirectory(root);
    const rootListing = await bootstrap.enumerateRelativeDirectory({ rootPath: root, rootIdentity: rootProof.identity, relativeDirectoryPath: "" });
    const srcIdentity = rootListing.entries.find(entry => entry.name === "src")?.identity;
    await bootstrap.close();
    expect(srcIdentity).toBeDefined();
    let swapped = false;
    const authority = createWorkspaceFilesystemObjectAuthority({
      afterDirectoryNamesEnumerated: async ({ relativeDirectoryPath }) => {
        if (swapped || relativeDirectoryPath !== "src") return;
        swapped = true;
        await rename(src, displaced);
        await rename(outside, src);
      },
    });
    try {
      const enumerated = await authority.enumerateRelativeDirectory({
        rootPath: root,
        rootIdentity: rootProof.identity,
        relativeDirectoryPath: "src",
        expectedDirectoryIdentity: srcIdentity,
      });
      const same = enumerated.entries.find(entry => entry.name === "same.txt");
      expect(swapped).toBe(true);
      expect(same?.object_type).toBe("FILE");
    } finally {
      await authority.close().catch(() => undefined);
      if (swapped) {
        await rename(src, outside).catch(() => undefined);
        await rename(displaced, src).catch(() => undefined);
      }
      await rm(base, { recursive: true, force: true });
    }
  });

  it("T62 child replacement between metadata and open fails before replacement bytes can be accepted", async () => {
    if (process.platform === "win32") {
      const result = await windowsAuthoritySelfTest();
      expect(result).toMatchObject({ ok: true, relative_child_identity_swap: "PASS", outside_child_read: false });
      return;
    }
    if (process.platform !== "linux") return;
    const root = await fixture();
    const original = path.join(root, "same.txt");
    const displaced = path.join(root, "same-original.txt");
    const replacement = path.join(root, "replacement.txt");
    await writeFile(original, "AUTHORIZED-T62");
    await writeFile(replacement, "REPLACEMENT-T62-MUST-NOT-BE-ACCEPTED");
    const bootstrap = createWorkspaceFilesystemObjectAuthority();
    const rootProof = await bootstrap.probeDirectory(root);
    const listing = await bootstrap.enumerateRelativeDirectory({ rootPath: root, rootIdentity: rootProof.identity, relativeDirectoryPath: "" });
    const expected = listing.entries.find(entry => entry.name === "same.txt")?.identity;
    await bootstrap.close();
    expect(expected).toBeDefined();
    let swapped = false;
    const authority = createWorkspaceFilesystemObjectAuthority({
      afterFileMetadataBeforeOpen: async () => {
        if (swapped) return;
        swapped = true;
        await rename(original, displaced);
        await rename(replacement, original);
      },
    });
    try {
      await expect(authority.captureRelativeFile({
        rootPath: root,
        rootIdentity: rootProof.identity,
        relativeFilePath: "same.txt",
        expectedFileIdentity: expected,
        maxPrefixBytes: 1024,
      })).rejects.toMatchObject({ code: "WORKSPACE_CHILD_OBJECT_IDENTITY_CHANGED" });
    } finally {
      await authority.close().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("T65 authoritative Windows helper proves normal and same-handle relative-child source authority", async () => {
    if (process.platform !== "win32") return;
    const result = await windowsAuthoritySelfTest();
    expect(result).toMatchObject({
      ok: true,
      same_handle_swap: "PASS",
      relative_child_root_swap: "PASS",
      relative_parent_swap: "PASS",
      relative_child_identity_swap: "PASS",
      outside_marker_enumerated: false,
      outside_child_read: false,
      file_id_length: 32,
    });
  });

  it("T66 Non-Git Workspace indexing remains first-class and introduces no Git dependency", async () => {
    const root = await fixture();
    try {
      await writeFile(path.join(root, "plain.txt"), "NON-GIT-T66");
      const contract = await indexWorkspace({ workspace_instance_id: "workspace-t66", root_path: root, binding_type: "LOCAL_FILESYSTEM" });
      expect(contract.snapshot.files.some(file => file.relative_path === "plain.txt")).toBe(true);
      expect(JSON.stringify(contract)).not.toContain("git commit");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("T67 external symlink/junction target never becomes governed child source content", async () => {
    const root = await fixture();
    const outside = await fixture();
    try {
      await writeFile(path.join(root, "inside.txt"), "INSIDE-T67");
      await writeFile(path.join(outside, "secret.txt"), "OUTSIDE-T67-SECRET");
      await createDirectoryBoundaryLink(outside, path.join(root, "external-link"));
      const contract = await indexWorkspace({ workspace_instance_id: "workspace-t67", root_path: root, binding_type: "LOCAL_FILESYSTEM" });
      expect(contract.snapshot.files.map(file => file.relative_path)).toContain("inside.txt");
      expect(JSON.stringify(contract)).not.toContain("OUTSIDE-T67-SECRET");
      expect(contract.failures.some(item => item.error_code === "SYMLINK_NOT_FOLLOWED" || item.error_code === "REPARSE_POINT_NOT_FOLLOWED")).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("T68 same-name replacement tree cannot pass parent authority through matching name or plausible metadata", async () => {
    if (process.platform !== "linux") return;
    const base = await fixture();
    const root = path.join(base, "root");
    const outside = path.join(base, "outside");
    const displaced = path.join(base, "root-displaced");
    await mkdir(root); await mkdir(outside);
    await writeFile(path.join(root, "same.txt"), "AAAAAAAAAAAAAAAA");
    await writeFile(path.join(outside, "same.txt"), "BBBBBBBBBBBBBBBB");
    const bootstrap = createWorkspaceFilesystemObjectAuthority();
    const rootProof = await bootstrap.probeDirectory(root);
    await bootstrap.close();
    let swapped = false;
    const authority = createWorkspaceFilesystemObjectAuthority({
      afterDirectoryNamesEnumerated: async ({ relativeDirectoryPath }) => {
        if (swapped || relativeDirectoryPath !== "") return;
        swapped = true;
        await rename(root, displaced);
        await rename(outside, root);
      },
    });
    try {
      const listing = await authority.enumerateRelativeDirectory({ rootPath: root, rootIdentity: rootProof.identity, relativeDirectoryPath: "" });
      const child = listing.entries.find(entry => entry.name === "same.txt");
      expect(child?.identity).toBeDefined();
      await expect(authority.captureRelativeFile({
        rootPath: root,
        rootIdentity: rootProof.identity,
        relativeFilePath: "same.txt",
        expectedFileIdentity: child?.identity,
        expectedSizeBytes: child?.size_bytes,
        maxPrefixBytes: 1024,
      })).rejects.toMatchObject({ code: "WORKSPACE_ROOT_AUTHORITY_CHANGED" });
    } finally {
      await authority.close().catch(() => undefined);
      if (swapped) {
        await rename(root, outside).catch(() => undefined);
        await rename(displaced, root).catch(() => undefined);
      }
      await rm(base, { recursive: true, force: true });
    }
  });

  it("T69 Windows governed capture aborts after a real mid-file progress chunk and closes the owned helper", async () => {
    if (process.platform !== "win32") return;
    const root = await fixture();
    try {
      await writeFile(path.join(root, "large.bin"), Buffer.alloc(8 * 1024 * 1024, 0x41));
      const bootstrap = createWorkspaceFilesystemObjectAuthority();
      const proof = await bootstrap.probeDirectory(root);
      const listing = await bootstrap.enumerateRelativeDirectory({ rootPath: root, rootIdentity: proof.identity, relativeDirectoryPath: "" });
      await bootstrap.close();
      const file = listing.entries.find(entry => entry.name === "large.bin");
      expect(file?.identity).toBeDefined();
      const controller = new AbortController();
      let progressChunks = 0; let spawnedPid = 0; let closedPid = 0;
      const authority = createWorkspaceFilesystemObjectAuthority({
        windowsCaptureChunkDelayMs: 30,
        onWindowsCaptureHelperSpawned: pid => { spawnedPid = pid; },
        onWindowsCaptureHelperClosed: pid => { closedPid = pid; },
        onWindowsCaptureProgress: () => { progressChunks += 1; if (progressChunks === 1) controller.abort(); },
      });
      try {
        await expect(authority.captureRelativeFile({
          rootPath: root, rootIdentity: proof.identity, relativeFilePath: "large.bin", expectedFileIdentity: file?.identity,
          expectedSizeBytes: file?.size_bytes, maxPrefixBytes: 1024, signal: controller.signal,
        })).rejects.toMatchObject({ code: "WORKSPACE_INDEX_ABORTED" });
        expect(progressChunks).toBeGreaterThanOrEqual(1);
        expect(spawnedPid).toBeGreaterThan(0);
        expect(closedPid).toBe(spawnedPid);
      } finally { await authority.close().catch(() => undefined); }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("T70 Windows governed capture enforces the absolute deadline during an active file read", async () => {
    if (process.platform !== "win32") return;
    const root = await fixture();
    try {
      await writeFile(path.join(root, "deadline.bin"), Buffer.alloc(16 * 1024 * 1024, 0x42));
      const bootstrap = createWorkspaceFilesystemObjectAuthority();
      const proof = await bootstrap.probeDirectory(root);
      const listing = await bootstrap.enumerateRelativeDirectory({ rootPath: root, rootIdentity: proof.identity, relativeDirectoryPath: "" });
      await bootstrap.close();
      const file = listing.entries.find(entry => entry.name === "deadline.bin");
      let progressChunks = 0;
      const authority = createWorkspaceFilesystemObjectAuthority({ windowsCaptureChunkDelayMs: 50, onWindowsCaptureProgress: () => { progressChunks += 1; } });
      try {
        await expect(authority.captureRelativeFile({
          rootPath: root, rootIdentity: proof.identity, relativeFilePath: "deadline.bin", expectedFileIdentity: file?.identity,
          expectedSizeBytes: file?.size_bytes, maxPrefixBytes: 1024, deadlineAt: Date.now() + 8_000,
        })).rejects.toMatchObject({ code: "WORKSPACE_INDEX_TIMEOUT" });
        expect(progressChunks).toBeGreaterThan(0);
      } finally { await authority.close().catch(() => undefined); }
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 20_000);

  it("T71 Windows abort during helper startup terminates the owned helper before source reading", async () => {
    if (process.platform !== "win32") return;
    const root = await fixture();
    try {
      await writeFile(path.join(root, "startup.bin"), Buffer.alloc(1024, 0x43));
      const bootstrap = createWorkspaceFilesystemObjectAuthority(); const proof = await bootstrap.probeDirectory(root);
      const listing = await bootstrap.enumerateRelativeDirectory({ rootPath: root, rootIdentity: proof.identity, relativeDirectoryPath: "" }); await bootstrap.close();
      const file = listing.entries.find(entry => entry.name === "startup.bin");
      const controller = new AbortController(); let progress = 0; let spawned = 0; let closed = 0;
      const authority = createWorkspaceFilesystemObjectAuthority({
        windowsCaptureStartupDelayMs: 5_000,
        onWindowsCaptureHelperSpawned: pid => { spawned = pid; setTimeout(() => controller.abort(), 50); },
        onWindowsCaptureHelperClosed: pid => { closed = pid; },
        onWindowsCaptureProgress: () => { progress += 1; },
      });
      try {
        await expect(authority.captureRelativeFile({ rootPath: root, rootIdentity: proof.identity, relativeFilePath: "startup.bin", expectedFileIdentity: file?.identity, expectedSizeBytes: file?.size_bytes, maxPrefixBytes: 0, signal: controller.signal })).rejects.toMatchObject({ code: "WORKSPACE_INDEX_ABORTED" });
        expect(progress).toBe(0); expect(closed).toBe(spawned);
      } finally { await authority.close().catch(() => undefined); }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("T72 Windows deadline during helper startup terminates boundedly before source reading", async () => {
    if (process.platform !== "win32") return;
    const root = await fixture();
    try {
      await writeFile(path.join(root, "startup-deadline.bin"), Buffer.alloc(1024, 0x44));
      const bootstrap = createWorkspaceFilesystemObjectAuthority(); const proof = await bootstrap.probeDirectory(root);
      const listing = await bootstrap.enumerateRelativeDirectory({ rootPath: root, rootIdentity: proof.identity, relativeDirectoryPath: "" }); await bootstrap.close();
      const file = listing.entries.find(entry => entry.name === "startup-deadline.bin"); let progress = 0;
      const authority = createWorkspaceFilesystemObjectAuthority({ windowsCaptureStartupDelayMs: 5_000, onWindowsCaptureProgress: () => { progress += 1; } });
      try {
        await expect(authority.captureRelativeFile({ rootPath: root, rootIdentity: proof.identity, relativeFilePath: "startup-deadline.bin", expectedFileIdentity: file?.identity, expectedSizeBytes: file?.size_bytes, maxPrefixBytes: 0, deadlineAt: Date.now() + 250 })).rejects.toMatchObject({ code: "WORKSPACE_INDEX_TIMEOUT" });
        expect(progress).toBe(0);
      } finally { await authority.close().catch(() => undefined); }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("T73 Windows cancellation promise resolves only after the exact owned capture helper has closed", async () => {
    if (process.platform !== "win32") return;
    const root = await fixture();
    try {
      await writeFile(path.join(root, "owned.bin"), Buffer.alloc(4 * 1024 * 1024, 0x45));
      const bootstrap = createWorkspaceFilesystemObjectAuthority(); const proof = await bootstrap.probeDirectory(root);
      const listing = await bootstrap.enumerateRelativeDirectory({ rootPath: root, rootIdentity: proof.identity, relativeDirectoryPath: "" }); await bootstrap.close();
      const file = listing.entries.find(entry => entry.name === "owned.bin"); const controller = new AbortController();
      let spawned = 0; let closed = 0;
      const authority = createWorkspaceFilesystemObjectAuthority({ windowsCaptureChunkDelayMs: 50, onWindowsCaptureHelperSpawned: pid => { spawned = pid; }, onWindowsCaptureHelperClosed: pid => { closed = pid; }, onWindowsCaptureProgress: () => controller.abort() });
      try {
        await expect(authority.captureRelativeFile({ rootPath: root, rootIdentity: proof.identity, relativeFilePath: "owned.bin", expectedFileIdentity: file?.identity, expectedSizeBytes: file?.size_bytes, maxPrefixBytes: 0, signal: controller.signal })).rejects.toMatchObject({ code: "WORKSPACE_INDEX_ABORTED" });
        expect(spawned).toBeGreaterThan(0); expect(closed).toBe(spawned);
      } finally { await authority.close().catch(() => undefined); }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("T74 normal Windows governed capture remains complete and same-object", async () => {
    if (process.platform !== "win32") return;
    const root = await fixture();
    try {
      const bytes = Buffer.from("NORMAL-WINDOWS-T74\nSECOND-LINE"); await writeFile(path.join(root, "normal.txt"), bytes);
      const authority = createWorkspaceFilesystemObjectAuthority();
      const proof = await authority.probeDirectory(root); const listing = await authority.enumerateRelativeDirectory({ rootPath: root, rootIdentity: proof.identity, relativeDirectoryPath: "" });
      const file = listing.entries.find(entry => entry.name === "normal.txt");
      const captured = await authority.captureRelativeFile({ rootPath: root, rootIdentity: proof.identity, relativeFilePath: "normal.txt", expectedFileIdentity: file?.identity, expectedSizeBytes: bytes.length, maxPrefixBytes: bytes.length, countLines: true, deadlineAt: Date.now() + 30_000, maxBytes: bytes.length });
      expect(captured.prefix_bytes.equals(bytes)).toBe(true); expect(captured.bytes_read).toBe(bytes.length); expect(captured.line_count).toBe(2);
      await authority.close();
    } finally { await rm(root, { recursive: true, force: true }); }
  });


  it("keeps Windows abort governance active through the post-read response-transfer window", async () => {
    if (process.platform !== "win32") return;
    const root = await fixture();
    try {
      await writeFile(path.join(root, "response-delay.bin"), Buffer.alloc(64 * 1024, 0x47));
      const bootstrap = createWorkspaceFilesystemObjectAuthority();
      const proof = await bootstrap.probeDirectory(root);
      const listing = await bootstrap.enumerateRelativeDirectory({ rootPath: root, rootIdentity: proof.identity, relativeDirectoryPath: "" });
      await bootstrap.close();
      const file = listing.entries.find(entry => entry.name === "response-delay.bin");
      const controller = new AbortController();
      let progress = 0; let spawned = 0; let closed = 0;
      const authority = createWorkspaceFilesystemObjectAuthority({
        windowsCaptureResponseDelayMs: 5_000,
        onWindowsCaptureHelperSpawned: pid => { spawned = pid; },
        onWindowsCaptureHelperClosed: pid => { closed = pid; },
        onWindowsCaptureProgress: () => {
          progress += 1;
          if (progress === 1) setTimeout(() => controller.abort(), 50);
        },
      });
      try {
        await expect(authority.captureRelativeFile({
          rootPath: root, rootIdentity: proof.identity, relativeFilePath: "response-delay.bin",
          expectedFileIdentity: file?.identity, expectedSizeBytes: file?.size_bytes,
          maxPrefixBytes: 0, signal: controller.signal,
        })).rejects.toMatchObject({ code: "WORKSPACE_INDEX_ABORTED" });
        expect(progress).toBeGreaterThan(0);
        expect(closed).toBe(spawned);
      } finally { await authority.close().catch(() => undefined); }
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 15_000);

  it("T75 Windows existing byte budget fails closed inside the helper read loop", async () => {
    if (process.platform !== "win32") return;
    const root = await fixture();
    try {
      await writeFile(path.join(root, "budget.bin"), Buffer.alloc(512 * 1024, 0x46));
      const authority = createWorkspaceFilesystemObjectAuthority(); const proof = await authority.probeDirectory(root);
      const listing = await authority.enumerateRelativeDirectory({ rootPath: root, rootIdentity: proof.identity, relativeDirectoryPath: "" }); const file = listing.entries.find(entry => entry.name === "budget.bin");
      await expect(authority.captureRelativeFile({ rootPath: root, rootIdentity: proof.identity, relativeFilePath: "budget.bin", expectedFileIdentity: file?.identity, expectedSizeBytes: file?.size_bytes, maxPrefixBytes: 0, maxBytes: 64 * 1024, byteBudgetCode: "WORKSPACE_INDEX_HASH_BUDGET_EXCEEDED" })).rejects.toMatchObject({ code: "WORKSPACE_INDEX_HASH_BUDGET_EXCEEDED" });
      await authority.close();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("T78 Linux/non-Windows chunk-level abort deadline and byte budget remain fail-closed", async () => {
    if (process.platform !== "linux") return;
    const chunks = [Buffer.alloc(32, 1), Buffer.alloc(32, 2), Buffer.alloc(32, 3)];
    const controller = new AbortController(); let seen = 0;
    await expect(captureWorkspaceFile("test-injected", { maxPrefixBytes: 128, signal: controller.signal, streamFactory: () => Readable.from(chunks), onBytes: () => { seen += 1; if (seen === 1) controller.abort(); } })).rejects.toMatchObject({ code: "WORKSPACE_INDEX_ABORTED" });
    const slowChunks = async function* () { yield Buffer.alloc(16, 1); await new Promise(resolve => setTimeout(resolve, 20)); yield Buffer.alloc(16, 2); };
    await expect(captureWorkspaceFile("test-injected", { maxPrefixBytes: 128, deadlineAt: Date.now() + 5, streamFactory: () => Readable.from(slowChunks()) })).rejects.toMatchObject({ code: "WORKSPACE_INDEX_TIMEOUT" });
    await expect(captureWorkspaceFile("test-injected", { maxPrefixBytes: 128, maxBytes: 40, byteBudgetCode: "WORKSPACE_INDEX_HASH_BUDGET_EXCEEDED", streamFactory: () => Readable.from(chunks) })).rejects.toMatchObject({ code: "WORKSPACE_INDEX_HASH_BUDGET_EXCEEDED" });
  });

  it("T81 inventory final-iteration Abort remains terminal instead of REVISION_INCOMPLETE", async () => {
    const root = path.resolve("terminal-inventory-abort-root");
    const identity: ProofGradeFilesystemObjectIdentity = { device_id: "1", file_id: "101", proof_method: "NODE_BIGINT_DEV_INO_V1" };
    const authority: WorkspaceFilesystemObjectAuthority = {
      probeDirectory: async () => ({ resolved_real_path: root, identity }),
      enumerateRelativeDirectory: async () => { throw new WorkspaceIndexBoundedError("WORKSPACE_INDEX_ABORTED", { phase: "DISCOVERING", path: "" }); },
      captureRelativeFile: async () => { throw new Error("UNREACHABLE_CAPTURE"); },
      close: async () => undefined,
    };
    await expect(inventoryWorkspaceFiles(root, [], new Date().toISOString(), { objectAuthority: authority }))
      .rejects.toMatchObject({ code: "WORKSPACE_INDEX_ABORTED" });
  });

  it("T82 inventory final-iteration Deadline remains terminal instead of source incompleteness", async () => {
    const root = path.resolve("terminal-inventory-timeout-root");
    const identity: ProofGradeFilesystemObjectIdentity = { device_id: "1", file_id: "102", proof_method: "NODE_BIGINT_DEV_INO_V1" };
    const authority: WorkspaceFilesystemObjectAuthority = {
      probeDirectory: async () => ({ resolved_real_path: root, identity }),
      enumerateRelativeDirectory: async () => { throw new WorkspaceIndexBoundedError("WORKSPACE_INDEX_TIMEOUT", { phase: "DISCOVERING", path: "" }); },
      captureRelativeFile: async () => { throw new Error("UNREACHABLE_CAPTURE"); },
      close: async () => undefined,
    };
    await expect(inventoryWorkspaceFiles(root, [], new Date().toISOString(), { objectAuthority: authority }))
      .rejects.toMatchObject({ code: "WORKSPACE_INDEX_TIMEOUT" });
  });

  it("T83 Windows mid-directory enumeration Abort terminates the owned helper", async () => {
    if (process.platform !== "win32") return;
    const root = await fixture();
    try {
      for (let index = 0; index < 3_000; index += 1) await writeFile(path.join(root, `entry-${index.toString().padStart(4, "0")}.txt`), "x");
      const bootstrap = createWorkspaceFilesystemObjectAuthority();
      const proof = await bootstrap.probeDirectory(root);
      await bootstrap.close();
      const controller = new AbortController();
      let progress = 0; let spawned = 0; let closed = 0;
      const authority = createWorkspaceFilesystemObjectAuthority({
        windowsEnumerationChunkDelayMs: 150,
        onWindowsEnumerationHelperSpawned: pid => { spawned = pid; },
        onWindowsEnumerationHelperClosed: pid => { closed = pid; },
        onWindowsEnumerationProgress: () => { progress += 1; if (progress === 1) controller.abort(); },
      });
      try {
        await expect(authority.enumerateRelativeDirectory({ rootPath: root, rootIdentity: proof.identity, relativeDirectoryPath: "", signal: controller.signal, deadlineAt: Date.now() + 30_000 }))
          .rejects.toMatchObject({ code: "WORKSPACE_INDEX_ABORTED" });
        expect(progress).toBeGreaterThan(0);
        expect(spawned).toBeGreaterThan(0);
        expect(closed).toBe(spawned);
      } finally { await authority.close().catch(() => undefined); }
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 30_000);

  it("T84 Windows mid-directory enumeration Deadline terminates before normal completion", async () => {
    if (process.platform !== "win32") return;
    const root = await fixture();
    try {
      for (let index = 0; index < 2_000; index += 1) await writeFile(path.join(root, `deadline-${index.toString().padStart(4, "0")}.txt`), "x");
      const bootstrap = createWorkspaceFilesystemObjectAuthority();
      const proof = await bootstrap.probeDirectory(root);
      await bootstrap.close();
      let spawned = 0; let closed = 0;
      const authority = createWorkspaceFilesystemObjectAuthority({
        windowsEnumerationChunkDelayMs: 1_000,
        onWindowsEnumerationHelperSpawned: pid => { spawned = pid; },
        onWindowsEnumerationHelperClosed: pid => { closed = pid; },
      });
      try {
        await expect(authority.enumerateRelativeDirectory({ rootPath: root, rootIdentity: proof.identity, relativeDirectoryPath: "", deadlineAt: Date.now() + 250 }))
          .rejects.toMatchObject({ code: "WORKSPACE_INDEX_TIMEOUT" });
        expect(spawned).toBeGreaterThan(0);
        expect(closed).toBe(spawned);
      } finally { await authority.close().catch(() => undefined); }
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 30_000);

  it("T85 cancelled Windows directory enumeration leaves no owned helper alive", async () => {
    if (process.platform !== "win32") return;
    const root = await fixture();
    try {
      for (let index = 0; index < 1_500; index += 1) await writeFile(path.join(root, `owned-enum-${index}.txt`), "x");
      const bootstrap = createWorkspaceFilesystemObjectAuthority();
      const proof = await bootstrap.probeDirectory(root);
      await bootstrap.close();
      const controller = new AbortController();
      const spawned: number[] = []; const closed: number[] = [];
      const authority = createWorkspaceFilesystemObjectAuthority({
        windowsEnumerationChunkDelayMs: 200,
        onWindowsEnumerationHelperSpawned: pid => spawned.push(pid),
        onWindowsEnumerationHelperClosed: pid => closed.push(pid),
        onWindowsEnumerationProgress: () => controller.abort(),
      });
      try {
        await expect(authority.enumerateRelativeDirectory({ rootPath: root, rootIdentity: proof.identity, relativeDirectoryPath: "", signal: controller.signal }))
          .rejects.toMatchObject({ code: "WORKSPACE_INDEX_ABORTED" });
        expect(spawned.length).toBe(1);
        expect(closed).toEqual(spawned);
      } finally { await authority.close().catch(() => undefined); }
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 30_000);

  it("T86 normal Windows directory enumeration remains authorized and complete", async () => {
    if (process.platform !== "win32") return;
    const root = await fixture();
    try {
      await writeFile(path.join(root, "normal-a.txt"), "A");
      await writeFile(path.join(root, "normal-b.txt"), "B");
      const authority = createWorkspaceFilesystemObjectAuthority();
      const proof = await authority.probeDirectory(root);
      const listing = await authority.enumerateRelativeDirectory({ rootPath: root, rootIdentity: proof.identity, relativeDirectoryPath: "", signal: new AbortController().signal, deadlineAt: Date.now() + 30_000 });
      expect(listing.entries.map(entry => entry.name)).toEqual(expect.arrayContaining(["normal-a.txt", "normal-b.txt"]));
      await authority.close();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("T87 non-Windows directory enumeration preserves Abort Deadline and object authority", async () => {
    if (process.platform !== "linux") return;
    const root = await fixture();
    try {
      for (let index = 0; index < 32; index += 1) await writeFile(path.join(root, `linux-enum-${index}.txt`), "x");
      const bootstrap = createWorkspaceFilesystemObjectAuthority();
      const proof = await bootstrap.probeDirectory(root);
      await bootstrap.close();

      const abortController = new AbortController();
      let abortProgress = 0;
      const abortAuthority = createWorkspaceFilesystemObjectAuthority({
        onNonWindowsEnumerationProgress: () => { abortProgress += 1; if (abortProgress === 1) abortController.abort(); },
      });
      await expect(abortAuthority.enumerateRelativeDirectory({ rootPath: root, rootIdentity: proof.identity, relativeDirectoryPath: "", signal: abortController.signal }))
        .rejects.toMatchObject({ code: "WORKSPACE_INDEX_ABORTED" });
      expect(abortProgress).toBeGreaterThan(0);
      await abortAuthority.close();

      let deadlineProgress = 0;
      const deadlineAuthority = createWorkspaceFilesystemObjectAuthority({
        nonWindowsEnumerationChunkDelayMs: 80,
        onNonWindowsEnumerationProgress: () => { deadlineProgress += 1; },
      });
      await expect(deadlineAuthority.enumerateRelativeDirectory({ rootPath: root, rootIdentity: proof.identity, relativeDirectoryPath: "", deadlineAt: Date.now() + 40 }))
        .rejects.toMatchObject({ code: "WORKSPACE_INDEX_TIMEOUT" });
      expect(deadlineProgress).toBeGreaterThan(0);
      await deadlineAuthority.close();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("C25-A real inventory preserves file-discovery budget as a global governed failure", async () => {
    const root = await fixture();
    try {
      await writeFile(path.join(root, "budget-a.txt"), "a");
      await writeFile(path.join(root, "budget-b.txt"), "b");
      await expect(inventoryWorkspaceFiles(root, [], undefined, { budgets: { maxDiscoveredFiles: 1 } }))
        .rejects.toMatchObject({ code: "WORKSPACE_INDEX_FILE_BUDGET_EXCEEDED" });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("C25-A real inventory preserves aggregate discovery byte budget as a global governed failure", async () => {
    const root = await fixture();
    try {
      await writeFile(path.join(root, "budget-bytes-a.txt"), "1234");
      await writeFile(path.join(root, "budget-bytes-b.txt"), "5678");
      await expect(inventoryWorkspaceFiles(root, [], undefined, { budgets: { maxDiscoveredBytes: 4 } }))
        .rejects.toMatchObject({ code: "WORKSPACE_INDEX_BYTE_BUDGET_EXCEEDED" });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("T89 Root probe Abort after probe start remains terminal", async () => {
    const root = await fixture();
    try {
      const controller = new AbortController();
      let startedResolve!: () => void;
      const started = new Promise<void>(resolve => { startedResolve = resolve; });
      const authority = createWorkspaceFilesystemObjectAuthority(process.platform === "win32" ? {
        windowsRootProbeStartupDelayMs: 1_000,
        onWindowsRootProbeHelperSpawned: () => startedResolve(),
      } : {
        nonWindowsRootProbeDelayMs: 1_000,
        onNonWindowsRootProbeStarted: () => startedResolve(),
      });
      try {
        const probe = authority.probeDirectory(root, { signal: controller.signal, deadlineAt: Date.now() + 30_000 });
        await started;
        controller.abort();
        await expect(probe).rejects.toMatchObject({ code: "WORKSPACE_INDEX_ABORTED" });
      } finally { await authority.close().catch(() => undefined); }
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 30_000);

  it("T90 Root probe Deadline after probe start remains terminal", async () => {
    const root = await fixture();
    try {
      const authority = createWorkspaceFilesystemObjectAuthority(process.platform === "win32" ? {
        windowsRootProbeStartupDelayMs: 1_000,
      } : {
        nonWindowsRootProbeDelayMs: 1_000,
      });
      try {
        await expect(authority.probeDirectory(root, { deadlineAt: Date.now() + 100 }))
          .rejects.toMatchObject({ code: "WORKSPACE_INDEX_TIMEOUT" });
      } finally { await authority.close().catch(() => undefined); }
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 30_000);

  it("T91 Windows cancelled Root probe closes the exact owned helper", async () => {
    if (process.platform !== "win32") return;
    const root = await fixture();
    try {
      const controller = new AbortController();
      let spawned = 0;
      let closed = 0;
      const authority = createWorkspaceFilesystemObjectAuthority({
        windowsRootProbeStartupDelayMs: 2_000,
        onWindowsRootProbeHelperSpawned: pid => { spawned = pid; controller.abort(); },
        onWindowsRootProbeHelperClosed: pid => { closed = pid; },
      });
      try {
        await expect(authority.probeDirectory(root, { signal: controller.signal, deadlineAt: Date.now() + 30_000 }))
          .rejects.toMatchObject({ code: "WORKSPACE_INDEX_ABORTED" });
        expect(spawned).toBeGreaterThan(0);
        expect(closed).toBe(spawned);
      } finally { await authority.close().catch(() => undefined); }
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 30_000);

  it("v1.0.3 Windows metadata helper reuses one owned PID for sequential probe and enumeration", async () => {
    if (process.platform !== "win32") return;
    const root = await fixture();
    try {
      await writeFile(path.join(root, "small.txt"), "small");
      const spawned: number[] = []; const requests: Array<{ pid: number; operation: "probe" | "enumerate_relative" }> = [];
      const authority = createWorkspaceFilesystemObjectAuthority({
        onWindowsMetadataHelperSpawned: pid => spawned.push(pid),
        onWindowsMetadataRequest: request => requests.push(request),
      });
      try {
        const proof1 = await authority.probeDirectory(root, { deadlineAt: Date.now() + 30_000 });
        const proof2 = await authority.probeDirectory(root, { deadlineAt: Date.now() + 30_000 });
        await authority.enumerateRelativeDirectory({ rootPath: root, rootIdentity: proof2.identity, relativeDirectoryPath: "", deadlineAt: Date.now() + 30_000 });
        expect(proof2.identity).toEqual(proof1.identity);
        expect(spawned).toHaveLength(1);
        expect(requests).toHaveLength(3);
        expect(new Set(requests.map(item => item.pid)).size).toBe(1);
      } finally { await authority.close(); }
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 30_000);

  it("v1.0.4 Windows metadata helper preserves UTF-8 Unicode names and File ID across long-lived round-trip traversal", async () => {
    if (process.platform !== "win32") return;
    const root = await fixture();
    const arabicDirectoryName = "مصدر عربي";
    const mixedDirectoryName = "مجلد داخلي-日本語-é";
    const unicodeFileName = "ملف-данные.txt";
    const arabicDirectoryPath = path.join(root, arabicDirectoryName);
    const mixedDirectoryPath = path.join(arabicDirectoryPath, mixedDirectoryName);
    try {
      await mkdir(mixedDirectoryPath, { recursive: true });
      await writeFile(path.join(mixedDirectoryPath, unicodeFileName), "UNICODE-PROTOCOL");
      const spawned: number[] = [];
      const requests: Array<{ pid: number; operation: "probe" | "enumerate_relative" }> = [];
      const authority = createWorkspaceFilesystemObjectAuthority({
        onWindowsMetadataHelperSpawned: pid => spawned.push(pid),
        onWindowsMetadataRequest: request => requests.push(request),
      });
      try {
        const rootProof = await authority.probeDirectory(root, { deadlineAt: Date.now() + 30_000 });
        const rootListing = await authority.enumerateRelativeDirectory({
          rootPath: root,
          rootIdentity: rootProof.identity,
          relativeDirectoryPath: "",
          deadlineAt: Date.now() + 30_000,
        });
        const arabicEntry = rootListing.entries.find(entry => entry.name === arabicDirectoryName);
        expect(arabicEntry).toMatchObject({ name: arabicDirectoryName, object_type: "DIRECTORY" });
        expect(arabicEntry?.name.includes("?")).toBe(false);
        expect(arabicEntry?.identity).toBeTruthy();
        if (!arabicEntry?.identity) throw new Error("UNICODE_ARABIC_DIRECTORY_IDENTITY_MISSING");

        const arabicListing = await authority.enumerateRelativeDirectory({
          rootPath: root,
          rootIdentity: rootProof.identity,
          relativeDirectoryPath: arabicEntry.name,
          expectedDirectoryIdentity: arabicEntry.identity,
          deadlineAt: Date.now() + 30_000,
        });
        expect(sameProofGradeFilesystemObject(arabicListing.identity, arabicEntry.identity)).toBe(true);
        const mixedEntry = arabicListing.entries.find(entry => entry.name === mixedDirectoryName);
        expect(mixedEntry).toMatchObject({ name: mixedDirectoryName, object_type: "DIRECTORY" });
        expect(mixedEntry?.name.includes("?")).toBe(false);
        expect(mixedEntry?.identity).toBeTruthy();
        if (!mixedEntry?.identity) throw new Error("UNICODE_MIXED_DIRECTORY_IDENTITY_MISSING");

        const nestedRelativePath = `${arabicEntry.name}/${mixedEntry.name}`;
        const nestedListing = await authority.enumerateRelativeDirectory({
          rootPath: root,
          rootIdentity: rootProof.identity,
          relativeDirectoryPath: nestedRelativePath,
          expectedDirectoryIdentity: mixedEntry.identity,
          deadlineAt: Date.now() + 30_000,
        });
        expect(sameProofGradeFilesystemObject(nestedListing.identity, mixedEntry.identity)).toBe(true);
        const unicodeFile = nestedListing.entries.find(entry => entry.name === unicodeFileName);
        expect(unicodeFile).toMatchObject({ name: unicodeFileName, object_type: "FILE" });
        expect(unicodeFile?.name.includes("?")).toBe(false);

        expect(spawned).toHaveLength(1);
        expect(requests).toHaveLength(4);
        expect(new Set(requests.map(item => item.pid)).size).toBe(1);
        expect(requests.map(item => item.operation)).toEqual([
          "probe",
          "enumerate_relative",
          "enumerate_relative",
          "enumerate_relative",
        ]);
      } finally { await authority.close(); }
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 30_000);

  it("v1.0.3 Windows metadata helper cancellation closes exact PID and next request respawns", async () => {
    if (process.platform !== "win32") return;
    const root = await fixture();
    try {
      const controller = new AbortController(); const spawned: number[] = []; const closed: number[] = [];
      const authority = createWorkspaceFilesystemObjectAuthority({
        windowsRootProbeStartupDelayMs: 1_000,
        onWindowsMetadataHelperSpawned: pid => spawned.push(pid),
        onWindowsMetadataHelperClosed: pid => closed.push(pid),
        onWindowsMetadataRequest: ({ operation }) => { if (operation === "probe" && spawned.length === 1) controller.abort(); },
      });
      try {
        await expect(authority.probeDirectory(root, { signal: controller.signal, deadlineAt: Date.now() + 30_000 })).rejects.toMatchObject({ code: "WORKSPACE_INDEX_ABORTED" });
        expect(spawned).toHaveLength(1);
        expect(closed).toEqual([spawned[0]]);
        const next = await authority.probeDirectory(root, { deadlineAt: Date.now() + 30_000 });
        expect(next.identity.file_id).toBeTruthy();
        expect(spawned).toHaveLength(2);
        expect(spawned[1]).not.toBe(spawned[0]);
      } finally { await authority.close(); }
      expect(closed).toEqual(expect.arrayContaining(spawned));
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 30_000);

  it("T92 normal governed Root probing supports Git-shaped and Non-Git local Workspaces", async () => {
    const base = await fixture();
    const gitRoot = path.join(base, "git-workspace");
    const nonGitRoot = path.join(base, "non-git-workspace");
    try {
      await mkdir(path.join(gitRoot, ".git"), { recursive: true });
      await mkdir(nonGitRoot, { recursive: true });
      await writeFile(path.join(gitRoot, "a.txt"), "a");
      await writeFile(path.join(nonGitRoot, "b.txt"), "b");
      const authority = createWorkspaceFilesystemObjectAuthority();
      try {
        const deadlineAt = Date.now() + 30_000;
        const gitProof = await authority.probeDirectory(gitRoot, { deadlineAt });
        const nonGitProof = await authority.probeDirectory(nonGitRoot, { deadlineAt });
        expect(gitProof.identity.file_id).toBeTruthy();
        expect(nonGitProof.identity.file_id).toBeTruthy();
      } finally { await authority.close().catch(() => undefined); }
    } finally { await rm(base, { recursive: true, force: true }); }
  });

});

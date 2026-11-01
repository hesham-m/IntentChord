import path from "node:path";
import { describe, expect, it } from "vitest";
import { LocalBoundedDiscoveryTools, type DiscoveryWorkspaceBoundary } from "@/core/discovery/discovery-tools";
import { captureWorkspaceFile, inventoryWorkspaceFiles } from "@/core/workspace-index/adapters/filesystem";
import { WorkspaceIndexBoundedError, globalRuntimeGovernanceCode, terminalRuntimeGovernanceCode } from "@/core/workspace-index/adapters/filesystem-errors";
import type {
  ProofGradeFilesystemObjectIdentity,
  WorkspaceFilesystemObjectAuthority,
} from "@/core/workspace-index/filesystem-object-authority";
import { captureRegisteredWorkspaceSourceFile } from "@/server/workspace-source-read";

const root = path.resolve("terminal-governance-root");
const identity: ProofGradeFilesystemObjectIdentity = {
  device_id: "7",
  file_id: "7001",
  proof_method: "NODE_BIGINT_DEV_INO_V1",
};
const fileIdentity: ProofGradeFilesystemObjectIdentity = {
  device_id: "7",
  file_id: "7002",
  proof_method: "NODE_BIGINT_DEV_INO_V1",
};

function terminalError(code: "WORKSPACE_INDEX_ABORTED" | "WORKSPACE_INDEX_TIMEOUT") {
  return new WorkspaceIndexBoundedError(code, { phase: "CAPTURE", path: "source.txt" });
}

function discoveryAuthority(code: "WORKSPACE_INDEX_ABORTED" | "WORKSPACE_INDEX_TIMEOUT"): WorkspaceFilesystemObjectAuthority {
  return {
    probeDirectory: async () => ({ resolved_real_path: root, identity }),
    enumerateRelativeDirectory: async () => ({
      resolved_real_path: root,
      identity,
      entries: [{
        name: "source.txt",
        object_type: "FILE",
        identity: fileIdentity,
        size_bytes: 10,
        mode: 0,
        modified_at_ms: 0,
        created_at_ms: 0,
      }],
    }),
    captureRelativeFile: async () => { throw terminalError(code); },
    close: async () => undefined,
  };
}

function inventoryAuthority(code: "WORKSPACE_INDEX_ABORTED" | "WORKSPACE_INDEX_TIMEOUT"): WorkspaceFilesystemObjectAuthority {
  return {
    probeDirectory: async () => ({ resolved_real_path: root, identity }),
    enumerateRelativeDirectory: async () => { throw terminalError(code); },
    captureRelativeFile: async () => { throw new Error("UNREACHABLE_CAPTURE"); },
    close: async () => undefined,
  };
}

const boundary: DiscoveryWorkspaceBoundary = {
  id: "11111111-1111-4111-8111-111111111111",
  displayName: "terminal-governance",
  rootReference: root,
  authorizedRootRealPath: root,
  authorizedRootObjectIdentity: identity,
  discoveryScopeMode: "FULL_WORKSPACE",
  allowedPaths: [],
  excludedPaths: [],
};

describe("T88 terminal runtime governance remains global across B1 layers", () => {
  for (const code of ["WORKSPACE_INDEX_ABORTED", "WORKSPACE_INDEX_TIMEOUT"] as const) {
    it(`${code} remains terminal across Discovery Inventory Capture and Source Evidence`, async () => {
      expect(terminalRuntimeGovernanceCode(terminalError(code))).toBe(code);

      const discovery = new LocalBoundedDiscoveryTools({}, discoveryAuthority(code));
      try {
        await expect(discovery.searchWorkspaceText(boundary, ["source"]))
          .rejects.toMatchObject({ code });
      } finally {
        await discovery.close().catch(() => undefined);
      }

      await expect(inventoryWorkspaceFiles(root, [], new Date().toISOString(), { objectAuthority: inventoryAuthority(code) }))
        .rejects.toMatchObject({ code });

      await expect(captureWorkspaceFile(path.join(root, "source.txt"), {
        maxPrefixBytes: 64,
        authorizedRootPath: root,
        authorizedRootRealPath: root,
        authorizedRootIdentity: identity,
        relativePath: "source.txt",
        expectedDeviceId: fileIdentity.device_id,
        expectedInode: fileIdentity.file_id,
        expectedProofMethod: fileIdentity.proof_method,
        expectedSizeBytes: 10,
        objectAuthority: discoveryAuthority(code),
      })).rejects.toMatchObject({ code });

      await expect(captureRegisteredWorkspaceSourceFile({
        workspaceId: "11111111-1111-4111-8111-111111111111",
        relativePath: "source.txt",
        maxPrefixBytes: 64,
      }, {
        resolveAuthority: async () => ({
          registration: {
            id: "11111111-1111-4111-8111-111111111111",
            revision: 1,
            displayName: "terminal-governance",
            role: "SOURCE",
            referenceType: "LOCAL_PATH",
            source: "MANUAL_VERIFIED",
            reference: root,
            normalizedReference: root,
            verificationStatus: "VERIFIED",
            verificationMethod: "TEST",
            verifiedAt: new Date(0).toISOString(),
            verificationAuthority: "TEST",
            fingerprint: "sha256:test",
            provenance: {},
            authorizationContext: "TEST",
            verifiedRootRealPath: root,
            verifiedRootObjectIdentity: identity,
            verifiedRootVerifiedAt: new Date(0).toISOString(),
            rootAuthorityState: "VERIFIED_MATCH",
            rootAuthorityCheckedAt: new Date(0).toISOString(),
          },
          currentIdentity: {
            normalizedReference: root,
            realPath: root,
            rootObjectIdentity: identity,
            fingerprint: "sha256:test",
            provenance: {},
          },
        }),
        objectAuthority: discoveryAuthority(code),
      })).rejects.toMatchObject({ code });
    });
  }
});


describe("C25 global runtime governance classification", () => {
  for (const code of [
    "WORKSPACE_INDEX_FILE_BUDGET_EXCEEDED",
    "WORKSPACE_INDEX_BYTE_BUDGET_EXCEEDED",
    "WORKSPACE_INDEX_HASH_BUDGET_EXCEEDED",
    "WORKSPACE_INDEX_AGGREGATE_TEXT_BUDGET_EXCEEDED",
  ] as const) {
    it(`${code} remains an operation-level governed boundary`, () => {
      expect(globalRuntimeGovernanceCode(new WorkspaceIndexBoundedError(code, { phase: "DISCOVERING" }))).toBe(code);
    });
  }
});

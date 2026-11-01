import { describe, expect, it } from "vitest";
import { resolveExecutionContract } from "@/core/contracts/resolver";
import { hasScopeOverlap, isAuthorizedPath, normalizeContractPath } from "@/core/policies/path-authority";

const authorization = { readFiles: true, modifySource: true, runStaticValidation: true, runTests: true, build: false, deploy: false, restartServices: false, writeDatabase: false, changeEnvironment: false, useNetwork: false };

describe("canonical contract resolution and path authority", () => {
  it("resolves every required contract field without fixture inheritance", () => {
    const contract = resolveExecutionContract({ contractId: "contract-test-001", objective: "Validate bounded source evidence.", taskMode: "SOURCE_IMPLEMENTATION", workspaces: [{ id: "demo", displayName: "demo", role: "primary", referenceType: "LOCAL_PATH", reference: "demo", fingerprint: "demo-fingerprint", allowedPaths: ["src/"], excludedPaths: ["src/private/"], authorizationContext: "test", ordering: 0 }], providerId: "OPENAI", modelId: "gpt-5.6-sol", executionChannelId: "CODEX", reasoningProfile: "High", runtimeProfileId: "STANDARD", ownerOverrideAccepted: false, allowedPaths: ["src/"], excludedPaths: ["src/private/"], evidenceFiles: ["evidence/log.txt"], identity: "session-1", authorization });
    expect(contract.policyVersion).toBe("0.2");
    expect(contract.requiredChecks.map(check => check.id)).toContain("tests");
    expect(contract.requiredChecks.find(check => check.id === "contract-validation")?.satisfactionMode)
      .toBe("BACKEND_AUTOMATIC");
    expect(contract.requiredChecks.find(check => check.id === "tests")?.satisfactionMode)
      .toBe("TRUSTED_PRODUCER");
    expect(contract.closureCriteria[0].evidenceRequired).toContain("contract-validation");
    expect(contract.scope.allowedPaths).toEqual(["demo:src"]);
  });

  it("resolves a controlled audit from full Workspace roots without invented file paths", () => {
    const contract = resolveExecutionContract({
      contractId: "contract-full-workspace-audit",
      title: "Update channel version 1.5.3",
      objective: "Determine why installed version 1.5.3 is absent from Self-Update Readiness.",
      taskMode: "CONTROLLED_AUDIT",
      workspaces: [{
        id: "11111111-1111-4111-8111-111111111111",
        displayName: "Example Server",
        role: "primary",
        referenceType: "LOCAL_PATH",
        source: "WINDOWS_NATIVE_SELECTOR",
        reference: "E:\\Sample Control Platform workspace\\control-server",
        fingerprint: "sha256:path",
        discoveryScopeMode: "FULL_WORKSPACE",
        allowedPaths: [],
        excludedPaths: [],
        authorizationContext: "owner",
        ordering: 0,
      }],
      providerId: "OPENAI",
      modelId: "gpt-5.6-terra",
      executionChannelId: "CODEX",
      reasoningProfile: "Medium",
      runtimeProfileId: "STANDARD",
      ownerOverrideAccepted: false,
      allowedPaths: [],
      excludedPaths: [],
      evidenceFiles: [],
      identity: "",
      authorization: {
        readFiles: true,
        modifySource: false,
        runStaticValidation: false,
        runTests: false,
        build: false,
        deploy: false,
        restartServices: false,
        writeDatabase: false,
        changeEnvironment: false,
        useNetwork: false,
      },
    });
    expect(contract.scope.workspaces[0]).toMatchObject({
      discoveryScopeMode: "FULL_WORKSPACE",
      effectiveReadBoundary: "WORKSPACE_ROOT",
      allowedPaths: [],
    });
    expect(contract.scope.allowedPaths).toEqual([
      "11111111-1111-4111-8111-111111111111:@workspace-root",
    ]);
    expect(contract.authorization.modifySource).toBe(false);
  });

  it("normalizes Windows paths, permits descendants, and lets exclusions win", () => {
    const scope = { allowedPaths: ["SRC\\"], excludedPaths: ["src/private"] };
    expect(normalizeContractPath("src//feature/file.ts")).toBe("src/feature/file.ts");
    expect(isAuthorizedPath("src/feature/file.ts", scope)).toBe(true);
    expect(isAuthorizedPath("SRC\\PRIVATE\\secret.ts", scope)).toBe(false);
    expect(isAuthorizedPath("src/../secret.ts", scope)).toBe(false);
    expect(hasScopeOverlap(scope)).toBe(true);
  });
});

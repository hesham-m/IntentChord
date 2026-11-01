import { describe, expect, it } from "vitest";
import { resolveExecutionContract } from "@/core/contracts/resolver";
import { executionContractSchema } from "@/core/contracts/execution-contract";
import { compileAgentPrompt, compileAgentPromptDiagnostics } from "@/core/prompts/compiler";
import { lintCompiledPrompt, lintResolvedContract } from "@/core/prompts/governance";

const workspaceIdA = "11111111-1111-4111-8111-111111111111";
const workspaceIdB = "22222222-2222-4222-8222-222222222222";

function resolvedContract() {
  const draft = resolveExecutionContract({
    contractId: "33333333-3333-4333-8333-333333333333",
    title: "Update Channel 1.5.3",
    objective: "update channel v 1.5.3.",
    taskMode: "CONTROLLED_AUDIT",
    intentResolution: {
      id: "44444444-4444-4444-8444-444444444444",
      revision: 1,
      contentSha256: "c".repeat(64),
      normalizedTopic: "Update Channel 1.5.3",
      ownerSummary: "Audit Update Channel 1.5.3 across the approved Backend and Windows Client workspaces using read-only discovery.",
      investigationQuestions: [
        { id: "Q-UPD-001", question: "Where is the authoritative update-version decision made?" },
        { id: "Q-UPD-002", question: "How do readiness, artifacts, native releases, and manifest data flow?" },
      ],
      expectedConcepts: ["self-update readiness", "artifacts", "native releases", "manifest", "version authority"],
      unknowns: ["Relevant paths have not been discovered yet."],
      forbiddenAssumptions: ["Source evidence cannot prove runtime behavior."],
    },
    discoveryResolution: {
      id: "66666666-6666-4666-8666-666666666666",
      outputSha256: "d".repeat(64),
      status: "COMPLETED",
      completedAt: "2026-07-26T11:55:00.000Z",
      assessment: {
        assessmentStatus: "ASSESSED",
        complexity: "HIGH",
        crossFileDependency: "YES",
        crossWorkspaceDependency: "YES",
        workspaceCount: 2,
        candidateFileCount: 4,
        inspectedFileCount: 4,
        requirementCoverage: [
          { requirementId: "REQ-UPD-001", discoveredItemCount: 2 },
          { requirementId: "REQ-UPD-004", discoveredItemCount: 2 },
        ],
        reasons: ["Relevant candidates span both approved Workspaces."],
      },
      requirementPaths: [
        { requirementId: "REQ-UPD-001", paths: [`${workspaceIdA}:src/updates/version-authority.ts`] },
        { requirementId: "REQ-UPD-004", paths: [`${workspaceIdB}:src/self-update/manifest-reader.rs`] },
      ],
      evidenceGaps: [],
    },
    ownerRequirements: [
      {
        id: "REQ-UPD-001",
        outcome: "Identify the authoritative source of the target update version.",
        requiredEvidenceTypes: ["SOURCE"],
        proofProfile: {
          sourceBehavior: true,
          positive: true,
          negativeAdversarial: false,
          persistenceReload: false,
        },
      },
      {
        id: "REQ-UPD-004",
        outcome: "Assess version identity across every discovered relevant layer.",
        requiredEvidenceTypes: ["SOURCE", "ARTIFACT"],
        proofProfile: {
          sourceBehavior: true,
          positive: true,
          negativeAdversarial: false,
          persistenceReload: false,
        },
      },
    ],
    workspaces: [
      {
        id: workspaceIdA,
        displayName: "control-server",
        role: "primary",
        referenceType: "LOCAL_PATH",
        source: "WINDOWS_NATIVE_SELECTOR",
        reference: "E:\\Sample Control Platform workspace\\control-server",
        fingerprint: "sha256:server",
        discoveryScopeMode: "FULL_WORKSPACE",
        allowedPaths: [],
        excludedPaths: [],
        authorizationContext: "owner approved read-only discovery",
        ordering: 0,
      },
      {
        id: workspaceIdB,
        displayName: "example-client",
        role: "supporting",
        referenceType: "LOCAL_PATH",
        source: "WINDOWS_NATIVE_SELECTOR",
        reference: "E:\\example-client-root\\ui\\login\\5\\example-client",
        fingerprint: "sha256:client",
        discoveryScopeMode: "FULL_WORKSPACE",
        allowedPaths: [],
        excludedPaths: [],
        authorizationContext: "owner approved read-only discovery",
        ordering: 1,
      },
    ],
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
    providerId: "OPENAI",
    modelId: "gpt-5.6-terra",
    executionChannelId: "CODEX",
    reasoningProfile: "Medium",
    runtimeProfileId: "STANDARD",
    ownerOverrideAccepted: false,
  });
  return {
    ...draft,
    ownerApproval: {
      required: true as const,
      state: "APPROVED" as const,
      approvedAt: "2026-07-26T12:00:00.000Z",
    },
  };
}

describe("intelligence-aware controlled-audit contract", () => {
  it("uses the confirmed topic-specific requirements instead of generic objective/governance placeholders", () => {
    const contract = resolvedContract();
    expect(contract.executionPackage.mandatoryRequirements.map(item => item.id)).toEqual([
      "REQ-UPD-001",
      "REQ-UPD-004",
    ]);
    expect(contract.requiredChecks.map(item => item.id)).toEqual(["contract-validation"]);
    expect(contract.requiredChecks.map(item => item.id)).not.toContain("evidence-validation");
    expect(contract.taskSemanticProfile.complexity).toBe("HIGH");
    expect(contract.taskSemanticProfile.crossFileDependency).toBe("YES");
    expect(contract.selectedConfiguration.modelId).toBe("gpt-5.6-sol");
    expect(contract.configurationRecommendation.status).toBe("RECOMMENDED");
    expect(contract.configurationRecommendation.reasons.join(" ")).toContain("automatically routed");
    expect(contract.selectedConfiguration.ownerOverrideAccepted).toBe(false);
    expect(lintResolvedContract(contract)).toEqual([]);
  });

  it("keeps evidence identity state and projected identity content consistent", () => {
    const contract = resolvedContract();
    expect(contract.evidenceIdentityState).toBe("NOT_ESTABLISHED");
    expect(contract.evidenceIdentity).toEqual({});
    expect(executionContractSchema.safeParse({
      ...contract,
      evidenceIdentityState: "BOUND",
      evidenceIdentity: {},
    }).success).toBe(false);
    expect(executionContractSchema.safeParse({
      ...contract,
      evidenceIdentityState: "NOT_ESTABLISHED",
      evidenceIdentity: { sessionId: "unexpected-session" },
    }).success).toBe(false);
  });

  it("compiles a run-bound prompt that preserves the version, questions, evidence classes, and internal-only CONTINUE semantics", () => {
    const contract = resolvedContract();
    const prompt = compileAgentPrompt(contract, "en", {
      activeRunId: "55555555-5555-4555-8555-555555555555",
      round: 1,
      executionType: "INITIAL",
    });

    expect(prompt).toContain("Update Channel 1.5.3");
    expect(prompt).toContain("Where is the authoritative update-version decision made?");
    expect(prompt).toContain("Bounded Discovery Map");
    expect(prompt).toContain("src/updates/version-authority.ts");
    expect(prompt).toContain("Cross-workspace dependency: YES");
    expect(prompt).toContain("SOURCE_EVIDENCE");
    expect(prompt).toContain("ARTIFACT_EVIDENCE");
    expect(prompt).toContain("VALIDATION_EVIDENCE");
    expect(prompt).toContain("RUNTIME_EVIDENCE");
    expect(prompt).toContain("Evidence identity state: NOT_ESTABLISHED");
    expect(prompt).not.toContain("Evidence identity: {}");
    expect(prompt).not.toContain("<CONTINUE|STOP_FOR_OWNER|READY_FOR_FINAL_REPORT>");
    expect(prompt).toContain("IntentChord Terminal State: <STOP_FOR_OWNER|READY_FOR_FINAL_REPORT>");
    expect(lintCompiledPrompt(prompt, contract)).toEqual([]);
  });

  it("keeps a large discovery map bounded in the executable prompt while retaining run-bound map identity", () => {
    const contract = resolvedContract();
    const largePaths = Array.from({ length: 120 }, (_, index) =>
      `${workspaceIdA}:src/generated/deep/path-${String(index).padStart(3, "0")}/implementation.ts`,
    );
    const largeContract = executionContractSchema.parse({
      ...contract,
      discoveryResolution: {
        ...contract.discoveryResolution!,
        assessment: {
          ...contract.discoveryResolution!.assessment,
          candidateFileCount: largePaths.length,
          inspectedFileCount: largePaths.length,
        },
        requirementPaths: [{
          requirementId: "REQ-UPD-001",
          paths: largePaths,
          totalPathCount: largePaths.length,
          omittedPathCount: 0,
        }],
      },
    });
    const diagnostics = compileAgentPromptDiagnostics(largeContract, "en", {
      activeRunId: "77777777-7777-4777-8777-777777777777",
      round: 1,
      executionType: "INITIAL",
    });
    expect(diagnostics.executable).toBe(true);
    expect(diagnostics.issues).toEqual([]);
    expect(diagnostics.prompt.length).toBeLessThanOrEqual(14_000);
    expect(diagnostics.prompt).toContain("Representative paths by requirement");
    expect(diagnostics.prompt).toContain("omitted from prompt");
    expect(diagnostics.prompt).toContain(contract.discoveryResolution!.id);
    expect(diagnostics.prompt).toContain(contract.discoveryResolution!.outputSha256);
    expect(diagnostics.prompt).not.toContain("path-119");
  });


  it("keeps the SOURCE_IMPLEMENTATION integration profile executable after deterministic discovery", () => {
    const requirementIds = ["BACKEND-AUTHORITY", "REQ-INT-001", "REQ-INT-002", "REQ-INT-003"];
    const largePaths = Array.from({ length: 160 }, (_, index) =>
      `${workspaceIdA}:src/integration/generated/path-${String(index).padStart(3, "0")}/implementation.ts`,
    );
    const contract = resolveExecutionContract({
      contractId: "88888888-8888-4888-8888-888888888888",
      title: "Backend authority integration",
      objective: "Implement and verify Backend authority, trusted evidence, Run state, and reload behavior.",
      taskMode: "SOURCE_IMPLEMENTATION",
      intentResolution: {
        id: "99999999-9999-4999-8999-999999999999",
        revision: 1,
        contentSha256: "e".repeat(64),
        normalizedTopic: "Backend authority integration",
        ownerSummary: "Implement and validate the approved Backend authority behavior inside the bounded Workspace.",
        investigationQuestions: requirementIds.map((id, index) => ({
          id: `Q-${id}`,
          question: `Which bounded source behavior is required for ${id} (${index + 1})?`,
        })),
        expectedConcepts: ["backend authority", "trusted evidence", "run state", "reload behavior"],
        unknowns: ["Exact entry points require bounded discovery."],
        forbiddenAssumptions: ["Executor claims are not independent evidence."],
      },
      discoveryResolution: {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        outputSha256: "f".repeat(64),
        status: "COMPLETED",
        completedAt: "2026-07-27T08:00:00.000Z",
        assessment: {
          assessmentStatus: "ASSESSED",
          complexity: "HIGH",
          crossFileDependency: "YES",
          crossWorkspaceDependency: "NO",
          workspaceCount: 1,
          candidateFileCount: largePaths.length,
          inspectedFileCount: largePaths.length,
          requirementCoverage: requirementIds.map(requirementId => ({
            requirementId,
            discoveredItemCount: 40,
          })),
          reasons: ["The bounded implementation spans multiple source entry points."],
        },
        requirementPaths: requirementIds.map((requirementId, requirementIndex) => ({
          requirementId,
          paths: largePaths.slice(requirementIndex * 40, requirementIndex * 40 + 40),
          totalPathCount: 40,
          omittedPathCount: 0,
        })),
        evidenceGaps: [],
      },
      ownerRequirements: requirementIds.map((id, index) => ({
        id,
        outcome: `Close the governed implementation outcome ${index + 1}.`,
        requiredEvidenceTypes: ["SOURCE", "VALIDATION"] as Array<"SOURCE" | "VALIDATION">,
        proofProfile: {
          sourceBehavior: true,
          positive: true,
          negativeAdversarial: true,
          persistenceReload: true,
        },
      })),
      workspaces: [{
        id: workspaceIdA,
        displayName: "IntentChord integration Workspace",
        role: "primary",
        referenceType: "LOCAL_PATH",
        source: "WINDOWS_NATIVE_SELECTOR",
        reference: "E:\\example\\workspace",
        fingerprint: "sha256:integration",
        discoveryScopeMode: "SELECTED_PATHS",
        allowedPaths: ["src"],
        excludedPaths: ["node_modules"],
        authorizationContext: "integration test scope",
        ordering: 0,
      }],
      allowedPaths: ["src"],
      excludedPaths: ["node_modules"],
      evidenceFiles: [],
      identity: "",
      authorization: {
        readFiles: true,
        modifySource: true,
        runStaticValidation: true,
        runTests: true,
        build: false,
        deploy: false,
        restartServices: false,
        writeDatabase: false,
        changeEnvironment: false,
        useNetwork: false,
      },
      providerId: "OPENAI",
      modelId: "gpt-5.6-terra",
      executionChannelId: "CODEX",
      reasoningProfile: "Medium",
      runtimeProfileId: "STANDARD",
      ownerOverrideAccepted: false,
    });
    const approved = executionContractSchema.parse({
      ...contract,
      ownerApproval: {
        required: true,
        state: "APPROVED",
        approvedAt: "2026-07-27T08:01:00.000Z",
      },
    });
    const diagnostics = compileAgentPromptDiagnostics(approved, "en", {
      activeRunId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      round: 1,
      executionType: "INITIAL",
      bindingMarker: "IC-RUN-INTEGRATION-PROMPT-BUDGET",
      contextLease: { revision: "1", fingerprint: `sha256:${"1".repeat(64)}` },
    });
    expect(diagnostics.executable).toBe(true);
    expect(diagnostics.issues).toEqual([]);
    expect(diagnostics.prompt.length).toBeLessThanOrEqual(14_000);
    expect(diagnostics.prompt).toContain("BACKEND-AUTHORITY");
    expect(diagnostics.prompt).toContain("omitted from prompt");
    expect(diagnostics.prompt).not.toContain("path-159");
  });

});

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runDeterministicBoundedDiscovery } from "@/core/discovery/discovery-runner";
import { createWorkspaceFilesystemObjectAuthority } from "@/core/workspace-index/filesystem-object-authority";
import type { IntentResolution } from "@/core/intelligence/intent-schema";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function makeRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

const intent: IntentResolution = {
  schemaVersion: "0.1",
  locale: "en",
  producerKind: "DETERMINISTIC_BASELINE",
  producerAdapterId: "DETERMINISTIC_INTENT_BASELINE",
  literalObjective: "review update channel v1.5.3",
  normalizedTopic: "Update Channel 1.5.3",
  taskMode: "CONTROLLED_AUDIT",
  ownerSummary: "Audit Update Channel 1.5.3 across Backend and Windows Client without source modification.",
  investigationQuestions: [
    { id: "Q-UPD-001", question: "Where is version authority defined?", origin: "SYSTEM_INFERRED" },
    { id: "Q-UPD-002", question: "How do readiness, native releases, artifacts, and manifests flow?", origin: "SYSTEM_INFERRED" },
  ],
  proposedRequirements: [
    { id: "REQ-UPD-001", outcome: "Identify version authority for 1.5.3.", origin: "SYSTEM_INFERRED", requiredEvidenceTypes: ["SOURCE"] },
    { id: "REQ-UPD-002", outcome: "Trace readiness, native releases, artifacts, and manifest data flow.", origin: "SYSTEM_INFERRED", requiredEvidenceTypes: ["SOURCE"] },
  ],
  expectedConcepts: ["version authority", "readiness", "native releases", "artifacts", "manifest"],
  unknowns: ["Relevant files are not known before discovery."],
  forbiddenAssumptions: ["Source evidence cannot prove runtime behavior."],
  preservedLiterals: ["1.5.3"],
  confidence: 0.96,
  needsClarification: false,
  providerBinding: {
    role: "INTENT_PLANNER",
    providerId: "OPENAI",
    modelId: "gpt-5.6-terra",
    executionChannelId: "CODEX",
  },
  authorityEcho: {
    taskMode: "CONTROLLED_AUDIT",
    workspaceIds: [
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
    ],
    effectiveCapabilities: ["readFiles"],
    authorityFingerprint: "a".repeat(64),
  },
};

async function authorizedRootBoundary(root: string) {
  const authority = createWorkspaceFilesystemObjectAuthority();
  try {
    const proof = await authority.probeDirectory(root);
    return { authorizedRootRealPath: proof.resolved_real_path, authorizedRootObjectIdentity: proof.identity };
  } finally {
    await authority.close();
  }
}

describe("deterministic bounded discovery", () => {
  it("discovers relevant candidates across approved workspaces without preselected files", async () => {
    const backend = await makeRoot("intentchord-backend-");
    const client = await makeRoot("intentchord-client-");
    await mkdir(path.join(backend, "src", "updates"), { recursive: true });
    await mkdir(path.join(client, "src", "self-update"), { recursive: true });
    await writeFile(
      path.join(backend, "src", "updates", "readiness-route.ts"),
      "export const versionAuthority = '1.5.3'; export const artifactManifest = 'native releases readiness';",
    );
    await writeFile(
      path.join(client, "src", "self-update", "manifest-reader.rs"),
      "const VERSION: &str = \"1.5.3\"; // readiness manifest artifact",
    );

    const backendAuthority = await authorizedRootBoundary(backend);
    const clientAuthority = await authorizedRootBoundary(client);

    const result = await runDeterministicBoundedDiscovery({
      taskId: "33333333-3333-4333-8333-333333333333",
      intentResolutionId: "44444444-4444-4444-8444-444444444444",
      authorityFingerprint: "a".repeat(64),
      intent,
      workspaces: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          displayName: "backend",
          rootReference: backend,
          ...backendAuthority,
          discoveryScopeMode: "FULL_WORKSPACE",
          allowedPaths: [],
          excludedPaths: [],
        },
        {
          id: "22222222-2222-4222-8222-222222222222",
          displayName: "client",
          rootReference: client,
          ...clientAuthority,
          discoveryScopeMode: "FULL_WORKSPACE",
          allowedPaths: [],
          excludedPaths: [],
        },
      ],
    });

    expect(result.items.length).toBeGreaterThanOrEqual(2);
    expect(result.assessment.assessmentStatus).toBe("ASSESSED");
    expect(result.assessment.crossFileDependency).toBe("YES");
    expect(result.assessment.crossWorkspaceDependency).toBe("YES");
    expect(result.assessment.requirementCoverage.every(item => item.discoveredItemCount > 0)).toBe(true);
    expect(result.items.every(item => item.contentSha256.match(/^[0-9a-f]{64}$/))).toBe(true);
    expect(result.evidenceGaps).toEqual([]);
  });

  it("propagates governed abort/deadline terminal conditions instead of converting them into Discovery evidence gaps", async () => {
    const workspace = await makeRoot("intentchord-discovery-governance-");
    const authority = await authorizedRootBoundary(workspace);
    const controller = new AbortController();
    controller.abort();
    const tools = {
      searchWorkspaceText: async () => {
        const error = new Error("WORKSPACE_INDEX_ABORTED") as Error & { code: string };
        error.code = "WORKSPACE_INDEX_ABORTED";
        throw error;
      },
      close: async () => undefined,
    };
    await expect(runDeterministicBoundedDiscovery({
      taskId: "33333333-3333-4333-8333-333333333333",
      intentResolutionId: "44444444-4444-4444-8444-444444444444",
      authorityFingerprint: "a".repeat(64),
      intent,
      signal: controller.signal,
      workspaces: [{
        id: "11111111-1111-4111-8111-111111111111",
        displayName: "workspace",
        rootReference: workspace,
        ...authority,
        discoveryScopeMode: "FULL_WORKSPACE",
        allowedPaths: [],
        excludedPaths: [],
      }],
    }, tools as never)).rejects.toMatchObject({ code: "WORKSPACE_INDEX_ABORTED" });
  });

});

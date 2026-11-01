import { describe, expect, it } from "vitest";
import { createBlankTaskDraft, type TaskDraftInput } from "@/core/tasks/task-input";
import { resolveUnifiedExecutionSetup } from "@/core/tasks/execution-routing-policy";

function governedDraft(): TaskDraftInput {
  const draft = createBlankTaskDraft("SOURCE_IMPLEMENTATION");
  return {
    ...draft,
    objective: "Correct a coupled multi-file source defect and validate the bounded result.",
    contextAnalysisBinding: {
      workspaceIndexSnapshotId: "11111111-1111-4111-8111-111111111111",
      mappingRunId: "22222222-2222-4222-8222-222222222222",
      proposalId: "33333333-3333-4333-8333-333333333333",
      proposalSha256: "a".repeat(64),
      acceptedContextDecisionIds: ["44444444-4444-4444-8444-444444444444"],
    },
    candidateScope: {
      workspaceIndexSnapshotId: "11111111-1111-4111-8111-111111111111",
      mappingRunId: "22222222-2222-4222-8222-222222222222",
      proposalId: "33333333-3333-4333-8333-333333333333",
      proposalSha256: "a".repeat(64),
      acceptedContextDecisionIdsSha256: "b".repeat(64),
      candidateScopeSha256: "c".repeat(64),
      entries: [],
      candidateAllowedPaths: [
        { workspaceId: "55555555-5555-4555-8555-555555555555", path: "src/server/a.ts" },
        { workspaceId: "55555555-5555-4555-8555-555555555555", path: "src/server/b.ts" },
        { workspaceId: "55555555-5555-4555-8555-555555555555", path: "src/core/c.ts" },
        { workspaceId: "55555555-5555-4555-8555-555555555555", path: "src/core/d.ts" },
      ],
    },
    scopeConfirmation: {
      candidateIdentity: {
        workspaceIndexSnapshotId: "11111111-1111-4111-8111-111111111111",
        mappingRunId: "22222222-2222-4222-8222-222222222222",
        proposalId: "33333333-3333-4333-8333-333333333333",
        proposalSha256: "a".repeat(64),
        acceptedContextDecisionIdsSha256: "b".repeat(64),
        candidateScopeSha256: "c".repeat(64),
      },
      confirmedAt: "2026-08-18T00:00:00.000Z",
      confirmedBy: "owner-local:Hisham",
      confirmedAllowedPaths: [
        { workspaceId: "55555555-5555-4555-8555-555555555555", path: "src/server/a.ts" },
        { workspaceId: "55555555-5555-4555-8555-555555555555", path: "src/server/b.ts" },
        { workspaceId: "55555555-5555-4555-8555-555555555555", path: "src/core/c.ts" },
        { workspaceId: "55555555-5555-4555-8555-555555555555", path: "src/core/d.ts" },
      ],
      confirmedExcludedPaths: [],
    },
  };
}

describe("UNIFIED_V1 late execution routing", () => {
  it("lets the Owner choose Codex while the backend resolves the exact OpenAI model and reasoning profile", () => {
    const setup = resolveUnifiedExecutionSetup(governedDraft(), "CODEX");
    expect(setup.executionChannelId).toBe("CODEX");
    expect(setup.providerId).toBe("OPENAI");
    expect(setup.modelId).toBe("gpt-5.6-sol");
    expect(setup.reasoningProfile).toBe("Medium");
    expect(setup.modelOverrideAccepted).toBe(false);
  });

  it("resolves Claude Code without accepting an Owner-selected model", () => {
    const setup = resolveUnifiedExecutionSetup(governedDraft(), "CLAUDE_CODE");
    expect(setup.executionChannelId).toBe("CLAUDE_CODE");
    expect(setup.providerId).toBe("ANTHROPIC");
    expect(setup.modelId).toBe("claude-opus-4-8");
    expect(setup.reasoningProfile).toBe("High");
  });

  it("fails closed before governed Scope Confirmation", () => {
    const draft = governedDraft();
    delete draft.scopeConfirmation;
    expect(() => resolveUnifiedExecutionSetup(draft, "CODEX")).toThrow(/Scope Confirmation/);
  });
});

import { describe, expect, it } from "vitest";
import { compileAgentPrompt } from "@/core/prompts/compiler";
import { createBlankContractInput, transitionProvider } from "@/core/tasks/task-input";
import { providerIds, providerRegistry } from "@/core/providers/registry";
import { evaluateVerdict } from "@/core/verdicts/engine";
import { approveContract, buildDraftContract } from "@/lib/ui-flow";
import { scenarioVerdict } from "@/test/fixtures/demo-scenarios";
import {
  activeRun,
  completeActiveRun,
  createTaskRecord,
  emptyWorkspace,
  parentRun,
  recordOwnerDecision,
  restoreWorkspace,
  setTaskContract,
  startPendingRun,
  upsertTask,
} from "@/lib/workspace";
import type { ProviderId } from "@/core/providers/registry";

function approvedTask(providerId: ProviderId = "OPENAI") {
  const configured = transitionProvider(createBlankContractInput("SOURCE_IMPLEMENTATION"), providerId);
  const input = {
    ...configured,
    modelOverrideAccepted: true,
    executionSetup: configured.executionSetup ? { ...configured.executionSetup, modelOverrideAccepted: true } : undefined,
    objective: "Implement one bounded owner-approved change across multiple approved files.",
    workspaceRef: "intentchord-owner-test",
    workspaceSource: "MANUAL_UNVERIFIED" as const,
    allowedPaths: ["src/"],
    excludedPaths: ["config/"],
    evidenceFiles: ["evidence/session-001.json"],
    identity: "owner-session-001",
  };
  const task = createTaskRecord(input, { id: `task-${providerId.toLowerCase()}`, now: "2026-07-19T12:00:00.000Z" });
  const contract = approveContract(buildDraftContract(input, `${task.id}-contract-r1`)!).contract!;
  return setTaskContract(task, contract, "2026-07-19T12:01:00.000Z");
}

describe("revision 3 provider, contract, and run lifecycle", () => {
  it("exposes only the three approved MVP providers and deterministic execution channels", () => {
    expect(providerIds).toEqual(["OPENAI", "ANTHROPIC", "GOOGLE"]);
    expect(Object.values(providerRegistry).map(item => item.executionChannelName)).toEqual(["Codex", "Claude Code", "Gemini CLI"]);
    expect(JSON.stringify(providerRegistry)).not.toContain("Cursor");
    expect(JSON.stringify(providerRegistry)).not.toContain("Other AI Agent");
  });

  it("resolves materially different provider contracts and delivery prompts", () => {
    const codex = approvedTask("OPENAI").contract!;
    const claude = approvedTask("ANTHROPIC").contract!;
    expect(codex.agentResolution.profileId).toBe("CODEX");
    expect(claude.agentResolution.profileId).toBe("CLAUDE_CODE");
    expect(codex.agentResolution.contextRules).not.toEqual(claude.agentResolution.contextRules);
    expect(codex.agentResolution.executionWorkflow).toEqual(claude.agentResolution.executionWorkflow);
    expect(compileAgentPrompt(codex, "en")).not.toBe(compileAgentPrompt(claude, "en"));
  });

  it("creates an authoritative pending initial run before any report is submitted", () => {
    const started = startPendingRun(approvedTask(), { executionType: "INITIAL", source: "IMPORTED_REPORT", now: "2026-07-19T12:02:00.000Z" });
    const run = activeRun(started)!;
    expect(started.runs).toHaveLength(1);
    expect(run.status).toBe("AWAITING_REPORT");
    expect(run.executionType).toBe("INITIAL");
    expect(run.round).toBe(1);
    expect(run.id).toBeTruthy();
    expect(run.modelId).toBe(started.contract?.selectedConfiguration.modelId);
  });

  it("completes the same authoritative run instead of generating a new id after validation", () => {
    const started = startPendingRun(approvedTask(), { executionType: "INITIAL", source: "IMPORTED_REPORT", now: "2026-07-19T12:02:00.000Z" });
    const pending = activeRun(started)!;
    const result = scenarioVerdict("controlled-success", started.contract!, pending.id);
    const completed = completeActiveRun(started, result.scenario.report, result.verdict, "2026-07-19T12:03:00.000Z");
    expect(completed.runs).toHaveLength(1);
    expect(activeRun(completed)?.id).toBe(pending.id);
    expect(activeRun(completed)?.status).toBe("REVIEW_READY");
    expect(activeRun(completed)?.report?.runId).toBe(pending.id);
  });

  it("names the authoritative active run in the deterministic mismatch action", () => {
    const task = approvedTask();
    const started = startPendingRun(task, { executionType: "INITIAL", source: "IMPORTED_REPORT" });
    const run = activeRun(started)!;
    const result = scenarioVerdict("controlled-success", task.contract!, run.id);
    const verdict = evaluateVerdict(task.contract!, { ...result.scenario.report, runId: "wrong-run" }, run.id);
    expect(verdict.classification).toBe("EVIDENCE_REQUIRED");
    expect(verdict.evidenceGaps[0]).toContain(run.id);
    expect(verdict.nextAction).toBe(`Resubmit the report using the active Run ID: ${run.id}.`);
  });

  it("creates a pending correction child before the corrected report and preserves lineage", () => {
    let task = startPendingRun(approvedTask(), { executionType: "INITIAL", source: "IMPORTED_REPORT", now: "2026-07-19T12:02:00.000Z" });
    const first = activeRun(task)!;
    const result = scenarioVerdict("evidence-mixing", task.contract!, first.id);
    task = completeActiveRun(task, result.scenario.report, result.verdict, "2026-07-19T12:03:00.000Z");
    task = recordOwnerDecision(task, "CORRECTION_REQUESTED", "2026-07-19T12:04:00.000Z");
    task = startPendingRun(task, { executionType: "CORRECTION", source: "CORRECTION_REPORT", parentRunId: first.id, now: "2026-07-19T12:05:00.000Z" });
    const correction = activeRun(task)!;
    expect(task.runs).toHaveLength(2);
    expect(correction.status).toBe("AWAITING_REPORT");
    expect(correction.round).toBe(2);
    expect(correction.parentRunId).toBe(first.id);
    expect(parentRun(task, correction)?.id).toBe(first.id);
    expect(correction.source).toBe("CORRECTION_REPORT");
  });

  it("restores the interface locale and pending correction lineage from local persistence", () => {
    let task = startPendingRun(approvedTask(), { executionType: "INITIAL", source: "IMPORTED_REPORT", now: "2026-07-19T12:02:00.000Z" });
    const first = activeRun(task)!;
    const result = scenarioVerdict("evidence-mixing", task.contract!, first.id);
    task = completeActiveRun(task, result.scenario.report, result.verdict, "2026-07-19T12:03:00.000Z");
    task = recordOwnerDecision(task, "CORRECTION_REQUESTED", "2026-07-19T12:04:00.000Z");
    task = startPendingRun(task, { executionType: "CORRECTION", source: "CORRECTION_REPORT", parentRunId: first.id, now: "2026-07-19T12:05:00.000Z" });
    const workspace = { ...upsertTask(emptyWorkspace(), task), interfaceLocale: "ar" as const };
    const restored = restoreWorkspace(JSON.stringify(workspace));
    const restoredTask = restored.tasks[0];
    const correction = activeRun(restoredTask)!;
    expect(restored.interfaceLocale).toBe("ar");
    expect(correction.status).toBe("AWAITING_REPORT");
    expect(correction.parentRunId).toBe(first.id);
    expect(parentRun(restoredTask, correction)?.decision).toBe("CORRECTION_REQUESTED");
  });
});

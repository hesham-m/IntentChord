import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PoolClient } from "pg";
import { trustedProducerRequiredChecks, type ExecutionContract } from "@/core/contracts/execution-contract";
import { validatePreflight } from "@/core/policies/preflight";
import type { ExecutorReportEnvelope } from "@/core/reports/executor-report";
import { reportSectionIds } from "@/core/reports/report-contract";
import {
  createBlankContractInput,
  synchronizeLegacyWorkspaceProjection,
  type ContractInput,
} from "@/core/tasks/task-input";
import { backendProducer, type TrustedProducerContext } from "@/server/authority";
import {
  completeDiscoveryRun,
  createTaskDiscoveryRun,
} from "@/server/discovery-lifecycle";
import { bindRollbackOnlyTestClient, databasePool, databaseQuery, verifyDatabaseIdentity } from "@/server/db";
import {
  approveContractRevision,
  compileContractArtifact,
  createRun,
  createTask,
  evaluateRun,
  readTaskHistory,
  readTaskLifecycle,
  recordOwnerDecision,
  recordToolTrace,
  recordValidationEvidence,
  resolveContract,
  resolveTaskIntent,
  confirmTaskIntent,
  reviseTask,
  startCorrection,
  submitRawReport,
} from "@/server/lifecycle";
import {
  createProjectContext,
  linkProjectContextWorkspace,
} from "@/server/project-context-service";
import {
  registerManualWorkspace,
  selectAndRegisterWorkspace,
  verifyAndRegisterWorkspace,
  verifyManualWorkspaceRegistration,
  type LocalWorkspaceConnector,
  type WorkspaceRegistration,
} from "@/server/workspace-connector";

const execFileAsync = promisify(execFile);

async function runGit(reference: string, args: string[]) {
  await execFileAsync("git", ["-C", reference, ...args], {
    windowsHide: true,
    timeout: 10_000,
    maxBuffer: 256 * 1024,
  });
}

function loadAuthorizedDatabaseUrl() {
  if (process.env.DATABASE_URL) return;
  const env = readFileSync(".env.local", "utf8");
  const match = env.match(/^DATABASE_URL\s*=\s*["']?([^\r\n"']+)/m);
  if (!match) throw new Error("DATABASE_URL is required for PostgreSQL integration tests.");
  process.env.DATABASE_URL = match[1].trim();
}

function draftFor(workspace: WorkspaceRegistration, suffix: string): ContractInput {
  const base = createBlankContractInput("SOURCE_IMPLEMENTATION");
  return synchronizeLegacyWorkspaceProjection({
    ...base,
    title: `Backend authority integration ${suffix}`,
    titleManuallyEdited: true,
    objective: `Implement and verify Backend authority, trusted evidence, Run state, and reload behavior for scenario ${suffix}.`,
    ownerRequirements: [{
      id: "BACKEND-AUTHORITY",
      outcome: "Backend authority and trusted evidence remain correct after reload and adversarial attempts.",
      proofProfile: {
        sourceBehavior: true,
        positive: true,
        negativeAdversarial: true,
        persistenceReload: true,
      },
    }],
    workspaces: [{
      id: workspace.id,
      displayName: workspace.displayName,
      role: workspace.role,
      referenceType: workspace.referenceType,
      source: workspace.source,
      reference: workspace.normalizedReference,
      repositoryIdentity: workspace.repositoryIdentity,
      branch: workspace.branch,
      commitSha: workspace.commitSha,
      fingerprint: workspace.fingerprint,
      provenance: JSON.stringify({
        verificationStatus: workspace.verificationStatus,
        verificationMethod: workspace.verificationMethod,
        source: workspace.source,
      }),
      discoveryScopeMode: "SELECTED_PATHS",
      allowedPaths: ["src"],
      excludedPaths: ["node_modules"],
      authorizationContext: workspace.authorizationContext,
      ordering: 0,
    }],
    identity: "",
    providerId: "GOOGLE",
    modelId: "gemini-3.6-flash",
    executionChannelId: "GEMINI_CLI",
    reasoningProfile: "Auto",
    runtimeProfileId: "STANDARD",
    modelOverrideAccepted: true,
    modelOverrideReason: "Integration test model override",
    executionSetup: {
      providerId: "GOOGLE",
      modelId: "gemini-3.6-flash",
      executionChannelId: "GEMINI_CLI",
      reasoningProfile: "Auto",
      runtimeProfileId: "STANDARD",
      modelOverrideAccepted: true,
      modelOverrideReason: "Integration test model override",
    },
  });
}

function sourceEvidenceFor(contract: ExecutionContract) {
  const relativePath = "src/server/lifecycle.ts";
  const contentSha256 = createHash("sha256")
    .update(readFileSync(relativePath))
    .digest("hex");
  return {
    kind: "SOURCE_EVIDENCE" as const,
    workspaceId: contract.scope.workspaces[0].id,
    relativePath,
    symbol: "approveContractRevision",
    contentSha256,
  };
}

function requirementProofs(contract: ExecutionContract): ExecutorReportEnvelope["requirementProofs"] {
  const sourceEvidence = sourceEvidenceFor(contract);
  return contract.executionPackage.mandatoryRequirements.map(requirement => {
    const requiresTrustedExecutionEvidence = requirement.requiredEvidenceTypes.some(
      evidenceType => evidenceType === "VALIDATION" || evidenceType === "RUNTIME",
    );
    return {
      requirementId: requirement.id,
      classification: "PASS" as const,
      actualSourceBehavior: `The governed behavior for ${requirement.id} was inspected and exercised.`,
      sourceBehaviorRefs: requirement.proofProfile.sourceBehavior
        ? [
          ...(requirement.requiredEvidenceTypes.includes("SOURCE") ? [sourceEvidence] : []),
          ...(requiresTrustedExecutionEvidence
            ? [{ kind: "VALIDATION_CHECK" as const, checkId: `requirement:${requirement.id}:source-behavior` }]
            : []),
        ]
        : [],
      positiveProofRefs: requirement.proofProfile.positive
        ? requiresTrustedExecutionEvidence
          ? [{ kind: "VALIDATION_CHECK" as const, checkId: `requirement:${requirement.id}:positive` }]
          : requirement.requiredEvidenceTypes.includes("SOURCE")
            ? [sourceEvidence]
            : []
        : [],
      negativeAdversarialProofRefs: requirement.proofProfile.negativeAdversarial && requiresTrustedExecutionEvidence
        ? [{ kind: "VALIDATION_CHECK" as const, checkId: `requirement:${requirement.id}:negative-adversarial` }]
        : [],
      persistenceReloadProofRefs: requirement.proofProfile.persistenceReload && requiresTrustedExecutionEvidence
        ? [{ kind: "VALIDATION_CHECK" as const, checkId: `requirement:${requirement.id}:persistence-reload` }]
        : [],
      notes: "Executor proof row only; source identity is Backend-verified and authoritative PASS still requires the separate trusted validation batch.",
    };
  });
}

function reportFor(
  task: NonNullable<Awaited<ReturnType<typeof readTaskLifecycle>>>,
  rawText: string,
): ExecutorReportEnvelope {
  const run = task.runs.at(-1)!;
  const contract = task.contract!;
  const primaryRequirement = contract.executionPackage.mandatoryRequirements[0];
  return {
    contractId: contract.contractId,
    runId: run.id,
    round: run.round,
    executionType: run.executionType,
    ...(run.parentRunId ? { parentRunId: run.parentRunId } : {}),
    bindingMarker: run.bindingMarker,
    executorName: contract.agentResolution.executionChannelName,
    providerId: run.providerId,
    modelId: run.modelId,
    executionChannelId: run.agentProfileId,
    reasoningProfile: run.reasoningProfile,
    runtimeProfileId: run.runtimeProfileId,
    terminalState: "READY_FOR_FINAL_REPORT",
    inspectedPaths: [{ workspaceId: contract.scope.workspaces[0].id, path: "src" }],
    changedPaths: [],
    commands: [],
    evidenceIdentities: contract.evidenceIdentityState === "BOUND"
      ? [contract.evidenceIdentity]
      : [],
    findings: [{
      requirementId: primaryRequirement.id,
      claim: "The approved Backend authority behavior was inspected inside the authorized Workspace.",
      status: "PROVEN_BY_SOURCE",
      evidenceRefs: [sourceEvidenceFor(contract)],
    }],
    requirementProofs: requirementProofs(contract),
    validationResults: contract.requiredChecks.map(check => ({
      checkId: check.id,
      status: "PASS",
      details: `Executor claims ${check.id} passed; trusted evidence is submitted separately.`,
    })),
    executorClassification: "PASS",
    nextAction: "Request Backend deterministic evaluation after trusted evidence ingestion.",
    reportSections: {
      "executive-summary": "Backend authority integration report.",
      "sources-inspected": "The structured src Workspace path was inspected.",
      "evidence-matrix": "Every mandatory requirement has one structured proof row.",
      "unsupported-claims": "No unsupported claim is promoted to trusted evidence.",
      "evidence-gaps": "Independent evidence is delivered through the trusted Backend APIs.",
      "validation-results": "Executor validation claims are preserved separately.",
      "executor-classification": "PASS",
      "exact-next-action": "Run deterministic Backend evaluation.",
    },
    missingRequiredSources: [],
    accessDeniedPaths: [],
    closureCriteriaSatisfied: contract.closureCriteria.map(item => item.id),
    rawReport: `${rawText}\nObjective: ${contract.objective}\nInspected: src`,
    completedReportSections: [...reportSectionIds],
  };
}

const ownerRuntimeProducer: TrustedProducerContext = {
  producerType: "OWNER_RUNTIME",
  producerId: "owner-local:Hisham",
  authority: "owner-local:Hisham",
  trustBasis: "OWNER_SESSION",
};

function signedHarnessProducer(requestId = randomUUID()): TrustedProducerContext {
  return {
    producerType: "HARNESS",
    producerId: "intentchord-integration-harness",
    authority: "HARNESS:intentchord-integration-harness",
    trustBasis: "SIGNED_HARNESS",
    requestId,
    routePath: "/api/integration/validations",
    bodySha256: "a".repeat(64),
  };
}

async function resolveAndConfirmIntent(
  task: NonNullable<Awaited<ReturnType<typeof readTaskLifecycle>>>,
) {
  const executionSetup = task.draft.executionSetup;
  let current = (await resolveTaskIntent(task.id, {
    expectedRevision: task.revision,
    locale: "en",
    plannerAdapterId: "DETERMINISTIC_INTENT_BASELINE",
    plannerProviderId: executionSetup?.providerId ?? task.draft.providerId ?? "GOOGLE",
    plannerModelId: executionSetup?.modelId ?? task.draft.modelId ?? "gemini-3.6-flash",
    plannerExecutionChannelId: executionSetup?.executionChannelId ?? task.draft.executionChannelId ?? "GEMINI_CLI",
  }))!;
  current = (await confirmTaskIntent(current.id, {
    expectedRevision: current.revision,
    expectedResolutionId: current.intentResolution!.id,
    expectedOutputSha256: current.intentResolution!.outputSha256,
  }))!;
  let discovery = await createTaskDiscoveryRun(current.id, {
    expectedRevision: current.revision,
    locale: "en",
    discoveryAdapterId: "DETERMINISTIC_BOUNDED_DISCOVERY",
    discoveryProviderId: executionSetup?.providerId ?? current.draft.providerId ?? "GOOGLE",
    discoveryModelId: executionSetup?.modelId ?? current.draft.modelId ?? "gemini-3.6-flash",
    discoveryExecutionChannelId: executionSetup?.executionChannelId ?? current.draft.executionChannelId ?? "GEMINI_CLI",
  });
  expect(discovery.status).toBe("READY_TO_COMPLETE");
  expect(discovery.providerInvocationState).toBe("NOT_INVOKED");
  expect(discovery.externalInvocationId).toBeUndefined();
  const preFindingEvidence = await databaseQuery(
    "select count(*)::int as count from intentchord.source_evidence where discovery_run_id=$1",
    [discovery.id],
  );
  expect(preFindingEvidence.rows[0].count).toBe(0);
  discovery = await completeDiscoveryRun(discovery.id, {
    expectedStateRevision: discovery.stateRevision,
  });
  expect(["COMPLETED", "EVIDENCE_REQUIRED"]).toContain(discovery.status);
  current = (await readTaskLifecycle(current.id))!;
  expect(current.discoveryRun?.id).toBe(discovery.id);
  return current;
}

async function createLegacyTask(draft: any, taskId = randomUUID()) {
  const task = await createTask({ draft, requestedTaskId: taskId });
  const legacyDraft = { ...task!.draft };
  delete (legacyDraft as any).orchestrationVersion;
  await databaseQuery(
    `update intentchord.tasks set draft=$1 where id=$2`,
    [JSON.stringify(legacyDraft), taskId],
  );
  await databaseQuery(
    `update intentchord.task_draft_revisions set draft_projection=$1 where task_id=$2 and revision=0`,
    [JSON.stringify(legacyDraft), taskId],
  );
  return (await readTaskLifecycle(taskId))!;
}

async function createApprovedRun(workspace: WorkspaceRegistration, suffix: string) {
  let task = await createLegacyTask(draftFor(workspace, suffix));
  task = await resolveAndConfirmIntent(task);
  task = (await resolveContract(task.id, { expectedRevision: task.revision, locale: "en" }))!;
  const explicitRequirement = task.contract!.executionPackage.mandatoryRequirements.find(
    requirement => requirement.id === "BACKEND-AUTHORITY",
  );
  expect(explicitRequirement?.proofProfile).toEqual({
    sourceBehavior: true,
    positive: true,
    negativeAdversarial: true,
    persistenceReload: true,
  });
  const inferredSourceRequirements = task.contract!.executionPackage.mandatoryRequirements.filter(
    requirement => requirement.id.startsWith("REQ-INT-")
      && requirement.requiredEvidenceTypes.length === 1
      && requirement.requiredEvidenceTypes[0] === "SOURCE",
  );
  expect(inferredSourceRequirements.length).toBeGreaterThan(0);
  expect(inferredSourceRequirements.every(requirement =>
    requirement.proofProfile.sourceBehavior
    && requirement.proofProfile.positive
    && !requirement.proofProfile.negativeAdversarial
    && !requirement.proofProfile.persistenceReload
  )).toBe(true);
  task = (await approveContractRevision(task.contractRevisionId!, {
    expectedRevision: task.contractStateRevision,
    expectedContentSha256: task.contractContentSha256,
    approvalChannel: "INTEGRATION_TEST",
  }))!;
  task = (await createRun(task.id, {
    expectedRevision: task.revision,
    locale: "en",
    executionType: "INITIAL",
    source: "IMPORTED_REPORT",
  }))!;
  return task;
}

async function submitJsonReport(task: NonNullable<Awaited<ReturnType<typeof readTaskLifecycle>>>, rawText: string) {
  const run = task.runs.at(-1)!;
  return (await submitRawReport(
    run.id,
    Buffer.from(JSON.stringify(reportFor(task, rawText)), "utf8"),
    "application/json",
    run.stateRevision ?? 0,
  ))!;
}

function trustedProducerCheckIds(contract: ExecutionContract): string[] {
  return trustedProducerRequiredChecks(contract).map(check => check.id);
}

async function recordValidationBatch(
  task: NonNullable<Awaited<ReturnType<typeof readTaskLifecycle>>>,
  checkIds: string[],
) {
  const batchId = randomUUID();
  let current = task;
  for (const [sequence, checkId] of checkIds.entries()) {
    const run = current.runs.at(-1)!;
    current = (await recordValidationEvidence(run.id, {
      expectedRevision: run.stateRevision,
      checkId,
      status: "PASS",
      details: `Trusted Backend validation passed for ${checkId}.`,
      batchId,
      sequence,
      sequenceTotal: checkIds.length,
      isTerminal: sequence === checkIds.length - 1,
    }, backendProducer()))!;
  }
  return current;
}

async function recordNoCommandTrace(task: NonNullable<Awaited<ReturnType<typeof readTaskLifecycle>>>) {
  const run = task.runs.at(-1)!;
  return (await recordToolTrace(run.id, {
    expectedRevision: run.stateRevision,
    batchId: randomUUID(),
    sequence: 0,
    sequenceTotal: 1,
    isTerminal: true,
    command: "INTENTCHORD:NO_COMMANDS_EXECUTED",
    authorizationResult: "AUTHORIZED",
    occurredAt: new Date().toISOString(),
  }, ownerRuntimeProducer))!;
}

describe.sequential("PostgreSQL authoritative lifecycle and trust invariants", () => {
  let verified: WorkspaceRegistration;
  let unverified: WorkspaceRegistration;
  let rollbackClient: PoolClient | undefined;
  let releaseRollbackBinding: (() => void) | undefined;

  beforeAll(async () => {
    loadAuthorizedDatabaseUrl();
    process.env.INTENTCHORD_ROLLBACK_ONLY_PG_TEST = "1";
    rollbackClient = await databasePool().connect();
    await verifyDatabaseIdentity(rollbackClient);
    await rollbackClient.query("BEGIN");
    releaseRollbackBinding = bindRollbackOnlyTestClient(rollbackClient);
    const identity = await rollbackClient.query(
      "select current_database() as database,current_user as role,current_schema() as schema",
    );
    expect(identity.rows[0]).toEqual({
      database: "intentchord_dev",
      role: "intentchord_app",
      schema: "intentchord",
    });
    const connector: LocalWorkspaceConnector = {
      id: "TEST_BOUNDED_LOCAL_SELECTION",
      async selectDirectory() {
        return process.cwd();
      },
    };
    verified = await selectAndRegisterWorkspace({
      displayName: "IntentChord integration Workspace",
      role: "primary",
      authorizationContext: "integration test scope",
    }, connector);
    unverified = await registerManualWorkspace({
      displayName: "Manual fallback",
      role: "supporting",
      referenceType: "LOCAL_PATH",
      reference: "C:\\owner-typed-unverified",
      authorizationContext: "advanced fallback",
    });
  });

  afterAll(async () => {
    try {
      if (rollbackClient) await rollbackClient.query("ROLLBACK");
    } finally {
      releaseRollbackBinding?.();
      rollbackClient?.release();
      delete process.env.INTENTCHORD_ROLLBACK_ONLY_PG_TEST;
      await databasePool().end();
    }
  });

  it("preserves verified source provenance without browser repository enumeration", () => {
    expect(verified.verificationStatus).toBe("VERIFIED");
    expect(verified.source).toBe("MANUAL_VERIFIED");
    expect(verified.provenance.repositoryEnumeration).toBe(false);
    expect(JSON.stringify(verified)).not.toMatch(/webkitdirectory|repositoryInventory|directoryTree/);
  });

  it("replays one requested Task identity without creating a duplicate row", async () => {
    const requestedTaskId = randomUUID();
    const draft = draftFor(verified, "idempotent-create");
    const first = await createTask({ draft, requestedTaskId });
    const replay = await createTask({ draft, requestedTaskId });
    expect(first?.id).toBe(requestedTaskId);
    expect(replay?.id).toBe(requestedTaskId);
    expect(replay?.draft).toEqual(first?.draft);
    await expect(createTask({
      draft: { ...draft, objective: `${draft.objective} changed` },
      requestedTaskId,
    })).rejects.toMatchObject({
      status: 409,
      code: "TASK_CREATE_IDEMPOTENCY_MISMATCH",
    });
    const count = await databaseQuery(
      "select count(*)::int as count from intentchord.tasks where id=$1",
      [requestedTaskId],
    );
    expect(count.rows[0].count).toBe(1);
  });

  it("binds each Task explicitly as independent or Project-bound without global Project authority", async () => {
    const project = await createProjectContext(
      { displayName: "IntentChord Task Context Integration" },
      "owner-local:Hisham",
      rollbackClient,
    );
    const linkedProject = await linkProjectContextWorkspace(project.id, {
      expectedRevision: project.revision,
      workspaceRegistrationId: verified.id,
      role: "PRIMARY",
      ordering: 0,
    }, "owner-local:Hisham", rollbackClient);

    const projectDraft = {
      ...draftFor(verified, "project-bound-task"),
      taskContext: {
        kind: "PROJECT_BOUND" as const,
        projectContextId: linkedProject.id,
        projectContextDisplayName: "stale client label",
        projectContextRevision: linkedProject.revision,
      },
    };
    const projectTask = await createTask({ draft: projectDraft });
    expect(projectTask?.draft.taskContext).toEqual({
      kind: "PROJECT_BOUND",
      projectContextId: linkedProject.id,
      projectContextDisplayName: linkedProject.displayName,
      projectContextRevision: linkedProject.revision,
    });

    const independentTask = await createTask({ draft: draftFor(verified, "independent-task") });
    expect(independentTask?.draft.taskContext).toEqual({ kind: "INDEPENDENT" });

    await expect(createTask({
      draft: {
        ...draftFor(unverified, "unlinked-project-workspace"),
        taskContext: {
          kind: "PROJECT_BOUND",
          projectContextId: linkedProject.id,
          projectContextDisplayName: linkedProject.displayName,
          projectContextRevision: linkedProject.revision,
        },
      },
    })).rejects.toMatchObject({
      status: 422,
      code: "PROJECT_WORKSPACE_LINK_REQUIRED",
    });
  });

  it("upgrades a manual registration only from the expected Workspace revision", async () => {
    const manual = await registerManualWorkspace({
      displayName: "Verifiable manual fallback",
      role: "supporting",
      referenceType: "LOCAL_PATH",
      reference: process.cwd(),
      authorizationContext: "manual verification integration test",
    });
    await expect(verifyManualWorkspaceRegistration(manual.id, { expectedRevision: manual.revision + 1 }))
      .rejects.toMatchObject({ status: 409, code: "REVISION_CONFLICT" });
    const upgraded = await verifyManualWorkspaceRegistration(manual.id, { expectedRevision: manual.revision });
    expect(upgraded.id).toBe(manual.id);
    expect(upgraded.revision).toBe(manual.revision + 1);
    expect(upgraded.source).toBe("MANUAL_VERIFIED");
  });

  it("registers a non-Git Workspace as a bounded path reference without claiming content freshness", async () => {
    const temporary = await mkdtemp(path.join(tmpdir(), "intentchord-workspace-reference-"));
    try {
      const workspace = await verifyAndRegisterWorkspace({
        displayName: "Bounded non-Git reference",
        role: "primary",
        reference: temporary,
        authorizationContext: "reference-only integration test",
        verificationMethod: "INTEGRATION_TEST_REFERENCE_ONLY",
      });
      expect(workspace.verificationStatus).toBe("VERIFIED");
      expect(workspace.provenance.pathIdentityComplete).toBe(true);
      expect(workspace.provenance.contentFreshnessStatus).toBe("UNKNOWN");
      expect(workspace.provenance.fileContentRead).toBe(false);
      expect(workspace.provenance.repositoryEnumeration).toBe(false);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it("rejects unverified Workspace snapshots before Contract resolution", async () => {
    const task = (await createTask({ draft: draftFor(unverified, "unverified") }))!;
    await expect(resolveTaskIntent(task.id, {
      expectedRevision: task.revision,
      locale: "en",
      plannerAdapterId: "DETERMINISTIC_INTENT_BASELINE",
      plannerProviderId: task.draft.executionSetup?.providerId ?? task.draft.providerId ?? "GOOGLE",
      plannerModelId: task.draft.executionSetup?.modelId ?? task.draft.modelId ?? "gemini-3.6-flash",
      plannerExecutionChannelId: task.draft.executionSetup?.executionChannelId ?? task.draft.executionChannelId ?? "GEMINI_CLI",
    })).rejects.toMatchObject({ status: 422, code: "WORKSPACE_VERIFICATION_REQUIRED" });
  });

  it("revalidates proof-grade Root Object authority and blocks a Task snapshot when the registered path is replaced", async () => {
    const temporary = await mkdtemp(path.join(tmpdir(), "intentchord-workspace-stale-"));
    const displaced = `${temporary}-displaced`;
    try {
      await writeFile(path.join(temporary, "source.txt"), "initial source", "utf8");

      const workspace = await verifyAndRegisterWorkspace({
        displayName: "Mutable Root Object Workspace",
        role: "primary",
        reference: temporary,
        authorizationContext: "root object identity integration test",
        verificationMethod: "INTEGRATION_TEST_ROOT_OBJECT_AUTHORITY",
      });
      expect(workspace.provenance.snapshotStrength).toBe("VERIFIED_ROOT_OBJECT_REFERENCE_ONLY");
      expect(workspace.provenance.fileContentRead).toBe(false);
      expect(workspace.provenance.repositoryEnumeration).toBe(false);
      expect(workspace.provenance.rootObjectIdentityProof).toBeTruthy();

      const task = (await createTask({ draft: draftFor(workspace, "stale-workspace") }))!;
      await rename(temporary, displaced);
      await mkdir(temporary, { recursive: true });
      await writeFile(path.join(temporary, "source.txt"), "initial source", "utf8");

      const executionSetup = task.draft.executionSetup;
      expect(executionSetup).toBeDefined();

      await expect(resolveTaskIntent(task.id, {
        expectedRevision: task.revision,
        locale: "en",
        plannerAdapterId: "DETERMINISTIC_INTENT_BASELINE",
        plannerProviderId: executionSetup!.providerId,
        plannerModelId: executionSetup!.modelId,
        plannerExecutionChannelId: executionSetup!.executionChannelId,
      })).rejects.toMatchObject({ status: 409, code: "WORKSPACE_IDENTITY_STALE" });
      const status = await databaseQuery(
        "select verification_status,root_authority_state from intentchord.workspaces where id=$1",
        [workspace.id],
      );
      expect(status.rows[0].verification_status).toBe("STALE");
      expect(status.rows[0].root_authority_state).toBe("STALE_MISMATCH");
    } finally {
      await rm(temporary, { recursive: true, force: true });
      await rm(displaced, { recursive: true, force: true });
    }
  });

  it("preserves immutable Task revisions and rejects stale writers", async () => {
    let task = (await createTask({ draft: draftFor(verified, "revision") }))!;
    const staleRevision = task.revision;
    task = (await reviseTask(task.id, {
      expectedRevision: task.revision,
      draft: { ...task.draft, objective: `${task.draft.objective} Revised once.` },
    }))!;
    await expect(reviseTask(task.id, {
      expectedRevision: staleRevision,
      draft: task.draft,
    })).rejects.toMatchObject({ status: 409, code: "REVISION_CONFLICT" });
    expect((await readTaskLifecycle(task.id))?.draft.objective).toContain("Revised once.");
  });

  it("creates only Run-bound executable artifacts and blocks a second unresolved Run", async () => {
    let task = await createLegacyTask(draftFor(verified, "single-run"));
    task = await resolveAndConfirmIntent(task);
    task = (await resolveContract(task.id, { expectedRevision: task.revision, locale: "en" }))!;
    task = (await approveContractRevision(task.contractRevisionId!, {
      expectedRevision: task.contractStateRevision,
      expectedContentSha256: task.contractContentSha256,
      approvalChannel: "INTEGRATION_TEST",
    }))!;
    const preview = await compileContractArtifact(task.contractRevisionId!, {
      expectedRevision: task.contractStateRevision,
      locale: "en",
    });
    expect(preview.executableArtifactCreated).toBe(false);
    task = (await createRun(task.id, {
      expectedRevision: task.revision,
      locale: "en",
      executionType: "INITIAL",
      source: "IMPORTED_REPORT",
    }))!;
    expect(task.runs[0].compiledArtifact?.deliveryState).toBe("DELIVERED");
    await expect(createRun(task.id, {
      expectedRevision: task.revision,
      locale: "en",
      executionType: "INITIAL",
      source: "IMPORTED_REPORT",
    })).rejects.toMatchObject({ status: 409, code: "RUN_ALREADY_ACTIVE" });
  });

  it("preserves rejected raw Markdown bytes without injecting governed identity", async () => {
    const task = await createApprovedRun(verified, "rejected-markdown");
    const run = task.runs.at(-1)!;
    const markdown = Buffer.from("## [IC-SECTION:executive-summary] Missing governed headers.", "utf8");
    await expect(submitRawReport(run.id, markdown, "text/markdown", run.stateRevision ?? 0))
      .rejects.toMatchObject({ status: 422, code: "REPORT_PARSE_REJECTED" });
    const stored = await databaseQuery(
      "select raw_content,parse_status,executor_claimed_identity from intentchord.report_submissions where run_id=$1",
      [run.id],
    );
    expect(Buffer.compare(stored.rows[0].raw_content, markdown)).toBe(0);
    expect(stored.rows[0].parse_status).toBe("REJECTED");
    expect(stored.rows[0].executor_claimed_identity).toEqual({});
  });

  it("keeps automatic Backend report validation outside trusted-producer batches", async () => {
    let task = await createApprovedRun(verified, "backend-automatic-validation");
    task = await submitJsonReport(task, "Backend automatic validation ownership report.");
    const run = task.runs.at(-1)!;
    const automaticCheck = task.contract!.requiredChecks.find(
      check => check.id === "contract-validation",
    );
    expect(automaticCheck?.satisfactionMode).toBe("BACKEND_AUTOMATIC");
    await expect(recordValidationEvidence(run.id, {
      expectedRevision: run.stateRevision,
      checkId: "contract-validation",
      status: "PASS",
      details: "A trusted producer must not resubmit the Backend-owned report binding check.",
      batchId: randomUUID(),
      sequence: 0,
      sequenceTotal: 1,
      isTerminal: true,
    }, backendProducer())).rejects.toMatchObject({
      status: 409,
      code: "VALIDATION_CHECK_BACKEND_AUTOMATIC",
    });
  });

  it("requires a complete trusted batch before deterministic PASS and survives reload", async () => {
    let task = await createApprovedRun(verified, "trusted-pass");
    task = await submitJsonReport(task, "Trusted full-pass integration report.");
    const requiredCheckIds = trustedProducerCheckIds(task.contract!);
    task = await recordValidationBatch(task, requiredCheckIds);
    task = await recordNoCommandTrace(task);
    const run = task.runs.at(-1)!;
    task = (await evaluateRun(run.id, { expectedRevision: run.stateRevision }))!;
    const trustedPassVerdict = task.runs.at(-1)?.verdict;
    expect(trustedPassVerdict?.classification, JSON.stringify(trustedPassVerdict, null, 2)).toBe("PASS");
    const reloaded = await readTaskLifecycle(task.id);
    expect(reloaded?.runs.at(-1)?.status).toBe("REVIEW_READY");
    expect(reloaded?.runs.at(-1)?.verdict?.classification).toBe("PASS");
  });

  it("rejects an executor command history that contradicts the trusted tool trace", async () => {
    let task = await createApprovedRun(verified, "command-history-mismatch");
    const run = task.runs.at(-1)!;
    const report = reportFor(task, "Command-history mismatch integration report.");
    report.commands = [{
      command: "Get-Content src/server/lifecycle.ts",
      purpose: "Inspect the authoritative lifecycle source.",
      exitCode: 0,
    }];
    task = (await submitRawReport(
      run.id,
      Buffer.from(JSON.stringify(report), "utf8"),
      "application/json",
      run.stateRevision ?? 0,
    ))!;
    const requiredCheckIds = trustedProducerCheckIds(task.contract!);
    task = await recordValidationBatch(task, requiredCheckIds);
    task = await recordNoCommandTrace(task);
    const reportReceived = task.runs.at(-1)!;
    task = (await evaluateRun(reportReceived.id, { expectedRevision: reportReceived.stateRevision }))!;
    expect(task.runs.at(-1)?.verdict?.classification).toBe("VIOLATION");
    expect(task.runs.at(-1)?.verdict?.detectedViolations.join(" ")).toContain(
      "command history does not exactly match",
    );
  });

  it("combines multiple complete producer-bound validation batches without weakening check identity", async () => {
    let task = await createApprovedRun(verified, "multi-validation-producer");
    task = await submitJsonReport(task, "Multiple trusted validation producers integration report.");
    const checkIds = trustedProducerCheckIds(task.contract!);
    const groups = [checkIds.filter((_, index) => index % 2 === 0), checkIds.filter((_, index) => index % 2 === 1)]
      .filter(group => group.length > 0);
    for (const [groupIndex, group] of groups.entries()) {
      const batchId = randomUUID();
      const producer = groupIndex === 0 ? backendProducer() : ownerRuntimeProducer;
      for (const [sequence, checkId] of group.entries()) {
        const run = task.runs.at(-1)!;
        task = (await recordValidationEvidence(run.id, {
          expectedRevision: run.stateRevision,
          checkId,
          status: "PASS",
          details: `Trusted producer ${producer.producerType} passed ${checkId}.`,
          batchId,
          sequence,
          sequenceTotal: group.length,
          isTerminal: sequence === group.length - 1,
        }, producer))!;
      }
    }
    task = await recordNoCommandTrace(task);
    const run = task.runs.at(-1)!;
    task = (await evaluateRun(run.id, { expectedRevision: run.stateRevision }))!;
    const multiProducerVerdict = task.runs.at(-1)?.verdict;
    expect(multiProducerVerdict?.classification, JSON.stringify(multiProducerVerdict, null, 2)).toBe("PASS");
  });

  it("rejects replay of the same signed producer request ID", async () => {
    let task = await createApprovedRun(verified, "signed-request-replay");
    task = await submitJsonReport(task, "Signed request replay integration report.");
    const checkIds = trustedProducerCheckIds(task.contract!);
    expect(checkIds.length).toBeGreaterThan(1);
    const batchId = randomUUID();
    const producer = signedHarnessProducer();
    let run = task.runs.at(-1)!;
    task = (await recordValidationEvidence(run.id, {
      expectedRevision: run.stateRevision,
      checkId: checkIds[0],
      status: "PASS",
      details: `Signed harness validation passed for ${checkIds[0]}.`,
      batchId,
      sequence: 0,
      sequenceTotal: checkIds.length,
      isTerminal: false,
    }, producer))!;
    run = task.runs.at(-1)!;
    await expect(recordValidationEvidence(run.id, {
      expectedRevision: run.stateRevision,
      checkId: checkIds[1],
      status: "PASS",
      details: `Replayed signed request attempted to pass ${checkIds[1]}.`,
      batchId,
      sequence: 1,
      sequenceTotal: checkIds.length,
      isTerminal: checkIds.length === 2,
    }, producer)).rejects.toMatchObject({ code: "TRUSTED_PRODUCER_REPLAY", status: 409 });
  });

  it("does not trust signed-harness validation after its immutable receipt is missing", async () => {
    let task = await createApprovedRun(verified, "signed-receipt-missing");
    task = await submitJsonReport(task, "Signed receipt deletion integration report.");
    const checkIds = trustedProducerCheckIds(task.contract!);
    const batchId = randomUUID();
    const requestIds: string[] = [];
    for (const [sequence, checkId] of checkIds.entries()) {
      const run = task.runs.at(-1)!;
      const producer = signedHarnessProducer();
      requestIds.push(producer.requestId!);
      task = (await recordValidationEvidence(run.id, {
        expectedRevision: run.stateRevision,
        checkId,
        status: "PASS",
        details: `Signed harness validation passed for ${checkId}.`,
        batchId,
        sequence,
        sequenceTotal: checkIds.length,
        isTerminal: sequence === checkIds.length - 1,
      }, producer))!;
    }
    task = await recordNoCommandTrace(task);
    const run = task.runs.at(-1)!;
    await databaseQuery(
      "delete from intentchord.trusted_producer_receipts where request_id=$1",
      [requestIds[0]],
    );
    task = (await evaluateRun(run.id, { expectedRevision: run.stateRevision }))!;
    expect(task.runs.at(-1)?.verdict?.classification).toBe("EVIDENCE_REQUIRED");
    expect(task.runs.at(-1)?.verdict?.evidenceGaps.join(" ")).toContain("unauthenticated, replay-unbound");
  });

  it("classifies persisted tool-trace hash tampering as a governance VIOLATION", async () => {
    let task = await createApprovedRun(verified, "trace-integrity-tamper");
    task = await submitJsonReport(task, "Trusted trace integrity tamper integration report.");
    const requiredCheckIds = trustedProducerCheckIds(task.contract!);
    task = await recordValidationBatch(task, requiredCheckIds);
    task = await recordNoCommandTrace(task);
    const run = task.runs.at(-1)!;
    await databaseQuery(
      `update intentchord.tool_trace_events
       set event_sha256=repeat('0',64)
       where id=(select id from intentchord.tool_trace_events where run_id=$1 order by sequence,id limit 1)`,
      [run.id],
    );
    task = (await evaluateRun(run.id, { expectedRevision: run.stateRevision }))!;
    expect(task.runs.at(-1)?.verdict?.classification).toBe("VIOLATION");
    expect(task.runs.at(-1)?.verdict?.detectedViolations.join(" ")).toContain("event-integrity verification");
  });

  it("classifies persisted trusted-evidence hash tampering as a governance VIOLATION", async () => {
    let task = await createApprovedRun(verified, "validation-integrity-tamper");
    task = await submitJsonReport(task, "Trusted validation integrity tamper integration report.");
    const requiredCheckIds = trustedProducerCheckIds(task.contract!);
    task = await recordValidationBatch(task, requiredCheckIds);
    task = await recordNoCommandTrace(task);
    const run = task.runs.at(-1)!;
    await databaseQuery(
      `update intentchord.validation_evidence
       set payload_sha256=repeat('0',64), integrity_sha256=repeat('0',64)
       where id=(select id from intentchord.validation_evidence where run_id=$1 order by captured_at,id limit 1)`,
      [run.id],
    );
    task = (await evaluateRun(run.id, { expectedRevision: run.stateRevision }))!;
    expect(task.runs.at(-1)?.verdict?.classification).toBe("VIOLATION");
    expect(task.runs.at(-1)?.verdict?.detectedViolations.join(" ")).toContain("payload-integrity verification");
  });

  it("rejects validation batch gaps and duplicate required-check replay", async () => {
    let task = await createApprovedRun(verified, "batch-adversarial");
    task = await submitJsonReport(task, "Batch adversarial integration report.");
    const run = task.runs.at(-1)!;
    const checkId = trustedProducerCheckIds(task.contract!)[0];
    const batchId = randomUUID();
    await expect(recordValidationEvidence(run.id, {
      expectedRevision: run.stateRevision,
      checkId,
      status: "PASS",
      details: "Out-of-order batch row must fail.",
      batchId,
      sequence: 1,
      sequenceTotal: 2,
      isTerminal: true,
    }, backendProducer())).rejects.toMatchObject({ status: 409, code: "VALIDATION_BATCH_SEQUENCE_GAP" });

    task = (await recordValidationEvidence(run.id, {
      expectedRevision: run.stateRevision,
      checkId,
      status: "PASS",
      details: "First valid row.",
      batchId,
      sequence: 0,
      sequenceTotal: 2,
      isTerminal: false,
    }, backendProducer()))!;
    const current = task.runs.at(-1)!;
    await expect(recordValidationEvidence(current.id, {
      expectedRevision: current.stateRevision,
      checkId,
      status: "PASS",
      details: "Duplicate check replay must fail.",
      batchId,
      sequence: 1,
      sequenceTotal: 2,
      isTerminal: true,
    }, backendProducer())).rejects.toMatchObject({ status: 409, code: "VALIDATION_CHECK_REPLAY" });
  });

  it("does not reduce a compound read-plus-network command to an authorized read capability", async () => {
    let task = await createApprovedRun(verified, "trace-compound-command");
    const command = "Get-Content src/server/lifecycle.ts; Invoke-WebRequest https://example.invalid";
    const initialRun = task.runs.at(-1)!;
    const report = reportFor(task, "Compound command classification integration report.");
    report.commands = [{
      command,
      purpose: "A compound command must not be silently classified as only readFiles.",
      exitCode: 0,
    }];
    task = (await submitRawReport(
      initialRun.id,
      Buffer.from(JSON.stringify(report), "utf8"),
      "application/json",
      initialRun.stateRevision ?? 0,
    ))!;
    const run = task.runs.at(-1)!;
    await expect(recordToolTrace(run.id, {
      expectedRevision: run.stateRevision,
      batchId: randomUUID(),
      sequence: 0,
      sequenceTotal: 1,
      isTerminal: true,
      command,
      authorizationResult: "AUTHORIZED",
      occurredAt: new Date().toISOString(),
    }, ownerRuntimeProducer)).rejects.toMatchObject({
      status: 422,
      code: "TRACE_AUTHORIZATION_MISMATCH",
    });
  });

  it("rejects a tool-trace batch whose timestamps move backwards", async () => {
    let task = await createApprovedRun(verified, "trace-time-order");
    task = await submitJsonReport(task, "Tool-trace timestamp ordering integration report.");
    const batchId = randomUUID();
    const firstOccurredAt = new Date().toISOString();
    let run = task.runs.at(-1)!;
    task = (await recordToolTrace(run.id, {
      expectedRevision: run.stateRevision,
      batchId,
      sequence: 0,
      sequenceTotal: 2,
      isTerminal: false,
      command: "Get-Content src/server/lifecycle.ts",
      authorizationResult: "AUTHORIZED",
      occurredAt: firstOccurredAt,
    }, ownerRuntimeProducer))!;

    const firstEvent = await databaseQuery(
      "select event_sha256 from intentchord.tool_trace_events where run_id=$1 and batch_id=$2 and sequence=0",
      [run.id, batchId],
    );
    run = task.runs.at(-1)!;
    await expect(recordToolTrace(run.id, {
      expectedRevision: run.stateRevision,
      batchId,
      sequence: 1,
      sequenceTotal: 2,
      isTerminal: true,
      command: "Get-Content src/server/schemas.ts",
      authorizationResult: "AUTHORIZED",
      occurredAt: new Date(Date.parse(firstOccurredAt) - 1000).toISOString(),
      previousEventSha256: firstEvent.rows[0].event_sha256,
    }, ownerRuntimeProducer)).rejects.toMatchObject({
      status: 422,
      code: "TOOL_TRACE_TIME_INVALID",
    });
  });

  it("consumes one correction decision exactly once and inherits only trusted satisfied checks", async () => {
    let task = await createApprovedRun(verified, "correction");
    task = await submitJsonReport(task, "Correction integration report.");
    const firstCheck = trustedProducerCheckIds(task.contract!)[0];
    task = await recordValidationBatch(task, [firstCheck]);
    task = await recordNoCommandTrace(task);
    let parent = task.runs.at(-1)!;
    task = (await evaluateRun(parent.id, { expectedRevision: parent.stateRevision }))!;
    expect(task.runs.at(-1)?.verdict?.classification).toBe("EVIDENCE_REQUIRED");
    parent = task.runs.at(-1)!;
    task = (await recordOwnerDecision(parent.id, {
      expectedRevision: parent.stateRevision,
      decisionType: "CORRECTION_REQUESTED",
      reason: "Complete the unresolved trusted checks without repeating inherited proof.",
    }))!;
    parent = task.runs.at(-1)!;
    await expect(createRun(task.id, {
      expectedRevision: task.revision,
      locale: "en",
      executionType: "INITIAL",
      source: "IMPORTED_REPORT",
    })).rejects.toMatchObject({ status: 409, code: "CORRECTION_REQUIRED" });
    task = (await startCorrection(parent.id, {
      expectedRevision: parent.stateRevision,
      locale: "en",
    }))!;
    const child = task.runs.at(-1)!;
    expect(child.parentRunId).toBe(parent.id);
    expect(child.bindingMarker).not.toBe(parent.bindingMarker);
    const inherited = await databaseQuery(
      "select check_id from intentchord.inherited_validation_evidence where run_id=$1",
      [child.id],
    );
    expect(inherited.rows.map(row => row.check_id)).toContain(firstCheck);
    expect(inherited.rows.map(row => row.check_id)).not.toContain("contract-validation");
    task = await submitJsonReport(task, "Correction child report must not replay inherited validation.");
    const reportReceivedChild = task.runs.at(-1)!;
    await expect(recordValidationEvidence(reportReceivedChild.id, {
      expectedRevision: reportReceivedChild.stateRevision,
      checkId: firstCheck,
      status: "PASS",
      details: "An inherited trusted check must not be resubmitted by the correction child.",
      batchId: randomUUID(),
      sequence: 0,
      sequenceTotal: 1,
      isTerminal: true,
    }, backendProducer())).rejects.toMatchObject({
      status: 409,
      code: "INHERITED_VALIDATION_CHECK_ALREADY_SATISFIED",
    });
    await expect(startCorrection(parent.id, {
      expectedRevision: parent.stateRevision,
      locale: "en",
    })).rejects.toMatchObject({ status: 409 });
  });

  it("enforces append-only audit records at the database boundary", async () => {
    const task = (await createTask({ draft: draftFor(verified, "audit") }))!;
    const event = await databaseQuery(
      "select id from intentchord.audit_events where related_task_id=$1 order by created_at desc limit 1",
      [task.id],
    );
    await expect(databaseQuery(
      "update intentchord.audit_events set metadata='{}'::jsonb where id=$1",
      [event.rows[0].id],
    )).rejects.toThrow(/INTENTCHORD_AUDIT_APPEND_ONLY/);
    await expect(databaseQuery(
      "delete from intentchord.audit_events where id=$1",
      [event.rows[0].id],
    )).rejects.toThrow(/INTENTCHORD_AUDIT_APPEND_ONLY/);
  });

  it("keeps the authoritative event history linked to governing transitions", async () => {
    const task = await createApprovedRun(verified, "history");
    const history = await readTaskHistory(task.id);
    expect(history.map(event => event.eventType)).toEqual(expect.arrayContaining([
      "TASK_CREATED",
      "CONTRACT_RESOLVED",
      "CONTRACT_APPROVED",
      "RUN_CREATED",
      "CONTRACT_DELIVERED",
    ]));
  });
});

import type {
  AgentResolution,
  AuthorizationCapability,
  ExecutionContract,
} from "@/core/contracts/execution-contract";
import {
  modelRegistry,
  providerRegistry,
  runtimeProfileForProvider,
  type ExecutionChannelId,
  type ModelId,
  type ProviderId,
  type ReasoningProfile,
  type RuntimeProfileId,
} from "@/core/providers/registry";
import type { TaskSemanticProfile } from "@/core/tasks/semantic-profile";

const supported: AuthorizationCapability[] = [
  "readFiles",
  "modifySource",
  "runStaticValidation",
  "runTests",
  "build",
];

const channelContext: Record<ExecutionChannelId, string[]> = {
  CODEX: [
    "Open the approved workspace before any read or command.",
    "Preserve the same Codex thread and repository context for this run.",
    "Read applicable AGENTS.md, overrides, and skills once; do not repeat broad repository scans.",
  ],
  CLAUDE_CODE: [
    "Open the approved workspace before any read or command.",
    "Use the approved CLAUDE.md and project settings only as supporting context for this bounded outcome.",
    "Keep the same task and repository context until this run stops or completes.",
  ],
  GEMINI_CLI: [
    "Open the approved workspace before any read or command.",
    "Reference the stable IntentChord workspace governance and resolve the on-demand task skill before executing the compact run-bound contract.",
    "Keep the final instruction and each search episode explicit and bounded.",
  ],
};

const behaviorControls: Record<ExecutionChannelId, string[]> = {
  CODEX: [
    "Execute one bounded /goal for the approved outcome.",
    "Use the Context Lease as the only authoritative run context.",
    "Do not restart discovery from the repository root after the relevant path or symbol is known.",
    "Record exact paths, symbols, commands, and evidence for every material conclusion.",
  ],
  CLAUDE_CODE: [
    "Implement or review only the approved outcome.",
    "Treat adjacent refactoring, redesign, renaming, and unsolicited improvements as out of scope.",
    "Present optional improvements separately; do not implement them without a new owner decision.",
    "Prefer the smallest coherent change, not a broad cleanup and not a textual patch that leaves the root cause unresolved.",
  ],
  GEMINI_CLI: [
    "Perform the investigation as explicit ordered steps in the exact order supplied.",
    "Do not skip, merge, substitute, or infer a step, file, identity, or missing value.",
    "Do not inspect a different path when an approved path is unavailable; classify the gap as EVIDENCE_REQUIRED.",
    "State NOT_PROVEN instead of filling an evidence gap with an assumption.",
    "Gemini CLI or Antigravity is not final acceptance authority; preserve the deterministic owner-decision boundary.",
  ],
};

function boundedGoal(channel: ExecutionChannelId, task: TaskSemanticProfile, objective: string, approvedEvidenceCount: number): string {
  const action = task.taskClass === "REPORT_REVIEW"
    ? `Verify the material claims for: ${objective}`
    : task.taskClass === "CONTROLLED_AUDIT"
      ? `Establish evidence-backed findings for: ${objective}`
      : `Prove the root cause and deliver the approved coherent implementation for: ${objective}`;
  const boundary = task.taskClass === "SOURCE_IMPLEMENTATION"
    ? "without broadening scope or changing unrelated source"
    : task.taskClass === "CONTROLLED_AUDIT"
      ? "without modifying source or expanding beyond the approved authority boundary"
      : approvedEvidenceCount > 0
        ? "without modifying source or expanding beyond the approved report, scope, and supporting evidence"
        : "without modifying source or expanding beyond the approved report and scope";
  return channel === "CODEX" ? `/goal ${action}, ${boundary}.` : `${action}, ${boundary}.`;
}

function investigationStrategy(
  task: TaskSemanticProfile,
  effective: ExecutionContract["authorization"],
  approvedEvidenceCount: number,
): string[] {
  if (task.taskClass === "REPORT_REVIEW") {
    return [
      "Read the report or claim set identified by the objective before opening supporting evidence.",
      "Extract each material claim that can be proven, contradicted, or left unresolved.",
      ...(approvedEvidenceCount > 0
        ? ["For each claim, select only the approved evidence path needed to test it."]
        : ["When no supporting evidence is approved, do not invent it; classify claims that cannot be established from the report and approved scope as EVIDENCE_REQUIRED."]),
      "Classify every claim as PROVEN, UNSUPPORTED, CONTRADICTED, or EVIDENCE_REQUIRED.",
      "Stop when a required source is missing, outside scope, or bound to a different identity.",
    ];
  }

  if (task.taskClass === "CONTROLLED_AUDIT") {
    const steps = [
      "Begin at the approved Workspace roots and use targeted symbol, route, DTO, field, and configuration searches derived from the objective.",
      "Identify the minimum relevant entry points without requiring the Owner to pre-identify root-cause files.",
      "Trace the relevant call path, policy path, or evidence chain without editing source.",
      "After relevant paths are known, narrow the investigation and do not repeat broad Workspace scans.",
      "Record the exact discovered paths and source evidence before forming each finding.",
    ];
    if (effective.runStaticValidation) steps.push("Run only the approved static validation after the evidence path is established.");
    if (effective.runTests) steps.push("Run only the approved tests that directly validate the bounded finding.");
    if (effective.build) steps.push("Run the approved build only after the audit evidence requires that gate.");
    steps.push("Report findings and gaps; do not repair source in audit mode.");
    return steps;
  }

  const steps = [
    "Identify the minimum approved entry points relevant to the stated defect or outcome.",
    "Trace the complete in-scope dependency path and prove the root cause before editing.",
    "Define one coherent change boundary that preserves the existing architecture and owner decisions.",
  ];
  if (effective.modifySource) steps.push("Apply the approved coherent source change only inside that boundary.");
  if (effective.runStaticValidation) steps.push("Run the approved static validation and record the exact result.");
  if (effective.runTests) steps.push("Run the approved regression tests and record the exact result.");
  if (effective.build) steps.push("Run the approved build and record the exact result.");
  steps.push("Review the complete in-scope diff and report any remaining evidence gap without inventing closure.");
  return steps;
}

function validationWorkflow(effective: ExecutionContract["authorization"]): string[] {
  const validation: string[] = [];
  if (effective.runStaticValidation) validation.push("Record the approved static-validation command, exit code, and result.");
  if (effective.runTests) validation.push("Record the approved test command, exit code, and result.");
  if (effective.build) validation.push("Record the approved build command, exit code, and result.");
  if (!validation.length) validation.push("Do not run validation commands that are not effective under this contract.");
  return validation;
}

export function resolveAgentContract(input: {
  providerId: ProviderId;
  modelId: ModelId;
  executionChannelId: ExecutionChannelId;
  reasoningProfile: ReasoningProfile;
  runtimeProfileId: RuntimeProfileId;
  taskMode: ExecutionContract["taskMode"];
  objective: string;
  taskSemanticProfile: TaskSemanticProfile;
  effectiveAuthorization: ExecutionContract["authorization"];
  approvedEvidenceCount: number;
}): AgentResolution {
  const model = modelRegistry[input.modelId];
  const provider = providerRegistry[input.providerId];
  const runtime = runtimeProfileForProvider(input.runtimeProfileId, input.providerId);
  const effective = (Object.entries(input.effectiveAuthorization) as [AuthorizationCapability, boolean][])
    .filter(([, value]) => value)
    .map(([capability]) => capability);
  const unsupported = effective.filter(capability => !supported.includes(capability));
  const strategy = investigationStrategy(input.taskSemanticProfile, input.effectiveAuthorization, input.approvedEvidenceCount);

  const taskGuidance = input.taskSemanticProfile.taskClass === "REPORT_REVIEW"
    ? ["Compare claims with approved evidence and preserve the distinction between absence of evidence and contradiction."]
    : input.taskSemanticProfile.taskClass === "CONTROLLED_AUDIT"
      ? ["Assess evidence sufficiency and validation breadth without taking repair authority."]
      : ["Prove root cause, preserve scope, and validate one coherent implementation rather than a symptom patch."];

  return {
    profileId: input.executionChannelId,
    profileVersion: "0.3",
    providerId: input.providerId,
    modelId: input.modelId,
    modelDisplayName: model.displayName,
    executionChannelId: input.executionChannelId,
    executionChannelName: provider.executionChannelName,
    reasoningProfile: input.reasoningProfile,
    runtimeProfileId: input.runtimeProfileId,
    runtimeProfileName: runtime.displayName,
    taskSkill: {
      id: input.taskMode === "SOURCE_IMPLEMENTATION" ? "intentchord-source-implementation" : input.taskMode === "REPORT_REVIEW" ? "intentchord-report-review" : "intentchord-controlled-audit",
      version: "1.0",
      taskClass: input.taskMode,
    },
    runtimeGuidance: runtime.guidance,
    supportedCapabilities: supported,
    unsupportedEffectiveCapabilities: unsupported,
    boundedGoal: boundedGoal(input.executionChannelId, input.taskSemanticProfile, input.objective, input.approvedEvidenceCount),
    contextRules: channelContext[input.executionChannelId],
    behaviorControls: behaviorControls[input.executionChannelId],
    investigationStrategy: strategy,
    modelGuidance: [...taskGuidance, ...model.guidance.slice(0, 1)],
    executionWorkflow: strategy,
    validationWorkflow: validationWorkflow(input.effectiveAuthorization),
    reportInstructions: [
      "Return concise structured Markdown by default using every canonical IntentChord header and [IC-SECTION:<id>] heading exactly as supplied by the executable contract.",
      "A complete mandatory final report is required before run closure; a progress-only final response is forbidden.",
      "The final report must contain one execution terminal state, one executor classification, one evidence mapping, and one exact next action; report readiness is separate from the deterministic verdict and never means PASS.",
      "For each mandatory requirement, provide a requirement-to-proof row covering actual source behavior, positive proof, applicable negative/adversarial proof, persistence or reload proof, and the claimed classification.",
      "Emit exactly one [IC-REQUIREMENT-PROOF] structured row for every mandatory requirement ID; do not merge, omit, rename, or self-declare a requirement PASS when a required proof category has no trusted reference.",
      "A source route, DTO, policy, or function may support a source finding only when cited as exact SOURCE_EVIDENCE with its workspace-relative path, symbol or line range, and content hash; it cannot prove runtime behavior.",
      "Artifact identity requires ARTIFACT_EVIDENCE, executed checks require trusted VALIDATION_EVIDENCE, and runtime behavior requires run-bound RUNTIME_EVIDENCE. Authorization boundaries are not independent proof, and executor claims are not independent proof.",
      "Exercise applicable malformed-input, stale-revision, replay, duplicate-transition, bypass, spoofing, reload, supersede, and negative-path tests before claiming a trust invariant PASS.",
      "Report readiness is separate from the verdict and does not mean PASS; any missing applicable proof requires EVIDENCE_REQUIRED or a stricter classification.",
      "Place the exact IntentChord Binding marker and all governed Run/profile fields supplied by the executable contract in the report header.",
      "Use the optional JSON automation template only when the owner explicitly enables JSON mode.",
      "Never claim owner acceptance and never copy the executor classification into the deterministic verdict.",
      ...(input.taskMode === "REPORT_REVIEW" && input.approvedEvidenceCount === 0
        ? ["When no supporting evidence is approved, state that independent corroboration is unavailable and do not upgrade unsupported claims to PASS."]
        : input.taskMode === "CONTROLLED_AUDIT" && input.approvedEvidenceCount === 0
          ? ["Begin from the authorized discovery/read scope, extract the actual evidence you inspect, and cite it in the report. Do not require the owner to pre-identify a separate evidence path."]
          : []),
    ],
    reportBindingPolicy: {
      mode: "REQUIRED",
      markerPlacement: "MARKDOWN_HEADER",
      semanticAlignmentRequired: true,
    },
    stopConditions: [
      "HARD_EXECUTION_BLOCKER: stop only for missing authority or credentials, an owner scope conflict, an unauthorized or destructive action, corrupt workspace state, protected external-database risk, unresolved concurrent owner changes, unavailable required evidence, unresolved owner decision, report/run identity mismatch, or execution configuration mismatch.",
      input.taskMode === "CONTROLLED_AUDIT"
        ? "VALIDATION_GATE_FAILURE: record the proven failure separately and continue the remaining authorized audit and source inspection; do not repair source."
        : input.taskMode === "REPORT_REVIEW"
          ? "VALIDATION_GATE_FAILURE: record the proven failure separately and continue the remaining authorized report and evidence review."
          : "VALIDATION_GATE_FAILURE: record the proven failure separately and continue the remaining authorized source implementation.",
      input.taskMode === "CONTROLLED_AUDIT"
        ? "TOOL_OR_RUNNER_TIMEOUT: record an inconclusive timeout as EVIDENCE_REQUIRED, continue remaining authorized audit work, and request a bounded rerun with captured output."
        : "TOOL_OR_RUNNER_TIMEOUT: record an inconclusive timeout as EVIDENCE_REQUIRED, continue remaining authorized work, and request a bounded rerun with captured output.",
      "Do not perform any capability that is not effective under the contract.",
      "Do not continue when the Context Lease fingerprint, workspace fingerprint, or report binding marker differs from the active run.",
    ],
  };
}

export function agentBehaviorProfile(channel: ExecutionChannelId) {
  return {
    contextRules: [...channelContext[channel]],
    behaviorControls: [...behaviorControls[channel]],
  };
}

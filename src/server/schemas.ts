import { z } from "zod/v3";
import {
  executionChannelIds,
  modelIds,
  providerIds,
  reasoningProfiles,
  runtimeProfileIds,
} from "@/core/providers/registry";
import { aiAdapterIds } from "@/core/providers/ai-role-routing";
import {
  discoveryFindingInputSchema,
  discoveryScopeExpansionSchema,
} from "@/core/discovery/discovery-schema";

import { localRelativePathKey } from "@/core/workspace-index/local-path-semantics";

const boundedText = (minimum: number, maximum: number) =>
  z.string().trim().min(minimum).max(maximum);

const scopePathSchema = boundedText(1, 1024).superRefine((value, context) => {
  const normalized = value.replaceAll("\\", "/");
  if (
    normalized.startsWith("/")
    || /^[A-Za-z]:\//.test(normalized)
    || normalized.split("/").includes("..")
    || normalized.includes("\0")
  ) {
    context.addIssue({
      code: "custom",
      message: "Scope paths must be relative, normalized, and cannot contain parent traversal.",
    });
  }
});

const workspaceReferenceSourceSchema = z.enum([
  "WINDOWS_NATIVE_SELECTOR",
  "MANUAL_VERIFIED",
  "MANUAL_UNVERIFIED",
  "REMOTE_CONNECTOR",
]);

const workspaceSourceSchema = z.enum([
  ...workspaceReferenceSourceSchema.options,
  "MIXED",
]);


const taskContextSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("INDEPENDENT") }).strict(),
  z.object({
    kind: z.literal("PROJECT_BOUND"),
    projectContextId: z.string().uuid(),
    projectContextDisplayName: boundedText(1, 160),
    projectContextRevision: z.number().int().nonnegative(),
  }).strict(),
]);


const ownerRequirementSchema = z.object({
  id: boundedText(1, 120).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/),
  outcome: boundedText(3, 5000),
  requiredEvidenceTypes: z.array(z.enum(["SOURCE", "ARTIFACT", "VALIDATION", "RUNTIME"]))
    .min(1).max(4).optional(),
  proofProfile: z.object({
    sourceBehavior: z.boolean(),
    positive: z.boolean(),
    negativeAdversarial: z.boolean(),
    persistenceReload: z.boolean(),
  }).strict(),
}).strict();

const workspaceDraftSchema = z.object({
  id: z.string().uuid(),
  displayName: boundedText(1, 160),
  role: boundedText(1, 80),
  referenceType: z.literal("LOCAL_PATH"),
  source: workspaceReferenceSourceSchema,
  reference: boundedText(1, 2048),
  repositoryIdentity: boundedText(1, 512).optional(),
  branch: boundedText(1, 512).optional(),
  commitSha: z.string().trim().regex(/^[0-9a-f]{7,64}$/i).optional(),
  fingerprint: boundedText(1, 256),
  provenance: boundedText(1, 4096).optional(),
  discoveryScopeMode: z.enum(["FULL_WORKSPACE", "SELECTED_PATHS", "NONE"]).optional(),
  allowedPaths: z.array(scopePathSchema).max(500),
  excludedPaths: z.array(scopePathSchema).max(500),
  authorizationContext: boundedText(1, 1000),
  ordering: z.number().int().nonnegative().max(999),
}).strict().superRefine((workspace, context) => {
  const discoveryScopeMode = workspace.discoveryScopeMode
    ?? (workspace.allowedPaths.length > 0 ? "SELECTED_PATHS" : "FULL_WORKSPACE");
  if (discoveryScopeMode === "SELECTED_PATHS" && workspace.allowedPaths.length === 0) {
    context.addIssue({
      code: "custom",
      path: ["allowedPaths"],
      message: "Selected-path discovery requires at least one approved relative path.",
    });
  }
  if (discoveryScopeMode !== "SELECTED_PATHS" && workspace.allowedPaths.length > 0) {
    context.addIssue({
      code: "custom",
      path: ["allowedPaths"],
      message: "Only selected-path discovery may carry explicit allowed paths.",
    });
  }
  const allowed = new Set(workspace.allowedPaths.map(value => localRelativePathKey(value)));
  for (const excluded of workspace.excludedPaths) {
    if (allowed.has(localRelativePathKey(excluded))) {
      context.addIssue({
        code: "custom",
        path: ["excludedPaths"],
        message: "A workspace path cannot be both allowed and excluded.",
      });
    }
  }
});

export const taskContextAnalysisBindingSchema = z.object({
  workspaceIndexSnapshotId: z.string().uuid(),
  mappingRunId: z.string().uuid(),
  proposalId: z.string().uuid(),
  proposalSha256: z.string().regex(/^(?:sha256:)?[0-9a-f]{64}$/i),
  acceptedContextDecisionIds: z.array(z.string().uuid()).min(1),
}).strict().superRefine((binding, context) => {
  const seen = new Set<string>();
  for (const [index, id] of binding.acceptedContextDecisionIds.entries()) {
    if (seen.has(id)) {
      context.addIssue({
        code: "custom",
        path: ["acceptedContextDecisionIds", index],
        message: "Duplicate acceptedContextDecisionId is forbidden.",
      });
    }
    seen.add(id);
  }
});

export const taskContextAssemblyBindingSchema = z.object({
  contractVersion: z.literal("intentchord.context-assembly.v1"),
  contextAssemblyId: z.string().uuid(),
  contextAssemblyRevisionId: z.string().uuid(),
  contextAssemblyRevision: z.number().int().positive(),
  mappingIterationId: z.string().uuid(),
  closureEvaluationId: z.string().uuid(),
  acceptedCatalogRevisionId: z.string().uuid(),
  acceptedCatalogSha256: z.string().regex(/^(?:sha256:)?[0-9a-f]{64}$/i),
}).strict();

export const legacyTaskCandidateScopeEntrySchema = z.object({
  workspaceId: z.string().min(1),
  normalizedPath: scopePathSchema,
  contextId: boundedText(1, 200),
  evidenceEntryId: boundedText(1, 256),
}).strict();

export const contextAssemblyTaskCandidateScopeEntrySchema = z.object({
  workspaceId: z.string().min(1),
  normalizedPath: scopePathSchema,
  componentId: boundedText(1, 200),
  evidenceEntryId: boundedText(1, 256),
}).strict();

export const workspaceScopedPathSchema = z.object({
  workspaceId: z.string().min(1),
  path: scopePathSchema,
}).strict();

export const legacyTaskCandidateScopeIdentitySchema = z.object({
  authorityVersion: z.literal("MAPPING_V1").optional(),
  workspaceIndexSnapshotId: z.string().min(1),
  mappingRunId: z.string().min(1),
  proposalId: z.string().min(1),
  proposalSha256: z.string().regex(/^(?:sha256:)?[0-9a-f]{64}$/i),
  acceptedContextDecisionIdsSha256: z.string().regex(/^(?:sha256:)?[0-9a-f]{64}$/i),
  candidateScopeSha256: z.string().regex(/^(?:sha256:)?[0-9a-f]{64}$/i),
}).strict();

export const contextAssemblyCandidateScopeIdentitySchema = z.object({
  authorityVersion: z.literal("CONTEXT_ASSEMBLY_V2"),
  contextAssemblyId: z.string().uuid(),
  contextAssemblyRevisionId: z.string().uuid(),
  mappingIterationId: z.string().uuid(),
  closureEvaluationId: z.string().uuid(),
  acceptedCatalogRevisionId: z.string().uuid(),
  acceptedCatalogSha256: z.string().regex(/^(?:sha256:)?[0-9a-f]{64}$/i),
  selectedComponentIdsSha256: z.string().regex(/^(?:sha256:)?[0-9a-f]{64}$/i),
  candidateScopeSha256: z.string().regex(/^(?:sha256:)?[0-9a-f]{64}$/i),
}).strict();

export const taskCandidateScopeIdentitySchema = z.union([
  legacyTaskCandidateScopeIdentitySchema,
  contextAssemblyCandidateScopeIdentitySchema,
]);

export const taskCandidateScopeSchema = z.union([
  legacyTaskCandidateScopeIdentitySchema.extend({
    entries: z.array(legacyTaskCandidateScopeEntrySchema),
    candidateAllowedPaths: z.array(workspaceScopedPathSchema),
  }).strict(),
  contextAssemblyCandidateScopeIdentitySchema.extend({
    entries: z.array(contextAssemblyTaskCandidateScopeEntrySchema),
    candidateAllowedPaths: z.array(workspaceScopedPathSchema),
  }).strict(),
]);

export const taskScopeConfirmationSchema = z.object({
  candidateIdentity: taskCandidateScopeIdentitySchema,
  authorityInputSha256: z.string().regex(/^[0-9a-f]{64}$/i).optional(),
  confirmedAt: boundedText(1, 100),
  confirmedBy: boundedText(1, 160),
  confirmedAllowedPaths: z.array(workspaceScopedPathSchema).max(500),
  confirmedExcludedPaths: z.array(workspaceScopedPathSchema).max(500),
  rationale: z.string().trim().max(2000).optional(),
}).strict();

export const taskScopeConfirmationCommandSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  expectedCandidateIdentity: taskCandidateScopeIdentitySchema,
  confirmedAllowedPaths: z.array(workspaceScopedPathSchema).max(500),
  confirmedExcludedPaths: z.array(workspaceScopedPathSchema).max(500).default([]),
  rationale: z.string().trim().max(2000).optional(),
}).strict();

const legacyTaskWorkSelectionCommandSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  mappingRunId: z.string().uuid(),
  selectedContextIds: z.array(z.string().min(1).max(200)).min(1).max(500),
  note: z.string().trim().max(2000).optional(),
}).strict();

const contextAssemblyWorkSelectionCommandSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  acceptedCatalogRevisionId: z.string().uuid(),
  selectedComponentIds: z.array(z.string().min(1).max(200)).min(1).max(500),
  note: z.string().trim().max(2000).optional(),
}).strict();

export const taskWorkSelectionCommandSchema = z.union([legacyTaskWorkSelectionCommandSchema, contextAssemblyWorkSelectionCommandSchema]).superRefine((command, context) => {
  const values = "selectedComponentIds" in command ? command.selectedComponentIds : command.selectedContextIds;
  const seen = new Set<string>();
  for (const [index, id] of values.entries()) {
    if (seen.has(id)) context.addIssue({ code: "custom", path: ["selectedComponentIds" in command ? "selectedComponentIds" : "selectedContextIds", index], message: "Duplicate selected Work ID." });
    seen.add(id);
  }
});

export const taskExecutionPlatformCommandSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  executionChannelId: z.enum(executionChannelIds),
}).strict();

export const taskExecutionSetupSchema = z.object({
  providerId: z.enum(providerIds),
  modelId: z.enum(modelIds),
  executionChannelId: z.enum(executionChannelIds),
  reasoningProfile: z.enum(reasoningProfiles),
  runtimeProfileId: z.enum(runtimeProfileIds),
  modelOverrideAccepted: z.boolean().default(false),
  modelOverrideReason: z.string().trim().max(2000).optional(),
}).strict();

export const taskDraftSchema = z.object({
  orchestrationVersion: z.literal("UNIFIED_V1").optional(),
  title: boundedText(1, 160),
  titleManuallyEdited: z.boolean(),
  objective: boundedText(3, 20_000),
  ownerRequirements: z.array(ownerRequirementSchema).max(100).default([]),
  taskContext: taskContextSchema.default({ kind: "INDEPENDENT" }),
  taskMode: z.enum(["CONTROLLED_AUDIT", "SOURCE_IMPLEMENTATION", "REPORT_REVIEW"]),
  providerId: z.enum(providerIds).optional(),
  modelId: z.enum(modelIds).optional(),
  executionChannelId: z.enum(executionChannelIds).optional(),
  reasoningProfile: z.enum(reasoningProfiles).optional(),
  runtimeProfileId: z.enum(runtimeProfileIds).optional(),
  modelOverrideAccepted: z.boolean().optional(),
  modelOverrideReason: z.string().trim().max(2000).optional(),
  contextAnalysisBinding: taskContextAnalysisBindingSchema.optional(),
  contextAssemblyBinding: taskContextAssemblyBindingSchema.optional(),
  candidateScope: taskCandidateScopeSchema.optional(),
  scopeConfirmation: taskScopeConfirmationSchema.optional(),
  executionSetup: taskExecutionSetupSchema.optional(),
  workspaces: z.array(workspaceDraftSchema).min(0).max(20),
  workspaceRef: z.string().max(20_000),
  workspaceSource: workspaceSourceSchema,
  workspaceFingerprint: z.string().max(10_000),
  allowedPaths: z.array(z.string().max(2048)).max(10_000),
  excludedPaths: z.array(z.string().max(2048)).max(10_000),
  evidenceFiles: z.array(scopePathSchema).max(500),
  identity: z.string().trim().max(512),
  readFiles: z.boolean(),
  modifySource: z.boolean(),
  runStaticValidation: z.boolean(),
  runTests: z.boolean(),
  build: z.boolean(),
  deploy: z.boolean(),
  restartServices: z.boolean(),
  writeDatabase: z.boolean(),
  changeEnvironment: z.boolean(),
  useNetwork: z.boolean(),
}).strict().superRefine((draft, context) => {
  const requirementIds = new Set<string>();
  for (const [index, requirement] of draft.ownerRequirements.entries()) {
    const canonicalId = requirement.id.toUpperCase();
    if (requirementIds.has(canonicalId)) {
      context.addIssue({ code: "custom", path: ["ownerRequirements", index, "id"], message: "Duplicate mandatory requirement ID." });
    }
    requirementIds.add(canonicalId);
  }
  const ids = new Set<string>();
  const orderings = new Set<number>();
  for (const [index, workspace] of draft.workspaces.entries()) {
    if (ids.has(workspace.id)) {
      context.addIssue({ code: "custom", path: ["workspaces", index, "id"], message: "Duplicate Workspace ID." });
    }
    if (orderings.has(workspace.ordering)) {
      context.addIssue({ code: "custom", path: ["workspaces", index, "ordering"], message: "Duplicate Workspace ordering." });
    }
    ids.add(workspace.id);
    orderings.add(workspace.ordering);
  }
  if (draft.workspaces.some((workspace, index) => workspace.ordering !== index)) {
    context.addIssue({ code: "custom", path: ["workspaces"], message: "Workspace ordering must be contiguous and match array order." });
  }
  if (draft.readFiles && draft.workspaces.every(workspace =>
    (workspace.discoveryScopeMode
      ?? (workspace.allowedPaths.length > 0
        ? "SELECTED_PATHS"
        : draft.taskMode === "CONTROLLED_AUDIT"
          ? "FULL_WORKSPACE"
          : "NONE")) === "NONE"
  )) {
    context.addIssue({ code: "custom", path: ["workspaces"], message: "Read authority requires at least one Workspace discovery boundary." });
  }
  if (draft.modifySource && draft.workspaces.some(workspace =>
    (workspace.discoveryScopeMode
      ?? (workspace.allowedPaths.length > 0
        ? "SELECTED_PATHS"
        : draft.taskMode === "CONTROLLED_AUDIT"
          ? "FULL_WORKSPACE"
          : "NONE")) === "FULL_WORKSPACE"
  )) {
    context.addIssue({
      code: "custom",
      path: ["workspaces"],
      message: "Full-workspace discovery is read-only; source modification requires explicit selected paths.",
    });
  }
  if (draft.modelOverrideAccepted && (!draft.modelOverrideReason || draft.modelOverrideReason.length < 12)) {
    context.addIssue({
      code: "custom",
      path: ["modelOverrideReason"],
      message: "An explicit Owner override reason of at least 12 characters is required.",
    });
  }
});

export const contractInputSchema = taskDraftSchema.refine((draft): draft is z.infer<typeof taskDraftSchema> & {
  providerId: z.infer<typeof taskDraftSchema>["providerId"];
  modelId: z.infer<typeof taskDraftSchema>["modelId"];
} => {
  const hasDirect = Boolean(
    draft.providerId && draft.modelId && draft.executionChannelId && draft.reasoningProfile && draft.runtimeProfileId,
  );
  const hasSetup = Boolean(draft.executionSetup);
  return hasDirect || hasSetup;
}, {
  message: "Contract input requires complete execution setup (provider, model, channel, reasoning, runtime profile).",
  path: ["executionSetup"],
});

export const createTaskCommandSchema = z.object({
  draft: taskDraftSchema,
  requestedTaskId: z.string().uuid().optional(),
}).strict();
export const reviseTaskCommandSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  draft: taskDraftSchema,
}).strict();
export const resolveIntentCommandSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  locale: z.enum(["en", "ar"]).default("en"),
  plannerAdapterId: z.enum(aiAdapterIds).default("DETERMINISTIC_INTENT_BASELINE"),
  plannerProviderId: z.enum(providerIds),
  plannerModelId: z.enum(modelIds),
  plannerExecutionChannelId: z.enum(executionChannelIds),
}).strict();
export const confirmIntentCommandSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  expectedResolutionId: z.string().uuid(),
  expectedOutputSha256: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();

export const createDiscoveryRunCommandSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  locale: z.enum(["en", "ar"]).default("en"),
  discoveryAdapterId: z.enum(aiAdapterIds).default("DETERMINISTIC_BOUNDED_DISCOVERY"),
  discoveryProviderId: z.enum(providerIds),
  discoveryModelId: z.enum(modelIds),
  discoveryExecutionChannelId: z.enum(executionChannelIds),
}).strict();

export const submitDiscoveryFindingsCommandSchema = z.object({
  expectedStateRevision: z.number().int().nonnegative(),
  findings: z.array(discoveryFindingInputSchema).max(500).default([]),
  scopeExpansionRequests: z.array(discoveryScopeExpansionSchema).max(100).default([]),
}).strict();

export const completeDiscoveryRunCommandSchema = z.object({
  expectedStateRevision: z.number().int().nonnegative(),
}).strict();

export const resolveContractCommandSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  locale: z.enum(["en", "ar"]).default("en"),
}).strict();
export const approveContractCommandSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  expectedContentSha256: z.string().regex(/^[0-9a-f]{64}$/),
  approvalChannel: boundedText(1, 80).default("LOCAL_UI"),
}).strict();
export const compileContractCommandSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  locale: z.enum(["en", "ar"]).default("en"),
}).strict();
export const createRunCommandSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  locale: z.enum(["en", "ar"]).default("en"),
  executionType: z.literal("INITIAL").default("INITIAL"),
  source: z.literal("IMPORTED_REPORT").default("IMPORTED_REPORT"),
}).strict();
export const evaluateRunCommandSchema = z.object({ expectedRevision: z.number().int().nonnegative() }).strict();
export const ownerDecisionCommandSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  decisionType: z.enum(["ACKNOWLEDGED", "ACCEPTED", "ACCEPTED_WITH_OVERRIDE", "CORRECTION_REQUESTED", "REJECTED"]),
  reason: z.string().trim().max(5000).optional(),
}).strict();
export const startCorrectionCommandSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  locale: z.enum(["en", "ar"]).default("en"),
}).strict();

export const manualWorkspaceCommandSchema = z.object({
  displayName: boundedText(1, 160),
  role: boundedText(1, 80),
  referenceType: z.literal("LOCAL_PATH").default("LOCAL_PATH"),
  reference: boundedText(1, 2048),
  authorizationContext: boundedText(1, 1000),
}).strict();
export const selectWorkspaceCommandSchema = z.object({
  displayName: boundedText(1, 160),
  role: boundedText(1, 80),
  authorizationContext: boundedText(1, 1000),
  taskMode: z.enum(["CONTROLLED_AUDIT", "SOURCE_IMPLEMENTATION", "REPORT_REVIEW"]),
}).strict();

export const selectWorkspaceScopePathCommandSchema = z.object({
  selectionType: z.enum(["FOLDER", "FILE"]),
}).strict();
export const verifyWorkspaceCommandSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
}).strict();

export const validationEvidenceCommandSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  checkId: boundedText(1, 200),
  status: z.enum(["PASS", "FAIL", "EVIDENCE_REQUIRED"]),
  details: boundedText(8, 20_000),
  integritySha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  batchId: z.string().uuid(),
  sequence: z.number().int().nonnegative(),
  sequenceTotal: z.number().int().positive(),
  isTerminal: z.boolean(),
}).strict().superRefine((value, context) => {
  if (value.sequence >= value.sequenceTotal) {
    context.addIssue({ code: "custom", path: ["sequence"], message: "sequence must be lower than sequenceTotal." });
  }
  if (value.isTerminal !== (value.sequence === value.sequenceTotal - 1)) {
    context.addIssue({ code: "custom", path: ["isTerminal"], message: "Only the final sequence entry can be terminal." });
  }
});

export const toolTraceCommandSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  batchId: z.string().uuid(),
  sequence: z.number().int().nonnegative(),
  sequenceTotal: z.number().int().positive(),
  isTerminal: z.boolean(),
  command: boundedText(1, 20_000),
  capability: z.enum([
    "readFiles",
    "modifySource",
    "runStaticValidation",
    "runTests",
    "build",
    "deploy",
    "restartServices",
    "writeDatabase",
    "changeEnvironment",
    "useNetwork",
  ]).optional(),
  authorizationResult: z.enum(["AUTHORIZED", "UNAUTHORIZED", "UNKNOWN"]),
  occurredAt: z.string().datetime(),
  previousEventSha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
}).strict().superRefine((value, context) => {
  if (value.sequence >= value.sequenceTotal) {
    context.addIssue({ code: "custom", path: ["sequence"], message: "sequence must be lower than sequenceTotal." });
  }
  if (value.sequence === 0 && value.previousEventSha256) {
    context.addIssue({ code: "custom", path: ["previousEventSha256"], message: "The first trace event cannot have a previous hash." });
  }
  if (value.sequence > 0 && !value.previousEventSha256) {
    context.addIssue({ code: "custom", path: ["previousEventSha256"], message: "A chained trace event requires the previous event hash." });
  }
  if (value.isTerminal !== (value.sequence === value.sequenceTotal - 1)) {
    context.addIssue({ code: "custom", path: ["isTerminal"], message: "Only the final sequence entry can be terminal." });
  }
  if (
    value.command === "INTENTCHORD:NO_COMMANDS_EXECUTED"
    && (value.sequence !== 0 || value.sequenceTotal !== 1 || !value.isTerminal)
  ) {
    context.addIssue({
      code: "custom",
      path: ["command"],
      message: "The no-command attestation must be the only terminal event in its batch.",
    });
  }
});

const toolTraceBatchEventSchema = z.object({
  command: boundedText(1, 20_000),
  capability: z.enum([
    "readFiles",
    "modifySource",
    "runStaticValidation",
    "runTests",
    "build",
    "deploy",
    "restartServices",
    "writeDatabase",
    "changeEnvironment",
    "useNetwork",
  ]).optional(),
  authorizationResult: z.enum(["AUTHORIZED", "UNAUTHORIZED", "UNKNOWN"]),
  occurredAt: z.string().datetime(),
}).strict();

export const toolTraceBatchCommandSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  batchId: z.string().uuid(),
  events: z.array(toolTraceBatchEventSchema).min(1).max(1000),
}).strict().superRefine((value, context) => {
  const noCommandEvents = value.events.filter(event => event.command === "INTENTCHORD:NO_COMMANDS_EXECUTED");
  if (noCommandEvents.length && (value.events.length !== 1 || noCommandEvents.length !== 1)) {
    context.addIssue({
      code: "custom",
      path: ["events"],
      message: "The no-command attestation cannot be mixed with executed-command events.",
    });
  }
});


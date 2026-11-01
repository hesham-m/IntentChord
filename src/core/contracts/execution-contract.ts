import { z } from "zod/v3";
import { policyVersion, resolveAuthorization } from "@/core/policies/policy";
import {
  executionChannelIds,
  modelIds,
  modelRegistry,
  providerIds,
  providerRegistry,
  reasoningProfiles,
  runtimeProfileIds,
  runtimeProfileSupportsProvider,
} from "@/core/providers/registry";
import { recommendationStatuses } from "@/core/recommendations/engine";

export const classificationSchema = z.enum(["PASS", "BLOCKER", "VIOLATION", "EVIDENCE_REQUIRED"]);
export const taskModeSchema = z.enum(["CONTROLLED_AUDIT", "SOURCE_IMPLEMENTATION", "REPORT_REVIEW"]);
export const approvalStateSchema = z.enum(["DRAFT", "AWAITING_OWNER_APPROVAL", "APPROVED", "REJECTED", "CANCELLED"]);
export const authorizationCapabilitySchema = z.enum(["readFiles", "modifySource", "runStaticValidation", "runTests", "build", "deploy", "restartServices", "writeDatabase", "changeEnvironment", "useNetwork"]);
export const providerIdSchema = z.enum(providerIds);
export const modelIdSchema = z.enum(modelIds);
export const executionChannelIdSchema = z.enum(executionChannelIds);
export const reasoningProfileSchema = z.enum(reasoningProfiles);
export const runtimeProfileIdSchema = z.enum(runtimeProfileIds);
export const recommendationStatusSchema = z.enum(recommendationStatuses);
export const requiredCheckSatisfactionModeSchema = z.enum(["BACKEND_AUTOMATIC", "TRUSTED_PRODUCER"]);
export const evidenceIdentitySchema = z.object({
  runId: z.string().min(1).optional(),
  sessionId: z.string().min(1).optional(),
  releaseId: z.string().min(1).optional(),
  commitSha: z.string().min(1).optional(),
  processId: z.string().min(1).optional(),
  viewerId: z.string().min(1).optional(),
  utcWindow: z.object({ start: z.string().datetime(), end: z.string().datetime() }).optional(),
  unknownFields: z.array(z.string()).optional(),
}).strict();
export const authorizationSchema = z.object({
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
}).strict();
export const policyDecisionSchema = z.object({
  capability: authorizationCapabilitySchema,
  requested: z.boolean(),
  effective: z.boolean(),
  source: z.enum(["OWNER_SELECTION", "TASK_MODE_POLICY", "MVP_SYSTEM_POLICY"]),
  reason: z.string().min(1),
}).strict();
export const taskSemanticProfileSchema = z.object({
  profileVersion: z.literal("0.2"),
  taskClass: taskModeSchema,
  assessmentStatus: z.enum(["PRELIMINARY", "ASSESSED"]),
  complexity: z.enum(["NOT_ASSESSED", "LOW", "MEDIUM", "HIGH"]),
  crossFileDependency: z.enum(["NOT_ASSESSED", "YES", "NO"]),
  crossWorkspaceDependency: z.enum(["NOT_ASSESSED", "YES", "NO"]),
  routingComplexity: z.enum(["LOW", "MEDIUM", "HIGH"]),
  sourceModificationRequired: z.boolean(),
  runtimeEvidenceRequired: z.boolean(),
  validationDepth: z.enum(["EVIDENCE_ONLY", "STATIC", "TESTS", "BUILD"]),
  reasons: z.array(z.string().min(1)).min(1),
}).strict();
export const selectedConfigurationSchema = z.object({
  providerId: providerIdSchema,
  modelId: modelIdSchema,
  executionChannelId: executionChannelIdSchema,
  reasoningProfile: reasoningProfileSchema,
  runtimeProfileId: runtimeProfileIdSchema,
  ownerOverrideAccepted: z.boolean(),
  ownerOverrideReason: z.string().min(12).max(2000).optional(),
}).strict();
export const configurationRecommendationSchema = z.object({
  profileVersion: z.literal("0.2"),
  assessmentStatus: z.enum(["PRELIMINARY", "ASSESSED"]),
  status: recommendationStatusSchema,
  selectedModelId: modelIdSchema,
  recommendedModelId: modelIdSchema,
  reasons: z.array(z.string().min(1)).min(1),
  recommendedActions: z.array(z.string().min(1)).min(1),
  ownerOverrideAccepted: z.boolean(),
}).strict();
export const agentResolutionSchema = z.object({
  profileId: executionChannelIdSchema,
  profileVersion: z.literal("0.3"),
  providerId: providerIdSchema,
  modelId: modelIdSchema,
  modelDisplayName: z.string().min(1),
  executionChannelId: executionChannelIdSchema,
  executionChannelName: z.string().min(1),
  reasoningProfile: reasoningProfileSchema,
  runtimeProfileId: runtimeProfileIdSchema,
  runtimeProfileName: z.string().min(1),
  taskSkill: z.object({ id: z.string().min(1), version: z.string().min(1), taskClass: taskModeSchema }).strict(),
  runtimeGuidance: z.array(z.string().min(1)).min(1),
  supportedCapabilities: z.array(authorizationCapabilitySchema),
  unsupportedEffectiveCapabilities: z.array(authorizationCapabilitySchema),
  boundedGoal: z.string().min(1),
  contextRules: z.array(z.string().min(1)).min(1),
  behaviorControls: z.array(z.string().min(1)).min(1),
  investigationStrategy: z.array(z.string().min(1)).min(1),
  modelGuidance: z.array(z.string().min(1)).min(1),
  executionWorkflow: z.array(z.string().min(1)).min(1),
  validationWorkflow: z.array(z.string().min(1)).min(1),
  reportInstructions: z.array(z.string().min(1)).min(1),
  reportBindingPolicy: z.object({
    mode: z.literal("REQUIRED"),
    markerPlacement: z.literal("MARKDOWN_HEADER"),
    semanticAlignmentRequired: z.literal(true),
  }).strict(),
  stopConditions: z.array(z.string().min(1)).min(1),
}).strict();
export const executionContractSchema = z.object({
  schemaVersion: z.literal("0.2"),
  policyVersion: z.literal("0.2"),
  contractId: z.string().min(1),
  title: z.string().min(1),
  objective: z.string().min(3),
  taskMode: taskModeSchema,
  intentResolution: z.object({
    id: z.string().uuid(),
    revision: z.number().int().positive(),
    contentSha256: z.string().regex(/^[0-9a-f]{64}$/),
    normalizedTopic: z.string().min(1),
    ownerSummary: z.string().min(1),
    investigationQuestions: z.array(z.object({
      id: z.string().min(1),
      question: z.string().min(1),
    }).strict()).min(1),
    expectedConcepts: z.array(z.string().min(1)),
    unknowns: z.array(z.string().min(1)),
    forbiddenAssumptions: z.array(z.string().min(1)),
  }).strict().optional(),
  discoveryResolution: z.object({
    id: z.string().uuid(),
    outputSha256: z.string().regex(/^[0-9a-f]{64}$/),
    status: z.enum(["COMPLETED", "EVIDENCE_REQUIRED"]),
    completedAt: z.string().datetime(),
    assessment: z.object({
      assessmentStatus: z.literal("ASSESSED"),
      complexity: z.enum(["LOW", "MEDIUM", "HIGH"]),
      crossFileDependency: z.enum(["YES", "NO"]),
      crossWorkspaceDependency: z.enum(["YES", "NO"]),
      workspaceCount: z.number().int().positive(),
      candidateFileCount: z.number().int().nonnegative(),
      inspectedFileCount: z.number().int().nonnegative(),
      requirementCoverage: z.array(z.object({
        requirementId: z.string().min(1),
        discoveredItemCount: z.number().int().nonnegative(),
      }).strict()),
      reasons: z.array(z.string().min(1)).min(1),
    }).strict(),
    requirementPaths: z.array(z.object({
      requirementId: z.string().min(1),
      paths: z.array(z.string().min(1)),
      totalPathCount: z.number().int().nonnegative().optional(),
      omittedPathCount: z.number().int().nonnegative().optional(),
    }).strict()),
    evidenceGaps: z.array(z.string().min(1)),
  }).strict().optional(),
  executionPackage: z.object({
    governanceProfile: z.object({ id: z.literal("intentchord-stable-governance"), version: z.literal("1.0") }).strict(),
    mandatoryRequirements: z.array(z.object({
      id: z.string().min(1),
      outcome: z.string().min(1),
      evidence: z.array(z.string().min(1)).min(1),
      gate: z.string().min(1),
      requiredEvidenceTypes: z.array(z.enum(["SOURCE", "ARTIFACT", "VALIDATION", "RUNTIME"]))
        .min(1).max(4),
      proofProfile: z.object({
        sourceBehavior: z.boolean(),
        positive: z.boolean(),
        negativeAdversarial: z.boolean(),
        persistenceReload: z.boolean(),
      }).strict(),
    }).strict()).min(1),
    gates: z.array(z.object({ id: z.string().min(1), exitCriteria: z.array(z.string().min(1)).min(1) }).strict()).min(1),
    completionLock: z.object({ executionState: z.enum(["CONTINUE", "STOP_FOR_OWNER", "READY_FOR_FINAL_REPORT"]), rule: z.string().min(1) }).strict(),
  }).strict(),
  scope: z.object({
    workspaces: z.array(z.object({
      id: z.string().min(1), displayName: z.string().min(1), role: z.string().min(1),
      referenceType: z.enum(["LOCAL_PATH", "REMOTE_REFERENCE"]), source: z.enum(["WINDOWS_NATIVE_SELECTOR", "MANUAL_VERIFIED", "MANUAL_UNVERIFIED", "REMOTE_CONNECTOR"]), reference: z.string().min(1),
      repositoryIdentity: z.string().optional(), branch: z.string().optional(), commitSha: z.string().optional(),
      fingerprint: z.string().min(1), provenance: z.string().optional(), authorizationContext: z.string().min(1), ordering: z.number().int().nonnegative(),
      discoveryScopeMode: z.enum(["FULL_WORKSPACE", "SELECTED_PATHS", "NONE"]),
      effectiveReadBoundary: z.enum(["WORKSPACE_ROOT", "SELECTED_PATHS", "NONE"]),
      allowedPaths: z.array(z.string().min(1)), excludedPaths: z.array(z.string().min(1)),
    }).strict()).min(1),
    /** Derived compatibility fields for older report consumers. */
    workspaceRef: z.string(),
    workspaceSource: z.enum(["WINDOWS_NATIVE_SELECTOR", "MANUAL_VERIFIED", "MANUAL_UNVERIFIED", "REMOTE_CONNECTOR", "MIXED"]),
    workspaceFingerprint: z.string().min(1),
    allowedPaths: z.array(z.string().min(1)),
    excludedPaths: z.array(z.string().min(1)),
    evidenceFiles: z.array(z.string().min(1)),
    evidenceReadOnly: z.literal(true),
    normalization: z.object({
      removedRedundantEntries: z.array(z.string()),
      conflicts: z.array(z.string()),
    }).strict(),
  }).strict(),
  authorization: authorizationSchema,
  policyDecisionTrace: z.array(policyDecisionSchema).length(10),
  allowedActions: z.array(z.string().min(1)),
  forbiddenActions: z.array(z.string().min(1)),
  evidenceIdentity: evidenceIdentitySchema,
  evidenceIdentityState: z.enum(["NOT_ESTABLISHED", "BOUND", "INVALID", "MISMATCHED"]),
  taskSemanticProfile: taskSemanticProfileSchema,
  selectedConfiguration: selectedConfigurationSchema,
  configurationRecommendation: configurationRecommendationSchema,
  requiredChecks: z.array(z.object({
    id: z.string().min(1),
    description: z.string().min(1),
    required: z.boolean(),
    satisfactionMode: requiredCheckSatisfactionModeSchema.optional(),
  }).strict()).min(1),
  closureCriteria: z.array(z.object({ id: z.string().min(1), description: z.string().min(1), evidenceRequired: z.array(z.string().min(1)).min(1) }).strict()).min(1),
  stopConditions: z.array(z.string().min(1)).min(1),
  requiredReportSections: z.array(z.string().min(1)).min(1),
  ownerApproval: z.object({ required: z.literal(true), state: approvalStateSchema, approvedAt: z.string().datetime().optional() }).strict(),
  agentResolution: agentResolutionSchema,
}).strict().superRefine((contract, context) => {
  if (contract.policyVersion !== policyVersion) {
    context.addIssue({ code: "custom", message: "The contract must use the canonical Policy 0.2 version.", path: ["policyVersion"] });
  }
  const expected = resolveAuthorization(contract.taskMode, contract.authorization).trace;
  if (JSON.stringify(contract.policyDecisionTrace) !== JSON.stringify(expected)) {
    context.addIssue({ code: "custom", message: "The policy decision trace must be resolved by the canonical policy authority.", path: ["policyDecisionTrace"] });
  }
  const model = modelRegistry[contract.selectedConfiguration.modelId];
  const provider = providerRegistry[contract.selectedConfiguration.providerId];
  if (model.providerId !== contract.selectedConfiguration.providerId) {
    context.addIssue({ code: "custom", message: "The selected model must belong to the selected provider.", path: ["selectedConfiguration", "modelId"] });
  }
  if (provider.executionChannelId !== contract.selectedConfiguration.executionChannelId) {
    context.addIssue({ code: "custom", message: "The execution channel must match the selected provider.", path: ["selectedConfiguration", "executionChannelId"] });
  }
  if (!runtimeProfileSupportsProvider(contract.selectedConfiguration.runtimeProfileId, contract.selectedConfiguration.providerId)) {
    context.addIssue({ code: "custom", message: "The runtime profile must be supported by the selected provider.", path: ["selectedConfiguration", "runtimeProfileId"] });
  }
  if (
    contract.agentResolution.providerId !== contract.selectedConfiguration.providerId
    || contract.agentResolution.modelId !== contract.selectedConfiguration.modelId
    || contract.agentResolution.executionChannelId !== contract.selectedConfiguration.executionChannelId
    || contract.agentResolution.reasoningProfile !== contract.selectedConfiguration.reasoningProfile
    || contract.agentResolution.runtimeProfileId !== contract.selectedConfiguration.runtimeProfileId
  ) {
    context.addIssue({ code: "custom", message: "The resolved agent contract must match the selected provider, model, channel, reasoning profile, and runtime profile.", path: ["agentResolution"] });
  }
  if (contract.configurationRecommendation.selectedModelId !== contract.selectedConfiguration.modelId) {
    context.addIssue({ code: "custom", message: "The recommendation must evaluate the selected model.", path: ["configurationRecommendation", "selectedModelId"] });
  }
  const identityHasBoundValue = Boolean(
    contract.evidenceIdentity.runId
    || contract.evidenceIdentity.sessionId
    || contract.evidenceIdentity.releaseId
    || contract.evidenceIdentity.commitSha
    || contract.evidenceIdentity.processId
    || contract.evidenceIdentity.viewerId
    || contract.evidenceIdentity.utcWindow,
  );
  if (contract.evidenceIdentityState === "BOUND" && !identityHasBoundValue) {
    context.addIssue({
      code: "custom",
      message: "A BOUND evidence identity must contain at least one governed identity value.",
      path: ["evidenceIdentity"],
    });
  }
  if (contract.evidenceIdentityState === "NOT_ESTABLISHED" && Object.keys(contract.evidenceIdentity).length > 0) {
    context.addIssue({
      code: "custom",
      message: "A NOT_ESTABLISHED evidence identity must not project identity fields.",
      path: ["evidenceIdentity"],
    });
  }
});

export type RunClassification = z.infer<typeof classificationSchema>;
export type EvidenceIdentity = z.infer<typeof evidenceIdentitySchema>;
export type AuthorizationCapability = z.infer<typeof authorizationCapabilitySchema>;
export type AgentResolution = z.infer<typeof agentResolutionSchema>;
export type ExecutionContract = z.infer<typeof executionContractSchema>;
export type RequiredCheck = ExecutionContract["requiredChecks"][number];

export function requiredCheckSatisfactionMode(
  check: RequiredCheck,
): "BACKEND_AUTOMATIC" | "TRUSTED_PRODUCER" {
  return check.satisfactionMode
    ?? (check.id === "contract-validation" ? "BACKEND_AUTOMATIC" : "TRUSTED_PRODUCER");
}

export function trustedProducerRequiredChecks(
  contract: Pick<ExecutionContract, "requiredChecks">,
): RequiredCheck[] {
  return contract.requiredChecks.filter(
    check => check.required && requiredCheckSatisfactionMode(check) === "TRUSTED_PRODUCER",
  );
}

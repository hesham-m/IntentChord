import { z } from "zod/v3";
import { proofEvidenceRefSchema, evidenceAwareFindingStatusSchema } from "@/core/evidence/evidence-types";
import { providerExecutionBindingSchema } from "@/core/intelligence/intent-schema";

export const discoverySchemaVersion = "0.1" as const;
export const discoveryPlannerVersion = "intentchord-bounded-discovery/0.1" as const;

const relativePathSchema = z.string().trim().min(1).max(4_096).superRefine((value, context) => {
  const normalized = value.replaceAll("\\", "/");
  if (
    normalized.startsWith("/")
    || /^[A-Za-z]:\//.test(normalized)
    || normalized.split("/").includes("..")
    || normalized.includes("\0")
  ) {
    context.addIssue({
      code: "custom",
      message: "Discovery paths must be normalized workspace-relative paths.",
    });
  }
});

export const discoveryRunStatusSchema = z.enum([
  "CREATED",
  "RUNNING",
  "AWAITING_FINDINGS",
  "READY_TO_COMPLETE",
  "COMPLETED",
  "EVIDENCE_REQUIRED",
  "FAILED",
  "SUPERSEDED",
]);
export type DiscoveryRunStatus = z.infer<typeof discoveryRunStatusSchema>;

export const discoveryItemStateSchema = z.enum([
  "DISCOVERED",
  "INSPECTED",
  "NOT_RELEVANT",
  "OUTSIDE_SCOPE",
]);
export type DiscoveryItemState = z.infer<typeof discoveryItemStateSchema>;

export const discoveryAssessmentSchema = z.object({
  assessmentStatus: z.literal("ASSESSED"),
  complexity: z.enum(["LOW", "MEDIUM", "HIGH"]),
  crossFileDependency: z.enum(["YES", "NO"]),
  crossWorkspaceDependency: z.enum(["YES", "NO"]),
  workspaceCount: z.number().int().positive(),
  candidateFileCount: z.number().int().nonnegative(),
  inspectedFileCount: z.number().int().nonnegative(),
  requirementCoverage: z.array(z.object({
    requirementId: z.string().trim().min(1).max(120),
    discoveredItemCount: z.number().int().nonnegative(),
  }).strict()).max(100),
  reasons: z.array(z.string().trim().min(1).max(2_000)).min(1).max(30),
}).strict();
export type DiscoveryAssessment = z.infer<typeof discoveryAssessmentSchema>;

export const discoveryItemSchema = z.object({
  id: z.string().uuid().optional(),
  workspaceId: z.string().uuid(),
  relativePath: relativePathSchema,
  symbol: z.string().trim().min(1).max(1_000).optional(),
  lineStart: z.number().int().positive().optional(),
  lineEnd: z.number().int().positive().optional(),
  contentSha256: z.string().regex(/^[0-9a-f]{64}$/),
  requirementIds: z.array(z.string().trim().min(1).max(120)).min(1).max(100),
  relevanceReason: z.string().trim().min(8).max(4_000),
  matchedConcepts: z.array(z.string().trim().min(1).max(500)).max(100),
  matchScore: z.number().int().nonnegative().max(100_000),
  state: discoveryItemStateSchema,
}).strict().superRefine((value, context) => {
  if ((value.lineStart === undefined) !== (value.lineEnd === undefined)) {
    context.addIssue({
      code: "custom",
      path: ["lineStart"],
      message: "lineStart and lineEnd must be supplied together.",
    });
  }
  if (value.lineStart !== undefined && value.lineEnd !== undefined && value.lineEnd < value.lineStart) {
    context.addIssue({
      code: "custom",
      path: ["lineEnd"],
      message: "lineEnd must not be lower than lineStart.",
    });
  }
});
export type DiscoveryItem = z.infer<typeof discoveryItemSchema>;

export const discoveryFindingInputSchema = z.object({
  requirementId: z.string().trim().min(1).max(120),
  claim: z.string().trim().min(8).max(20_000),
  status: evidenceAwareFindingStatusSchema,
  evidenceRefs: z.array(proofEvidenceRefSchema).max(100),
}).strict();
export type DiscoveryFindingInput = z.infer<typeof discoveryFindingInputSchema>;

export const discoveryScopeExpansionSchema = z.object({
  workspaceId: z.string().uuid(),
  requestedPath: z.string().trim().min(1).max(4_096),
  reason: z.string().trim().min(8).max(4_000),
}).strict();
export type DiscoveryScopeExpansion = z.infer<typeof discoveryScopeExpansionSchema>;

export const discoveryRunProjectionSchema = z.object({
  id: z.string().uuid(),
  taskId: z.string().uuid(),
  taskDraftRevisionId: z.string().uuid(),
  intentResolutionId: z.string().uuid(),
  stateRevision: z.number().int().nonnegative(),
  status: discoveryRunStatusSchema,
  schemaVersion: z.literal(discoverySchemaVersion),
  plannerVersion: z.literal(discoveryPlannerVersion),
  adapterId: z.string().trim().min(1).max(200),
  providerBinding: providerExecutionBindingSchema.refine(
    value => value.role === "DISCOVERY_INVESTIGATOR",
    "Discovery runs require a DISCOVERY_INVESTIGATOR binding.",
  ),
  providerInvocationState: z.enum(["NOT_INVOKED", "INVOKED"]),
  externalInvocationId: z.string().trim().min(1).max(1_000).optional(),
  authorityFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  inputSha256: z.string().regex(/^[0-9a-f]{64}$/),
  outputSha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  assessment: discoveryAssessmentSchema.optional(),
  items: z.array(discoveryItemSchema).max(2_000),
  findings: z.array(discoveryFindingInputSchema).max(500),
  evidenceGaps: z.array(z.string().trim().min(1).max(4_000)).max(500),
  scopeExpansionRequests: z.array(discoveryScopeExpansionSchema).max(100),
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict().superRefine((value, context) => {
  if ((value.providerInvocationState === "INVOKED") !== Boolean(value.externalInvocationId)) {
    context.addIssue({
      code: "custom",
      path: ["externalInvocationId"],
      message: "An external invocation ID is required exactly when a provider was invoked.",
    });
  }
});
export type DiscoveryRunProjection = z.infer<typeof discoveryRunProjectionSchema>;

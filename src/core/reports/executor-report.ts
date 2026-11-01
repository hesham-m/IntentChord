import { z } from "zod/v3";
import {
  classificationSchema,
  evidenceIdentitySchema,
  executionChannelIdSchema,
  modelIdSchema,
  providerIdSchema,
  reasoningProfileSchema,
  runtimeProfileIdSchema,
} from "@/core/contracts/execution-contract";
import { reportSectionIds } from "@/core/reports/report-contract";

export const reportPathReferenceSchema = z.object({
  workspaceId: z.string().uuid(),
  path: z.string().trim().min(1).max(2048),
}).strict();

export const reportEvidenceReferenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("INSPECTED_PATH"), workspaceId: z.string().uuid(), path: z.string().trim().min(1).max(2048) }).strict(),
  z.object({ kind: z.literal("SUPPORTING_EVIDENCE"), workspaceId: z.string().uuid().optional(), path: z.string().trim().min(1).max(2048) }).strict(),
  z.object({ kind: z.literal("VALIDATION_CHECK"), checkId: z.string().trim().min(1).max(200) }).strict(),
  z.object({ kind: z.literal("TOOL_TRACE_EVENT"), sequence: z.number().int().nonnegative() }).strict(),
  z.object({
    kind: z.literal("SOURCE_EVIDENCE"),
    workspaceId: z.string().uuid(),
    relativePath: z.string().trim().min(1).max(4096),
    symbol: z.string().trim().min(1).max(1000).optional(),
    lineStart: z.number().int().positive().optional(),
    lineEnd: z.number().int().positive().optional(),
    contentSha256: z.string().regex(/^[0-9a-f]{64}$/),
  }).strict(),
  z.object({
    kind: z.literal("ARTIFACT_EVIDENCE"),
    artifactId: z.string().trim().min(1).max(1000),
    artifactSha256: z.string().regex(/^[0-9a-f]{64}$/),
    manifestRelationship: z.string().trim().min(1).max(2000).optional(),
  }).strict(),
  z.object({
    kind: z.literal("VALIDATION_EVIDENCE"),
    checkId: z.string().trim().min(1).max(500),
    producer: z.enum(["BACKEND", "SIGNED_HARNESS", "OWNER_RUNTIME"]),
  }).strict(),
  z.object({
    kind: z.literal("RUNTIME_EVIDENCE"),
    checkId: z.string().trim().min(1).max(500),
    producer: z.enum(["SIGNED_HARNESS", "OWNER_RUNTIME"]),
    runIdentity: z.string().trim().min(1).max(1000),
  }).strict(),
]).superRefine((reference, context) => {
  if (reference.kind !== "SOURCE_EVIDENCE") return;
  if ((reference.lineStart === undefined) !== (reference.lineEnd === undefined)) {
    context.addIssue({
      code: "custom",
      message: "Source lineStart and lineEnd must be supplied together.",
    });
  }
  if (reference.lineStart !== undefined
    && reference.lineEnd !== undefined
    && reference.lineEnd < reference.lineStart) {
    context.addIssue({
      code: "custom",
      path: ["lineEnd"],
      message: "lineEnd must not be lower than lineStart.",
    });
  }
  if (/^(?:[A-Za-z]:[\\/]|[\\/]{2}|\/)/.test(reference.relativePath)
    || reference.relativePath.split(/[\\/]/).includes("..")) {
    context.addIssue({
      code: "custom",
      path: ["relativePath"],
      message: "Source evidence paths must be normalized workspace-relative paths.",
    });
  }
});


export const requirementProofSchema = z.object({
  requirementId: z.string().trim().min(1).max(200),
  classification: classificationSchema,
  actualSourceBehavior: z.string().trim().min(1).max(20_000),
  sourceBehaviorRefs: z.array(reportEvidenceReferenceSchema),
  positiveProofRefs: z.array(reportEvidenceReferenceSchema),
  negativeAdversarialProofRefs: z.array(reportEvidenceReferenceSchema),
  persistenceReloadProofRefs: z.array(reportEvidenceReferenceSchema),
  notes: z.string().trim().max(20_000).default(""),
}).strict();

const reportSectionsSchema = z.object(Object.fromEntries(
  reportSectionIds.map(id => [id, z.string().trim().min(1).max(100_000)]),
) as Record<(typeof reportSectionIds)[number], z.ZodString>).strict();

export const executorReportEnvelopeSchema = z.object({
  contractId: z.string().min(1),
  runId: z.string().min(1),
  round: z.number().int().positive(),
  executionType: z.enum(["INITIAL", "CORRECTION", "FIXTURE"]),
  parentRunId: z.string().min(1).optional(),
  bindingMarker: z.string().min(1),
  executorName: z.string().min(1),
  providerId: providerIdSchema,
  modelId: modelIdSchema,
  executionChannelId: executionChannelIdSchema,
  reasoningProfile: reasoningProfileSchema,
  runtimeProfileId: runtimeProfileIdSchema,
  terminalState: z.enum(["STOP_FOR_OWNER", "READY_FOR_FINAL_REPORT"]),
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
  inspectedPaths: z.array(reportPathReferenceSchema),
  changedPaths: z.array(reportPathReferenceSchema),
  commands: z.array(z.object({
    command: z.string().min(1),
    exitCode: z.number().int().optional(),
    purpose: z.string().min(1),
  }).strict()),
  evidenceIdentities: z.array(evidenceIdentitySchema),
  findings: z.array(z.object({
    requirementId: z.string().trim().min(1).max(200),
    claim: z.string().min(1),
    status: z.enum([
      "PROVEN",
      "PROBABLE",
      "POSSIBLE",
      "UNSUPPORTED",
      "PROVEN_BY_SOURCE",
      "PROVEN_BY_ARTIFACT",
      "PROVEN_BY_VALIDATION",
      "PROVEN_BY_RUNTIME",
      "CONTRADICTED",
      "NOT_PROVEN",
      "EVIDENCE_REQUIRED",
    ]),
    evidenceRefs: z.array(reportEvidenceReferenceSchema),
  }).strict()),
  requirementProofs: z.array(requirementProofSchema).min(1),
  validationResults: z.array(z.object({
    checkId: z.string().min(1),
    status: z.enum(["PASS", "FAIL", "NOT_RUN"]),
    details: z.string(),
  }).strict()),
  executorClassification: classificationSchema,
  nextAction: z.string().min(1),
  reportSections: reportSectionsSchema,
  missingRequiredSources: z.array(z.string()).default([]),
  accessDeniedPaths: z.array(z.string()).default([]),
  closureCriteriaSatisfied: z.array(z.string()).default([]),
  rawReport: z.string().default(""),
  completedReportSections: z.array(z.enum(reportSectionIds)).default([]),
}).strict().superRefine((report, context) => {
  if (report.executionType === "CORRECTION" && !report.parentRunId) {
    context.addIssue({ code: "custom", message: "A correction report must include its parent Run ID.", path: ["parentRunId"] });
  }
  if (report.executionType !== "CORRECTION" && report.parentRunId) {
    context.addIssue({ code: "custom", message: "Only a correction report may include a parent Run ID.", path: ["parentRunId"] });
  }
});

export type ReportPathReference = z.infer<typeof reportPathReferenceSchema>;
export type ReportEvidenceReference = z.infer<typeof reportEvidenceReferenceSchema>;
export type RequirementProof = z.infer<typeof requirementProofSchema>;
export type ExecutorReportEnvelope = z.infer<typeof executorReportEnvelopeSchema>;

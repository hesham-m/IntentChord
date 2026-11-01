import { z } from "zod/v3";

export const proofEvidenceKindSchema = z.enum([
  "SOURCE_EVIDENCE",
  "ARTIFACT_EVIDENCE",
  "VALIDATION_EVIDENCE",
  "RUNTIME_EVIDENCE",
]);
export type ProofEvidenceKind = z.infer<typeof proofEvidenceKindSchema>;

export const sourceEvidenceRefSchema = z.object({
  kind: z.literal("SOURCE_EVIDENCE"),
  workspaceId: z.string().uuid(),
  relativePath: z.string().trim().min(1).max(4_096),
  symbol: z.string().trim().min(1).max(1_000).optional(),
  lineStart: z.number().int().positive().optional(),
  lineEnd: z.number().int().positive().optional(),
  contentSha256: z.string().regex(/^[0-9a-f]{64}$/),
}).strict().superRefine((value, context) => {
  if ((value.lineStart === undefined) !== (value.lineEnd === undefined)) {
    context.addIssue({ code: "custom", message: "Source lineStart and lineEnd must be supplied together." });
  }
  if (value.lineStart !== undefined && value.lineEnd !== undefined && value.lineEnd < value.lineStart) {
    context.addIssue({ code: "custom", path: ["lineEnd"], message: "lineEnd must not be lower than lineStart." });
  }
  if (/^(?:[A-Za-z]:[\\/]|[\\/]{2}|\/)/.test(value.relativePath) || value.relativePath.split(/[\\/]/).includes("..")) {
    context.addIssue({ code: "custom", path: ["relativePath"], message: "Source evidence paths must be normalized workspace-relative paths." });
  }
});

export const artifactEvidenceRefSchema = z.object({
  kind: z.literal("ARTIFACT_EVIDENCE"),
  artifactId: z.string().trim().min(1).max(1_000),
  artifactSha256: z.string().regex(/^[0-9a-f]{64}$/),
  manifestRelationship: z.string().trim().min(1).max(2_000).optional(),
}).strict();

export const validationEvidenceRefSchema = z.object({
  kind: z.literal("VALIDATION_EVIDENCE"),
  checkId: z.string().trim().min(1).max(500),
  producer: z.enum(["BACKEND", "SIGNED_HARNESS", "OWNER_RUNTIME"]),
}).strict();

export const runtimeEvidenceRefSchema = z.object({
  kind: z.literal("RUNTIME_EVIDENCE"),
  checkId: z.string().trim().min(1).max(500),
  producer: z.enum(["SIGNED_HARNESS", "OWNER_RUNTIME"]),
  runIdentity: z.string().trim().min(1).max(1_000),
}).strict();

export const proofEvidenceRefSchema = z.union([
  sourceEvidenceRefSchema,
  artifactEvidenceRefSchema,
  validationEvidenceRefSchema,
  runtimeEvidenceRefSchema,
]);
export type ProofEvidenceRef = z.infer<typeof proofEvidenceRefSchema>;

export const evidenceAwareFindingStatusSchema = z.enum([
  "PROVEN_BY_SOURCE",
  "PROVEN_BY_ARTIFACT",
  "PROVEN_BY_VALIDATION",
  "PROVEN_BY_RUNTIME",
  "CONTRADICTED",
  "NOT_PROVEN",
  "EVIDENCE_REQUIRED",
]);
export type EvidenceAwareFindingStatus = z.infer<typeof evidenceAwareFindingStatusSchema>;

import { z } from "zod/v3";
import type { JsonValue } from "@/core/truth/project-truth-hash";
import {
  projectFactStatuses,
  type ProjectFactStatus,
} from "@/core/truth/project-fact-types";

export { initialProjectFactTypes } from "@/core/truth/project-fact-types";
export type { InitialProjectFactType, ProjectFactStatus } from "@/core/truth/project-fact-types";

const boundedText = (minimum: number, maximum: number) => z.string().trim().min(minimum).max(maximum);
const isoDateTime = z.string().datetime({ offset: true });

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.null(),
  z.array(jsonValueSchema),
  z.record(jsonValueSchema),
]));

const boundedJsonValueSchema = jsonValueSchema.superRefine((value, context) => {
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > 64 * 1024) {
    context.addIssue({ code: "custom", message: "Structured fact values are limited to 64 KiB." });
  }
});

const provenanceSchema = z.record(jsonValueSchema).default({}).superRefine((value, context) => {
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > 32 * 1024) {
    context.addIssue({ code: "custom", message: "Fact provenance is limited to 32 KiB." });
  }
});

export const factKeySchema = z.string().trim().toUpperCase()
  .regex(/^[A-Z0-9][A-Z0-9._:-]{0,199}$/);

export const factTypeSchema = z.string().trim().toUpperCase()
  .regex(/^[A-Z][A-Z0-9_]{1,79}$/);

export const proposeProjectFactCommandSchema = z.object({
  expectedFactRevision: z.number().int().nonnegative(),
  factKey: factKeySchema,
  factType: factTypeSchema,
  value: boundedJsonValueSchema,
  validFrom: isoDateTime.optional(),
  validUntil: isoDateTime.optional(),
  provenance: provenanceSchema,
}).strict().superRefine((value, context) => {
  if (value.validFrom && value.validUntil && Date.parse(value.validUntil) <= Date.parse(value.validFrom)) {
    context.addIssue({ code: "custom", path: ["validUntil"], message: "validUntil must be later than validFrom." });
  }
});

export const approveProjectFactCommandSchema = z.object({
  expectedRevision: z.number().int().positive(),
  proposalRevisionId: z.string().uuid(),
  decisionReason: boundedText(8, 5000),
  effectiveFrom: isoDateTime.optional(),
  effectiveUntil: isoDateTime.optional(),
}).strict().superRefine((value, context) => {
  if (value.effectiveFrom && value.effectiveUntil && Date.parse(value.effectiveUntil) <= Date.parse(value.effectiveFrom)) {
    context.addIssue({ code: "custom", path: ["effectiveUntil"], message: "effectiveUntil must be later than effectiveFrom." });
  }
});

export const rejectProjectFactCommandSchema = z.object({
  expectedRevision: z.number().int().positive(),
  proposalRevisionId: z.string().uuid(),
  decisionReason: boundedText(8, 5000),
}).strict();

export const supersedeProjectFactCommandSchema = z.object({
  expectedRevision: z.number().int().positive(),
  expectedCurrentApprovedRevisionId: z.string().uuid(),
  replacementProposalRevisionId: z.string().uuid().optional(),
  decisionReason: boundedText(8, 5000),
  effectiveAt: isoDateTime.optional(),
  effectiveUntil: isoDateTime.optional(),
}).strict().superRefine((value, context) => {
  if (value.effectiveAt && value.effectiveUntil && Date.parse(value.effectiveUntil) <= Date.parse(value.effectiveAt)) {
    context.addIssue({ code: "custom", path: ["effectiveUntil"], message: "effectiveUntil must be later than effectiveAt." });
  }
});

export const createProjectTruthSnapshotCommandSchema = z.object({
  snapshotVersion: boundedText(1, 120),
  effectiveAt: isoDateTime.optional(),
  factRevisionIds: z.array(z.string().uuid()).max(500).optional(),
}).strict();

export type ProposeProjectFactCommand = z.infer<typeof proposeProjectFactCommandSchema>;
export type ApproveProjectFactCommand = z.infer<typeof approveProjectFactCommandSchema>;
export type RejectProjectFactCommand = z.infer<typeof rejectProjectFactCommandSchema>;
export type SupersedeProjectFactCommand = z.infer<typeof supersedeProjectFactCommandSchema>;
export type CreateProjectTruthSnapshotCommand = z.infer<typeof createProjectTruthSnapshotCommandSchema>;

export type ProjectFactRevisionView = {
  id: string;
  projectFactId: string;
  revision: number;
  value: JsonValue;
  status: ProjectFactStatus;
  validFrom: string;
  validUntil?: string;
  sourceProposalRevisionId?: string;
  supersedesRevisionId?: string;
  provenance: Record<string, JsonValue>;
  ownerDecisionId?: string;
  contentSha256: string;
  createdAt: string;
  unresolvedProposal: boolean;
};

export type ProjectFactView = {
  id: string;
  projectContextId: string;
  factKey: string;
  factType: string;
  currentRevision: number;
  currentStatus: ProjectFactStatus;
  currentFactRevisionId: string;
  createdAt: string;
  updatedAt: string;
  current: ProjectFactRevisionView;
  revisions: ProjectFactRevisionView[];
};

export type ProjectTruthSnapshotView = {
  id: string;
  projectContextId: string;
  snapshotVersion: string;
  effectiveAt: string;
  selectedFactRevisionIds: string[];
  contentSha256: string;
  createdByAuthority: string;
  createdAt: string;
};

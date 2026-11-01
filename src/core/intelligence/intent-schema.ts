import { z } from "zod/v3";
import {
  executionChannelIdSchema,
  modelIdSchema,
  providerIdSchema,
  taskModeSchema,
} from "@/core/contracts/execution-contract";

export const intentResolutionSchemaVersion = "0.1" as const;
export const intentPromptVersion = "intentchord-intent-planner/0.1" as const;

export const intentOriginSchema = z.enum([
  "OWNER_EXPLICIT",
  "SYSTEM_INFERRED",
  "AI_INFERRED",
  "OWNER_CONFIRMED",
]);
export type IntentOrigin = z.infer<typeof intentOriginSchema>;

export const evidenceTypeSchema = z.enum([
  "SOURCE",
  "ARTIFACT",
  "VALIDATION",
  "RUNTIME",
]);
export type EvidenceType = z.infer<typeof evidenceTypeSchema>;

export const aiRoleSchema = z.enum([
  "INTENT_PLANNER",
  "DISCOVERY_INVESTIGATOR",
]);
export type AiRole = z.infer<typeof aiRoleSchema>;

export const providerExecutionBindingSchema = z.object({
  role: aiRoleSchema,
  providerId: providerIdSchema,
  modelId: modelIdSchema,
  executionChannelId: executionChannelIdSchema,
}).strict();
export type ProviderExecutionBinding = z.infer<typeof providerExecutionBindingSchema>;

export const intentAuthorityEchoSchema = z.object({
  taskMode: taskModeSchema,
  workspaceIds: z.array(z.string().uuid()).min(1).max(20),
  effectiveCapabilities: z.array(z.string().min(1)).max(20),
  authorityFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();
export type IntentAuthorityEcho = z.infer<typeof intentAuthorityEchoSchema>;

export const intentResolutionSchema = z.object({
  schemaVersion: z.literal(intentResolutionSchemaVersion),
  locale: z.enum(["en", "ar"]),
  producerKind: z.enum(["DETERMINISTIC_BASELINE", "EXTERNAL_AI"]),
  producerAdapterId: z.string().trim().min(1).max(200),
  literalObjective: z.string().trim().min(3).max(20_000),
  normalizedTopic: z.string().trim().min(1).max(500),
  preservedLiterals: z.array(z.string().trim().min(1).max(500)).max(100),
  taskMode: taskModeSchema,
  ownerSummary: z.string().trim().min(20).max(8_000),
  investigationQuestions: z.array(z.object({
    id: z.string().regex(/^[A-Z0-9][A-Z0-9_-]*$/),
    question: z.string().trim().min(8).max(5_000),
    origin: intentOriginSchema,
  }).strict()).min(1).max(100),
  proposedRequirements: z.array(z.object({
    id: z.string().regex(/^[A-Z0-9][A-Z0-9_-]*$/),
    outcome: z.string().trim().min(8).max(5_000),
    origin: intentOriginSchema,
    requiredEvidenceTypes: z.array(evidenceTypeSchema).min(1).max(4),
  }).strict()).min(1).max(100),
  expectedConcepts: z.array(z.string().trim().min(1).max(500)).max(100),
  unknowns: z.array(z.string().trim().min(1).max(2_000)).max(100),
  forbiddenAssumptions: z.array(z.string().trim().min(1).max(2_000)).max(100),
  confidence: z.number().min(0).max(1),
  needsClarification: z.boolean(),
  clarificationQuestion: z.string().trim().min(8).max(2_000).optional(),
  providerBinding: providerExecutionBindingSchema,
  authorityEcho: intentAuthorityEchoSchema,
}).strict().superRefine((value, context) => {
  const questionIds = new Set<string>();
  for (const [index, question] of value.investigationQuestions.entries()) {
    if (questionIds.has(question.id)) {
      context.addIssue({
        code: "custom",
        path: ["investigationQuestions", index, "id"],
        message: "Duplicate investigation question ID.",
      });
    }
    questionIds.add(question.id);
  }

  const requirementIds = new Set<string>();
  for (const [index, requirement] of value.proposedRequirements.entries()) {
    if (requirementIds.has(requirement.id)) {
      context.addIssue({
        code: "custom",
        path: ["proposedRequirements", index, "id"],
        message: "Duplicate proposed requirement ID.",
      });
    }
    requirementIds.add(requirement.id);
  }

  if (value.needsClarification !== Boolean(value.clarificationQuestion)) {
    context.addIssue({
      code: "custom",
      path: ["clarificationQuestion"],
      message: "A clarification question is required exactly when needsClarification is true.",
    });
  }
  if (value.providerBinding.role !== "INTENT_PLANNER") {
    context.addIssue({
      code: "custom",
      path: ["providerBinding", "role"],
      message: "Intent resolution must be bound to the INTENT_PLANNER role.",
    });
  }
});

export type IntentResolution = z.infer<typeof intentResolutionSchema>;

export type IntentPlannerInput = {
  literalObjective: string;
  locale: "en" | "ar";
  taskMode: z.infer<typeof taskModeSchema>;
  workspaceIds: string[];
  workspaceDisplayNames: string[];
  effectiveCapabilities: string[];
  authorityFingerprint: string;
  providerBinding: ProviderExecutionBinding;
};

export type ConfirmedIntentResolution = IntentResolution & {
  investigationQuestions: Array<IntentResolution["investigationQuestions"][number] & {
    origin: "OWNER_EXPLICIT" | "OWNER_CONFIRMED";
  }>;
  proposedRequirements: Array<IntentResolution["proposedRequirements"][number] & {
    origin: "OWNER_EXPLICIT" | "OWNER_CONFIRMED";
  }>;
};

import { ZodError } from "zod/v3";
import { compileAgentPrompt, compileExecutorNeutralPrompt, type PromptExecutionContext } from "@/core/prompts/compiler";
import {
  executionContractSchema,
  type ExecutionContract,
} from "@/core/contracts/execution-contract";
import { validatePreflight } from "@/core/policies/preflight";
import { resolveAuthorization } from "@/core/policies/policy";
import { resolveExecutionContract } from "@/core/contracts/resolver";
import {
  executorReportEnvelopeSchema,
  type ExecutorReportEnvelope,
} from "@/core/reports/executor-report";
import { evaluateVerdict } from "@/core/verdicts/engine";
import { parseAuthoritativeReport } from "@/core/reports/parser";
import type { Locale } from "@/i18n/types";
import {
  extractExecutionSetup,
  legacyWorkspaceId,
  requestedAuthorization,
  type AuthorizationCapability,
  type ContractInput,
  type TaskDraftInput,
} from "@/core/tasks/task-input";
import {
  defaultRuntimeProfileForProvider,
  modelRegistry,
  providerRegistry,
} from "@/core/providers/registry";
import { deriveTaskSemanticProfile } from "@/core/tasks/semantic-profile";
import { evaluateConfiguration } from "@/core/recommendations/engine";

export type { AuthorizationCapability, ContractInput, TaskDraftInput } from "@/core/tasks/task-input";

export function buildDraftContract(input: TaskDraftInput, contractId = "contract-local-draft"): ExecutionContract | undefined {
  const executionSetup = extractExecutionSetup(input);
  if (!executionSetup) {
    return undefined;
  }
  const providerId = executionSetup.providerId;
  const modelId = executionSetup.modelId;
  return resolveExecutionContract({
    contractId,
    title: input.title,
    objective: input.objective,
    taskMode: input.taskMode,
    ownerRequirements: input.ownerRequirements,
    workspaces: input.workspaces.length ? input.workspaces : input.workspaceRef.trim() ? [{
      id: legacyWorkspaceId, displayName: input.workspaceRef, role: "primary", referenceType: "LOCAL_PATH" as const,
      reference: input.workspaceRef, fingerprint: input.workspaceFingerprint || `legacy-${legacyWorkspaceId}`, allowedPaths: input.allowedPaths,
      excludedPaths: input.excludedPaths, authorizationContext: "compatibility upgrade", ordering: 0,
    }] : [],
    allowedPaths: input.allowedPaths,
    excludedPaths: input.excludedPaths,
    evidenceFiles: input.evidenceFiles,
    identity: input.identity,
    authorization: requestedAuthorization(input),
    providerId,
    modelId,
    executionChannelId: executionSetup.executionChannelId,
    reasoningProfile: executionSetup.reasoningProfile,
    runtimeProfileId: executionSetup.runtimeProfileId,
    ownerOverrideAccepted: Boolean(executionSetup.modelOverrideAccepted),
  });
}

export type ConfigurationPreviewResult = {
  task: ReturnType<typeof deriveTaskSemanticProfile>;
  recommendation: ReturnType<typeof evaluateConfiguration> | undefined;
  executionStatus: "SELECTED" | "NOT_SELECTED";
};

export function configurationPreview(input: TaskDraftInput): ConfigurationPreviewResult {
  const policy = resolveAuthorization(input.taskMode, requestedAuthorization(input));
  const task = deriveTaskSemanticProfile({
    taskMode: input.taskMode,
    objective: input.objective,
    allowedPaths: input.allowedPaths,
    evidenceFiles: input.evidenceFiles,
    authorization: policy.effective,
  });

  const executionSetup = extractExecutionSetup(input);
  if (!executionSetup) {
    return {
      task,
      recommendation: undefined,
      executionStatus: "NOT_SELECTED",
    };
  }

  const providerId = executionSetup.providerId;
  const modelId = executionSetup.modelId;
  return {
    task,
    recommendation: evaluateConfiguration({
      providerId,
      modelId,
      reasoningProfile: executionSetup.reasoningProfile,
      runtimeProfileId: executionSetup.runtimeProfileId,
      task,
      ownerOverrideAccepted: Boolean(executionSetup.modelOverrideAccepted),
    }),
    executionStatus: "SELECTED",
  };
}

export function authorizationPolicyPreview(taskMode: ExecutionContract["taskMode"]) {
  const requested = {
    readFiles: true,
    modifySource: true,
    runStaticValidation: true,
    runTests: true,
    build: true,
    deploy: true,
    restartServices: true,
    writeDatabase: true,
    changeEnvironment: true,
    useNetwork: true,
  } satisfies ExecutionContract["authorization"];
  return resolveAuthorization(taskMode, requested).trace;
}

export function approvalState(contract: ExecutionContract) {
  const allIssues = validatePreflight(contract);
  const issues = allIssues.filter(issue => issue.code !== "MISSING_OWNER_APPROVAL");
  return {
    issues,
    allIssues,
    nonApprovalIssues: issues,
    canApprove: contract.ownerApproval.state !== "APPROVED" && issues.length === 0,
    canExecute: contract.ownerApproval.state === "APPROVED" && issues.length === 0,
  };
}

export function approveContract(contract: ExecutionContract): {
  contract?: ExecutionContract;
  issues: ReturnType<typeof validatePreflight>;
  error?: string;
} {
  const parsed = executionContractSchema.safeParse(contract);
  if (!parsed.success) return { issues: [], error: describeSchemaError(parsed.error) };
  const beforeApproval = validatePreflight(parsed.data).filter(issue => issue.code !== "MISSING_OWNER_APPROVAL");
  if (beforeApproval.length) return { issues: validatePreflight(parsed.data) };
  const approved: ExecutionContract = {
    ...parsed.data,
    ownerApproval: {
      required: true,
      state: "APPROVED",
      approvedAt: new Date().toISOString(),
    },
  };
  const issues = validatePreflight(approved);
  return issues.length ? { issues } : { contract: approved, issues: [] };
}

export function compiledPrompt(contract: ExecutionContract) {
  return compileExecutorNeutralPrompt(contract, "en");
}

export function compiledPromptForLocale(contract: ExecutionContract, locale: Locale, execution?: PromptExecutionContext) {
  return compileAgentPrompt(contract, locale, execution);
}

export type ImportedReportParseResult = {
  report?: ExecutorReportEnvelope;
  error?: string;
  issues?: string[];
  errorType?: "SYNTAX" | "SCHEMA" | "MAPPING";
  format?: "JSON" | "MARKDOWN";
  mappedFields?: string[];
  missingFields?: string[];
  boundFields?: string[];
};

export type ImportedReportContext = Pick<ExecutorReportEnvelope,
  "contractId" | "runId" | "round" | "executionType" | "executorName" | "providerId" | "modelId" | "executionChannelId" | "reasoningProfile" | "runtimeProfileId"
> & {
  parentRunId?: string;
  bindingMarker?: string;
  evidenceIdentity: ExecutionContract["evidenceIdentity"];
};

const governedReportFields = [
  "contractId",
  "runId",
  "round",
  "executionType",
  "parentRunId",
  "bindingMarker",
  "executorName",
  "providerId",
  "modelId",
  "executionChannelId",
  "reasoningProfile",
  "runtimeProfileId",
] as const;

/**
 * Client-side preview uses the same strict parser as the Backend.
 * Governed identity is never injected from UI state; a supplied context is used only
 * to detect mismatches before the raw report is sent to the authoritative API.
 */
export function parseImportedReport(text: string, context?: ImportedReportContext): ImportedReportParseResult {
  const trimmed = text.trim();
  const format: "JSON" | "MARKDOWN" = trimmed.startsWith("{") ? "JSON" : "MARKDOWN";
  const parsed = parseAuthoritativeReport(
    text,
    format === "JSON" ? "application/json" : "text/markdown",
  );

  if (!("report" in parsed)) {
    const issues = parsed.issues;
    const syntax = format === "JSON" && issues.some(issue => /malformed/i.test(issue));
    return {
      errorType: syntax ? "SYNTAX" : "SCHEMA",
      format,
      issues,
      error: issues.join("; "),
      boundFields: [],
    };
  }

  if (context) {
    const expected: Partial<ExecutorReportEnvelope> = {
      contractId: context.contractId,
      runId: context.runId,
      round: context.round,
      executionType: context.executionType,
      parentRunId: context.parentRunId,
      bindingMarker: context.bindingMarker,
      executorName: context.executorName,
      providerId: context.providerId,
      modelId: context.modelId,
      executionChannelId: context.executionChannelId,
      reasoningProfile: context.reasoningProfile,
      runtimeProfileId: context.runtimeProfileId,
    };
    const mismatches = governedReportFields.filter(field => {
      if (expected[field] === undefined) return false;
      return (parsed.report[field] ?? null) !== (expected[field] ?? null);
    });
    if (mismatches.length) {
      const issues = mismatches.map(field => `Governed report identity mismatch: ${field}.`);
      return {
        errorType: "MAPPING",
        format,
        report: parsed.report,
        issues,
        error: issues.join("; "),
        mappedFields: Object.keys(parsed.report),
        missingFields: [],
        boundFields: [],
      };
    }
  }

  return {
    report: parsed.report,
    format,
    mappedFields: Object.keys(parsed.report),
    missingFields: [],
    boundFields: [],
  };
}

export function describeSchemaError(error: unknown) {
  return error instanceof ZodError
    ? error.issues.map(issue => issue.message).join("; ")
    : "Invalid contract.";
}

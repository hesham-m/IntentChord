import {
  defaultModelForProvider,
  defaultRuntimeProfileForProvider,
  modelRegistry,
  providerRegistry,
  type ExecutionChannelId,
  type ProviderId,
} from "@/core/providers/registry";
import { evaluateConfiguration } from "@/core/recommendations/engine";
import { deriveTaskSemanticProfile } from "@/core/tasks/semantic-profile";
import {
  requestedAuthorization,
  type TaskDraftInput,
  type TaskExecutionSetup,
} from "@/core/tasks/task-input";

export class UnifiedExecutionRoutingError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "UnifiedExecutionRoutingError";
  }
}

function providerForExecutionChannel(executionChannelId: ExecutionChannelId): ProviderId {
  const provider = Object.values(providerRegistry).find(
    profile => profile.executionChannelId === executionChannelId,
  );
  if (!provider) {
    throw new UnifiedExecutionRoutingError(
      "EXECUTION_PLATFORM_NOT_SUPPORTED",
      `Execution platform ${executionChannelId} is not supported by the governed provider registry.`,
    );
  }
  return provider.id;
}

/**
 * Resolve the exact external execution configuration after governed Scope Confirmation.
 *
 * Owner authority ends at choosing the execution platform. Provider/model/reasoning/runtime
 * are backend-derived from the confirmed task/work/scope context and the versioned routing
 * policy represented by the model registry + recommendation engine.
 */
export function resolveUnifiedExecutionSetup(
  draft: TaskDraftInput,
  executionChannelId: ExecutionChannelId,
): TaskExecutionSetup {
  if (draft.orchestrationVersion !== "UNIFIED_V1") {
    throw new UnifiedExecutionRoutingError(
      "UNIFIED_TASK_ORCHESTRATION_REQUIRED",
      "Late execution-platform routing is available only for UNIFIED_V1 tasks.",
    );
  }
  if (!draft.contextAssemblyBinding || draft.candidateScope?.authorityVersion !== "CONTEXT_ASSEMBLY_V2" || draft.scopeConfirmation?.candidateIdentity.authorityVersion !== "CONTEXT_ASSEMBLY_V2") {
    throw new UnifiedExecutionRoutingError(
      "GOVERNED_SCOPE_CONFIRMATION_REQUIRED",
      "Current closed CONTEXT_ASSEMBLY_V2 authority, Candidate Scope, and Owner Scope Confirmation are required before execution-platform selection.",
    );
  }

  const providerId = providerForExecutionChannel(executionChannelId);
  const initialModelId = defaultModelForProvider(providerId);
  const initialModel = modelRegistry[initialModelId];
  const runtimeProfileId = defaultRuntimeProfileForProvider(providerId);
  const authorization = requestedAuthorization(draft);
  const confirmedPaths = draft.scopeConfirmation.confirmedAllowedPaths.map(
    path => `${path.workspaceId}:${path.path}`,
  );
  const semantic = deriveTaskSemanticProfile({
    taskMode: draft.taskMode,
    objective: draft.objective,
    allowedPaths: confirmedPaths,
    evidenceFiles: draft.evidenceFiles,
    authorization,
  });
  const preliminary = evaluateConfiguration({
    providerId,
    modelId: initialModelId,
    reasoningProfile: initialModel.defaultReasoningProfile,
    runtimeProfileId,
    task: semantic,
    ownerOverrideAccepted: false,
  });
  const modelId = preliminary.recommendedModelId;
  const model = modelRegistry[modelId];
  const reasoningProfile = model.defaultReasoningProfile;
  const finalEvaluation = evaluateConfiguration({
    providerId,
    modelId,
    reasoningProfile,
    runtimeProfileId,
    task: semantic,
    ownerOverrideAccepted: false,
  });
  if (finalEvaluation.status === "BLOCKED") {
    throw new UnifiedExecutionRoutingError(
      "EXECUTION_CONFIGURATION_RESOLUTION_BLOCKED",
      finalEvaluation.reasons.join(" "),
    );
  }

  return {
    providerId,
    modelId,
    executionChannelId,
    reasoningProfile,
    runtimeProfileId,
    modelOverrideAccepted: false,
  };
}

import type {
  IntentPlannerInput,
  IntentResolution,
  ProviderExecutionBinding,
} from "@/core/intelligence/intent-schema";
import type { DiscoveryWorkspaceBoundary } from "@/core/discovery/discovery-tools";
import type {
  DiscoveryFindingInput,
  DiscoveryScopeExpansion,
} from "@/core/discovery/discovery-schema";
import type { AiAdapterId } from "@/core/providers/ai-role-routing";

export type ExternalAgentHandle = {
  adapterId: AiAdapterId;
  externalRunId: string;
  threadId?: string;
};

export type ExternalAgentStatus =
  | { state: "QUEUED" | "RUNNING" }
  | { state: "COMPLETED"; outputSha256: string }
  | { state: "FAILED"; code: string; message: string };

export interface IntentPlannerAdapter {
  readonly adapterId: AiAdapterId;
  readonly role: "INTENT_PLANNER";
  resolve(input: IntentPlannerInput): Promise<IntentResolution>;
}

/**
 * Pre-Contract bounded-discovery input. The adapter receives the confirmed Intent
 * and immutable authority boundary, never an unrestricted filesystem or a compiled
 * execution Contract. IntentChord-owned tools remain the only filesystem surface.
 */
export type DiscoveryStartInput = {
  discoveryRunId: string;
  taskId: string;
  intentResolutionId: string;
  authorityFingerprint: string;
  binding: ProviderExecutionBinding & { role: "DISCOVERY_INVESTIGATOR" };
  intent: IntentResolution;
  workspaces: DiscoveryWorkspaceBoundary[];
  effectiveCapabilities: ["readFiles"];
};

export type DiscoveryAgentResult = {
  findings: DiscoveryFindingInput[];
  scopeExpansionRequests: DiscoveryScopeExpansion[];
};

export interface DiscoveryInvestigatorAdapter {
  readonly adapterId: AiAdapterId;
  readonly role: "DISCOVERY_INVESTIGATOR";
  start(input: DiscoveryStartInput): Promise<ExternalAgentHandle>;
  status(handle: ExternalAgentHandle): Promise<ExternalAgentStatus>;
  collect(handle: ExternalAgentHandle): Promise<DiscoveryAgentResult>;
}

/**
 * External provider packages are intentionally implemented behind these interfaces.
 * Registering an adapter never grants authority and never starts multiple providers.
 */
export type AiProviderAdapter = IntentPlannerAdapter | DiscoveryInvestigatorAdapter;

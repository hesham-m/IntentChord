import {
  MAX_INDEX_PAYLOAD_ESTIMATED_TOKENS,
  MAX_MODEL_OUTPUT_ESTIMATED_TOKENS,
} from "@/core/ai-context-mapper/types";
import { AI_CONTEXT_MAPPER_SYSTEM_PROMPT_V2 } from "@/core/ai-context-mapper/prompt-v2";
import { estimatedTokensForUtf8 } from "@/core/ai-context-mapper/canonical";

/**
 * Governed reserves per the frozen Multi-Window Architecture Contract
 * (Section 3.2 Token Budget Derivation):
 * usable_input_budget = governed_total_budget - (system_prompt_reserve + response_reserve + protocol_overhead)
 */
export const GOVERNED_RESPONSE_RESERVE_TOKENS = 8_000;
export const GOVERNED_PROTOCOL_OVERHEAD_TOKENS = 1_000;

export interface GovernedTokenBudgetDetails {
  governedTotalBudget: number;
  maxIndexPayloadTokens: number;
  maxModelOutputTokens: number;
  systemPromptReserve: number;
  systemPromptEstimatedTokens: number;
  responseReserve: number;
  protocolOverhead: number;
  effectiveTopologyInputBudget: number;
  effectiveDrilldownInputBudget: number;
  effectiveReductionInputBudget: number;
  windowBudgetDerivationConformsToFrozenContract: boolean;
}

/**
 * Returns the estimated tokens for the canonical V2 system prompt (~1,000 to ~1,200 tokens).
 */
export function getGovernedSystemPromptEstimatedTokens(): number {
  return estimatedTokensForUtf8(AI_CONTEXT_MAPPER_SYSTEM_PROMPT_V2);
}

/**
 * Computes the effective usable input budget derived strictly from the frozen contract:
 * usable_input_budget = governed_total_budget - (system_prompt_reserve + response_reserve + protocol_overhead)
 */
export function getGovernedUsableInputBudget(totalBudget: number = MAX_INDEX_PAYLOAD_ESTIMATED_TOKENS): number {
  const systemPromptReserve = getGovernedSystemPromptEstimatedTokens();
  const usable = totalBudget - (systemPromptReserve + GOVERNED_RESPONSE_RESERVE_TOKENS + GOVERNED_PROTOCOL_OVERHEAD_TOKENS);
  return Math.max(0, usable);
}

/**
 * Derives the governed token budget for topology windows from the canonical
 * usable input budget, with optional env override taking precedence if set.
 */
export function getGovernedTopologyWindowTokenBudget(): number {
  const envVal = typeof process !== "undefined" ? Number(process.env?.TOPOLOGY_WINDOW_TOKEN_BUDGET) : NaN;
  if (!Number.isNaN(envVal) && envVal > 0) {
    return envVal;
  }
  return getGovernedUsableInputBudget();
}

/**
 * Derives the governed token budget for selective drilldown windows from the canonical
 * usable input budget, with optional env override taking precedence if set.
 */
export function getGovernedDrilldownWindowTokenBudget(): number {
  const envVal = typeof process !== "undefined" ? Number(process.env?.DRILLDOWN_WINDOW_TOKEN_BUDGET) : NaN;
  if (!Number.isNaN(envVal) && envVal > 0) {
    return envVal;
  }
  return getGovernedUsableInputBudget();
}

/**
 * Derives the governed token budget for hierarchical reduction windows from the canonical
 * usable input budget, with optional env override taking precedence if set.
 */
export function getGovernedReductionWindowTokenBudget(): number {
  const envVal = typeof process !== "undefined" ? Number(process.env?.REDUCTION_WINDOW_TOKEN_BUDGET) : NaN;
  if (!Number.isNaN(envVal) && envVal > 0) {
    return envVal;
  }
  return getGovernedUsableInputBudget();
}

/**
 * Full inspection view of governed token budget parameters.
 */
export function getGovernedTokenBudgetDetails(): GovernedTokenBudgetDetails {
  const sysReserve = getGovernedSystemPromptEstimatedTokens();
  const topoBudget = getGovernedTopologyWindowTokenBudget();
  const drillBudget = getGovernedDrilldownWindowTokenBudget();
  const redBudget = getGovernedReductionWindowTokenBudget();
  const usableBudget = getGovernedUsableInputBudget();

  return {
    governedTotalBudget: MAX_INDEX_PAYLOAD_ESTIMATED_TOKENS,
    maxIndexPayloadTokens: MAX_INDEX_PAYLOAD_ESTIMATED_TOKENS,
    maxModelOutputTokens: MAX_MODEL_OUTPUT_ESTIMATED_TOKENS,
    systemPromptReserve: sysReserve,
    systemPromptEstimatedTokens: sysReserve,
    responseReserve: GOVERNED_RESPONSE_RESERVE_TOKENS,
    protocolOverhead: GOVERNED_PROTOCOL_OVERHEAD_TOKENS,
    effectiveTopologyInputBudget: topoBudget,
    effectiveDrilldownInputBudget: drillBudget,
    effectiveReductionInputBudget: redBudget,
    windowBudgetDerivationConformsToFrozenContract:
      topoBudget === usableBudget &&
      drillBudget === usableBudget &&
      redBudget === usableBudget,
  };
}

export const DEFAULT_TOPOLOGY_WINDOW_TOKEN_BUDGET = getGovernedTopologyWindowTokenBudget();
export const DEFAULT_DRILLDOWN_WINDOW_TOKEN_BUDGET = getGovernedDrilldownWindowTokenBudget();
export const DEFAULT_REDUCTION_WINDOW_TOKEN_BUDGET = getGovernedReductionWindowTokenBudget();

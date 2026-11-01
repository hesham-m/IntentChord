import { requiredCheckSatisfactionMode, type ExecutionContract } from "@/core/contracts/execution-contract";

export function resolveCorrectionOperationalInheritance(input: {
  sameExactExecutionAuthority: boolean;
  historicalAcceptedFacts: string[];
  trustedSatisfiedCheckIds: string[];
  contract: ExecutionContract;
}): { completedFacts: string[]; inheritedCheckIds: string[] } {
  if (!input.sameExactExecutionAuthority) return { completedFacts: [], inheritedCheckIds: [] };
  const inheritedCheckIds = Array.from(new Set(input.trustedSatisfiedCheckIds)).filter(checkId => {
    const check = input.contract.requiredChecks.find(item => item.id === checkId && item.required);
    return Boolean(check && requiredCheckSatisfactionMode(check) === "TRUSTED_PRODUCER");
  });
  return { completedFacts: [...input.historicalAcceptedFacts], inheritedCheckIds };
}

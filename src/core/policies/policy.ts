import type { ExecutionContract } from "@/core/contracts/execution-contract";

export const policyVersion = "0.2" as const;
export const capabilities = ["readFiles","modifySource","runStaticValidation","runTests","build","deploy","restartServices","writeDatabase","changeEnvironment","useNetwork"] as const;
export type Capability = typeof capabilities[number];
export type PolicyDecision = { capability: Capability; requested: boolean; effective: boolean; source: "OWNER_SELECTION"|"TASK_MODE_POLICY"|"MVP_SYSTEM_POLICY"; reason: string };
export const modeMaximums: Record<ExecutionContract["taskMode"], readonly Capability[]> = { CONTROLLED_AUDIT:["readFiles","runStaticValidation","runTests"], SOURCE_IMPLEMENTATION:["readFiles","modifySource","runStaticValidation","runTests","build"], REPORT_REVIEW:["readFiles"] };
const systemDenied: Capability[] = ["deploy","restartServices","writeDatabase","changeEnvironment","useNetwork"];
export function resolveAuthorization(mode: ExecutionContract["taskMode"], requested: ExecutionContract["authorization"]): { effective: ExecutionContract["authorization"]; trace: PolicyDecision[] } {
  const effective = {} as ExecutionContract["authorization"];
  const trace = capabilities.map((capability): PolicyDecision => {
    const owner = requested[capability];
    const inMode = modeMaximums[mode].includes(capability);
    const system = systemDenied.includes(capability);
    const value = owner && inMode && !system;
    effective[capability] = value;
    if (!owner) return { capability, requested: false, effective: false, source: "OWNER_SELECTION", reason: "Owner did not request this capability." };
    if (system) return { capability, requested: true, effective: false, source: "MVP_SYSTEM_POLICY", reason: "This capability is unavailable under the current governed policy." };
    if (!inMode) return { capability, requested: true, effective: false, source: "TASK_MODE_POLICY", reason: "This capability is forbidden by the selected task mode." };
    return { capability, requested: true, effective: true, source: "TASK_MODE_POLICY", reason: "Allowed by the selected task mode." };
  });
  return { effective, trace };
}

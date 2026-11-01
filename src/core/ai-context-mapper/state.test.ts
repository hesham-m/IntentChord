import { describe, expect, it } from "vitest";
import { assertMappingRunTransition, isAllowedMappingRunTransition } from "@/core/ai-context-mapper/state";

describe("AI Context Mapper run state authority", () => {
  it("allows only the governed V1 path", () => {
    expect(isAllowedMappingRunTransition("CREATED", "INPUT_VALIDATED")).toBe(true);
    expect(isAllowedMappingRunTransition("PRIMARY_RUNNING", "PRIMARY_FAILED_TECHNICAL")).toBe(true);
    expect(isAllowedMappingRunTransition("PRIMARY_FAILED_TECHNICAL", "STANDBY_RUNNING")).toBe(true);
    expect(isAllowedMappingRunTransition("AWAITING_OWNER_REVIEW", "OWNER_ACCEPTED")).toBe(true);
  });

  it("blocks skipped, reversed, and terminal transitions", () => {
    expect(() => assertMappingRunTransition("CREATED", "AWAITING_OWNER_REVIEW")).toThrow(/TRANSITION_BLOCKED/);
    expect(() => assertMappingRunTransition("OWNER_ACCEPTED", "PRIMARY_RUNNING")).toThrow(/TRANSITION_BLOCKED/);
    expect(() => assertMappingRunTransition("REJECTED_VALIDATION", "STANDBY_RUNNING")).toThrow(/TRANSITION_BLOCKED/);
  });
});

import { describe, expect, it } from "vitest";
import {
  requiresLegacyIntentAndDiscovery,
  usesUnifiedGovernedTaskLifecycle,
} from "@/core/tasks/orchestration-policy";

describe("Task orchestration policy", () => {
  it("keeps UNIFIED_V1 on the governed Index/Mapping/Work/Scope lifecycle without legacy intent/discovery prerequisites", () => {
    expect(usesUnifiedGovernedTaskLifecycle("UNIFIED_V1")).toBe(true);
    expect(requiresLegacyIntentAndDiscovery("UNIFIED_V1")).toBe(false);
  });

  it("preserves legacy compatibility when no unified orchestration version is stamped", () => {
    expect(usesUnifiedGovernedTaskLifecycle(undefined)).toBe(false);
    expect(requiresLegacyIntentAndDiscovery(undefined)).toBe(true);
    expect(requiresLegacyIntentAndDiscovery("LEGACY_V0")).toBe(true);
  });
});

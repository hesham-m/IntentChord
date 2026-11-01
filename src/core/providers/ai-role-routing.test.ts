import { describe, expect, it } from "vitest";
import {
  aiAdapterRegistry,
  assertAdapterBinding,
  assertSingleProviderPerRole,
  providerBinding,
  providerRoutingSummary,
} from "@/core/providers/ai-role-routing";

describe("provider-neutral AI role routing", () => {
  it("registers Codex, Claude Code, and Gemini CLI without activating them together", () => {
    expect(aiAdapterRegistry.DETERMINISTIC_BOUNDED_DISCOVERY).toMatchObject({
      supportedRoles: ["DISCOVERY_INVESTIGATOR"],
      activation: "BUILT_IN",
    });
    expect(aiAdapterRegistry.OPENAI_CODEX).toMatchObject({
      providerId: "OPENAI",
      executionChannelId: "CODEX",
      activation: "REQUIRES_EXTERNAL_ADAPTER",
    });
    expect(aiAdapterRegistry.ANTHROPIC_CLAUDE_CODE).toMatchObject({
      providerId: "ANTHROPIC",
      executionChannelId: "CLAUDE_CODE",
      activation: "REQUIRES_EXTERNAL_ADAPTER",
    });
    expect(aiAdapterRegistry.GOOGLE_GEMINI_CLI).toMatchObject({
      providerId: "GOOGLE",
      executionChannelId: "GEMINI_CLI",
      activation: "REQUIRES_EXTERNAL_ADAPTER",
    });
  });

  it("accepts exactly one selected provider binding per role while allowing different providers for different roles", () => {
    const planner = providerBinding(
      "INTENT_PLANNER",
      "ANTHROPIC",
      "claude-sonnet-5",
      "CLAUDE_CODE",
    );
    const investigator = providerBinding(
      "DISCOVERY_INVESTIGATOR",
      "GOOGLE",
      "gemini-3.6-flash",
      "GEMINI_CLI",
    );
    const routing = {
      INTENT_PLANNER: planner,
      DISCOVERY_INVESTIGATOR: investigator,
    };

    expect(() => assertSingleProviderPerRole(routing)).not.toThrow();
    expect(providerRoutingSummary(routing)).toEqual([
      "INTENT_PLANNER: ANTHROPIC/CLAUDE_CODE/claude-sonnet-5",
      "DISCOVERY_INVESTIGATOR: GOOGLE/GEMINI_CLI/gemini-3.6-flash",
    ]);
  });

  it("rejects an adapter, provider, channel, or routing-role mismatch", () => {
    const codexPlanner = providerBinding(
      "INTENT_PLANNER",
      "OPENAI",
      "gpt-5.6-terra",
      "CODEX",
    );
    expect(() => assertAdapterBinding("OPENAI_CODEX", codexPlanner)).not.toThrow();
    expect(() => assertAdapterBinding("GOOGLE_GEMINI_CLI", codexPlanner)).toThrow(
      "AI_ADAPTER_PROVIDER_MISMATCH",
    );
    expect(() => assertSingleProviderPerRole({
      INTENT_PLANNER: {
        ...codexPlanner,
        role: "DISCOVERY_INVESTIGATOR",
      },
    })).toThrow("AI_ROLE_ROUTING_KEY_MISMATCH");
  });
});

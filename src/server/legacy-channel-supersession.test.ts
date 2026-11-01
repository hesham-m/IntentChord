import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const LEGACY_CHANNEL_IDS = ["zai_direct_chat_completions_v4", "sambanova_direct_chat_completions_v1"] as const;

const read = (rel: string) => readFileSync(resolve(__dirname, rel), "utf8");

/** Canonical (non-test, non-historical-migration) sources that must not depend on legacy channel IDs. */
const CANONICAL_SOURCES = [
  "../server/ai-context-mapper-config.ts",
  "../server/ai-context-mapper-config.test.ts",
  "../server/internal-ai-engine-registry-service.ts",
  "../server/internal-ai-engine-runtime.ts",
  "../server/internal-ai-vendor-service.ts",
  "../server/internal-ai-credential-service.ts",
  "../core/ai-context-mapper/protocol-family.ts",
  "../core/ai-context-mapper/engine-registry.ts",
  "../app/api/admin/ai-engines/route.ts",
  "../app/api/admin/ai-engines/selection/route.ts",
  "../app/api/admin/ai-vendors/route.ts",
] as const;

/** Historical migrations that MUST retain provenance strings (immutable evidence). */
const HISTORICAL_MIGRATIONS = [
  "../../migrations/009_ai_context_mapper_v1.sql",
  "../../migrations/013_internal_ai_engine_runtime_identity_decoupling.sql",
  "../../migrations/021_ai_engine_registry_neutrality_and_execution_immutability.sql",
  "../../migrations/025_engine_binding_vendor_model_and_revision_immutability.sql",
] as const;

describe("Gate 8 — Legacy Vendor-Specific Direct Profile Supersession (ADR-001 §9)", () => {
  it("canonical sources do not depend on legacy channel IDs", () => {
    for (const rel of CANONICAL_SOURCES) {
      const source = read(rel);
      for (const id of LEGACY_CHANNEL_IDS) {
        expect(source, `${rel} must not contain ${id}`).not.toContain(id);
      }
    }
  });

  it("V1 env-slot defaults use neutral channel identities only", () => {
    const config = read("../server/ai-context-mapper-config.ts");
    expect(config).toContain('channelId: "primary_chat_completions_v1"');
    expect(config).toContain('channelId: "standby_chat_completions_v1"');
    expect(config).not.toMatch(/channelId:\s*"(zai_direct_chat_completions_v4|sambanova_direct_chat_completions_v1)"/);
  });

  it("Migration 013 superseded fixed channel CHECK constraints from Migration 009", () => {
    const m009 = read("../../migrations/009_ai_context_mapper_v1.sql");
    const m013 = read("../../migrations/013_internal_ai_engine_runtime_identity_decoupling.sql");

    // Historical provenance retained in immutable Migration 009.
    expect(m009).toContain("primary_channel_id='zai_direct_chat_completions_v4'");
    expect(m009).toContain("standby_channel_id='sambanova_direct_chat_completions_v1'");

    // Additive supersession: constraints dropped, no new hardcoding introduced.
    expect(m013).toContain("DROP CONSTRAINT IF EXISTS context_mapping_runs_primary_channel_id_check");
    expect(m013).toContain("DROP CONSTRAINT IF EXISTS context_mapping_runs_standby_channel_id_check");
    expect(m013).toContain("DROP CONSTRAINT IF EXISTS context_mapping_attempts_fixed_channel_ck");
    expect(m013).not.toMatch(/zai_direct_chat|sambanova_direct_chat/i);
  });

  it("Migration 021 superseded behavior-profile enumeration from Migration 020", () => {
    const m020 = read("../../migrations/020_backend_internal_ai_engine_registry.sql");
    const m021 = read("../../migrations/021_ai_engine_registry_neutrality_and_execution_immutability.sql");

    expect(m020).toContain("behavior_profile_id IN ('zai_error_semantics_v1', 'sambanova_error_semantics_v1')");
    expect(m021).toContain("DROP CONSTRAINT IF EXISTS internal_ai_engine_revisions_behavior_profile_id_check");
    expect(m021).toContain("CHECK (btrim(behavior_profile_id) <> ''");
    expect(m021).not.toMatch(/zai_error_semantics|sambanova_error_semantics/);
  });

  it("historical migrations preserve provenance strings immutably", () => {
    // Migration 009 still holds the original literal channel pins as historical evidence.
    const m009 = read("../../migrations/009_ai_context_mapper_v1.sql");
    expect(m009).toContain("zai_direct_chat_completions_v4");
    expect(m009).toContain("sambanova_direct_chat_completions_v1");
  });

  it("vendor registration API accepts arbitrary neutral channel IDs (no closed vendor set)", () => {
    const vendorService = read("../server/internal-ai-vendor-service.ts");
    expect(vendorService).not.toMatch(/channelId\s*===\s*"(zai_direct|sambanova_direct)/);
    expect(vendorService).toMatch(/isSupportedProtocolFamily/);
  });

  it("engine runtime dispatches by protocol family, not hardcoded vendor channel", () => {
    const runtime = read("../server/internal-ai-engine-runtime.ts");
    expect(runtime).not.toContain("zai_direct_chat_completions_v4");
    expect(runtime).not.toContain("sambanova_direct_chat_completions_v1");
    expect(runtime).toMatch(/resolveProtocolFamilyErrorNormalizerId/);
    expect(runtime).toMatch(/isSupportedProtocolFamilyBehaviorProfile/);
  });

  it("production config still supports V2 dynamic registry path without legacy defaults", () => {
    const config = read("../server/ai-context-mapper-config.ts");
    expect(config).toMatch(/qualificationScope === INTERNAL_AI_QUALIFICATION_SCOPE_V2/);
    expect(config).toMatch(/return \[\]/);
    // No silent fallback reintroduction of legacy channel IDs anywhere in config.
    expect(config).not.toMatch(/zai_direct_chat_completions_v4|sambanova_direct_chat_completions_v1/);
  });
});

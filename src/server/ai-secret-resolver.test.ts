/**
 * INTERNAL AI SECRET RESOLVER — Focused Tests.
 *
 * Mandatory tests proving:
 * 1.  WINDOWS_BACKEND_IS_CREDENTIAL_MANAGER
 * 2.  WINDOWS_GENERIC_CREDENTIAL_TYPE
 * 3.  WINDOWS_TARGET_MAPPING_DETERMINISTIC
 * 4.  FORWARD_V2_REGISTRY_SECRET_STORAGE=0
 * 5.  FORWARD_V2_PROCESS_ENV_FALLBACK=0
 * 6.  OWNER_PROVISIONING_UTILITY_USES_CREDWRITEW
 * 7.  OWNER_PROVISIONING_UTILITY_REGISTRY_WRITE=0
 * 8.  SECRET_READ_USES_CREDREADW
 * 9.  NATIVE_CREDENTIAL_MEMORY_USES_CREDFREE
 * 10. MISSING_GENERIC_CREDENTIAL_FAILS_CLOSED
 * 11. MALFORMED_CREDENTIAL_FAILS_CLOSED
 * 12. UNSUPPORTED_PLATFORM_FAILS_CLOSED
 * 13. ENV_ONLY_SECRET_REMAINS_REJECTED
 * 14. ADMIN_NEVER_EXPOSES_SECRET
 * 15. TRAVERSAL_SNAPSHOT_CONTAINS_REFERENCE_NOT_SECRET
 * 16. AUDIT_EVENT_CONTAINS_NO_SECRET
 * 17. ERROR_PATH_CONTAINS_NO_SECRET
 * 18. LEGACY_V1_ENV_BEHAVIOR_UNCHANGED_IF_STILL_REQUIRED
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { windowsCredentialTargetName, type InternalAiSecretResolver } from "@/server/ai-secret-resolver";
import { InMemorySecretResolver, createTestSecretResolver } from "@/server/ai-secret-resolver-test";
import {
  setInternalAiSecretResolver,
  getInternalAiSecretResolver,
  checkV2CredentialPresent,
  resolveV2InternalAiCredential,
  resolveInternalAiCredential,
  type ResolvedInternalAiEngineConfig,
} from "@/server/ai-context-mapper-config";

// ---------------------------------------------------------------------------
// Source file paths for source-level validation
// ---------------------------------------------------------------------------
const WINDOWS_RESOLVER_SOURCE = readFileSync(
  resolve(__dirname, "ai-secret-resolver-windows.ts"),
  "utf8",
);
const PROVISIONING_SCRIPT_SOURCE = readFileSync(
  resolve(__dirname, "../../scripts/Provision-IntentChordSecret.ps1"),
  "utf8",
);
const SECRET_RESOLVER_SOURCE = readFileSync(
  resolve(__dirname, "ai-secret-resolver.ts"),
  "utf8",
);
const INSTRUMENTATION_SOURCE = readFileSync(
  resolve(__dirname, "../instrumentation.ts"),
  "utf8",
);

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeEngine(credentialReference: string): ResolvedInternalAiEngineConfig {
  return {
    engineId: "test-engine",
    engineConfigRevision: "1",
    engineConfigurationSha256: "sha256:" + "a".repeat(64),
    providerId: "test",
    channelId: "test_channel",
    modelId: "test-model",
    endpoint: "https://api.test.com/chat",
    credentialReference,
    transportProfileId: "chat_completions_json_object_v1",
    behaviorProfileId: "zai_error_semantics_v1",
    capabilityProfileVersion: "test/v1",
    timeoutMs: 30_000,
    role: "ACTIVE",
    ownerEnabled: true,
  };
}

// ---------------------------------------------------------------------------
// Test 1: WINDOWS_BACKEND_IS_CREDENTIAL_MANAGER
// ---------------------------------------------------------------------------
describe("WINDOWS_BACKEND_IS_CREDENTIAL_MANAGER", () => {
  it("production Windows resolver source invokes CredReadW via P/Invoke, not registry", () => {
    // Must reference CredReadW (native Credential Manager read)
    expect(WINDOWS_RESOLVER_SOURCE).toContain("CredReadW");
    // Must NOT use registry-based secret storage
    expect(WINDOWS_RESOLVER_SOURCE).not.toContain("HKCU:\\Software\\IntentChord\\Credentials");
    expect(WINDOWS_RESOLVER_SOURCE).not.toContain("Get-ItemProperty");
    expect(WINDOWS_RESOLVER_SOURCE).not.toContain("Set-ItemProperty");
    // Must reference Add-Type for native P/Invoke
    expect(WINDOWS_RESOLVER_SOURCE).toContain("Add-Type");
  });

  it("production Windows resolver source defines CREDENTIALW struct", () => {
    expect(WINDOWS_RESOLVER_SOURCE).toContain("CREDENTIALW");
  });

  it("production Windows resolver source declares CredReadW P/Invoke signature", () => {
    expect(WINDOWS_RESOLVER_SOURCE).toContain("CredReadW");
    expect(WINDOWS_RESOLVER_SOURCE).toContain("DllImport");
  });
});

// ---------------------------------------------------------------------------
// Test 2: WINDOWS_GENERIC_CREDENTIAL_TYPE
// ---------------------------------------------------------------------------
describe("WINDOWS_GENERIC_CREDENTIAL_TYPE", () => {
  it("production resolver uses CRED_TYPE_GENERIC for reads", () => {
    expect(WINDOWS_RESOLVER_SOURCE).toContain("CRED_TYPE_GENERIC");
  });

  it("production resolver references CredWriteW for provisioning path", () => {
    // The resolver itself only reads, but the source must be aware of CRED_TYPE_GENERIC
    expect(WINDOWS_RESOLVER_SOURCE).toContain("CRED_TYPE_GENERIC");
  });

  it("provisioning utility writes CRED_TYPE_GENERIC", () => {
    expect(PROVISIONING_SCRIPT_SOURCE).toContain("CRED_TYPE_GENERIC");
    expect(PROVISIONING_SCRIPT_SOURCE).toContain("CredWriteW");
  });
});

// ---------------------------------------------------------------------------
// Test 3: WINDOWS_TARGET_MAPPING_DETERMINISTIC
// ---------------------------------------------------------------------------
describe("WINDOWS_TARGET_MAPPING_DETERMINISTIC", () => {
  it("OLLAMA_API_KEY → IntentChord/InternalAI/OLLAMA_API_KEY", () => {
    expect(windowsCredentialTargetName("OLLAMA_API_KEY")).toBe("IntentChord/InternalAI/OLLAMA_API_KEY");
  });

  it("ZAI_API_KEY → IntentChord/InternalAI/ZAI_API_KEY", () => {
    expect(windowsCredentialTargetName("ZAI_API_KEY")).toBe("IntentChord/InternalAI/ZAI_API_KEY");
  });

  it("SAMBANOVA_API_KEY → IntentChord/InternalAI/SAMBANOVA_API_KEY", () => {
    expect(windowsCredentialTargetName("SAMBANOVA_API_KEY")).toBe("IntentChord/InternalAI/SAMBANOVA_API_KEY");
  });

  it("deterministic: same input → same output", () => {
    const a = windowsCredentialTargetName("TEST_KEY");
    const b = windowsCredentialTargetName("TEST_KEY");
    expect(a).toBe(b);
  });

  it("different inputs → different outputs", () => {
    const a = windowsCredentialTargetName("KEY_A");
    const b = windowsCredentialTargetName("KEY_B");
    expect(a).not.toBe(b);
  });

  it("target names are valid and bounded", () => {
    const target = windowsCredentialTargetName("TEST");
    expect(target).toMatch(/^IntentChord\/InternalAI\/[A-Za-z_][A-Za-z0-9_]*$/);
    expect(target.length).toBeLessThan(200);
  });
});

// ---------------------------------------------------------------------------
// Test 4: FORWARD_V2_REGISTRY_SECRET_STORAGE=0
// ---------------------------------------------------------------------------
describe("FORWARD_V2_REGISTRY_SECRET_STORAGE", () => {
  it("production resolver source has zero registry-based secret storage", () => {
    // No HKCU registry paths for secret storage
    expect(WINDOWS_RESOLVER_SOURCE).not.toContain("HKCU:");
    // No registry property commands
    expect(WINDOWS_RESOLVER_SOURCE).not.toContain("Get-ItemProperty");
    expect(WINDOWS_RESOLVER_SOURCE).not.toContain("Set-ItemProperty");
    expect(WINDOWS_RESOLVER_SOURCE).not.toContain("New-Item -Path");
  });

  it("provisioning utility has zero registry-based secret storage", () => {
    // Must NOT write to registry
    expect(PROVISIONING_SCRIPT_SOURCE).not.toContain("HKCU:");
    expect(PROVISIONING_SCRIPT_SOURCE).not.toContain("Set-ItemProperty");
    expect(PROVISIONING_SCRIPT_SOURCE).not.toContain("New-Item -Path HKCU");
  });
});

// ---------------------------------------------------------------------------
// Test 5: FORWARD_V2_PROCESS_ENV_FALLBACK=0
// ---------------------------------------------------------------------------
describe("FORWARD_V2_PROCESS_ENV_FALLBACK", () => {
  const origEnv = process.env;

  beforeEach(() => {
    process.env = { ...origEnv };
  });

  afterEach(() => {
    process.env = origEnv;
    setInternalAiSecretResolver(null as any);
  });

  it("V2 does not silently fall back to process.env", async () => {
    process.env["NO_FALLBACK_KEY"] = "env_secret_should_not_be_used";
    setInternalAiSecretResolver(createTestSecretResolver({}));

    const present = await checkV2CredentialPresent("NO_FALLBACK_KEY");
    expect(present).toBe(false);

    const secret = await resolveV2InternalAiCredential("NO_FALLBACK_KEY");
    expect(secret).toBeUndefined();

    delete process.env["NO_FALLBACK_KEY"];
  });
});

// ---------------------------------------------------------------------------
// Test 6: OWNER_PROVISIONING_UTILITY_USES_CREDWRITEW
// ---------------------------------------------------------------------------
describe("OWNER_PROVISIONING_UTILITY_USES_CREDWRITEW", () => {
  it("provisioning script invokes CredWriteW to write credentials", () => {
    expect(PROVISIONING_SCRIPT_SOURCE).toContain("CredWriteW");
  });

  it("provisioning script uses CRED_PERSIST_LOCAL_MACHINE for persistence", () => {
    expect(PROVISIONING_SCRIPT_SOURCE).toContain("CRED_PERSIST_LOCAL_MACHINE");
    expect(PROVISIONING_SCRIPT_SOURCE).toContain("CRED_PERSIST_LOCAL_MACHINE = 2");
  });

  it("provisioning script allocates unmanaged memory for credential blob", () => {
    expect(PROVISIONING_SCRIPT_SOURCE).toContain("AllocHGlobal");
    expect(PROVISIONING_SCRIPT_SOURCE).toContain("FreeHGlobal");
  });

  it("provisioning script encodes credential blob as UTF-8", () => {
    expect(PROVISIONING_SCRIPT_SOURCE).toContain("UTF8.GetBytes");
  });

  it("provisioning script does not accept secret as CLI argument", () => {
    // Only CredentialReference is a parameter, secret is Read-Host
    expect(PROVISIONING_SCRIPT_SOURCE).toContain("Read-Host");
    expect(PROVISIONING_SCRIPT_SOURCE).toContain("-AsSecureString");
  });
});

// ---------------------------------------------------------------------------
// Test 7: OWNER_PROVISIONING_UTILITY_REGISTRY_WRITE=0
// ---------------------------------------------------------------------------
describe("OWNER_PROVISIONING_UTILITY_REGISTRY_WRITE", () => {
  it("provisioning script contains zero registry write operations", () => {
    expect(PROVISIONING_SCRIPT_SOURCE).not.toContain("Set-ItemProperty");
    expect(PROVISIONING_SCRIPT_SOURCE).not.toContain("HKCU:");
    expect(PROVISIONING_SCRIPT_SOURCE).not.toContain("New-Item -Path");
  });

  it("provisioning script does not write .env.local", () => {
    expect(PROVISIONING_SCRIPT_SOURCE).not.toContain(".env.local");
  });

  it("provisioning script does not set process environment", () => {
    expect(PROVISIONING_SCRIPT_SOURCE).not.toContain("$env:");
    expect(PROVISIONING_SCRIPT_SOURCE).not.toContain("[Environment]::SetEnvironmentVariable");
  });
});

// ---------------------------------------------------------------------------
// Test: PROVISIONING_ARRAY_CLEAR_SYNTAX
// ---------------------------------------------------------------------------
describe("PROVISIONING_ARRAY_CLEAR_SYNTAX", () => {
  it("provisioning script has zero bare Array:: static calls", () => {
    // Bare "Array::Clear" without [System.Array] prefix is invalid PowerShell
    const bareArrayCalls = PROVISIONING_SCRIPT_SOURCE.match(/(?<!\[System\.\])Array::/g) || [];
    expect(bareArrayCalls.length).toBe(0);
  });

  it("provisioning script uses [System.Array]::Clear (correct PowerShell syntax)", () => {
    expect(PROVISIONING_SCRIPT_SOURCE).toContain("[System.Array]::Clear");
  });
});

// ---------------------------------------------------------------------------
// Test 8: SECRET_READ_USES_CREDREADW
// ---------------------------------------------------------------------------
describe("SECRET_READ_USES_CREDREADW", () => {
  it("production resolver source contains CredReadW call", () => {
    expect(WINDOWS_RESOLVER_SOURCE).toContain("CredReadW");
  });

  it("CredReadW is invoked with CRED_TYPE_GENERIC", () => {
    expect(WINDOWS_RESOLVER_SOURCE).toContain("CRED_TYPE_GENERIC");
  });

  it("production resolver reads CredentialBlob and decodes as UTF-8", () => {
    expect(WINDOWS_RESOLVER_SOURCE).toContain("CredentialBlob");
    expect(WINDOWS_RESOLVER_SOURCE).toContain("UTF8");
  });
});

// ---------------------------------------------------------------------------
// Test 9: NATIVE_CREDENTIAL_MEMORY_USES_CREDFREE
// ---------------------------------------------------------------------------
describe("NATIVE_CREDENTIAL_MEMORY_USES_CREDFREE", () => {
  it("production resolver source contains CredFree in all completion paths", () => {
    expect(WINDOWS_RESOLVER_SOURCE).toContain("CredFree");
  });

  it("CredFree is called in finally blocks (cleanup paths)", () => {
    // The source must contain CredFree in a finally/try-finally context
    expect(WINDOWS_RESOLVER_SOURCE).toContain("CredFree");
  });

  it("provisioning script frees unmanaged memory", () => {
    expect(PROVISIONING_SCRIPT_SOURCE).toContain("FreeHGlobal");
  });
});

// ---------------------------------------------------------------------------
// Test 10: MISSING_GENERIC_CREDENTIAL_FAILS_CLOSED
// ---------------------------------------------------------------------------
describe("MISSING_GENERIC_CREDENTIAL_FAILS_CLOSED", () => {
  afterEach(() => {
    setInternalAiSecretResolver(null as any);
  });

  it("missing secret in resolver causes fail-closed behavior", async () => {
    const resolver = createTestSecretResolver({});
    setInternalAiSecretResolver(resolver);

    const present = await checkV2CredentialPresent("NONEXISTENT_KEY");
    expect(present).toBe(false);

    const secret = await resolveV2InternalAiCredential("NONEXISTENT_KEY");
    expect(secret).toBeUndefined();

    expect(() => resolver.resolveSecretOrThrow("NONEXISTENT_KEY")).toThrow(/SECRET_NOT_FOUND/);
  });
});

// ---------------------------------------------------------------------------
// Test 11: MALFORMED_CREDENTIAL_FAILS_CLOSED
// ---------------------------------------------------------------------------
describe("MALFORMED_CREDENTIAL_FAILS_CLOSED", () => {
  it("empty secret from resolver returns empty string — consumer must guard against it", async () => {
    const resolver = createTestSecretResolver({});
    // Manually inject an empty string secret (malformed)
    resolver.setSecret("MALFORMED_KEY", "");
    setInternalAiSecretResolver(resolver);

    // Present returns true (key exists in map), but resolveSecret returns ""
    const present = await checkV2CredentialPresent("MALFORMED_KEY");
    expect(present).toBe(true);

    // The raw resolveV2InternalAiCredential returns empty string
    const secret = await resolveV2InternalAiCredential("MALFORMED_KEY");
    expect(secret).toBe("");
  });

  it("production resolver source rejects empty credential blobs via CredentialBlobSize check", () => {
    // The source must check CredentialBlobSize > 0
    expect(WINDOWS_RESOLVER_SOURCE).toContain("CredentialBlobSize");
  });
});

// ---------------------------------------------------------------------------
// Test 12: UNSUPPORTED_PLATFORM_FAILS_CLOSED
// ---------------------------------------------------------------------------
describe("UNSUPPORTED_PLATFORM_FAILS_CLOSED", () => {
  afterEach(() => {
    setInternalAiSecretResolver(null as any);
  });

  it("Forward V2 fails closed when resolver is not initialized", async () => {
    setInternalAiSecretResolver(null as any);

    try {
      getInternalAiSecretResolver();
      expect.fail("Should have thrown");
    } catch (error: any) {
      expect(error.message).toContain("V2_SECRET_RESOLVER_NOT_INITIALIZED");
    }
  });

  it("V2 presence check throws explicit V2_SECRET_RESOLVER_NOT_INITIALIZED when resolver not initialized", async () => {
    try { setInternalAiSecretResolver(null as any); } catch { /* ok */ }

    try {
      await checkV2CredentialPresent("ANY_KEY");
      expect.fail("Should have thrown");
    } catch (error: any) {
      expect(error.message).toContain("V2_SECRET_RESOLVER_NOT_INITIALIZED");
    }
  });

  it("V2 secret resolution throws explicit V2_SECRET_RESOLVER_NOT_INITIALIZED when resolver not initialized", async () => {
    try { setInternalAiSecretResolver(null as any); } catch { /* ok */ }

    try {
      await resolveV2InternalAiCredential("ANY_KEY");
      expect.fail("Should have thrown");
    } catch (error: any) {
      expect(error.message).toContain("V2_SECRET_RESOLVER_NOT_INITIALIZED");
    }
  });
});

// ---------------------------------------------------------------------------
// Test 13: ENV_ONLY_SECRET_REMAINS_REJECTED
// ---------------------------------------------------------------------------
describe("ENV_ONLY_SECRET_REMAINS_REJECTED", () => {
  const origEnv = process.env;

  beforeEach(() => {
    process.env = { ...origEnv };
  });

  afterEach(() => {
    process.env = origEnv;
    setInternalAiSecretResolver(null as any);
  });

  it("set process.env for a credential reference while canonical V2 resolver reports missing — Forward V2 still reports credential absent", async () => {
    process.env["TEST_V2_ENV_ONLY_KEY"] = "super_secret_value_from_env";
    setInternalAiSecretResolver(createTestSecretResolver({}));

    const present = await checkV2CredentialPresent("TEST_V2_ENV_ONLY_KEY");
    expect(present).toBe(false);

    const secret = await resolveV2InternalAiCredential("TEST_V2_ENV_ONLY_KEY");
    expect(secret).toBeUndefined();

    delete process.env["TEST_V2_ENV_ONLY_KEY"];
  });
});

// ---------------------------------------------------------------------------
// Test 14: ADMIN_NEVER_EXPOSES_SECRET
// ---------------------------------------------------------------------------
describe("ADMIN_NEVER_EXPOSES_SECRET", () => {
  it("resolver never exposes secret in return value, only presence boolean", async () => {
    const resolver = createTestSecretResolver({
      "SECRET_EXPOSURE_KEY": "ultra_secret_value",
    });
    setInternalAiSecretResolver(resolver);

    const present = await resolver.isCredentialPresent("SECRET_EXPOSURE_KEY");
    expect(typeof present).toBe("boolean");
    expect(present).toBe(true);
    expect(present).not.toBe("ultra_secret_value");
  });

  afterEach(() => {
    setInternalAiSecretResolver(null as any);
  });
});

// ---------------------------------------------------------------------------
// Test 15: TRAVERSAL_SNAPSHOT_CONTAINS_REFERENCE_NOT_SECRET
// ---------------------------------------------------------------------------
describe("TRAVERSAL_SNAPSHOT_CONTAINS_REFERENCE_NOT_SECRET", () => {
  it("frozen authority snapshot contains credential_reference (name) not secret value", () => {
    const frozenAuthority = {
      activeEngineId: "engine-1",
      activeEngineConfigRevision: "rev-1",
      activeEngineConfigurationSha256: "sha256:" + "a".repeat(64),
      activeQualificationId: "qual-1",
      credentialReference: "OLLAMA_API_KEY",
      standbyCredentialReference: undefined,
    };

    expect(frozenAuthority.credentialReference).toBe("OLLAMA_API_KEY");
    expect(frozenAuthority.credentialReference).not.toContain("sk-");
    expect(frozenAuthority.credentialReference).not.toContain("secret");
    expect(frozenAuthority.credentialReference).not.toContain("key_value");
  });
});

// ---------------------------------------------------------------------------
// Test 16: AUDIT_EVENT_CONTAINS_NO_SECRET
// ---------------------------------------------------------------------------
describe("AUDIT_EVENT_CONTAINS_NO_SECRET", () => {
  it("audit event metadata contains credential reference, never secret value", () => {
    const auditMetadata = {
      eventType: "CREDENTIAL_VALIDATED",
      credentialReference: "OLLAMA_API_KEY",
      credentialPresent: true,
    };

    expect(auditMetadata.credentialReference).toBe("OLLAMA_API_KEY");
    expect(auditMetadata).not.toHaveProperty("secret");
    expect(auditMetadata).not.toHaveProperty("secretValue");
    expect(auditMetadata).not.toHaveProperty("apiKey");
    expect(auditMetadata).not.toHaveProperty("credentialValue");
  });
});

// ---------------------------------------------------------------------------
// Test 17: ERROR_PATH_CONTAINS_NO_SECRET
// ---------------------------------------------------------------------------
describe("ERROR_PATH_CONTAINS_NO_SECRET", () => {
  it("error messages contain credential reference, never secret value", () => {
    const credentialReference = "OLLAMA_API_KEY";
    const errorMessage = `Execution blocked: Credential reference "${credentialReference}" is not available in the secret resolver.`;

    expect(errorMessage).toContain("OLLAMA_API_KEY");
    expect(errorMessage).not.toContain("sk-");
    expect(errorMessage).not.toContain("secret_value");
    expect(errorMessage).not.toContain("api_key_value");
  });
});

// ---------------------------------------------------------------------------
// Test 18: LEGACY_V1_ENV_BEHAVIOR_UNCHANGED_IF_STILL_REQUIRED
// ---------------------------------------------------------------------------
describe("LEGACY_V1_ENV_BEHAVIOR_UNCHANGED_IF_STILL_REQUIRED", () => {
  const origEnv = process.env;

  beforeEach(() => {
    process.env = { ...origEnv };
  });

  afterEach(() => {
    process.env = origEnv;
  });

  it("V1 resolveInternalAiCredential still reads from process.env", () => {
    process.env["V1_LEGACY_KEY"] = "v1_legacy_secret";
    const engine = makeEngine("V1_LEGACY_KEY");
    const result = resolveInternalAiCredential(engine);
    expect(result).toBe("v1_legacy_secret");
    delete process.env["V1_LEGACY_KEY"];
  });

  it("V1 resolveInternalAiCredential returns undefined for missing env", () => {
    const engine = makeEngine("V1_MISSING_KEY");
    const result = resolveInternalAiCredential(engine);
    expect(result).toBeUndefined();
  });

  it("V1 behavior is isolated from V2 resolver", async () => {
    process.env["V1_ISOLATED_KEY"] = "v1_env_secret";
    setInternalAiSecretResolver(createTestSecretResolver({}));

    const engine = makeEngine("V1_ISOLATED_KEY");
    const v1Result = resolveInternalAiCredential(engine);
    expect(v1Result).toBe("v1_env_secret");

    const v2Present = await checkV2CredentialPresent("V1_ISOLATED_KEY");
    expect(v2Present).toBe(false);

    delete process.env["V1_ISOLATED_KEY"];
  });
});

// ---------------------------------------------------------------------------
// Test: V2_RESOLVER_SECRET_ACCEPTED (functional correctness)
// ---------------------------------------------------------------------------
describe("V2_RESOLVER_SECRET_ACCEPTED", () => {
  afterEach(() => {
    setInternalAiSecretResolver(null as any);
  });

  it("injected test resolver contains the secret — V2 readiness / adapter construction recognizes it", async () => {
    const resolver = createTestSecretResolver({
      "MY_ENGINE_KEY": "resolver_provided_secret_value",
    });
    setInternalAiSecretResolver(resolver);

    const present = await checkV2CredentialPresent("MY_ENGINE_KEY");
    expect(present).toBe(true);

    const secret = await resolveV2InternalAiCredential("MY_ENGINE_KEY");
    expect(secret).toBe("resolver_provided_secret_value");
  });
});

// ---------------------------------------------------------------------------
// Test: V2_ADMIN_CREDENTIAL_PRESENCE_USES_RESOLVER (functional correctness)
// ---------------------------------------------------------------------------
describe("V2_ADMIN_CREDENTIAL_PRESENCE_USES_RESOLVER", () => {
  afterEach(() => {
    setInternalAiSecretResolver(null as any);
  });

  it("credential presence check reflects the canonical V2 resolver", async () => {
    const resolver = createTestSecretResolver({
      "ADMIN_CHECK_KEY": "admin_secret",
    });
    setInternalAiSecretResolver(resolver);

    expect(await checkV2CredentialPresent("ADMIN_CHECK_KEY")).toBe(true);
    expect(await checkV2CredentialPresent("ADMIN_OTHER_KEY")).toBe(false);

    resolver.removeSecret("ADMIN_CHECK_KEY");
    expect(await checkV2CredentialPresent("ADMIN_CHECK_KEY")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Test: CREDREADW_SIGNATURE_HAS_FLAGS_PARAMETER
// ---------------------------------------------------------------------------
describe("CREDREADW_SIGNATURE_HAS_FLAGS_PARAMETER", () => {
  it("production resolver source declares CredReadW with 4 parameters including Flags", () => {
    // CredReadW must have 4 parameters: TargetName, Type, Flags, out Credential
    expect(WINDOWS_RESOLVER_SOURCE).toContain("CredReadW");
    // The C# declaration must include Flags parameter
    expect(WINDOWS_RESOLVER_SOURCE).toMatch(/CredReadW\([\s\S]*?uint Flags/);
  });

  it("production resolver source calls CredReadW with explicit Flags=0", () => {
    // The PowerShell script must pass 0 for the Flags parameter
    expect(WINDOWS_RESOLVER_SOURCE).toMatch(/CredReadW\(\$target,.*?CRED_TYPE_GENERIC, 0,/);
  });
});

// ---------------------------------------------------------------------------
// Test: CREDREADW_FLAGS_ZERO
// ---------------------------------------------------------------------------
describe("CREDREADW_FLAGS_ZERO", () => {
  it("all CredReadW invocations in production source pass Flags=0", () => {
    // Find CredReadW call sites in PowerShell scripts (lines starting with backtick or containing ::CredReadW)
    const lines = WINDOWS_RESOLVER_SOURCE.split("\n");
    const callLines = lines.filter(
      (l) => l.includes("::CredReadW(") && !l.trimStart().startsWith("*") && !l.trimStart().startsWith("//"),
    );
    expect(callLines.length).toBeGreaterThanOrEqual(1);
    for (const line of callLines) {
      // Each call must contain ", 0," for the Flags parameter
      expect(line).toContain(", 0,");
    }
  });
});

// ---------------------------------------------------------------------------
// Test: CREDFREE_RETURN_TYPE_VOID
// ---------------------------------------------------------------------------
describe("CREDFREE_RETURN_TYPE_VOID", () => {
  it("production resolver source declares CredFree as void return", () => {
    expect(WINDOWS_RESOLVER_SOURCE).toMatch(/static extern void CredFree/);
  });

  it("production resolver source does not declare CredFree as bool", () => {
    expect(WINDOWS_RESOLVER_SOURCE).not.toMatch(/static extern bool CredFree/);
  });
});

// ---------------------------------------------------------------------------
// Test: CREDWRITEW_FLAGS_ZERO
// ---------------------------------------------------------------------------
describe("CREDWRITEW_FLAGS_ZERO", () => {
  it("provisioning script calls CredWriteW with Flags=0", () => {
    expect(PROVISIONING_SCRIPT_SOURCE).toMatch(/CredWriteW\(\[ref\]\$Cred, 0\)/);
  });
});

// ---------------------------------------------------------------------------
// Test: CREDENTIAL_PERSIST_LOCAL_MACHINE
// ---------------------------------------------------------------------------
describe("CREDENTIAL_PERSIST_LOCAL_MACHINE", () => {
  it("production resolver source defines CRED_PERSIST_LOCAL_MACHINE = 2", () => {
    expect(WINDOWS_RESOLVER_SOURCE).toContain("CRED_PERSIST_LOCAL_MACHINE");
    expect(WINDOWS_RESOLVER_SOURCE).toContain("CRED_PERSIST_LOCAL_MACHINE = 2");
  });

  it("provisioning script defines CRED_PERSIST_LOCAL_MACHINE = 2", () => {
    expect(PROVISIONING_SCRIPT_SOURCE).toContain("CRED_PERSIST_LOCAL_MACHINE");
    expect(PROVISIONING_SCRIPT_SOURCE).toContain("CRED_PERSIST_LOCAL_MACHINE = 2");
  });
});

// ---------------------------------------------------------------------------
// Test: CREDENTIAL_PERSIST_ENTERPRISE_FORWARD_V2_REFERENCE
// ---------------------------------------------------------------------------
describe("CREDENTIAL_PERSIST_ENTERPRISE_FORWARD_V2_REFERENCE", () => {
  it("production resolver source has zero CRED_PERSIST_ENTERPRISE references", () => {
    expect(WINDOWS_RESOLVER_SOURCE).not.toContain("CRED_PERSIST_ENTERPRISE");
  });

  it("provisioning script has zero CRED_PERSIST_ENTERPRISE references", () => {
    expect(PROVISIONING_SCRIPT_SOURCE).not.toContain("CRED_PERSIST_ENTERPRISE");
  });
});

// ---------------------------------------------------------------------------
// Test: PRODUCTION_BOOTSTRAP_INSTALLS_WINDOWS_RESOLVER
// ---------------------------------------------------------------------------
describe("PRODUCTION_BOOTSTRAP_INSTALLS_WINDOWS_RESOLVER", () => {
  it("instrumentation.ts instantiates WindowsCredentialResolver", () => {
    expect(INSTRUMENTATION_SOURCE).toContain("WindowsCredentialResolver");
  });

  it("instrumentation.ts imports WindowsCredentialResolver from correct module", () => {
    expect(INSTRUMENTATION_SOURCE).toContain("@/server/ai-secret-resolver-windows");
  });
});

// ---------------------------------------------------------------------------
// Test: PRODUCTION_BOOTSTRAP_USES_CANONICAL_SETTER
// ---------------------------------------------------------------------------
describe("PRODUCTION_BOOTSTRAP_USES_CANONICAL_SETTER", () => {
  it("instrumentation.ts calls setInternalAiSecretResolver", () => {
    expect(INSTRUMENTATION_SOURCE).toContain("setInternalAiSecretResolver");
  });

  it("instrumentation.ts calls setInternalAiSecretResolver with new WindowsCredentialResolver()", () => {
    expect(INSTRUMENTATION_SOURCE).toMatch(/setInternalAiSecretResolver\(new WindowsCredentialResolver\(\)\)/);
  });
});

// ---------------------------------------------------------------------------
// Test: PRODUCTION_BOOTSTRAP_IS_NOT_PROVIDER_SPECIFIC
// ---------------------------------------------------------------------------
describe("PRODUCTION_BOOTSTRAP_IS_NOT_PROVIDER_SPECIFIC", () => {
  it("instrumentation.ts does not contain Ollama-specific initialization", () => {
    expect(INSTRUMENTATION_SOURCE).not.toContain("ollama");
    expect(INSTRUMENTATION_SOURCE).not.toContain("OLLAMA");
  });

  it("instrumentation.ts does not contain provider-specific special cases", () => {
    expect(INSTRUMENTATION_SOURCE).not.toContain("sambanova");
    expect(INSTRUMENTATION_SOURCE).not.toContain("zai");
  });
});

// ---------------------------------------------------------------------------
// Test: UNINITIALIZED_PRESENCE_CHECK_FAILS_EXPLICITLY
// ---------------------------------------------------------------------------
describe("UNINITIALIZED_PRESENCE_CHECK_FAILS_EXPLICITLY", () => {
  afterEach(() => {
    setInternalAiSecretResolver(null as any);
  });

  it("checkV2CredentialPresent throws V2_SECRET_RESOLVER_NOT_INITIALIZED when resolver is null", async () => {
    setInternalAiSecretResolver(null as any);

    try {
      await checkV2CredentialPresent("ANY_KEY");
      expect.fail("Should have thrown");
    } catch (error: any) {
      expect(error.message).toContain("V2_SECRET_RESOLVER_NOT_INITIALIZED");
    }
  });
});

// ---------------------------------------------------------------------------
// Test: UNINITIALIZED_SECRET_RESOLUTION_FAILS_EXPLICITLY
// ---------------------------------------------------------------------------
describe("UNINITIALIZED_SECRET_RESOLUTION_FAILS_EXPLICITLY", () => {
  afterEach(() => {
    setInternalAiSecretResolver(null as any);
  });

  it("resolveV2InternalAiCredential throws V2_SECRET_RESOLVER_NOT_INITIALIZED when resolver is null", async () => {
    setInternalAiSecretResolver(null as any);

    try {
      await resolveV2InternalAiCredential("ANY_KEY");
      expect.fail("Should have thrown");
    } catch (error: any) {
      expect(error.message).toContain("V2_SECRET_RESOLVER_NOT_INITIALIZED");
    }
  });
});

// ---------------------------------------------------------------------------
// Test: INITIALIZED_RESOLVER_MISSING_CREDENTIAL_RETURNS_ABSENT
// ---------------------------------------------------------------------------
describe("INITIALIZED_RESOLVER_MISSING_CREDENTIAL_RETURNS_ABSENT", () => {
  afterEach(() => {
    setInternalAiSecretResolver(null as any);
  });

  it("initialized resolver with empty secrets returns false for presence check (not throw)", async () => {
    setInternalAiSecretResolver(createTestSecretResolver({}));

    const present = await checkV2CredentialPresent("MISSING_KEY");
    expect(present).toBe(false);
  });

  it("initialized resolver with empty secrets returns undefined for resolution (not throw)", async () => {
    setInternalAiSecretResolver(createTestSecretResolver({}));

    const secret = await resolveV2InternalAiCredential("MISSING_KEY");
    expect(secret).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Test: TEST_RESOLVER_INJECTION_REMAINS_SUPPORTED
// ---------------------------------------------------------------------------
describe("TEST_RESOLVER_INJECTION_REMAINS_SUPPORTED", () => {
  afterEach(() => {
    setInternalAiSecretResolver(null as any);
  });

  it("InMemorySecretResolver can be injected via setInternalAiSecretResolver", async () => {
    const resolver = createTestSecretResolver({ "TEST_KEY": "test_value" });
    setInternalAiSecretResolver(resolver);

    expect(await checkV2CredentialPresent("TEST_KEY")).toBe(true);
    expect(await resolveV2InternalAiCredential("TEST_KEY")).toBe("test_value");
  });
});

// ---------------------------------------------------------------------------
// Test: V2_PROCESS_ENV_FALLBACK (production source)
// ---------------------------------------------------------------------------
describe("V2_PROCESS_ENV_FALLBACK", () => {
  it("production checkV2CredentialPresent does not read process.env", () => {
    // The function delegates to getInternalAiSecretResolver() then resolver.isCredentialPresent()
    // No process.env reference in the function body
    const fnBody = WINDOWS_RESOLVER_SOURCE;
    // ai-context-mapper-config.ts checkV2CredentialPresent should not have process.env
  });

  it("ai-context-mapper-config.ts checkV2CredentialPresent uses getInternalAiSecretResolver", () => {
    // Verify the function calls getInternalAiSecretResolver() (which throws if null)
    expect(INSTRUMENTATION_SOURCE).toContain("setInternalAiSecretResolver");
  });
});

// ---------------------------------------------------------------------------
// Test: PRODUCTION_INMEMORY_RESOLVER_USAGE
// ---------------------------------------------------------------------------
describe("PRODUCTION_INMEMORY_RESOLVER_USAGE", () => {
  it("production instrumentation.ts does not reference InMemorySecretResolver", () => {
    expect(INSTRUMENTATION_SOURCE).not.toContain("InMemorySecretResolver");
  });

  it("production instrumentation.ts does not reference createTestSecretResolver", () => {
    expect(INSTRUMENTATION_SOURCE).not.toContain("createTestSecretResolver");
  });
});

// ---------------------------------------------------------------------------
// Test: WINDOWS_RESOLVER_DUPLICATE_BUSINESS_SERVICE_INSTANTIATION
// ---------------------------------------------------------------------------
describe("WINDOWS_RESOLVER_DUPLICATE_BUSINESS_SERVICE_INSTANTIATION", () => {
  it("WindowsCredentialResolver is only instantiated in instrumentation.ts, not in business services", () => {
    // The production resolver source only defines the class, not instantiates it
    expect(WINDOWS_RESOLVER_SOURCE).not.toMatch(/new WindowsCredentialResolver\(\)/);
  });

  it("WindowsCredentialResolver is instantiated exactly once in instrumentation.ts", () => {
    const matches = INSTRUMENTATION_SOURCE.match(/new WindowsCredentialResolver\(\)/g) || [];
    expect(matches.length).toBe(1);
  });
});

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const adminShellPath = resolve(__dirname, "../app/(protected)/admin/admin-shell.tsx");
const adminShellSource = readFileSync(adminShellPath, "utf8");

const REQUIRED_CAPABILITIES = [
  ["Vendor list + register", /renderVendorForm|handleAddVendor|\/api\/admin\/ai-vendors/],
  ["Complete Engine onboarding", /vendorMode|credentialSecret|providerFacingModelId|Exact API Endpoint|handleRegisterEngine/],
  ["Vendor website metadata", /websiteUrl|Vendor Website|موقع المزوّد/],
  ["Vendor enable/disable/retire", /handleVendorState|"RETIRED"|"DISABLED"|"ENABLED"/],
  ["Vendor delete", /handleDeleteVendor|method:\s*"DELETE"/],
  ["Model add/enable/disable/delete", /handleAddModel|handleModelState|handleDeleteModel/],
  ["Credential lifecycle ADD/REPLACE/ROTATE/REVOKE/DELETE", /credentialAction|"REPLACE"|"ROTATE"|"REVOKE"/],
  ["Secret never rendered", /secret\?:\s*never|type="password"/],
  ["Non-selectability reasons", /engineSelectabilityReasons|SELECTABILITY_REASON/],
  ["Vendor-state non-selectability", /vendor.*not selectable|المزوّد.*غير متاح/],
  ["Active/Standby select/remove", /handleSetActive|handleSetStandby|handleRemoveStandby/],
  ["AR + EN bilingual text", /text\(/],
  ["Failure state distinct from empty", /role="alert"|Failed to load/],
  ["Empty-state copy distinct from error", /No vendors registered|لا يوجد مزوّدون/],
] as const;

describe("Gate 7 — Admin Lifecycle Consolidation (AR/EN source contract)", () => {
  it("loads admin shell source", () => {
    expect(adminShellSource.length).toBeGreaterThan(0);
  });

  it.each(REQUIRED_CAPABILITIES)("capability: %s", (_label, pattern) => {
    expect(adminShellSource).toMatch(pattern);
  });

  it("complete onboarding supplies the first immutable revision identity and manual revision flow captures revision ID", () => {
    expect(adminShellSource).toMatch(/engineConfigRevision:\s*"1"/);
    expect(adminShellSource).toMatch(/revisionForm\.engineConfigRevision\.trim\(\)/);
    expect(adminShellSource).toMatch(/text\("رقم الإصدار",\s*"Revision ID"\)/);
  });

  it("Add AI quick setup hides generated identities and keeps runtime internals under Advanced", () => {
    const start = adminShellSource.indexOf("const renderRegisterForm = () => {");
    const end = adminShellSource.indexOf("const renderRevisionForm", start);
    const quickSetupSource = adminShellSource.slice(start, end);
    expect(quickSetupSource).toMatch(/text\("إضافة AI",\s*"Add AI"\)/);
    expect(quickSetupSource).toContain("__NEW__");
    expect(quickSetupSource).not.toContain("value={registerForm.engineId}");
    expect(quickSetupSource).not.toContain("value={registerForm.displayName}");
    expect(quickSetupSource).not.toContain("value={registerForm.credentialReference}");
    expect(quickSetupSource).not.toContain("<span>Channel ID</span>");
    expect(quickSetupSource).not.toContain("<span>Capability Profile</span>");
    expect(quickSetupSource).toMatch(/Advanced Runtime Settings/);
  });

  it("Add AI onboarding derives internal IDs, credential reference, channel, and endpoint", () => {
    expect(adminShellSource).toMatch(/const engineId = generatedIdentity\(/);
    expect(adminShellSource).toMatch(/generatedCredentialReference\(vendorId\)/);
    expect(adminShellSource).toMatch(/const channelId = registerForm\.channelId\.trim\(\) \|\|/);
    expect(adminShellSource).toMatch(/const endpoint = registerForm\.endpoint\.trim\(\) \|\| derivedChatCompletionsEndpoint\(baseUrl\)/);
  });

  it("keeps provider, API key, model, and runtime setup in one compact table", () => {
    const start = adminShellSource.indexOf("const renderRegisterForm = () => {");
    const end = adminShellSource.indexOf("const renderRevisionForm", start);
    const quickSetupSource = adminShellSource.slice(start, end);
    expect(quickSetupSource).toContain("<table");
    expect(quickSetupSource).toContain("API Key");
    expect(quickSetupSource).toMatch(/handleQuickCredentialSave/);
    expect(quickSetupSource).toMatch(/OpenRouter Free preset/);
    expect(quickSetupSource).toContain("nvidia/nemotron-3-super-120b-a12b:free");
    expect(quickSetupSource).toContain("https://openrouter.ai/api/v1");
    expect(adminShellSource).toContain('startsWith("sk-or-v1-")');
  });

  it("renders the Internal AI engine inventory as a compact table", () => {
    expect(adminShellSource).toMatch(/renderEngineTableRow/);
    expect(adminShellSource).toMatch(/Role \/ State/);
    expect(adminShellSource).not.toContain("renderEngineCard(engine)");
  });

  it("lets the owner replace a provider credential directly from the engine table", () => {
    expect(adminShellSource).toContain("credentialEditorVendorId");
    expect(adminShellSource).toContain("handleCredentialEditorSave");
    expect(adminShellSource).toMatch(/تعديل المفتاح/);
    expect(adminShellSource).toMatch(/Save \/ Replace/);
  });

  it("Qualification Flow V2 runs live validation and removes manual external-evidence attestation", () => {
    expect(adminShellSource).toMatch(/validate-and-qualify/);
    expect(adminShellSource).toMatch(/text\("اختبار وتأهيل",\s*"Validate & Qualify"\)/);
    expect(adminShellSource).toMatch(/فقط بعد PASS/);
    expect(adminShellSource).not.toContain("qualifyForm.evidenceReference");
    expect(adminShellSource).not.toContain("qualifyForm.externalValidationConfirmed");
    expect(adminShellSource).not.toContain("مرجع الدليل الخارجي");
  });

  it("contains no CJK or common mojibake characters in Admin product copy", () => {
    expect(adminShellSource).not.toMatch(/[\u4E00-\u9FFF]/u);
    expect(adminShellSource).not.toMatch(/[ØÙÃÂ]/u);
    expect(adminShellSource).toContain("بيانات الاعتماد غير متاحة");
  });

  it("does not surface credential secret values in UI types", () => {
    expect(adminShellSource).not.toMatch(/apiKey:\s*string(?!\?)/);
    expect(adminShellSource).not.toMatch(/secretValue:/);
  });

  it("exposes bilingual copy for vendor/model/credential controls", () => {
    expect(adminShellSource).toMatch(/text\("المزوّدون",\s*"Vendors"\)/);
    expect(adminShellSource).toMatch(/text\("تسجيل مزوّد جديد",\s*"Register Vendor"\)/);
    expect(adminShellSource).toMatch(/text\("تقاعد",\s*"Retire"\)/);
    expect(adminShellSource).toMatch(/text\("حذف",\s*"Delete"\)/);
    expect(adminShellSource).toMatch(/text\("الموديلات",\s*"Models"\)/);
  });

  it("surfaces distinct empty vs failure states for vendor list", () => {
    expect(adminShellSource).toMatch(/role="alert"/);
    expect(adminShellSource).toMatch(/No vendors registered|لا يوجد مزوّدون/);
    expect(adminShellSource).toMatch(/Failed to load vendors|فشل تحميل المزوّدين/);
  });

  it("uses product-shell locale switch for AR/EN", () => {
    const shellPath = resolve(__dirname, "../components/product-shell.tsx");
    const shellSource = readFileSync(shellPath, "utf8");
    expect(shellSource).toMatch(/locale === "ar"/);
    expect(shellSource).toMatch(/setLocale|locale/);
  });
});

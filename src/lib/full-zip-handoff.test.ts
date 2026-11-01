import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function text(path: string) {
  return readFileSync(path, "utf8").replace(/^\uFEFF/, "");
}

describe("fail-closed full-ZIP handoff", () => {
  it("keeps PowerShell handoff scripts ASCII-safe for Windows PowerShell 5.1", () => {
    for (const path of [
      "scripts/package-full-zip.ps1",
      "scripts/apply-full-zip.ps1",
    ]) {
      const bytes = readFileSync(path);
      expect(bytes.every((byte) => byte <= 0x7f)).toBe(true);
    }
  });

  it("forbids package creation until every authoritative source gate passes", () => {
    const script = text("scripts/package-full-zip.ps1");
    const compressAt = script.indexOf("Compress-Archive");
    for (const command of [
      "npm run toolchain:check",
      "npm ci",
      "npm run typecheck",
      "npm run test",
      "npm run lint",
      "npm audit",
      "npm run build",
    ]) {
      const gateAt = script.indexOf(command);
      expect(gateAt).toBeGreaterThan(-1);
      expect(gateAt).toBeLessThan(compressAt);
    }
    expect(script).toContain("ACTIVE_WORKSPACE_NODE_PROCESS_BLOCKER");
    expect(script).toContain("SOURCE_MUTATED_DURING_VALIDATION");
    expect(script).toContain("ZIP_REEXTRACTION_AND_HASH_VERIFICATION: PASS");
    expect(script).toContain("ZIP_TRAVERSAL_ENTRY");
    expect(script).toContain("UNLISTED_PACKAGE_FILE");
    expect(script).toContain(".tsbuildinfo");
  });

  it("validates the extracted candidate completely before touching the live workspace", () => {
    const script = text("scripts/apply-full-zip.ps1");
    expect(script).not.toContain("SkipValidation");
    expect(script).toContain("ACTIVE_WORKSPACE_NODE_PROCESS_BLOCKER");
    expect(script).toContain("ZIP_ENTRY_OUTSIDE_ROOT");
    expect(script).toContain("MANIFEST_PATH_ESCAPES_ROOT");
    expect(script).toContain("PRE_REPLACEMENT_VALIDATION: PASS");
    const validationAt = script.indexOf("PRE_REPLACEMENT_VALIDATION: PASS");
    const liveWriteAt = script.indexOf("$LiveWriteStarted = $true");
    const liveCopyAt = script.indexOf("-Source $UpdatedSource -Destination $Workspace");
    expect(validationAt).toBeGreaterThan(-1);
    expect(validationAt).toBeLessThan(liveWriteAt);
    expect(validationAt).toBeLessThan(liveCopyAt);
  });

  it("writes every application attempt to an owner-shareable transcript log", () => {
    const script = text("scripts/apply-full-zip.ps1");
    expect(script).toContain("Start-Transcript");
    expect(script).toContain("Stop-Transcript");
    expect(script).toContain("IntentChord-logs");
    expect(script).toContain("LOG_FILE_PATH:");
    expect(script).toContain("REPORT_FILE_PATH:");
    expect(script).toContain("SCRIPT_SHA256_MATCH: True");
    expect(script).toContain("$MyInvocation.MyCommand.Path");
    expect(script).toContain("V10_REQUIREMENT_PROOF_AUTHORITY");
  });

  it("preserves owner authority and restores the prior source on a post-write failure", () => {
    const script = text("scripts/apply-full-zip.ps1");
    const envExample = text(".env.example");
    const workflow = text("docs/INTENTCHORD_LOCAL_TOOLCHAIN_AND_FULL_ZIP_WORKFLOW.md");
    expect(script).toContain("FILE_LEVEL_ROLLBACK: PASS");
    expect(script).toContain("PRESERVED: .git, .env.local");
    expect(script).toContain("MIGRATION_ACTIONS: 0");
    expect(script).toContain("GIT_WRITE_ACTIONS: 0");
    expect(script).toContain("VALIDATED_NODE_MODULES_SWAP: PASS");
    expect(script).toContain("$OldNodeModulesMoved");
    expect(envExample).toContain("DATABASE_URL=postgresql://intentchord_app:CHANGE_ME@127.0.0.1:5432/intentchord_dev");
    expect(workflow).toContain("قبل لمس مساحة التطوير الحية");
    expect(workflow).toContain("SkipValidation");
    expect(workflow).toContain("لا يوجد");
  });
});

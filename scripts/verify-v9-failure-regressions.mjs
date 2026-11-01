import { readFileSync } from "node:fs";

const shell = readFileSync("src/components/product-shell.tsx", "utf8");
const shellCss = readFileSync("src/components/product-shell.module.css", "utf8");
const globalCss = readFileSync("src/app/globals.css", "utf8");
const ownerRuntimeTest = readFileSync("src/lib/final-owner-runtime-closure.test.ts", "utf8");
const identityManifest = JSON.parse(
  readFileSync(
    "docs/architecture/INTENTCHORD_APPROVED_IDENTITY_ASSET_MANIFEST_2026_07_29.json",
    "utf8",
  ),
);

const failures = [];
const approvedTagline = "هدف واضح • تنفيذ منضبط • نتائج قابلة للتحقق";

if (!/\.canvasInner\s*\{[\s\S]*width:\s*100%;[\s\S]*max-width:\s*none;/.test(shellCss)) {
  failures.push("MAIN_CANVAS_FULL_WIDTH_CONTRACT_MISSING");
}
if (!/\.welcome-home[\s\S]*max-width:\s*none;/.test(globalCss)) {
  failures.push("FULL_WIDTH_FIRST_USE_HOME_MISSING");
}
if (identityManifest.approved_tagline !== approvedTagline) {
  failures.push("APPROVED_TAGLINE_MANIFEST_MISMATCH");
}
if (shell.includes(approvedTagline)) {
  failures.push("COMPACT_TOPBAR_MICRO_TAGLINE_REINTRODUCED");
}
if (ownerRuntimeTest.includes(`expect(shell).toContain("${approvedTagline}")`)) {
  failures.push("STALE_TOPBAR_TAGLINE_ASSERTION_REINTRODUCED");
}

if (failures.length) {
  for (const failure of failures) console.error(`V9_FAILURE_REGRESSION: BLOCKER | ${failure}`);
  process.exit(1);
}

console.log("V9_FAILURE_REGRESSION: PASS | resolved_assertions=3");
console.log("MAIN_CANVAS=FULL_WIDTH");
console.log("FIRST_USE_HOME=FULL_WIDTH_WORK_SURFACE");
console.log("TOPBAR_TAGLINE=ABSENT_BY_COMPACT_ASSET_ROLE");

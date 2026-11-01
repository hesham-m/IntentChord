import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const target = path.join(process.cwd(), "node_modules", "minimatch", "minimatch.js");
let source;
try {
  source = await readFile(target, "utf8");
} catch (error) {
  if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") process.exit(0);
  throw error;
}

const candidates = [
  "var expand = require('brace-expansion')",
  'var expand = require("brace-expansion")',
  "const expand = require('brace-expansion')",
  'const expand = require("brace-expansion")',
];
const replacement = "var braceExpansion = require('brace-expansion')\nvar expand = typeof braceExpansion === 'function' ? braceExpansion : braceExpansion.expand";
let patched = source;
for (const candidate of candidates) {
  if (patched.includes(candidate)) {
    patched = patched.replace(candidate, replacement);
    break;
  }
}
if (patched === source) {
  if (!source.includes("braceExpansion.expand")) {
    throw new Error("MINIMATCH_BRACE_COMPAT_PATTERN_NOT_FOUND");
  }
  process.exit(0);
}
await writeFile(target, patched, "utf8");
console.log("MINIMATCH_BRACE_COMPAT: APPLIED");

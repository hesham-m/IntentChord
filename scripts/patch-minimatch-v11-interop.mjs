/**
 * Explicit dev-tool compatibility bridge for the pinned minimatch 11.0.1.
 * Some current ESLint consumers load minimatch through legacy default ESM import
 * or callable CommonJS require. Preserve the upstream minimatch algorithm;
 * expose only those legacy API surfaces. Fail closed on unknown versions/shapes.
 * Revisit/remove when consumers support the v11 named API directly.
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const moduleRoot = path.join(process.cwd(), "node_modules", "minimatch");
const pkg = JSON.parse(await readFile(path.join(moduleRoot, "package.json"), "utf8"));
if (pkg.version !== "11.0.1") {
  throw new Error("MINIMATCH_V11_INTEROP_VERSION_GUARD: " + pkg.version);
}
const files = [
  {
    name: "ESM",
    file: path.join(moduleRoot, "dist", "esm", "index.js"),
    signature: "export const minimatch = ",
    append: "export { minimatch as default };",
  },
  {
    name: "CJS",
    file: path.join(moduleRoot, "dist", "commonjs", "index.js"),
    signature: "exports.minimatch = minimatch;",
    append: "module.exports = Object.assign(exports.minimatch, exports);",
  },
];
for (const { name, file, signature, append } of files) {
  const original = await readFile(file, "utf8");
  if (!original.includes(signature)) throw new Error("MINIMATCH_V11_INTEROP_UNRECOGNIZED_" + name);
  const appearances = original.split(append).length - 1;
  if (appearances === 1) {
    console.log("MINIMATCH_V11_INTEROP_" + name + "=ALREADY_APPLIED");
    continue;
  }
  if (appearances !== 0) throw new Error("MINIMATCH_V11_INTEROP_DUPLICATE_" + name);
  await writeFile(file, original.trimEnd() + "\n" + append + "\n", "utf8");
  console.log("MINIMATCH_V11_INTEROP_" + name + "=APPLIED");
}

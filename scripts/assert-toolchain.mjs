import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const expected = Object.freeze({ node: "25.2.1", npm: "11.6.2" });
const actualNode = process.versions.node;

function npmVersionFromUserAgent() {
  const match = process.env.npm_config_user_agent?.match(/npm\/([^\s]+)/);
  return match?.[1] ?? null;
}

function npmCliCandidates() {
  const nodeDirectory = path.dirname(process.execPath);
  return [
    process.env.INTENTCHORD_NPM_CLI_PATH,
    process.env.npm_execpath,
    path.join(nodeDirectory, "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(nodeDirectory, "..", "node_modules", "npm", "bin", "npm-cli.js"),
  ].filter((candidate, index, all) =>
    Boolean(candidate) && all.indexOf(candidate) === index,
  );
}

function npmVersionFromCli() {
  for (const candidate of npmCliCandidates()) {
    if (!existsSync(candidate)) continue;

    try {
      return execFileSync(process.execPath, [candidate, "--version"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    } catch {
      // Try the next deterministic npm CLI candidate.
    }
  }

  return null;
}

function readNpmVersion() {
  return npmVersionFromUserAgent() ?? npmVersionFromCli() ?? "UNAVAILABLE";
}

const actualNpm = readNpmVersion();
const failures = [];

if (actualNode !== expected.node) {
  failures.push(`NODE_VERSION_MISMATCH: expected=${expected.node} actual=${actualNode}`);
}

if (actualNpm !== expected.npm) {
  failures.push(`NPM_VERSION_MISMATCH: expected=${expected.npm} actual=${actualNpm}`);
}

if (failures.length > 0) {
  for (const failure of failures) console.error(failure);
  console.error("TOOLCHAIN_GATE: BLOCKER");
  process.exit(1);
}

console.log(`TOOLCHAIN_GATE: PASS | node=${actualNode} | npm=${actualNpm}`);

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import type { GitWorkspaceEnrichment, RenameHint } from "@/core/workspace-index/types";

const execFileAsync = promisify(execFile);

async function runGit(root: string, args: string[], timeout = 8_000): Promise<{ value?: string; state: "PASS" | "NOT_GIT" | "TIMEOUT" | "ERROR" }> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", root, ...args], { timeout, maxBuffer: 2 * 1024 * 1024, windowsHide: true });
    return { value: stdout.trim(), state: "PASS" };
  } catch (error) {
    const details = error as { killed?: boolean; signal?: string; stderr?: string };
    const stderr = String(details.stderr ?? "");
    if (/not a git repository/i.test(stderr)) return { state: "NOT_GIT" };
    if (details.killed || details.signal === "SIGTERM") return { state: "TIMEOUT" };
    return { state: "ERROR" };
  }
}

function parseRenameHints(output: string): RenameHint[] {
  const hints: RenameHint[] = [];
  for (const line of output.split(/\r?\n/).filter(Boolean)) {
    const [status, fromPath, toPath] = line.split("\t");
    if (!status?.startsWith("R") || !fromPath || !toPath) continue;
    const score = Number(status.slice(1));
    hints.push({
      from_relative_path: fromPath.replaceAll("\\", "/"),
      to_relative_path: toPath.replaceAll("\\", "/"),
      confidence: Number.isFinite(score) && score >= 90 ? "PROVEN" : "POSSIBLE",
      evidence: `git-diff-rename-score:${Number.isFinite(score) ? score : "unknown"}`,
    });
  }
  return hints;
}

export class ReadOnlyGitWorkspaceAdapter {
  readonly adapter_id = "READ_ONLY_GIT_WORKSPACE_ADAPTER";
  readonly adapter_version = "1.0.0";

  async enrich(rootPath: string, previousCommit?: string): Promise<GitWorkspaceEnrichment> {
    const root = path.resolve(rootPath);
    const rootResult = await runGit(root, ["rev-parse", "--show-toplevel"]);
    const diagnostics: GitWorkspaceEnrichment["diagnostics"] = [{ command: "git rev-parse --show-toplevel", state: rootResult.state }];
    if (!rootResult.value) return { rename_hints: [], diagnostics };
    const [branch, commit] = await Promise.all([
      runGit(root, ["branch", "--show-current"]),
      runGit(root, ["rev-parse", "HEAD"]),
    ]);
    diagnostics.push({ command: "git branch --show-current", state: branch.state }, { command: "git rev-parse HEAD", state: commit.state });
    let renameHints: RenameHint[] = [];
    if (previousCommit && commit.value && previousCommit !== commit.value) {
      const rename = await runGit(root, ["diff", "--name-status", "-M", previousCommit, commit.value], 15_000);
      diagnostics.push({ command: "git diff --name-status -M <from> <to>", state: rename.state });
      if (rename.value) renameHints = parseRenameHints(rename.value);
    }
    return {
      repository_identity: path.resolve(rootResult.value),
      branch: branch.value,
      commit_sha: commit.value,
      rename_hints: renameHints,
      diagnostics,
    };
  }
}

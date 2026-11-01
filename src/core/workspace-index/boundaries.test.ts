import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const coreFiles = [
  "src/core/workspace-index/indexer.ts",
  "src/core/workspace-index/validator.ts",
  "src/core/workspace-index/delta.ts",
  "src/core/workspace-index/parsers.ts",
  "src/core/workspace-index/registries.ts",
  "src/core/workspace-index/adapters/filesystem.ts",
  "src/core/workspace-index/adapters/git.ts",
];

async function sourceText() {
  return (await Promise.all(coreFiles.map(file => readFile(path.join(root, file), "utf8")))).join("\n");
}

describe("Workspace Indexer explicit negative architecture boundaries", () => {
  it("contains no AI invocation, Context naming, Provider selection, or Prompt generation", async () => {
    const source = await sourceText();
    expect(source).not.toMatch(/core\/(?:providers|prompts|intelligence)|OpenAI|Gemini|Claude|AI Context Mapper|Context Validator/);
    expect(source).not.toMatch(/Update Channel|Remote|Users|Authentication|["'`]Policy["'`]/);
  });

  it("contains no source write, test/build/deploy execution, database, API, or UI dependency", async () => {
    const source = await sourceText();
    expect(source).not.toMatch(/\b(?:writeFile|appendFile|unlink|rename|rm|rmdir|mkdir|copyFile|chmod|chown|truncate|createWriteStream)\s*\(/);
    expect(source).toContain("platform()");
    expect(source).not.toMatch(/npm\s+(?:test|run|build)|next build|deploy|serviceRestart|databaseWrite/);
    expect(source).not.toMatch(/@\/server|@\/app|@\/components|\bpg\b|DATABASE_URL|(?:from|join|update|insert\s+into|delete\s+from)\s+intentchord\./i);
  });

  it("does not embed raw Workspace content in the Contract model", async () => {
    const typeSource = await readFile(path.join(root, "src/core/workspace-index/types.ts"), "utf8");
    expect(typeSource).not.toMatch(/raw_content\s*:/);
    expect(typeSource).not.toMatch(/file_content\s*:/);
    expect(typeSource).toContain("retrieval_ref");
    expect(typeSource).toContain("content_hash");
  });

  it("keeps Git optional and filesystem indexing primary", async () => {
    const indexer = await readFile(path.join(root, "src/core/workspace-index/indexer.ts"), "utf8");
    expect(indexer).toContain("inventoryWorkspaceFiles");
    expect(indexer).toContain("request.git_enrichment ??");
    expect(indexer).not.toContain("new ReadOnlyGitWorkspaceAdapter");
  });
});

import { mkdtemp, mkdir, writeFile, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export async function createWorkspaceIndexFixture(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "intentchord-index-"));
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(path.join(root, "docs"), { recursive: true });
  await mkdir(path.join(root, "config"), { recursive: true });
  await writeFile(path.join(root, "package.json"), JSON.stringify({
    name: "fixture-workspace",
    scripts: { test: "vitest run" },
    dependencies: { zod: "^3.24.1" },
  }, null, 2));
  await writeFile(path.join(root, "src", "util.ts"), "export function double(value: number) { return value * 2; }\n");
  await writeFile(path.join(root, "src", "index.ts"), "import { double } from './util';\nexport const result = double(2);\n");
  await writeFile(path.join(root, "src", "index.test.ts"), "import { result } from './index';\nexport const expected = result === 4;\n");
  await writeFile(path.join(root, "docs", "README.md"), "# Fixture Workspace\n\n## Evidence\n\nDeterministic index fixture.\n");
  await writeFile(path.join(root, "config", "settings.json"), JSON.stringify({ enabled: true }));
  await writeFile(path.join(root, ".env.fixture"), "DEMO_TOKEN=not-a-real-secret\n");
  await writeFile(path.join(root, "asset.bin"), Buffer.from([0, 1, 2, 3, 4]));
  return root;
}

export async function copyWorkspaceIndexFixture(source: string): Promise<string> {
  const target = await mkdtemp(path.join(tmpdir(), "intentchord-index-copy-"));
  await cp(source, target, { recursive: true });
  return target;
}

import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  // Vitest 4 / Vite 8: JSX transform is handled by Oxc rather than esbuild.
  oxc: {
    jsx: {
      runtime: "automatic",
      importSource: "react",
    },
  },
  test: {
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
  resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
});

import { describe, expect, it } from "vitest";
import {
  localRelativePathIsWithin,
  localRelativePathKey,
  sameLocalAbsolutePath,
} from "@/core/workspace-index/local-path-semantics";

describe("B1 platform-correct local path semantics", () => {
  it("R3 folds local path case only for Windows", () => {
    expect(localRelativePathKey("src/Foo.ts", "win32")).toBe(localRelativePathKey("src/foo.ts", "win32"));
    expect(localRelativePathKey("src/Foo.ts", "linux")).not.toBe(localRelativePathKey("src/foo.ts", "linux"));
    expect(sameLocalAbsolutePath("C:\\Repo\\Foo.ts", "c:\\repo\\foo.ts", "win32")).toBe(true);
    expect(sameLocalAbsolutePath("/repo/Foo.ts", "/repo/foo.ts", "linux")).toBe(false);
  });

  it("R3 preserves Owner scope boundaries under platform-specific case rules", () => {
    expect(localRelativePathIsWithin("SRC/Foo.ts", "src", "win32")).toBe(true);
    expect(localRelativePathIsWithin("SRC/Foo.ts", "src", "linux")).toBe(false);
    expect(localRelativePathIsWithin("src/Foo.ts", "src", "linux")).toBe(true);
  });
});

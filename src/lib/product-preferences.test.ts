import { describe, expect, it } from "vitest";
import {
  globalProjectAutoSelection,
  taskProjectContextPersistence,
} from "@/lib/product-preferences";

describe("Task project-context authority", () => {
  it("stores project membership only with an authoritative Task revision", () => {
    expect(taskProjectContextPersistence).toBe("POSTGRESQL_TASK_REVISION_ONLY");
  });

  it("forbids a global browser-selected Project", () => {
    expect(globalProjectAutoSelection).toBe("FORBIDDEN");
  });
});

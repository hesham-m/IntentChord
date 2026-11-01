import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import Page from "@/app/(protected)/project-contexts/page";

describe("Projects owner surface", () => {
  it("renders the unified ProductShell and a human project entry", () => {
    const html = renderToStaticMarkup(createElement(Page));
    expect(html).toContain("IntentChord · Projects");
    expect(html).toContain("Create your first project");
    expect(html).toContain("New task");
    expect(html).not.toContain("Governed environment");
    expect(html).not.toContain("Project Truth Registry");
    expect(html).not.toContain("Value JSON");
    expect(html).not.toContain("Workspace registration ID");
  });
});

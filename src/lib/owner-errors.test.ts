import { describe, expect, it } from "vitest";
import { ownerErrorMessage } from "@/lib/owner-errors";

describe("ownerErrorMessage", () => {
  it("maps known backend codes to human Arabic guidance", () => {
    const message = ownerErrorMessage({ code: "REVISION_CONFLICT", error: "raw database text", details: { sql: "secret" } }, "ar");
    expect(message).toContain("تغيرت الحالة الحاكمة");
    expect(message).toContain("حدّث الحالة الحاكمة");
    expect(message).not.toContain("raw database text");
    expect(message).not.toContain("secret");
  });

  it("does not expose unknown raw backend details", () => {
    const message = ownerErrorMessage({ error: "Zod issue at body.details[0]", details: [{ path: ["slug"] }] }, "en");
    expect(message).toBe("The command could not be completed. Review the inputs and try again.");
  });
});

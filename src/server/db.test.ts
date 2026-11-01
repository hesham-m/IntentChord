import { describe, expect, it } from "vitest";
import { validateRuntimeDatabaseUrl } from "@/server/db";

const approved = "postgresql://intentchord_app@127.0.0.1:5432/intentchord_dev";

describe("runtime PostgreSQL identity boundary", () => {
  it("accepts only the approved local IntentChord database identity", () => {
    expect(validateRuntimeDatabaseUrl(approved)).toBe(approved);
  });

  it.each([
    ["database", "postgresql://intentchord_app@127.0.0.1:5432/unapproved_database"],
    ["user", "postgresql://postgres:secret@127.0.0.1:5432/intentchord_dev"],
    ["host", "postgresql://intentchord_app@localhost:5432/intentchord_dev"],
    ["port", "postgresql://intentchord_app@127.0.0.1:5433/intentchord_dev"],
    ["protocol", "https://intentchord_app@127.0.0.1:5432/intentchord_dev"],
  ])("fails closed on a mismatched %s", (_label, value) => {
    expect(() => validateRuntimeDatabaseUrl(value)).toThrow("INTENTCHORD_DATABASE_IDENTITY_BLOCKED");
  });

  it("does not disclose the database password in an identity error", () => {
    expect(() => validateRuntimeDatabaseUrl("postgresql://intentchord_app:do-not-print@localhost:5432/intentchord_dev"))
      .toThrowError(expect.not.stringContaining("do-not-print"));
  });
});

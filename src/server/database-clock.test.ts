import { describe, expect, it, vi } from "vitest";
import { readDatabaseCommandTime } from "@/server/database-clock";

describe("database command clock", () => {
  it("returns the PostgreSQL clock timestamp as canonical ISO text", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{ command_time: new Date("2026-07-28T12:34:56.789Z") }],
    });

    await expect(readDatabaseCommandTime({ query } as never)).resolves.toBe(
      "2026-07-28T12:34:56.789Z",
    );
    expect(query).toHaveBeenCalledWith("select clock_timestamp() as command_time");
  });

  it("fails closed when PostgreSQL does not return a command timestamp", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    await expect(readDatabaseCommandTime({ query } as never)).rejects.toThrow(
      "INTENTCHORD_DATABASE_CLOCK_UNAVAILABLE",
    );
  });
});

import type { PoolClient, QueryResultRow } from "pg";

export type DatabaseClockQueryable = Pick<PoolClient, "query">;

type DatabaseClockRow = QueryResultRow & {
  command_time: Date | string;
};

function asIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/**
 * Returns one authoritative database-sourced timestamp for a command.
 *
 * Project Truth domain defaults must never be derived from the application
 * process clock. PostgreSQL clock_timestamp() is intentionally used instead
 * of now()/transaction_timestamp(), because a governed command may execute
 * inside a caller-managed transaction that spans multiple commands.
 */
export async function readDatabaseCommandTime(
  queryable: DatabaseClockQueryable,
): Promise<string> {
  const result = await queryable.query<DatabaseClockRow>(
    "select clock_timestamp() as command_time",
  );
  const value = result.rows[0]?.command_time;
  if (value === undefined || value === null) {
    throw new Error("INTENTCHORD_DATABASE_CLOCK_UNAVAILABLE");
  }
  return asIso(value);
}

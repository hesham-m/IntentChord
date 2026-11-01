import type { PoolClient } from "pg";
import {
  bindRollbackOnlyTestClient,
  databasePool,
  verifyDatabaseIdentity,
} from "@/server/db";

export type RollbackOnlyOwnerDbHarness = {
  client: PoolClient;
  close: () => Promise<void>;
};

export async function beginRollbackOnlyOwnerDbTest(): Promise<RollbackOnlyOwnerDbHarness> {
  process.env.INTENTCHORD_ROLLBACK_ONLY_PG_TEST = "1";
  const client = await databasePool().connect();
  try {
    await verifyDatabaseIdentity(client);
    await client.query("BEGIN");
    const unbind = bindRollbackOnlyTestClient(client);
    let closed = false;
    return {
      client,
      async close() {
        if (closed) return;
        closed = true;
        try {
          await client.query("ROLLBACK");
        } finally {
          unbind();
          client.release();
          delete process.env.INTENTCHORD_ROLLBACK_ONLY_PG_TEST;
          await databasePool().end();
        }
      },
    };
  } catch (error) {
    client.release(true);
    delete process.env.INTENTCHORD_ROLLBACK_ONLY_PG_TEST;
    throw error;
  }
}

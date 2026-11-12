import pg from 'pg';
import { readFileSync } from 'node:fs';

export type Db = pg.Pool;
export type Tx = pg.PoolClient;

export function createDb(url: string): Db {
  const pool = new pg.Pool({ connectionString: url, max: 10 });
  // BIGINT comes back as string by default; our amounts fit safely in a JS number (< 9e15 micro-units).
  pg.types.setTypeParser(20, v => {
    const n = Number(v);
    if (!Number.isSafeInteger(n)) throw new Error(`BIGINT out of safe range: ${v}`);
    return n;
  });
  return pool;
}

export async function migrate(db: Db): Promise<void> {
  const sql = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
  await db.query(sql);
}

/** Run fn in one transaction; rolls back on any error. */
export async function inTx<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

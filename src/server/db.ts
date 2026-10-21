import pg from 'pg';

// DATE columns stay as ISO strings (no local-midnight Date conversion); NUMERIC stays string by default.
pg.types.setTypeParser(1082, (value: string) => value);

export type Db = pg.Pool;
export type DbClient = pg.PoolClient;
export type Queryable = pg.Pool | pg.PoolClient;

export function createPool(connectionString: string, ssl: boolean): pg.Pool {
  return new pg.Pool({
    connectionString,
    max: 10,
    ssl: ssl ? { rejectUnauthorized: true } : undefined,
    application_name: 'pdi-tqms',
  });
}

export async function withTransaction<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function one<T extends pg.QueryResultRow>(db: Queryable, sql: string, params: unknown[] = []): Promise<T | null> {
  const res = await db.query<T>(sql, params);
  return res.rows[0] ?? null;
}

export async function many<T extends pg.QueryResultRow>(db: Queryable, sql: string, params: unknown[] = []): Promise<T[]> {
  const res = await db.query<T>(sql, params);
  return res.rows;
}

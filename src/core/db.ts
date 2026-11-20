import pg from "pg";
import { env } from "../config/env.js";

// NUMERIC -> string (jamais de conversion implicite en flottant pour les montants).
pg.types.setTypeParser(1700, (v) => v);
// DATE -> chaîne ISO (YYYY-MM-DD), sans décalage de fuseau.
pg.types.setTypeParser(1082, (v) => v);
// BIGINT -> number si sûr, sinon chaîne.
pg.types.setTypeParser(20, (v) => {
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : v;
});

export interface Db {
  query<T extends pg.QueryResultRow = any>(text: string, params?: unknown[]): Promise<pg.QueryResult<T>>;
}

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!pool) {
    const e = env();
    pool = new pg.Pool({
      connectionString: e.DATABASE_URL,
      max: e.DATABASE_POOL_MAX,
      ssl: e.DATABASE_SSL ? { rejectUnauthorized: true } : undefined,
      application_name: "trans-afrique-core-api",
    });
    pool.on("error", (err) => {
      console.error(`[db] erreur de connexion inactive; code=${(err as any)?.code ?? "UNKNOWN"}`);
    });
  }
  return pool;
}

export async function closePool() {
  if (pool) {
    const p = pool;
    pool = null;
    await p.end();
  }
}

export const db: Db = {
  query: (text, params) => getPool().query(text, params as any[]),
};

/** Exécute fn dans une transaction ; rollback automatique sur erreur. */
export async function withTransaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("begin");
    const result = await fn({ query: (t, p) => client.query(t, p as any[]) });
    await client.query("commit");
    return result;
  } catch (err) {
    try { await client.query("rollback"); } catch { /* connexion déjà fermée */ }
    throw err;
  } finally {
    client.release();
  }
}

export async function one<T extends pg.QueryResultRow = any>(d: Db, text: string, params?: unknown[]): Promise<T | null> {
  const r = await d.query<T>(text, params);
  return r.rows[0] ?? null;
}

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";

/**
 * Exécuteur de migrations versionnées.
 * En production Supabase, préférer `supabase db push` (mêmes fichiers).
 * Ce runner sert aux environnements sans CLI et aux tests ; il refuse de
 * rejouer une migration dont le contenu a changé (somme de contrôle).
 */
export async function runMigrations(
  connectionString: string,
  opts: { dir: string; seedDir?: string; extraBefore?: string[]; log?: (m: string) => void },
) {
  const log = opts.log ?? (() => {});
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    for (const f of opts.extraBefore ?? []) {
      await client.query(await readFile(f, "utf8"));
    }
    await client.query(`create schema if not exists private`);
    await client.query(`create table if not exists private.schema_migrations (
      name text primary key, checksum char(64) not null, applied_at timestamptz not null default now())`);

    const files = (await readdir(opts.dir)).filter((f) => f.endsWith(".sql")).sort();
    for (const name of files) {
      const sql = await readFile(path.join(opts.dir, name), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const existing = await client.query(`select checksum from private.schema_migrations where name = $1`, [name]);
      if (existing.rows[0]) {
        if (existing.rows[0].checksum !== checksum) {
          throw new Error(`MIGRATION_TAMPERED: ${name} a été modifiée après application`);
        }
        continue;
      }
      await client.query("begin");
      try {
        await client.query(sql);
        await client.query(`insert into private.schema_migrations(name, checksum) values ($1, $2)`, [name, checksum]);
        await client.query("commit");
        log(`migration appliquée : ${name}`);
      } catch (err) {
        await client.query("rollback");
        throw new Error(`Échec de la migration ${name} : ${(err as Error).message}`);
      }
    }

    if (opts.seedDir) {
      const seeds = (await readdir(opts.seedDir)).filter((f) => f.endsWith(".sql")).sort();
      for (const name of seeds) {
        await client.query("begin");
        try {
          await client.query(await readFile(path.join(opts.seedDir, name), "utf8"));
          await client.query("commit");
          log(`seed appliqué : ${name}`);
        } catch (err) {
          await client.query("rollback");
          throw new Error(`Échec du seed ${name} : ${(err as Error).message}`);
        }
      }
    }
  } finally {
    await client.end();
  }
}

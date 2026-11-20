import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { writeFile } from "node:fs/promises";
import { runMigrations } from "../../src/core/migrator.js";

const PASSWORD = "test-only-password";
export const PG_INFO_FILE = path.join(os.tmpdir(), "ta-core-api-test-pg.json");

async function freePort(): Promise<number> {
  const net = await import("node:net");
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  const port = (s.address() as any).port as number;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

/** Démarre un PostgreSQL réel, applique shim Supabase + migrations + seeds sur une base modèle. */
export default async function setup() {
  const PORT = await freePort();
  const dir = await mkdtemp(path.join(os.tmpdir(), "ta-core-pg-"));
  const pgServer = new EmbeddedPostgres({
    databaseDir: dir, user: "postgres", password: PASSWORD, port: PORT, persistent: false,
    initdbFlags: ["--encoding=UTF8", "--locale=C"], onLog: () => {}, onError: () => {},
    // PG 18 sous Windows : les io_worker peuvent survivre à l'arrêt ; io synchrone en test.
    postgresFlags: ["-c", "io_method=sync"],
  });
  await pgServer.initialise();
  await pgServer.start();
  const admin = new pg.Client({ host: "127.0.0.1", port: PORT, user: "postgres", password: PASSWORD, database: "postgres" });
  await admin.connect();
  await admin.query(`create database ta_template`);
  await admin.end();
  await runMigrations(`postgres://postgres:${PASSWORD}@127.0.0.1:${PORT}/ta_template`, {
    dir: "supabase/migrations", seedDir: "supabase/seed", extraBefore: ["supabase/tests/supabase_shim.sql"],
  });
  await writeFile(PG_INFO_FILE, JSON.stringify({ port: PORT, password: PASSWORD }));
  return async () => {
    await pgServer.stop();
    await rm(dir, { recursive: true, force: true });
  };
}


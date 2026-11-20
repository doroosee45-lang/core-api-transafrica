/**
 * Qualification locale reproductible (développement uniquement — jamais en production).
 *
 *   npm run build && npm run qualify:local
 *
 * 1. Démarre un PostgreSQL 18 vierge (embarqué) et y installe le shim Supabase de TEST
 *    (rôles anon/authenticated, schéma auth) : sur Supabase réel, ces objets existent déjà.
 * 2. Exécute la VRAIE commande `npm run db:migrate` deux fois (la seconde ne doit rien appliquer).
 * 3. Démarre le serveur COMPILÉ (`node dist/src/server.js`) et l'interroge en HTTP.
 * Chaque contrôle affiche OK / ÉCHEC ; code de sortie 1 au premier échec.
 * Ce script ne contacte aucun service externe (Supabase, Resend) : il ne prouve donc
 * PAS l'intégration réelle — voir scripts/recette-supabase.ts pour la préproduction.
 */
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";

const PASSWORD = "qualification-only";
let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "OK    " : "ÉCHEC "} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

async function freePort() {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  const p = (s.address() as net.AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return p;
}

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv) {
  return new Promise<{ code: number; out: string }>((resolve) => {
    const c = spawn(cmd, args, { env: { ...process.env, ...env } });
    let out = "";
    c.stdout.on("data", (d) => (out += d));
    c.stderr.on("data", (d) => (out += d));
    c.on("close", (code) => resolve({ code: code ?? 1, out }));
  });
}

const dir = await mkdtemp(path.join(os.tmpdir(), "ta-qualify-"));
const pgPort = await freePort();
const server = new EmbeddedPostgres({
  databaseDir: dir, user: "postgres", password: PASSWORD, port: pgPort, persistent: false,
  initdbFlags: ["--encoding=UTF8", "--locale=C"], onLog: () => {}, onError: () => {}, postgresFlags: ["-c", "io_method=sync"],
});
let api: ReturnType<typeof spawn> | null = null;
try {
  await server.initialise();
  await server.start();
  const url = `postgres://postgres:${PASSWORD}@127.0.0.1:${pgPort}/postgres`;
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  await c.query(await readFile("supabase/tests/supabase_shim.sql", "utf8"));

  const env = {
    NODE_ENV: "production", DATABASE_URL: url, DATABASE_SSL: "false",
    SUPABASE_URL: "http://127.0.0.1:9", SUPABASE_ANON_KEY: "qualification", SUPABASE_JWT_SECRET: "qualification-secret-qualification-secret",
    WORKER_ENABLED: "false", PORT: String(await freePort()),
  };
  const m1 = await run(process.execPath, ["node_modules/tsx/dist/cli.mjs", "scripts/db-migrate.ts"], env);
  const applied = (m1.out.match(/migration appliquée/g) ?? []).length;
  const files = (await import("node:fs")).readdirSync("supabase/migrations").filter((f) => f.endsWith(".sql")).length;
  check("db:migrate sur base vierge", m1.code === 0 && applied === files, `${applied}/${files} migrations`);
  const m2 = await run(process.execPath, ["node_modules/tsx/dist/cli.mjs", "scripts/db-migrate.ts"], env);
  check("db:migrate rejoué (idempotent)", m2.code === 0 && !/migration appliquée/.test(m2.out));
  const counts = (await c.query(
    `select (select count(*) from shared.countries where is_operating)::int countries,
            (select count(*) from shared.currencies)::int currencies,
            (select count(*) from access.permissions)::int permissions,
            (select count(*) from access.roles where is_active)::int roles`)).rows[0];
  check("référentiels", counts.countries === 5 && counts.currencies === 6, JSON.stringify(counts));
  await c.end();

  api = spawn("node", ["dist/src/server.js"], { env: { ...process.env, ...env }, stdio: "ignore" });
  const base = `http://127.0.0.1:${env.PORT}/api/v1`;
  const t0 = Date.now();
  let up = false;
  while (Date.now() - t0 < 180_000 && !up) {
    try { up = (await fetch(`${base}/health`)).ok; } catch { await new Promise((r) => setTimeout(r, 1000)); }
  }
  check("serveur compilé démarré (health 200)", up, `${Math.round((Date.now() - t0) / 1000)} s`);
  if (up) {
    const h = await fetch(`${base}/health`);
    check("en-têtes de sécurité", h.headers.get("x-content-type-options") === "nosniff" && !h.headers.get("x-powered-by"));
    const i18n = await (await fetch(`${base}/i18n`, { headers: { "Accept-Language": "en" } })).json();
    check("GET /i18n public", i18n.success === true);
    const me = await fetch(`${base}/identity/me`, { headers: { "Accept-Language": "en" } });
    const meBody = await me.json();
    check("route protégée sans jeton → 401 traduit", me.status === 401 && meBody.error.message === "Authentication required.", meBody.error?.message);
    const forged = await fetch(`${base}/canada/parcels`, { headers: { Authorization: "Bearer abc.def.ghi" } });
    check("jeton falsifié → 401", forged.status === 401);
    const bad = await fetch(`${base}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" });
    check("JSON invalide → 400", bad.status === 400);
    const nf = await fetch(`${base}/inexistant`);
    check("route inconnue → 404", nf.status === 404);
  }
} finally {
  api?.kill();
  await server.stop().catch(() => {});
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}
console.log(failures ? `\n${failures} contrôle(s) en échec.` : "\nQualification locale : tous les contrôles sont OK.");
process.exit(failures ? 1 : 0);

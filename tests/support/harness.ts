import { randomBytes, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import bcrypt from "bcryptjs";
import pg from "pg";
import supertest from "supertest";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setEnvForTests } from "../../src/config/env.js";
import { startGoTrueStub } from "./gotrue-stub.js";

export const PASSWORD = "Passw0rd-Test-1";

export interface Role { role: string; scope_type: string; scope_id?: string | null; scope_country?: string | null; expires_at?: string | null }

export async function setupHarness(opts: { enforceMfa?: boolean } = {}) {
  const { port, password } = JSON.parse(readFileSync(path.join(os.tmpdir(), "ta-core-api-test-pg.json"), "utf8"));
  const dbName = `t_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Client({ host: "127.0.0.1", port, user: "postgres", password, database: "postgres" });
  await admin.connect();
  await admin.query(`create database ${dbName} template ta_template`);
  await admin.end();
  const url = `postgres://postgres:${password}@127.0.0.1:${port}/${dbName}`;
  const pool = new pg.Pool({ connectionString: url, max: 4 });

  const jwtSecret = randomBytes(32).toString("hex");
  const serviceKey = `service-${randomBytes(8).toString("hex")}`;
  // Port libre attribué par l'OS puis réutilisé par la doublure.
  const probe = (await import("node:net")).createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", () => r()));
  const stubPort = (probe.address() as AddressInfo).port;
  await new Promise<void>((r) => probe.close(() => r()));
  const stub = startGoTrueStub({ pool, jwtSecret, port: stubPort, serviceKey });
  await stub.listen();

  setEnvForTests({
    NODE_ENV: "test", TRUST_PROXY: false, DATABASE_URL: url, DATABASE_SSL: false, DATABASE_POOL_MAX: 5,
    SUPABASE_URL: stub.url, SUPABASE_ANON_KEY: "anon-test-key", SUPABASE_SERVICE_ROLE_KEY: serviceKey, SUPABASE_JWT_SECRET: jwtSecret,
    AUTH_ENFORCE_MFA: opts.enforceMfa ?? true, CORS_ORIGINS: "http://localhost:3000", APP_PUBLIC_URL: "http://localhost:3000",
    STORAGE_BUCKET: "canada-documents", DOCUMENT_MAX_BYTES: 10 * 1024 * 1024,
    OUTBOX_POLL_MS: 1000, WORKER_ENABLED: false,
  } as any);
  const { createApp } = await import("../../src/app.js");
  const { closePool } = await import("../../src/core/db.js");
  const api = supertest(createApp());

  async function makeUser(email: string, o: { first?: string; last?: string; roles?: Role[]; confirmed?: boolean; client?: { residence?: string; agency?: string };
    mfa?: boolean; language?: "fr" | "en" } = {}) {
    const u = (await pool.query(
      `insert into auth.users(email, encrypted_password, email_confirmed_at) values ($1, $2, $3) returning id`,
      [email, await bcrypt.hash(PASSWORD, 4), o.confirmed === false ? null : new Date()])).rows[0];
    await pool.query(`insert into identity.profiles(id, first_name, last_name, account_status, preferred_language) values ($1,$2,$3,'active',$4)`,
      [u.id, o.first ?? "Test", o.last ?? email.split("@")[0], o.language ?? "fr"]);
    await pool.query(`insert into access.user_platform_access(user_id, platform_id) values ($1, 1)`, [u.id]);
    for (const r of o.roles ?? []) {
      await pool.query(
        `insert into access.user_roles(user_id, role_id, scope_type, scope_id, scope_country, expires_at, justification)
         select $1, id, $3, $4, $5, $6, 'fixture de test' from access.roles where code = $2`,
        [u.id, r.role, r.scope_type, r.scope_id ?? null, r.scope_country ?? null, r.expires_at ?? null]);
    }
    let clientId: string | null = null;
    if (o.client) {
      clientId = (await pool.query(
        `insert into canada.clients(client_number, user_id, first_name, last_name, email, phone, residence_country, home_agency_id)
         values ($1,$2,$3,$4,$5,'+243000000',$6,$7) returning id`,
        [`CL-T-${randomBytes(4).toString("hex")}`, u.id, o.first ?? "Test", o.last ?? email.split("@")[0], email, o.client.residence ?? null, o.client.agency ?? null])).rows[0].id;
    }
    return {
      id: u.id as string, email, clientId,
      // Les comptes « mfa » obtiennent par défaut une session AAL2 (MFA validée).
      token: (aal: "aal1" | "aal2" = o.mfa ? "aal2" : "aal1") => stub.issue(u.id, aal),
    };
  }

  /** Référentiel minimal réaliste : agences CN / CD / CM, entrepôts, compagnie, aéroports, barème, taux. */
  async function world() {
    const ins = async (sql: string, p: unknown[]) => (await pool.query(sql, p)).rows[0].id;
    const agency = (code: string, country: string, tz: string) =>
      ins(`insert into canada.agencies(code, name, country_code, city, timezone) values ($1,$2,$3,$2,$4) returning id`, [code, `Agence ${code}`, country, tz]);
    const cn = await agency(`GZ-${randomBytes(2).toString("hex")}`, "CN", "Asia/Shanghai");
    const cd = await agency(`KIN-${randomBytes(2).toString("hex")}`, "CD", "Africa/Kinshasa");
    const cm = await agency(`DLA-${randomBytes(2).toString("hex")}`, "CM", "Africa/Douala");
    const wh = (agencyId: string, country: string) =>
      ins(`insert into canada.warehouses(agency_id, country_code, code, name) values ($1,$2,$3,'Entrepôt') returning id`, [agencyId, country, `WH-${randomBytes(3).toString("hex")}`]);
    const whCn = await wh(cn, "CN"), whCd = await wh(cd, "CD");
    const airline = await ins(`insert into canada.airlines(iata_code, name) values ('ET','Ethiopian Airlines') on conflict (iata_code) do update set name = excluded.name returning id`, []);
    await pool.query(`insert into canada.airports(iata_code, name, city, country_code, timezone) values
      ('CAN','Guangzhou Baiyun','Guangzhou','CN','Asia/Shanghai'), ('FIH','N''djili','Kinshasa','CD','Africa/Kinshasa'),
      ('DLA','Douala International','Douala','CM','Africa/Douala') on conflict do nothing`);
    await pool.query(`insert into canada.pricing_rules(code, version, origin_country, destination_country, transport_mode, currency, rate_per_kg,
      minimum_charge, service_fee, volumetric_divisor, effective_from, status) values ('CN-CD-AIR', 1, 'CN','CD','air','USD', 8, 20, 5, 6000, now() - interval '1 day', 'active')`);
    await pool.query(`insert into canada.exchange_rates(base_currency, quote_currency, rate, effective_at, source) values ('USD','CDF', 2800, now() - interval '1 hour', 'test')`);
    return { cn, cd, cm, whCn, whCd, airline };
  }

  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const idem = () => ({ "Idempotency-Key": `test-${randomUUID()}` });

  async function teardown() {
    await closePool();
    await stub.close();
    await pool.end();
    const a = new pg.Client({ host: "127.0.0.1", port, user: "postgres", password, database: "postgres" });
    await a.connect();
    await a.query(`drop database if exists ${dbName} with (force)`);
    await a.end();
  }

  return { api, pool, stub, makeUser, world, auth, idem, teardown };
}

export type Harness = Awaited<ReturnType<typeof setupHarness>>;

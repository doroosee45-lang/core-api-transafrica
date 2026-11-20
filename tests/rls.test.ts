import { setupHarness, type Harness } from "./support/harness.js";

/**
 * Défense en profondeur PostgreSQL (Dossier 03 §10.1, Spéc. identité §10.3, Cahier §16).
 * Vérifie sur la base RÉELLEMENT migrée : RLS activée partout, aucun privilège `anon`,
 * privilèges `authenticated` limités à une liste blanche, aucune fonction exposée,
 * et comportement des politiques « propriétaire » sous le rôle `authenticated`.
 * Ce test échoue si une migration future ajoute une table sans RLS ou ouvre un droit.
 */
let h: Harness;
let a: any, b: any;
const SCHEMAS = ["identity", "access", "organizations", "shared", "canada", "audit", "private"];
// Liste blanche documentée dans 20261119000700_rls_policies.sql (lectures « propriétaire »).
const AUTHENTICATED_ALLOWED: Record<string, string[]> = {
  "identity.profiles": ["SELECT"],
  "shared.notifications": ["SELECT"],
  "canada.clients": ["SELECT"],
  "canada.parcels": ["SELECT"],
  "canada.parcel_events": ["SELECT"],
};

beforeAll(async () => {
  h = await setupHarness();
  a = await h.makeUser("rls.a@ta.test", { roles: [{ role: "canada_client", scope_type: "own" }], client: { residence: "CD" } });
  b = await h.makeUser("rls.b@ta.test", { roles: [{ role: "canada_client", scope_type: "own" }], client: { residence: "CM" } });
});
afterAll(async () => { await h?.teardown(); });

/** Exécute des requêtes sous le rôle Supabase `authenticated` avec le JWT de `userId`. */
async function asAuthenticated<T>(userId: string, fn: (q: (sql: string, p?: unknown[]) => Promise<any>) => Promise<T>) {
  const c = await h.pool.connect();
  try {
    await c.query("begin");
    await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: userId, role: "authenticated" })]);
    await c.query("set local role authenticated");
    return await fn((sql, p) => c.query(sql, p as any[]));
  } finally {
    await c.query("rollback");
    c.release();
  }
}

describe("Privilèges et RLS sur la base migrée", () => {
  it("toutes les tables métier ont la RLS activée", async () => {
    const r = await h.pool.query(
      `select n.nspname || '.' || c.relname as t from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where c.relkind in ('r','p') and n.nspname = any($1) and not c.relrowsecurity order by 1`, [SCHEMAS]);
    expect(r.rows.map((x: any) => x.t)).toEqual([]);
  });

  it("anon n'a aucun droit ; authenticated uniquement la liste blanche", async () => {
    const r = await h.pool.query(
      `select n.nspname || '.' || c.relname as t, p.priv,
              has_table_privilege('anon', c.oid, p.priv) as anon, has_table_privilege('authenticated', c.oid, p.priv) as auth
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
         cross join unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p(priv)
        where c.relkind in ('r','p','v','m') and n.nspname = any($1)`, [SCHEMAS]);
    expect(r.rows.filter((x: any) => x.anon)).toEqual([]);
    const granted = r.rows.filter((x: any) => x.auth).map((x: any) => `${x.t}:${x.priv}`).sort();
    const expected = Object.entries(AUTHENTICATED_ALLOWED).flatMap(([t, ps]) => ps.map((p) => `${t}:${p}`)).sort();
    expect(granted).toEqual(expected);
    // Mises à jour : uniquement au niveau colonne (jamais account_status, user_id…).
    const cols = await h.pool.query(
      `select table_schema || '.' || table_name || '.' || column_name as c from information_schema.column_privileges
        where grantee = 'authenticated' and privilege_type = 'UPDATE' and table_schema = any($1) order by 1`, [SCHEMAS]);
    expect(cols.rows.map((x: any) => x.c)).toEqual([
      "identity.profiles.display_name", "identity.profiles.first_name", "identity.profiles.last_name",
      "identity.profiles.preferred_language", "shared.notifications.read_at",
    ]);
  });

  it("aucune séquence ni fonction métier n'est utilisable par anon / authenticated ; aucun SECURITY DEFINER", async () => {
    const seq = await h.pool.query(
      `select n.nspname || '.' || c.relname as s from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where c.relkind = 'S' and n.nspname = any($1)
          and (has_sequence_privilege('authenticated', c.oid, 'USAGE') or has_sequence_privilege('anon', c.oid, 'USAGE'))`, [SCHEMAS]);
    expect(seq.rows).toEqual([]);
    const fn = await h.pool.query(
      `select n.nspname || '.' || p.proname as f, p.prosecdef,
              has_schema_privilege('authenticated', n.oid, 'USAGE') and has_function_privilege('authenticated', p.oid, 'EXECUTE') as callable
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = any($1)`, [SCHEMAS]);
    expect(fn.rows.filter((x: any) => x.callable).map((x: any) => x.f)).toEqual([]);
    expect(fn.rows.filter((x: any) => x.prosecdef).map((x: any) => x.f)).toEqual([]);
  });

  it("sous le rôle authenticated, un client ne voit que ses propres lignes et ne peut rien écrire", async () => {
    await asAuthenticated(a.id, async (q) => {
      expect((await q(`select id from canada.clients`)).rows.map((x: any) => x.id)).toEqual([a.clientId]);
      expect((await q(`select id from identity.profiles`)).rows.map((x: any) => x.id)).toEqual([a.id]);
      await expect(q(`select 1 from access.user_roles`)).rejects.toMatchObject({ code: "42501" });
    });
    await asAuthenticated(a.id, async (q) => {
      await expect(q(`update identity.profiles set account_status = 'active' where id = $1`, [a.id])).rejects.toMatchObject({ code: "42501" });
    });
    await asAuthenticated(a.id, async (q) => {
      await expect(q(`insert into canada.clients(client_number, first_name, last_name) values ('X','Y','Z')`)).rejects.toMatchObject({ code: "42501" });
    });
    await asAuthenticated(a.id, async (q) => {
      // Mise à jour autorisée de son propre prénom, sans effet sur le profil d'autrui.
      expect((await q(`update identity.profiles set first_name = 'Pirate' where id = $1`, [b.id])).rowCount).toBe(0);
      expect((await q(`update identity.profiles set first_name = 'Ama' where id = $1`, [a.id])).rowCount).toBe(1);
    });
    await asAuthenticated(b.id, async (q) => {
      expect((await q(`select id from canada.clients`)).rows.map((x: any) => x.id)).toEqual([b.clientId]);
    });
  });
});

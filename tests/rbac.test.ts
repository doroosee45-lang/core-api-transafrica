import { setupHarness, type Harness } from "./support/harness.js";

let h: Harness;
let w: Awaited<ReturnType<Harness["world"]>>;
let superAdmin: any, adminCD: any, agentCN: any, agentCD: any, clientA: any, clientB: any, opsCM: any;
let parcelCN: string;

beforeAll(async () => {
  h = await setupHarness();
  w = await h.world();
  superAdmin = await h.makeUser("root@ta.test", { roles: [{ role: "canada_administrator", scope_type: "global" }] });
  adminCD = await h.makeUser("admin.cd@ta.test", { roles: [{ role: "canada_administrator", scope_type: "country", scope_country: "CD" }] });
  agentCN = await h.makeUser("agent.cn@ta.test", { roles: [{ role: "canada_agent", scope_type: "agency", scope_id: w.cn }] });
  agentCD = await h.makeUser("agent.cd@ta.test", { roles: [{ role: "canada_agent", scope_type: "agency", scope_id: w.cd }] });
  opsCM = await h.makeUser("admin.cm@ta.test", { mfa: true, roles: [{ role: "canada_administrator", scope_type: "country", scope_country: "CM" }] });
  clientA = await h.makeUser("client.a@ta.test", { roles: [{ role: "canada_client", scope_type: "own" }], client: { residence: "CD" } });
  clientB = await h.makeUser("client.b@ta.test", { roles: [{ role: "canada_client", scope_type: "own" }], client: { residence: "CD" } });
  const r = await h.api.post("/api/v1/canada/parcels").set(h.auth(await agentCN.token())).set(h.idem())
    .send({ client_id: clientA.clientId, recipient_name: "Famille A", origin_country: "CN", destination_country: "CD", origin_agency_id: w.cn, destination_agency_id: w.cd });
  expect(r.status).toBe(201);
  parcelCN = r.body.data.id;
});
afterAll(async () => { await h?.teardown(); });

describe("Isolation multi-pays et propriétaire (Cahier §19.1, Dossier 03 §13)", () => {
  it("le Super Admin global (MFA) voit tous les pays", async () => {
    const r = await h.api.get("/api/v1/canada/agencies").set(h.auth(await superAdmin.token("aal2")));
    expect(r.status).toBe(200);
    expect(new Set(r.body.data.map((a: any) => a.country_code))).toEqual(new Set(["CN", "CD", "CM"]));
  });

  it("l'administrateur RDC ne voit pas les agences du Cameroun ni de Chine", async () => {
    const r = await h.api.get("/api/v1/canada/agencies").set(h.auth(await adminCD.token("aal2")));
    expect(r.body.data.map((a: any) => a.country_code)).toEqual(["CD"]);
  });

  it("le pays de destination voit le colis à destination de son pays ; le Cameroun non", async () => {
    expect((await h.api.get(`/api/v1/canada/parcels/${parcelCN}`).set(h.auth(await adminCD.token("aal2")))).status).toBe(200);
    const cm = await h.api.get(`/api/v1/canada/parcels/${parcelCN}`).set(h.auth(await opsCM.token()));
    expect(cm.status).toBe(403);
    const list = await h.api.get("/api/v1/canada/parcels").set(h.auth(await opsCM.token()));
    expect(list.body.data).toHaveLength(0);
  });

  it("un filtre de requête ne peut pas élargir le périmètre (paramètre agency_id d'une autre agence)", async () => {
    const r = await h.api.get(`/api/v1/canada/parcels?agency_id=${w.cn}`).set(h.auth(await opsCM.token()));
    expect(r.body.data).toHaveLength(0);
  });

  it("client A ne lit pas les données du client B (UUID substitué) ; le refus est journalisé", async () => {
    const own = await h.api.get(`/api/v1/me/parcels/${parcelCN}/tracking`).set(h.auth(await clientA.token()));
    expect(own.status).toBe(200);
    const other = await h.api.get(`/api/v1/me/parcels/${parcelCN}/tracking`).set(h.auth(await clientB.token()));
    expect(other.status).toBe(403);
    const staffRoute = await h.api.get(`/api/v1/canada/parcels`).set(h.auth(await clientB.token()));
    expect(staffRoute.body.data).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 100));
    const ev = await h.pool.query(`select count(*)::int n from audit.security_events where event_type = 'access.denied' and user_id = $1`, [clientB.id]);
    expect(ev.rows[0].n).toBeGreaterThan(0);
  });

  it("un client ne modifie jamais un statut logistique", async () => {
    const r = await h.api.post(`/api/v1/canada/parcels/${parcelCN}/transitions`).set(h.auth(await clientA.token())).set(h.idem()).send({ to_status: "delivered", proof_reference: "x" });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("PERMISSION_REQUIRED");
  });

  it("une étape d'origine ne peut pas être faite par l'agence de destination", async () => {
    const r = await h.api.post(`/api/v1/canada/parcels/${parcelCN}/transitions`).set(h.auth(await agentCD.token())).set(h.idem()).send({ to_status: "inspected" });
    expect(r.status).toBe(403);
  });
});

describe("Anti-escalade et gestion des accès (Dossier 03 §6, §11, §12)", () => {
  it("un agent ne peut ni attribuer de rôle ni modifier ses propres permissions", async () => {
    const r = await h.api.post("/api/v1/access/user-roles").set(h.auth(await agentCN.token())).set(h.idem())
      .send({ user_id: agentCN.id, role_code: "canada_administrator", scope_type: "global" });
    expect(r.status).toBe(403);
  });

  it("personne ne s'attribue un rôle à soi-même, même un Super Admin", async () => {
    const r = await h.api.post("/api/v1/access/user-roles").set(h.auth(await superAdmin.token("aal2"))).set(h.idem())
      .send({ user_id: superAdmin.id, role_code: "canada_finance_manager", scope_type: "global" });
    expect(r.body.error.code).toBe("SELF_ASSIGNMENT");
  });

  it("un administrateur pays ne crée pas d'autre administrateur (rôle sensible : global uniquement)", async () => {
    const target = await h.makeUser("futur.admin@ta.test");
    const r = await h.api.post("/api/v1/access/user-roles").set(h.auth(await adminCD.token("aal2"))).set(h.idem())
      .send({ user_id: target.id, role_code: "canada_administrator", scope_type: "country", scope_country: "CD" });
    expect(r.status).toBe(403);
  });

  it("un administrateur pays ne peut pas accorder des permissions qu'il ne détient pas (finance)", async () => {
    const target = await h.makeUser("caissier.cd@ta.test");
    const r = await h.api.post("/api/v1/access/user-roles").set(h.auth(await adminCD.token("aal2"))).set(h.idem())
      .send({ user_id: target.id, role_code: "canada_finance_agent", scope_type: "country", scope_country: "CD" });
    expect(r.body.error.code).toBe("PRIVILEGE_ESCALATION");
  });

  it("un administrateur pays attribue un manager d'agence dans son pays, pas dans un autre", async () => {
    const target = await h.makeUser("manager.cd@ta.test");
    const ok = await h.api.post("/api/v1/access/user-roles").set(h.auth(await adminCD.token("aal2"))).set(h.idem())
      .send({ user_id: target.id, role_code: "canada_agency_manager", scope_type: "agency", scope_id: w.cd });
    expect(ok.status).toBe(201);
    const ko = await h.api.post("/api/v1/access/user-roles").set(h.auth(await adminCD.token("aal2"))).set(h.idem())
      .send({ user_id: target.id, role_code: "canada_agency_manager", scope_type: "agency", scope_id: w.cm });
    expect(ko.status).toBe(403);
    const audit = await h.pool.query(`select count(*)::int n from audit.access_changes where target_user_id = $1 and change_type = 'grant'`, [target.id]);
    expect(audit.rows[0].n).toBe(1);
  });

  it("le rôle client ne peut avoir qu'un périmètre « own » (contrainte base)", async () => {
    const target = await h.makeUser("x@ta.test");
    const r = await h.api.post("/api/v1/access/user-roles").set(h.auth(await superAdmin.token("aal2"))).set(h.idem())
      .send({ user_id: target.id, role_code: "canada_client", scope_type: "global" });
    expect(r.body.error.code).toBe("SCOPE_NOT_ALLOWED");
  });

  it("MFA : les rôles sensibles sont ignorés en session AAL1", async () => {
    const r = await h.api.get("/api/v1/canada/agencies").set(h.auth(await superAdmin.token("aal1")));
    expect(r.status).toBe(403);
    const me = await h.api.get("/api/v1/identity/me").set(h.auth(await superAdmin.token("aal1")));
    expect(me.body.data.roles_pending_mfa).toContain("canada_administrator");
  });

  it("révocation : effet immédiat sur la requête suivante, historique conservé", async () => {
    const victim = await h.makeUser("agent.revoque@ta.test", { roles: [{ role: "canada_agent", scope_type: "agency", scope_id: w.cd }] });
    const t = await victim.token();
    expect((await h.api.get("/api/v1/canada/parcels").set(h.auth(t))).status).toBe(200);
    const a = (await h.pool.query(`select id from access.user_roles where user_id = $1`, [victim.id])).rows[0];
    const rv = await h.api.post(`/api/v1/access/user-roles/${a.id}/revoke`).set(h.auth(await adminCD.token("aal2"))).send({ reason: "Départ de l'agence" });
    expect(rv.status).toBe(200);
    expect((await h.api.get("/api/v1/canada/parcels").set(h.auth(t))).status).toBe(403);
    const kept = await h.pool.query(`select revoked_at, revocation_reason from access.user_roles where id = $1`, [a.id]);
    expect(kept.rows[0].revocation_reason).toBe("Départ de l'agence");
    await expect(h.pool.query(`delete from access.user_roles where id = $1`, [a.id])).rejects.toThrow(/APPEND_ONLY/);
  });

  it("rôle exceptionnel : réservé au super-administrateur exceptionnel, justifié et limité dans le temps", async () => {
    const target = await h.makeUser("breakglass@ta.test");
    const r = await h.api.post("/api/v1/access/user-roles").set(h.auth(await superAdmin.token("aal2"))).set(h.idem())
      .send({ user_id: target.id, role_code: "canada_super_administrator", scope_type: "global" });
    expect(r.status).toBe(403);
  });

  it("invitation : jeton haché, adresse vérifiée correspondante, usage unique", async () => {
    const inv = await h.api.post("/api/v1/access/invitations").set(h.auth(await adminCD.token("aal2"))).set(h.idem())
      .send({ email: "nouvel.agent@ta.test", role_code: "canada_agent", scope_type: "agency", scope_id: w.cd });
    expect(inv.status).toBe(201);
    expect(inv.body.data.email_delivery).toBe("skipped"); // aucun fournisseur e-mail configuré : jamais « envoyé »
    const token = inv.body.data.dev_token;
    const stored = await h.pool.query(`select token_hash from access.invitations where id = $1`, [inv.body.data.invitation_id]);
    expect(stored.rows[0].token_hash).not.toBe(token);

    const intruder = await h.makeUser("intrus@ta.test");
    expect((await h.api.post("/api/v1/access/invitations/accept").set(h.auth(await intruder.token())).send({ token })).body.error.code).toBe("INVITATION_EMAIL_MISMATCH");
    const invitee = await h.makeUser("nouvel.agent@ta.test");
    const ok = await h.api.post("/api/v1/access/invitations/accept").set(h.auth(await invitee.token())).send({ token });
    expect(ok.status).toBe(200);
    expect(ok.body.data.role).toBe("canada_agent");
    expect((await h.api.post("/api/v1/access/invitations/accept").set(h.auth(await invitee.token())).send({ token })).status).toBe(409);
  });
});

describe("Intégrité et défense en profondeur", () => {
  it("journaux et historiques en ajout seul ; pas de suppression physique de colis", async () => {
    await expect(h.pool.query(`update audit.audit_events set action = 'x'`)).rejects.toThrow(/APPEND_ONLY/);
    await expect(h.pool.query(`delete from canada.parcel_events`)).rejects.toThrow(/APPEND_ONLY/);
    await expect(h.pool.query(`delete from canada.parcels where id = $1`, [parcelCN])).rejects.toThrow(/APPEND_ONLY/);
  });

  it("RLS : un rôle « authenticated » ne lit que ses colis et n'accède pas aux tables d'administration", async () => {
    const c = await h.pool.connect();
    try {
      await c.query("begin");
      await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: clientB.id, role: "authenticated" })]);
      await c.query("set local role authenticated");
      expect((await c.query(`select id from canada.parcels`)).rows).toHaveLength(0);
      await c.query("rollback");
      await c.query("begin");
      await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: clientA.id, role: "authenticated" })]);
      await c.query("set local role authenticated");
      expect((await c.query(`select id from canada.parcels`)).rows.map((r) => r.id)).toEqual([parcelCN]);
      await expect(c.query(`select * from access.user_roles`)).rejects.toThrow(/permission denied/);
      await c.query("rollback");
      await c.query("begin");
      await c.query("set local role anon");
      await expect(c.query(`select * from canada.parcels`)).rejects.toThrow(/permission denied/);
      await c.query("rollback");
    } finally { c.release(); }
  });

  it("catalogue : chaque permission exigée par une route existe en base", async () => {
    const { registry } = await import("../src/core/routes.js");
    const used = new Set(registry.flatMap((r: any) => r.anyPermission ?? []));
    const known = new Set((await h.pool.query(`select code from access.permissions`)).rows.map((r) => r.code));
    expect([...used].filter((p) => !known.has(p))).toEqual([]);
  });
});

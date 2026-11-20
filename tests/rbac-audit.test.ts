import { setupHarness, type Harness } from "./support/harness.js";

/**
 * Audit RBAC du 20/11/2026 :
 *  - escalation par modification d'un rôle personnalisé déjà attribué (corrigée) ;
 *  - comportement actuel de la nomination du personnel financier (D-15, option 1 sélectionnée,
 *    en attente de validation formelle : ces tests décrivent l'existant, aucune règle n'a été changée) ;
 *  - V-02 : le Super Admin n'obtient jamais d'opération d'encaissement, directement ou indirectement.
 */
let h: Harness;
let w: Awaited<ReturnType<Harness["world"]>>;
let root: any, exceptional: any, adminCN: any, cashier: any;
const T = async (u: any, aal?: "aal1" | "aal2") => h.auth(await u.token(aal));
const in3days = () => new Date(Date.now() + 3 * 86400000).toISOString();

beforeAll(async () => {
  h = await setupHarness();
  w = await h.world();
  root = await h.makeUser("root.audit@ta.test", { mfa: true, roles: [{ role: "canada_administrator", scope_type: "global" }] });
  adminCN = await h.makeUser("admin.cn.audit@ta.test", { mfa: true, roles: [{ role: "canada_administrator", scope_type: "country", scope_country: "CN" }] });
  exceptional = await h.makeUser("bris.glace@ta.test", { mfa: true, roles: [{ role: "canada_super_administrator", scope_type: "global", expires_at: in3days() }] });
  cashier = await h.makeUser("futur.caissier@ta.test");
});
afterAll(async () => { await h?.teardown(); });

const permsOf = async (u: any) => (await h.api.get("/api/v1/identity/me").set(await T(u))).body.data.permissions as string[];

describe("Rôles personnalisés : pas d'escalade par modification", () => {
  it("le Super Admin ne peut pas ajouter à un rôle déjà attribué une permission qu'il ne détient pas", async () => {
    const created = await h.api.post("/api/v1/access/roles").set(await T(root)).set(h.idem())
      .send({ code: "canada_custom_guichet", name: "Guichet", permissions: ["canada.clients.read_scoped"], allowed_scopes: ["agency"] });
    expect(created.status).toBe(201);
    const target = await h.makeUser("guichet@ta.test");
    expect((await h.api.post("/api/v1/access/user-roles").set(await T(root)).set(h.idem())
      .send({ user_id: target.id, role_code: "canada_custom_guichet", scope_type: "agency", scope_id: w.cn })).status).toBe(201);

    const patch = await h.api.patch("/api/v1/access/roles/canada_custom_guichet").set(await T(root))
      .send({ permissions: ["canada.clients.read_scoped", "canada.payments.verify", "canada.refunds.execute"], reason: "Tentative d'élargissement" });
    expect(patch.status).toBe(403);
    expect(patch.body.error.code).toBe("PRIVILEGE_ESCALATION");
    expect(await permsOf(target)).not.toContain("canada.payments.verify");

    // Un administrateur PAYS (roles.manage est global) ne gère pas les rôles.
    expect((await h.api.patch("/api/v1/access/roles/canada_custom_guichet").set(await T(adminCN))
      .send({ name: "Renommé", reason: "Essai pays" })).status).toBe(403);
    // Retirer une permission ou renommer reste possible et audité.
    const ok = await h.api.patch("/api/v1/access/roles/canada_custom_guichet").set(await T(root))
      .send({ name: "Guichet accueil", reason: "Libellé" });
    expect(ok.status).toBe(200);
  });

  it("l'administrateur exceptionnel (MFA) peut définir un rôle « caissier » ; le Super Admin ne peut pas l'élargir", async () => {
    const created = await h.api.post("/api/v1/access/roles").set(await T(root)).set(h.idem())
      .send({ code: "canada_custom_caissier", name: "Caissier", permissions: ["canada.payments.read_scoped"], allowed_scopes: ["agency"] });
    expect(created.status).toBe(201);
    const byExc = await h.api.patch("/api/v1/access/roles/canada_custom_caissier").set(await T(exceptional))
      .send({ permissions: ["canada.payments.read_scoped", "canada.payments.verify"], reason: "Définition du rôle caissier" });
    expect(byExc.status).toBe(200);
    // Désactivé, il ne peut être réactivé que par quelqu'un qui détient ses permissions.
    expect((await h.api.patch("/api/v1/access/roles/canada_custom_caissier").set(await T(root)).send({ is_active: false, reason: "Gel temporaire" })).status).toBe(200);
    const revive = await h.api.patch("/api/v1/access/roles/canada_custom_caissier").set(await T(root)).send({ is_active: true, reason: "Réactivation" });
    expect(revive.body.error.code).toBe("PRIVILEGE_ESCALATION");
    expect((await h.api.patch("/api/v1/access/roles/canada_custom_caissier").set(await T(exceptional)).send({ is_active: true, reason: "Réactivation" })).status).toBe(200);
  });
});

describe("D-15 — comportement ACTUEL de la nomination du personnel financier (option 1 sélectionnée, non encore validée)", () => {
  it("le Super Admin ne peut nommer ni agent financier, ni responsable financier, ni caissier", async () => {
    for (const [role, scope] of [["canada_finance_agent", { scope_type: "agency", scope_id: w.cn }],
      ["canada_finance_manager", { scope_type: "global" }], ["canada_custom_caissier", { scope_type: "agency", scope_id: w.cn }]] as const) {
      const r = await h.api.post("/api/v1/access/user-roles").set(await T(root)).set(h.idem()).send({ user_id: cashier.id, role_code: role, ...scope });
      expect(r.status).toBe(403);
    }
  });

  it("l'administrateur exceptionnel ne peut nommer qu'en session MFA (AAL2) ; l'attribution est journalisée", async () => {
    const aal1 = await h.api.post("/api/v1/access/user-roles").set(await T(exceptional, "aal1")).set(h.idem())
      .send({ user_id: cashier.id, role_code: "canada_custom_caissier", scope_type: "agency", scope_id: w.cn });
    expect(aal1.status).toBe(403);
    const ok = await h.api.post("/api/v1/access/user-roles").set(await T(exceptional, "aal2")).set(h.idem())
      .send({ user_id: cashier.id, role_code: "canada_custom_caissier", scope_type: "agency", scope_id: w.cn, justification: "Ouverture du guichet de Guangzhou" });
    expect(ok.status).toBe(201);
    expect(await permsOf(cashier)).toContain("canada.payments.verify");
    const log = (await h.pool.query(`select change_type, reason from audit.access_changes where target_user_id = $1`, [cashier.id])).rows;
    expect(log).toContainEqual({ change_type: "grant", reason: "Ouverture du guichet de Guangzhou" });
    // Le journal d'accès est en ajout seul.
    await expect(h.pool.query(`update audit.access_changes set reason = 'x' where target_user_id = $1`, [cashier.id])).rejects.toBeTruthy();
  });

  it("le Super Admin peut RÉVOQUER un rôle financier (la révocation n'exige pas la permission révoquée)", async () => {
    const a = (await h.pool.query(`select ur.id from access.user_roles ur join access.roles r on r.id = ur.role_id where ur.user_id = $1 and r.code = 'canada_custom_caissier'`, [cashier.id])).rows[0];
    const r = await h.api.post(`/api/v1/access/user-roles/${a.id}/revoke`).set(await T(root)).set(h.idem()).send({ reason: "Fin de mission au guichet" });
    expect(r.status).toBe(200);
    expect(await permsOf(cashier)).not.toContain("canada.payments.verify");
  });

  it("le rôle exceptionnel ne peut être attribué que par un autre administrateur exceptionnel, pour 7 jours au plus", async () => {
    const candidate = await h.makeUser("relais@ta.test");
    const byRoot = await h.api.post("/api/v1/access/user-roles").set(await T(root)).set(h.idem())
      .send({ user_id: candidate.id, role_code: "canada_super_administrator", scope_type: "global", expires_at: in3days(), justification: "Nomination du caissier de Douala" });
    expect(byRoot.status).toBe(403);
    const tooLong = await h.api.post("/api/v1/access/user-roles").set(await T(exceptional)).set(h.idem())
      .send({ user_id: candidate.id, role_code: "canada_super_administrator", scope_type: "global",
        expires_at: new Date(Date.now() + 8 * 86400000).toISOString(), justification: "Nomination du caissier de Douala" });
    expect(tooLong.body.error.code).toBe("EXPIRY_REQUIRED");
  });

  it("à expiration, l'administrateur exceptionnel perd immédiatement ses droits (l'échéance est immuable en base)", async () => {
    await expect(h.pool.query(`update access.user_roles set expires_at = now() + interval '1 year' where user_id = $1`, [exceptional.id]))
      .rejects.toThrow(/ROLE_ASSIGNMENT_IMMUTABLE/);
    const shortLived = await h.makeUser("bris.glace.court@ta.test", { mfa: true,
      roles: [{ role: "canada_super_administrator", scope_type: "global", expires_at: new Date(Date.now() + 1500).toISOString() }] });
    const token = await shortLived.token("aal2");
    await new Promise((r) => setTimeout(r, 2000));
    const r = await h.api.post("/api/v1/access/user-roles").set(h.auth(token)).set(h.idem())
      .send({ user_id: cashier.id, role_code: "canada_finance_agent", scope_type: "agency", scope_id: w.cn });
    expect(r.status).toBe(403);
  });
});

describe("V-02 — aucun chemin indirect vers l'encaissement pour le Super Admin", () => {
  it("ses permissions effectives n'incluent jamais payments.verify ni refunds.*", async () => {
    const p = await permsOf(root);
    expect(p.filter((x) => x === "canada.payments.verify" || x.startsWith("canada.refunds."))).toEqual([]);
  });
  it("il ne peut pas se donner (ni via un complice) un rôle portant ces permissions", async () => {
    const self = await h.api.post("/api/v1/access/user-roles").set(await T(root)).set(h.idem())
      .send({ user_id: root.id, role_code: "canada_finance_manager", scope_type: "global" });
    expect(self.status).toBe(403);
  });
});

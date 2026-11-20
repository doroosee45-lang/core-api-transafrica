/**
 * Structure multi-pays par l'API (Cahier §3, §4, Modules 1-5, 12, 15) :
 * les 5 pays, leurs agences, entrepôts, clients, référentiels, barèmes, comptes et rapports,
 * avec l'isolation de chaque administration nationale.
 */
import { setupHarness, type Harness } from "./support/harness.js";

let h: Harness;
let root: any, admins: Record<string, any> = {}, finMgrCD: any, auditor: any;
const agencies: Record<string, string> = {};
const T = async (u: any, aal?: "aal1" | "aal2") => h.auth(await u.token(aal));
const COUNTRIES = { CN: "Asia/Shanghai", CD: "Africa/Kinshasa", CG: "Africa/Brazzaville", CM: "Africa/Douala", CA: "America/Toronto" } as const;

beforeAll(async () => {
  h = await setupHarness();
  root = await h.makeUser("root@ta.test", { mfa: true, roles: [{ role: "canada_administrator", scope_type: "global" }] });
  for (const c of Object.keys(COUNTRIES)) {
    admins[c] = await h.makeUser(`admin.${c.toLowerCase()}@ta.test`, { mfa: true, roles: [{ role: "canada_administrator", scope_type: "country", scope_country: c }] });
  }
  finMgrCD = await h.makeUser("fin.cd@ta.test", { mfa: true, roles: [{ role: "canada_finance_manager", scope_type: "country", scope_country: "CD" }] });
  auditor = await h.makeUser("audit@ta.test", { roles: [{ role: "canada_security_auditor", scope_type: "global" }] });
});
afterAll(async () => { await h?.teardown(); });

describe("Cinq pays, cinq administrations isolées", () => {
  it("les 5 pays d'exploitation sont configurés avec devise et fuseau", async () => {
    const r = await h.api.get("/api/v1/canada/countries").set(await T(admins.CD));
    const op = r.body.data.filter((c: any) => c.is_operating).map((c: any) => [c.code, c.default_currency]);
    expect(op.sort()).toEqual([["CA", "CAD"], ["CD", "CDF"], ["CG", "XAF"], ["CM", "XAF"], ["CN", "CNY"]]);
  });

  it("chaque administrateur crée les agences de SON pays uniquement", async () => {
    for (const [c, tz] of Object.entries(COUNTRIES)) {
      const r = await h.api.post("/api/v1/canada/agencies").set(await T(admins[c]))
        .send({ code: `AG-${c}`, name: `Agence ${c}`, country_code: c, city: "Capitale", timezone: tz });
      expect(r.status, c).toBe(201);
      agencies[c] = r.body.data.id;
    }
    const cross = await h.api.post("/api/v1/canada/agencies").set(await T(admins.CD)).send({ code: "AG-X", name: "Agence pirate", country_code: "CA", timezone: "America/Toronto" });
    expect(cross.status).toBe(403);
    const second = await h.api.post("/api/v1/canada/agencies").set(await T(root)).send({ code: "AG-CD-2", name: "Lubumbashi", country_code: "CD", timezone: "Africa/Lubumbashi" });
    expect(second.status).toBe(201);
  });

  it("un pays de transit n'accueille pas d'agence ; seul le Super Admin le déclare", async () => {
    expect((await h.api.post("/api/v1/canada/countries").set(await T(admins.CD)).send({ code: "ET", name_fr: "Éthiopie", name_en: "Ethiopia" })).status).toBe(403);
    expect((await h.api.post("/api/v1/canada/countries").set(await T(root)).send({ code: "ET", name_fr: "Éthiopie", name_en: "Ethiopia", default_timezone: "Africa/Addis_Ababa" })).status).toBe(201);
    const r = await h.api.post("/api/v1/canada/agencies").set(await T(root)).send({ code: "AG-ET", name: "Addis", country_code: "ET", timezone: "Africa/Addis_Ababa" });
    expect(r.body.error.code).toBe("COUNTRY_NOT_OPERATING");
  });

  it("listes et modifications d'agences limitées au pays", async () => {
    const list = await h.api.get("/api/v1/canada/agencies").set(await T(admins.CM));
    expect(list.body.data.map((a: any) => a.country_code)).toEqual(["CM"]);
    expect((await h.api.get("/api/v1/canada/agencies").set(await T(root))).body.data).toHaveLength(6);
    expect((await h.api.patch(`/api/v1/canada/agencies/${agencies.CM}`).set(await T(admins.CM)).send({ phone: "+237 600 000" })).status).toBe(200);
    expect((await h.api.patch(`/api/v1/canada/agencies/${agencies.CM}`).set(await T(admins.CG)).send({ status: "suspended" })).status).toBe(403);
    const wh = await h.api.post(`/api/v1/canada/agencies/${agencies.CG}/warehouses`).set(await T(admins.CG)).send({ code: "WH-BZV", name: "Entrepôt Brazzaville" });
    expect(wh.status).toBe(201);
    expect((await h.api.get(`/api/v1/canada/agencies/${agencies.CG}/warehouses`).set(await T(admins.CA))).status).toBe(403);
  });

  it("référentiels aériens et barèmes : réservés au périmètre global", async () => {
    expect((await h.api.post("/api/v1/canada/airlines").set(await T(admins.CD)).send({ iata_code: "AF", name: "Air France" })).status).toBe(403);
    expect((await h.api.post("/api/v1/canada/airlines").set(await T(root)).send({ iata_code: "AF", icao_code: "AFR", name: "Air France" })).status).toBe(201);
    expect((await h.api.post("/api/v1/canada/airports").set(await T(root)).send({ iata_code: "YUL", name: "Montréal-Trudeau", city: "Montréal", country_code: "CA", timezone: "Mars/Olympus" })).status).toBe(400);
    expect((await h.api.post("/api/v1/canada/airports").set(await T(root)).send({ iata_code: "YUL", name: "Montréal-Trudeau", city: "Montréal", country_code: "CA", timezone: "America/Toronto" })).status).toBe(201);
    const rule = { code: "CA-CD-AIR", origin_country: "CA", destination_country: "CD", transport_mode: "air", currency: "CAD",
      rate_per_kg: "12.5", minimum_charge: "25", service_fee: "10", volumetric_divisor: 5000, effective_from: new Date(Date.now() - 1000).toISOString() };
    expect((await h.api.post("/api/v1/canada/pricing-rules").set(await T(finMgrCD)).send(rule)).status).toBe(403); // global_only
    const v1 = await h.api.post("/api/v1/canada/pricing-rules").set(await T(root)).send(rule);
    expect(v1.body.data.version).toBe(1);
    expect((await h.api.post(`/api/v1/canada/pricing-rules/${v1.body.data.id}/activate`).set(await T(root))).body.data.status).toBe("active");
    const v2 = await h.api.post("/api/v1/canada/pricing-rules").set(await T(root)).send({ ...rule, rate_per_kg: "13" });
    await h.api.post(`/api/v1/canada/pricing-rules/${v2.body.data.id}/activate`).set(await T(root));
    const all = (await h.api.get("/api/v1/canada/pricing-rules").set(await T(admins.CA))).body.data.filter((r: any) => r.code === "CA-CD-AIR");
    expect(all.map((r: any) => [r.version, r.status])).toEqual([[2, "active"], [1, "retired"]]);
  });
});

describe("Clients, comptes et rapports par périmètre", () => {
  it("clients : création au guichet dans l'agence, lecture limitée, rattachement de compte audité", async () => {
    const agent = await h.makeUser("agent.ca@ta.test", { roles: [{ role: "canada_agent", scope_type: "agency", scope_id: agencies.CA }] });
    const c = await h.api.post("/api/v1/canada/clients").set(await T(agent)).set(h.idem())
      .send({ first_name: "Marie", last_name: "Tremblay", phone: "+1 514 555 0100", residence_country: "CA", home_agency_id: agencies.CA });
    expect(c.status).toBe(201);
    expect(c.body.data.client_number).toMatch(/^CL-\d{4}-\d{6}$/);
    expect((await h.api.post("/api/v1/canada/clients").set(await T(agent)).set(h.idem())
      .send({ first_name: "X", last_name: "Y", phone: "+243 000 000", residence_country: "CD", home_agency_id: agencies.CD })).status).toBe(403);
    expect((await h.api.get(`/api/v1/canada/clients/${c.body.data.id}`).set(await T(admins.CD))).status).toBe(403);
    const search = await h.api.get("/api/v1/canada/clients?search=Tremb").set(await T(admins.CA));
    expect(search.body.data.map((x: any) => x.last_name)).toEqual(["Tremblay"]);
    const account = await h.makeUser("marie@ta.test");
    expect((await h.api.post(`/api/v1/canada/clients/${c.body.data.id}/link-account`).set(await T(admins.CA)).send({ user_id: account.id, reason: "Pièce d'identité vérifiée" })).status).toBe(200);
    expect((await h.api.post(`/api/v1/canada/clients/${c.body.data.id}/link-account`).set(await T(admins.CA)).send({ user_id: account.id, reason: "Doublon" })).body.error.code).toBe("CLIENT_ALREADY_LINKED");
  });

  it("utilisateurs : l'administrateur pays ne voit que le personnel de son pays ; suspension réservée au global", async () => {
    const mgr = await h.makeUser("mgr.cm@ta.test", { roles: [{ role: "canada_agency_manager", scope_type: "agency", scope_id: agencies.CM }] });
    const cm = (await h.api.get("/api/v1/access/users").set(await T(admins.CM))).body.data.map((u: any) => u.email);
    expect(cm).toEqual(expect.arrayContaining(["mgr.cm@ta.test", "admin.cm@ta.test"]));
    expect(cm).not.toContain("admin.cd@ta.test");
    expect((await h.api.get("/api/v1/access/roles").set(await T(admins.CM))).body.data.map((r: any) => r.code)).toContain("canada_agency_manager");
    expect((await h.api.post(`/api/v1/access/users/${mgr.id}/platform-access`).set(await T(admins.CM)).send({ status: "suspended", reason: "Enquête interne" })).status).toBe(403);
    expect((await h.api.post(`/api/v1/access/users/${mgr.id}/platform-access`).set(await T(root)).send({ status: "suspended", reason: "Enquête interne" })).status).toBe(200);
    expect((await h.api.get("/api/v1/canada/agencies").set(await T(mgr))).body.error.code).toBe("PLATFORM_ACCESS_REQUIRED");
    expect((await h.api.post(`/api/v1/access/users/${mgr.id}/account-status`).set(await T(root)).send({ status: "suspended", reason: "Départ" })).status).toBe(200);
    expect((await h.api.get("/api/v1/identity/me").set(await T(mgr))).body.error.code).toBe("ACCOUNT_NOT_ACTIVE");
  });

  it("tableaux de bord et audit : agrégats limités au pays ; indicateurs techniques au global", async () => {
    const cd = await h.api.get("/api/v1/canada/reports/overview").set(await T(admins.CD));
    expect(cd.status).toBe(200);
    expect(cd.body.data.scope).toMatchObject({ global: false, countries: ["CD"] });
    expect(cd.body.data.notification_failures).toBeUndefined();
    const all = await h.api.get("/api/v1/canada/reports/overview").set(await T(root));
    expect(all.body.data.outbox).toBeDefined();
    const auditCD = await h.api.get("/api/v1/canada/audit-events?resource_type=agency").set(await T(admins.CD));
    expect(auditCD.body.data.every((e: any) => e.country_code === "CD")).toBe(true);
    const auditAll = await h.api.get("/api/v1/canada/audit-events?resource_type=agency").set(await T(auditor));
    expect(new Set(auditAll.body.data.map((e: any) => e.country_code)).size).toBeGreaterThanOrEqual(5);
    expect((await h.api.post("/api/v1/canada/agencies").set(await T(auditor)).send({ code: "AG-Z", name: "Z", country_code: "CD", timezone: "Africa/Kinshasa" })).status).toBe(403);
  });
});

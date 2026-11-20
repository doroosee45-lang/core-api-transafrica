import { setupHarness, type Harness } from "./support/harness.js";

/**
 * Vérification du 20/11/2026 (mission de consolidation des preuves) : routes sensibles dont les
 * tests ne prouvaient que le cas AUTORISÉ. Chaque cas ci-dessous prouve le REFUS hors périmètre
 * (autre pays, autre agence, autre client) ou sans permission, avec un témoin autorisé.
 * Aucun code applicatif n'est modifié par ce fichier.
 */
let h: Harness;
let w: Awaited<ReturnType<Harness["world"]>>;
let root: any, adminCN: any, adminCD: any, adminCM: any, mgrCN: any, mgrCD: any, mgrCM: any, agentCN: any, agentCM: any, finCN: any, finCM: any, client: any, other: any;
let parcelId: string, shipmentId: string, flightId: string, ticketId: string;
const T = async (u: any, aal?: "aal1" | "aal2") => h.auth(await u.token(aal));
const refused = (s: number) => expect([403, 404]).toContain(s);

beforeAll(async () => {
  h = await setupHarness();
  w = await h.world();
  const mk = (e: string, role: string, scope: any, mfa = false) => h.makeUser(e, { mfa, roles: [{ role, ...scope }] });
  root = await mk("root.neg@ta.test", "canada_administrator", { scope_type: "global" }, true);
  adminCN = await mk("adm.cn.neg@ta.test", "canada_administrator", { scope_type: "country", scope_country: "CN" }, true);
  adminCD = await mk("adm.cd.neg@ta.test", "canada_administrator", { scope_type: "country", scope_country: "CD" }, true);
  adminCM = await mk("adm.cm.neg@ta.test", "canada_administrator", { scope_type: "country", scope_country: "CM" }, true);
  mgrCN = await mk("mgr.cn.neg@ta.test", "canada_agency_manager", { scope_type: "agency", scope_id: w.cn });
  mgrCD = await mk("mgr.cd.neg@ta.test", "canada_agency_manager", { scope_type: "agency", scope_id: w.cd });
  mgrCM = await mk("mgr.cm.neg@ta.test", "canada_agency_manager", { scope_type: "agency", scope_id: w.cm });
  agentCN = await mk("agt.cn.neg@ta.test", "canada_agent", { scope_type: "agency", scope_id: w.cn });
  agentCM = await mk("agt.cm.neg@ta.test", "canada_agent", { scope_type: "agency", scope_id: w.cm });
  finCN = await mk("fin.cn.neg@ta.test", "canada_finance_agent", { scope_type: "agency", scope_id: w.cn });
  finCM = await mk("fin.cm.neg@ta.test", "canada_finance_agent", { scope_type: "agency", scope_id: w.cm });
  client = await h.makeUser("cli.neg@ta.test", { roles: [{ role: "canada_client", scope_type: "own" }], client: { residence: "CD", agency: w.cd } });
  other = await h.makeUser("oth.neg@ta.test", { roles: [{ role: "canada_client", scope_type: "own" }], client: { residence: "CD" } });

  const p = await h.api.post("/api/v1/canada/parcels").set(await T(agentCN)).set(h.idem())
    .send({ client_id: client.clientId, recipient_name: "Famille", origin_country: "CN", destination_country: "CD", origin_agency_id: w.cn, destination_agency_id: w.cd, received_now: true });
  parcelId = p.body.data.id;
  await h.api.post(`/api/v1/canada/parcels/${parcelId}/measurements`).set(await T(agentCN)).set(h.idem()).send({ actual_weight_kg: "2" });
  for (const s of ["inspected", "ready_for_shipment"]) await h.api.post(`/api/v1/canada/parcels/${parcelId}/transitions`).set(await T(agentCN)).set(h.idem()).send({ to_status: s });
  shipmentId = (await h.api.post("/api/v1/canada/shipments").set(await T(mgrCN)).set(h.idem()).send({ origin_country: "CN", destination_country: "CD", origin_agency_id: w.cn })).body.data.id;
  expect((await h.api.post(`/api/v1/canada/shipments/${shipmentId}/parcels`).set(await T(mgrCN)).set(h.idem()).send({ parcel_ids: [parcelId] })).status).toBe(200);
  const d = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
  flightId = (await h.api.post("/api/v1/canada/flights").set(await T(adminCN)).set(h.idem()).send({ airline_iata: "ET", flight_number: "699", flight_date: d,
    departure_airport: "CAN", arrival_airport: "FIH", scheduled_departure: `${d}T10:00:00+08:00`, scheduled_arrival: `${d}T20:00:00+01:00` })).body.data.id;
  ticketId = (await h.api.post("/api/v1/me/support-tickets").set(await T(client)).set(h.idem())
    .send({ category: "delay", subject: "Retard", message: "Mon colis est en retard.", parcel_id: parcelId })).body.data.id;
});
afterAll(async () => { await h?.teardown(); });

describe("Colis : création, suivi interne, classification hors périmètre", () => {
  it("création refusée à un agent d'une autre agence et à un client", async () => {
    const body = { client_id: client.clientId, recipient_name: "Famille", origin_country: "CN", destination_country: "CD", origin_agency_id: w.cn };
    refused((await h.api.post("/api/v1/canada/parcels").set(await T(agentCM)).set(h.idem()).send(body)).status);
    refused((await h.api.post("/api/v1/canada/parcels").set(await T(client)).set(h.idem()).send(body)).status);
  });
  it("suivi interne et classification : refusés hors agence, autorisés dans l'agence", async () => {
    refused((await h.api.get(`/api/v1/canada/parcels/${parcelId}/tracking`).set(await T(mgrCM))).status);
    expect((await h.api.get(`/api/v1/canada/parcels/${parcelId}/tracking`).set(await T(agentCN))).status).toBe(200);
    refused((await h.api.patch(`/api/v1/canada/parcels/${parcelId}/classification`).set(await T(agentCM)).send({ category: "clothing", reason: "Reclassement" })).status);
    // Témoin autorisé sur un colis neuf (un colis déjà en expédition a une classification figée : 409).
    const fresh = (await h.api.post("/api/v1/canada/parcels").set(await T(agentCN)).set(h.idem())
      .send({ client_id: client.clientId, recipient_name: "Famille", origin_country: "CN", destination_country: "CD", origin_agency_id: w.cn, received_now: true })).body.data.id;
    expect((await h.api.patch(`/api/v1/canada/parcels/${fresh}/classification`).set(await T(agentCN)).send({ category: "clothing", reason: "Reclassement" })).status).toBe(200);
  });
});

describe("Expéditions et vols : actions hors périmètre (V-01)", () => {
  it("retrait d'un colis et association à un vol refusés à une autre agence", async () => {
    refused((await h.api.post(`/api/v1/canada/shipments/${shipmentId}/parcels/${parcelId}/remove`).set(await T(mgrCM)).set(h.idem()).send({ reason: "Retrait" })).status);
    refused((await h.api.post(`/api/v1/canada/flights/${flightId}/shipments`).set(await T(mgrCM)).set(h.idem()).send({ shipment_id: shipmentId })).status);
  });
  it("validation (schedule) d'un vol refusée au manager (V-01) et au pays sans lien ; détail et suivi refusés hors périmètre", async () => {
    refused((await h.api.post(`/api/v1/canada/flights/${flightId}/schedule`).set(await T(mgrCN))).status);
    refused((await h.api.post(`/api/v1/canada/flights/${flightId}/schedule`).set(await T(adminCM))).status);
    refused((await h.api.get(`/api/v1/canada/flights/${flightId}`).set(await T(mgrCM))).status);
    expect((await h.api.get(`/api/v1/canada/flights/${flightId}`).set(await T(mgrCN))).status).toBe(200);
    refused((await h.api.get(`/api/v1/canada/flights/${flightId}/tracking`).set(await T(client))).status);
  });
});

describe("Finance : permissions et périmètre", () => {
  it("création d'un paiement : refusée sans permission et à la finance d'un autre pays", async () => {
    const body = { client_id: client.clientId, agency_id: w.cn, amount_due: "10", currency: "USD", purpose: "service" };
    refused((await h.api.post("/api/v1/canada/payments").set(await T(agentCN)).set(h.idem()).send(body)).status);
    refused((await h.api.post("/api/v1/canada/payments").set(await T(finCM)).set(h.idem()).send(body)).status);
    const ok = await h.api.post("/api/v1/canada/payments").set(await T(finCN)).set(h.idem()).send(body);
    expect(ok.status).toBe(201);
    refused((await h.api.get(`/api/v1/canada/payments/${ok.body.data.id}`).set(await T(finCM))).status);
    refused((await h.api.get(`/api/v1/canada/payments/${ok.body.data.id}`).set(await T(client))).status);
    expect((await h.api.get(`/api/v1/canada/payments/${ok.body.data.id}`).set(await T(finCN))).status).toBe(200);
  });
  it("taux et barèmes : gestion refusée au manager et à l'administrateur pays (gouvernance globale)", async () => {
    const rate = { base_currency: "USD", quote_currency: "CAD", rate: "1.37", effective_at: new Date().toISOString(), source: "Banque du Canada" };
    refused((await h.api.post("/api/v1/canada/exchange-rates").set(await T(mgrCN)).send(rate)).status);
    refused((await h.api.post("/api/v1/canada/exchange-rates").set(await T(adminCN)).send(rate)).status);
    refused((await h.api.get("/api/v1/canada/exchange-rates?base=USD&quote=CAD").set(await T(client))).status);
    const draft = await h.api.post("/api/v1/canada/pricing-rules").set(await T(root))
      .send({ code: "CN-CA-AIR", origin_country: "CN", destination_country: "CA", transport_mode: "air", currency: "CAD", rate_per_kg: "9", volumetric_divisor: 6000, effective_from: new Date().toISOString() });
    expect(draft.status).toBe(201);
    refused((await h.api.post(`/api/v1/canada/pricing-rules/${draft.body.data.id}/activate`).set(await T(mgrCN))).status);
    refused((await h.api.post(`/api/v1/canada/pricing-rules/${draft.body.data.id}/activate`).set(await T(adminCN))).status);
    refused((await h.api.get("/api/v1/canada/pricing-rules").set(await T(client))).status);
  });
  it("révision d'un devis refusée à une autre agence", async () => {
    const q = await h.api.post("/api/v1/canada/quotes").set(await T(mgrCN)).set(h.idem())
      .send({ client_id: client.clientId, agency_id: w.cn, origin_country: "CN", destination_country: "CD", currency: "USD", lines: [{ category: "handling", designation: "Manutention", quantity: "1", unit_price: "3", currency: "USD" }] });
    expect(q.status).toBe(201);
    refused((await h.api.post(`/api/v1/canada/quotes/${q.body.data.id}/revisions`).set(await T(mgrCM)).set(h.idem())
      .send({ lines: [{ category: "handling", designation: "Manutention", quantity: "1", unit_price: "4", currency: "USD" }], reason: "Révision" })).status);
  });
});

describe("Structure, gouvernance, audit, support : périmètre pays", () => {
  it("paramètres d'un autre pays et entrepôt dans une agence d'un autre pays : refusés", async () => {
    refused((await h.api.patch("/api/v1/canada/countries/CD/settings").set(await T(adminCN)).send({ default_locale: "fr", reason: "Essai hors pays" })).status);
    expect((await h.api.patch("/api/v1/canada/countries/CN/settings").set(await T(adminCN)).send({ default_locale: "fr", reason: "Confirmation" })).status).toBe(200);
    refused((await h.api.post(`/api/v1/canada/agencies/${w.cn}/warehouses`).set(await T(adminCM)).send({ code: "WH-NEG-1", name: "Entrepôt test" })).status);
    expect((await h.api.post(`/api/v1/canada/agencies/${w.cn}/warehouses`).set(await T(adminCN)).send({ code: "WH-NEG-2", name: "Entrepôt test" })).status).toBe(201);
  });
  it("invitations et révocations : refusées sans autorité sur le périmètre cible", async () => {
    refused((await h.api.post("/api/v1/access/invitations").set(await T(mgrCN)).set(h.idem())
      .send({ email: "x1@ta.test", role_code: "canada_agent", scope_type: "agency", scope_id: w.cn })).status);
    refused((await h.api.post("/api/v1/access/invitations").set(await T(adminCN)).set(h.idem())
      .send({ email: "x2@ta.test", role_code: "canada_agent", scope_type: "agency", scope_id: w.cd })).status);
    // V-02 par invitation : le Super Admin ne peut pas inviter un agent financier.
    refused((await h.api.post("/api/v1/access/invitations").set(await T(root)).set(h.idem())
      .send({ email: "x3@ta.test", role_code: "canada_finance_agent", scope_type: "agency", scope_id: w.cn })).status);
    const a = (await h.pool.query(`select id from access.user_roles where user_id = $1`, [mgrCN.id])).rows[0];
    refused((await h.api.post(`/api/v1/access/user-roles/${a.id}/revoke`).set(await T(adminCM)).set(h.idem()).send({ reason: "Hors périmètre" })).status);
  });
  it("listes d'utilisateurs, de clients et journal d'audit filtrés par pays", async () => {
    const users = async (u: any) => JSON.stringify((await h.api.get("/api/v1/access/users").set(await T(u))).body.data);
    expect(await users(adminCN)).toContain(mgrCN.id);
    expect(await users(adminCM)).not.toContain(mgrCN.id);
    const clients = async (u: any) => JSON.stringify((await h.api.get("/api/v1/canada/clients").set(await T(u))).body.data);
    expect(await clients(adminCD)).toContain(client.clientId);
    expect(await clients(adminCM)).not.toContain(client.clientId);
    refused((await h.api.get("/api/v1/canada/audit-events").set(await T(mgrCN))).status);
    const audit = async (u: any) => JSON.stringify((await h.api.get(`/api/v1/canada/audit-events?resource_id=${parcelId}`).set(await T(u))).body.data);
    expect(await audit(adminCN)).toContain(parcelId);
    expect(await audit(adminCM)).not.toContain(parcelId);
    refused((await h.api.get("/api/v1/canada/reports/overview").set(await T(client))).status);
  });
  it("support : ticket d'autrui illisible ; réponse refusée au pays non chargé du traitement (D-14)", async () => {
    refused((await h.api.get(`/api/v1/me/support-tickets/${ticketId}`).set(await T(other))).status);
    refused((await h.api.post(`/api/v1/canada/support-tickets/${ticketId}/messages`).set(await T(mgrCM)).send({ body: "Réponse" })).status);
    expect((await h.api.post(`/api/v1/canada/support-tickets/${ticketId}/messages`).set(await T(mgrCD)).send({ body: "Nous vérifions." })).status).toBe(201);
  });
  it("déconnexion sans jeton : 401", async () => {
    expect((await h.api.post("/api/v1/auth/logout").send({})).status).toBe(401);
  });
});

describe("Concurrence des associations colis / expéditions", () => {
  it("un même colis ajouté simultanément à deux expéditions n'est associé qu'à une seule", async () => {
    const p = (await h.api.post("/api/v1/canada/parcels").set(await T(agentCN)).set(h.idem())
      .send({ client_id: client.clientId, recipient_name: "Famille", origin_country: "CN", destination_country: "CD", origin_agency_id: w.cn, received_now: true })).body.data.id;
    await h.api.post(`/api/v1/canada/parcels/${p}/measurements`).set(await T(agentCN)).set(h.idem()).send({ actual_weight_kg: "1" });
    for (const s of ["inspected", "ready_for_shipment"]) await h.api.post(`/api/v1/canada/parcels/${p}/transitions`).set(await T(agentCN)).set(h.idem()).send({ to_status: s });
    const mkShip = async () => (await h.api.post("/api/v1/canada/shipments").set(await T(mgrCN)).set(h.idem()).send({ origin_country: "CN", destination_country: "CD", origin_agency_id: w.cn })).body.data.id;
    const [s1, s2] = [await mkShip(), await mkShip()];
    const tok = await T(mgrCN);
    const add = (s: string) => h.api.post(`/api/v1/canada/shipments/${s}/parcels`).set(tok).set(h.idem()).send({ parcel_ids: [p] });
    const [a, b] = await Promise.all([add(s1), add(s2)]);
    expect([a.status, b.status].filter((x) => x === 200)).toHaveLength(1);
    expect((await h.pool.query(`select count(*)::int n from canada.shipment_parcels where parcel_id = $1 and removed_at is null`, [p])).rows[0].n).toBe(1);
  });
});

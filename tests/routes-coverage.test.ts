import { PASSWORD, setupHarness, type Harness } from "./support/harness.js";

/**
 * Audit du 20/11/2026 : 37 routes sur 145 n'étaient appelées par AUCUN test
 * (inventaire automatique registre ↔ tests). Ce fichier les exerce toutes, avec
 * au moins un cas autorisé et un cas refusé (périmètre ou propriétaire), et vérifie
 * les droits du client (Cahier §3.6, §7.5, §19.1, §19.5).
 */
let h: Harness;
let w: Awaited<ReturnType<Harness["world"]>>;
let root: any, adminCN: any, adminCD: any, adminCM: any, mgrCN: any, mgrCD: any, mgrCM: any, agentCN: any, finCN: any, finMgr: any;
let client: any, other: any;
const T = async (u: any, aal?: "aal1" | "aal2") => h.auth(await u.token(aal));
const day = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

async function readyParcel(clientId: string) {
  const r = await h.api.post("/api/v1/canada/parcels").set(await T(agentCN)).set(h.idem())
    .send({ client_id: clientId, recipient_name: "Famille", origin_country: "CN", destination_country: "CD", origin_agency_id: w.cn, destination_agency_id: w.cd, received_now: true });
  expect(r.status).toBe(201);
  const id = r.body.data.id as string;
  expect((await h.api.post(`/api/v1/canada/parcels/${id}/measurements`).set(await T(agentCN)).set(h.idem()).send({ actual_weight_kg: "4.2" })).status).toBe(201);
  for (const s of ["inspected", "ready_for_shipment"]) {
    expect((await h.api.post(`/api/v1/canada/parcels/${id}/transitions`).set(await T(agentCN)).set(h.idem()).send({ to_status: s })).status).toBe(200);
  }
  return { id, reference: r.body.data.reference as string };
}

let parcel: { id: string; reference: string };
let shipmentId: string, flightId: string;

beforeAll(async () => {
  h = await setupHarness();
  w = await h.world();
  root = await h.makeUser("root.cov@ta.test", { mfa: true, roles: [{ role: "canada_administrator", scope_type: "global" }] });
  adminCN = await h.makeUser("admin.cn.cov@ta.test", { mfa: true, roles: [{ role: "canada_administrator", scope_type: "country", scope_country: "CN" }] });
  adminCD = await h.makeUser("admin.cd.cov@ta.test", { mfa: true, roles: [{ role: "canada_administrator", scope_type: "country", scope_country: "CD" }] });
  adminCM = await h.makeUser("admin.cm.cov@ta.test", { mfa: true, roles: [{ role: "canada_administrator", scope_type: "country", scope_country: "CM" }] });
  mgrCN = await h.makeUser("mgr.cn.cov@ta.test", { roles: [{ role: "canada_agency_manager", scope_type: "agency", scope_id: w.cn }] });
  mgrCD = await h.makeUser("mgr.cd.cov@ta.test", { roles: [{ role: "canada_agency_manager", scope_type: "agency", scope_id: w.cd }] });
  mgrCM = await h.makeUser("mgr.cm.cov@ta.test", { roles: [{ role: "canada_agency_manager", scope_type: "agency", scope_id: w.cm }] });
  agentCN = await h.makeUser("agent.cn.cov@ta.test", { roles: [{ role: "canada_agent", scope_type: "agency", scope_id: w.cn }] });
  finCN = await h.makeUser("fin.cn.cov@ta.test", { roles: [{ role: "canada_finance_agent", scope_type: "agency", scope_id: w.cn }] });
  finMgr = await h.makeUser("dfin.cov@ta.test", { mfa: true, roles: [{ role: "canada_finance_manager", scope_type: "global" }] });
  client = await h.makeUser("client.cov@ta.test", { roles: [{ role: "canada_client", scope_type: "own" }], client: { residence: "CD", agency: w.cd } });
  other = await h.makeUser("other.cov@ta.test", { roles: [{ role: "canada_client", scope_type: "own" }], client: { residence: "CD", agency: w.cd } });

  // Parcours réel : colis prêt → expédition → vol validé → association → publication.
  parcel = await readyParcel(client.clientId);
  const s = await h.api.post("/api/v1/canada/shipments").set(await T(mgrCN)).set(h.idem()).send({ origin_country: "CN", destination_country: "CD", origin_agency_id: w.cn });
  shipmentId = s.body.data.id;
  expect((await h.api.post(`/api/v1/canada/shipments/${shipmentId}/parcels`).set(await T(mgrCN)).set(h.idem()).send({ parcel_ids: [parcel.id] })).status).toBe(200);
  expect((await h.api.post(`/api/v1/canada/shipments/${shipmentId}/ready`).set(await T(mgrCN))).status).toBe(200);
  const d = day(6);
  const f = await h.api.post("/api/v1/canada/flights").set(await T(adminCN)).set(h.idem()).send({ airline_iata: "ET", flight_number: "607", flight_date: d,
    departure_airport: "CAN", arrival_airport: "FIH", scheduled_departure: `${d}T10:00:00+08:00`, scheduled_arrival: `${d}T20:00:00+01:00` });
  expect(f.status).toBe(201);
  flightId = f.body.data.id;
  expect((await h.api.post(`/api/v1/canada/flights/${flightId}/schedule`).set(await T(adminCN))).status).toBe(200);
  expect((await h.api.post(`/api/v1/canada/flights/${flightId}/shipments`).set(await T(mgrCN)).set(h.idem()).send({ shipment_id: shipmentId })).status).toBe(201);
  expect((await h.api.post(`/api/v1/canada/flights/${flightId}/publish`).set(await T(adminCN)).set(h.idem())).status).toBe(200);
  await (await import("../src/modules/notifications/worker.js")).runWorkerOnce();
});
afterAll(async () => { await h?.teardown(); });

describe("Droits du client (Cahier §3.6, §7.5) — suivi autorisé, aucune action opérationnelle", () => {
  it("consulte le suivi de SON colis et le vol publié de SON expédition, présentés séparément", async () => {
    const t = await h.api.get(`/api/v1/me/parcels/${parcel.id}/tracking`).set(await T(client));
    expect(t.status).toBe(200);
    expect(t.body.data.flight_tracking).toMatchObject({ designator: "ET607", position: null });
    expect(t.body.data.package_tracking.events.length).toBeGreaterThan(0);
    const sh = await h.api.get("/api/v1/me/shipments").set(await T(client));
    expect(sh.body.data).toHaveLength(1);
    expect(sh.body.data[0].flights.map((x: any) => x.designator)).toEqual(["ET607"]);
    const byRef = await h.api.get(`/api/v1/canada/parcels/by-reference/${parcel.reference}`).set(await T(client));
    expect(byRef.status).toBe(200);
  });

  it("ne voit ni les colis, ni les expéditions, ni le suivi d'un autre client", async () => {
    expect((await h.api.get(`/api/v1/me/parcels/${parcel.id}/tracking`).set(await T(other))).status).toBe(403);
    expect((await h.api.get("/api/v1/me/shipments").set(await T(other))).body.data).toEqual([]);
    expect([403, 404]).toContain((await h.api.get(`/api/v1/canada/parcels/by-reference/${parcel.reference}`).set(await T(other))).status);
  });

  it("ne peut ni changer un statut, ni créer / publier / annuler un vol, ni lire les vols ou expéditions en interne", async () => {
    const tok = await T(client);
    expect((await h.api.post(`/api/v1/canada/parcels/${parcel.id}/transitions`).set(tok).set(h.idem()).send({ to_status: "delivered" })).status).toBe(403);
    expect((await h.api.post("/api/v1/canada/flights").set(tok).set(h.idem()).send({})).status).toBe(403);
    expect((await h.api.post(`/api/v1/canada/flights/${flightId}/publish`).set(tok).set(h.idem())).status).toBe(403);
    expect((await h.api.post(`/api/v1/canada/flights/${flightId}/cancel`).set(tok).set(h.idem()).send({ reason: "Je veux annuler" })).status).toBe(403);
    expect((await h.api.post(`/api/v1/canada/flights/${flightId}/status`).set(tok).set(h.idem()).send({ status: "ARRIVED" })).status).toBe(403);
    expect((await h.api.get("/api/v1/canada/flights").set(tok)).status).toBe(403);
    expect((await h.api.get(`/api/v1/canada/shipments/${shipmentId}`).set(tok)).status).toBe(403);
    expect((await h.api.get("/api/v1/canada/airlines").set(tok)).status).toBe(403);
    expect((await h.api.post(`/api/v1/canada/flights/${flightId}/shipments/${shipmentId}/unassign`).set(tok).set(h.idem()).send({ reason: "Changement" })).status).toBe(403);
  });
});

describe("Expéditions et vols (lectures et actions non couvertes)", () => {
  it("liste et détail des expéditions limités au périmètre", async () => {
    const mine = await h.api.get("/api/v1/canada/shipments").set(await T(mgrCN));
    expect(mine.body.data.map((s: any) => s.id)).toContain(shipmentId);
    expect((await h.api.get("/api/v1/canada/shipments").set(await T(mgrCM))).body.data.map((s: any) => s.id)).not.toContain(shipmentId);
    expect((await h.api.get(`/api/v1/canada/shipments/${shipmentId}`).set(await T(mgrCN))).status).toBe(200);
    expect([403, 404]).toContain((await h.api.get(`/api/v1/canada/shipments/${shipmentId}`).set(await T(mgrCM))).status);
  });

  it("désassociation d'un vol : par l'origine seulement, motivée ; le client ne voit plus le vol", async () => {
    expect((await h.api.post(`/api/v1/canada/flights/${flightId}/shipments/${shipmentId}/unassign`).set(await T(mgrCM)).set(h.idem()).send({ reason: "Changement de vol" })).status).toBe(403);
    const ok = await h.api.post(`/api/v1/canada/flights/${flightId}/shipments/${shipmentId}/unassign`).set(await T(mgrCN)).set(h.idem()).send({ reason: "Changement de vol" });
    expect(ok.status).toBe(200);
    expect((await h.api.get("/api/v1/me/shipments").set(await T(client))).body.data[0].flights).toEqual([]);
  });

  it("annulation d'une expédition : motif, permission et périmètre", async () => {
    const s2 = (await h.api.post("/api/v1/canada/shipments").set(await T(mgrCN)).set(h.idem()).send({ origin_country: "CN", destination_country: "CD", origin_agency_id: w.cn })).body.data;
    expect((await h.api.post(`/api/v1/canada/shipments/${s2.id}/cancel`).set(await T(agentCN)).set(h.idem()).send({ reason: "Erreur de saisie" })).status).toBe(403);
    expect((await h.api.post(`/api/v1/canada/shipments/${s2.id}/cancel`).set(await T(mgrCM)).set(h.idem()).send({ reason: "Erreur de saisie" })).status).toBe(403);
    const ok = await h.api.post(`/api/v1/canada/shipments/${s2.id}/cancel`).set(await T(mgrCN)).set(h.idem()).send({ reason: "Erreur de saisie" });
    expect(ok.status).toBe(200);
    expect((await h.pool.query(`select status from canada.shipments where id = $1`, [s2.id])).rows[0].status).toBe("cancelled");
  });

  it("référentiels aériens lisibles par le personnel habilité", async () => {
    expect((await h.api.get("/api/v1/canada/airlines").set(await T(mgrCN))).body.data.map((a: any) => a.iata_code)).toContain("ET");
    expect((await h.api.get("/api/v1/canada/airports").set(await T(mgrCN))).body.data.map((a: any) => a.iata_code)).toEqual(expect.arrayContaining(["CAN", "FIH"]));
  });
});

describe("Colis : référence et corrections", () => {
  it("recherche par référence : périmètre respecté", async () => {
    expect((await h.api.get(`/api/v1/canada/parcels/by-reference/${parcel.reference}`).set(await T(agentCN))).status).toBe(200);
    expect([403, 404]).toContain((await h.api.get(`/api/v1/canada/parcels/by-reference/${parcel.reference}`).set(await T(mgrCM))).status);
  });

  it("correction d'un événement : nouvelle trace motivée, l'original reste intact", async () => {
    const ev = (await h.pool.query(`select id, to_status from canada.parcel_events where parcel_id = $1 order by recorded_at limit 1`, [parcel.id])).rows[0];
    expect((await h.api.post(`/api/v1/canada/parcels/${parcel.id}/events/${ev.id}/corrections`).set(await T(agentCN)).set(h.idem())
      .send({ comment: "Heure de réception erronée" })).status).toBe(403);
    const before = (await h.pool.query(`select count(*)::int n from canada.parcel_events where parcel_id = $1`, [parcel.id])).rows[0].n;
    const ok = await h.api.post(`/api/v1/canada/parcels/${parcel.id}/events/${ev.id}/corrections`).set(await T(mgrCN)).set(h.idem())
      .send({ comment: "Heure de réception erronée" });
    expect([200, 201]).toContain(ok.status);
    expect((await h.pool.query(`select count(*)::int n from canada.parcel_events where parcel_id = $1`, [parcel.id])).rows[0].n).toBe(before + 1);
    expect((await h.pool.query(`select to_status from canada.parcel_events where id = $1`, [ev.id])).rows[0].to_status).toBe(ev.to_status);
  });
});

describe("Devis et paiements (lectures, refus, annulations)", () => {
  let quoteId: string;
  it("devis : liste et détail par périmètre ; le client voit le sien, le refuse ; l'autre client ne voit rien", async () => {
    const q = await h.api.post("/api/v1/canada/quotes").set(await T(mgrCN)).set(h.idem())
      .send({ client_id: client.clientId, agency_id: w.cn, origin_country: "CN", destination_country: "CD", currency: "USD", parcel_ids: [parcel.id] });
    expect(q.status).toBe(201);
    quoteId = q.body.data.id;
    expect((await h.api.get("/api/v1/canada/quotes").set(await T(mgrCN))).body.data.map((x: any) => x.id)).toContain(quoteId);
    expect((await h.api.get("/api/v1/canada/quotes").set(await T(mgrCM))).body.data.map((x: any) => x.id)).not.toContain(quoteId);
    expect((await h.api.get(`/api/v1/canada/quotes/${quoteId}`).set(await T(mgrCN))).status).toBe(200);
    expect([403, 404]).toContain((await h.api.get(`/api/v1/canada/quotes/${quoteId}`).set(await T(mgrCM))).status);
    expect((await h.api.get("/api/v1/me/quotes").set(await T(client))).body.data).toEqual([]); // brouillon invisible
    expect((await h.api.post(`/api/v1/canada/quotes/${quoteId}/issue`).set(await T(mgrCN)).set(h.idem())).status).toBe(200);
    expect((await h.api.get("/api/v1/me/quotes").set(await T(client))).body.data.map((x: any) => x.id)).toEqual([quoteId]);
    expect((await h.api.get("/api/v1/me/quotes").set(await T(other))).body.data).toEqual([]);
    expect((await h.api.post(`/api/v1/me/quotes/${quoteId}/versions/1/reject`).set(await T(other)).send({ reason: "Non" })).status).toBe(403);
    const rej = await h.api.post(`/api/v1/me/quotes/${quoteId}/versions/1/reject`).set(await T(client)).send({ reason: "Trop cher" });
    expect(rej.status).toBe(200);
    const acc = await h.api.post(`/api/v1/me/quotes/${quoteId}/versions/1/accept`).set(await T(client)).set(h.idem()).send({ accept_conditions: true });
    expect(acc.status).toBeGreaterThanOrEqual(400); // un refus n'est jamais transformé en acceptation
  });

  it("annulation de devis : permission requise et motif", async () => {
    const q = await h.api.post("/api/v1/canada/quotes").set(await T(mgrCN)).set(h.idem())
      .send({ client_id: client.clientId, agency_id: w.cn, origin_country: "CN", destination_country: "CD", currency: "USD",
        lines: [{ category: "handling", designation: "Manutention", quantity: "1", unit_price: "5", currency: "USD" }] });
    expect((await h.api.post(`/api/v1/canada/quotes/${q.body.data.id}/cancel`).set(await T(agentCN)).set(h.idem()).send({ reason: "Doublon" })).status).toBe(403);
    expect((await h.api.post(`/api/v1/canada/quotes/${q.body.data.id}/cancel`).set(await T(mgrCN)).set(h.idem()).send({ reason: "Doublon" })).status).toBe(200);
  });

  it("paiements : liste par périmètre, liste du client, annulation réservée au rapprochement (jamais au Super Admin)", async () => {
    const p = await h.api.post("/api/v1/canada/payments").set(await T(finCN)).set(h.idem())
      .send({ client_id: client.clientId, agency_id: w.cn, amount_due: "40", currency: "USD", purpose: "service" });
    expect(p.status).toBe(201);
    const pid = p.body.data.id;
    expect((await h.api.get("/api/v1/canada/payments").set(await T(finCN))).body.data.map((x: any) => x.id)).toContain(pid);
    expect((await h.api.get("/api/v1/canada/payments").set(await T(mgrCM))).body.data.map((x: any) => x.id)).not.toContain(pid);
    expect((await h.api.get("/api/v1/me/payments").set(await T(client))).body.data.map((x: any) => x.id)).toContain(pid);
    expect((await h.api.get("/api/v1/me/payments").set(await T(other))).body.data).toEqual([]);
    expect((await h.api.post(`/api/v1/canada/payments/${pid}/cancel`).set(await T(finCN)).set(h.idem()).send({ reason: "Erreur de montant" })).status).toBe(403);
    expect((await h.api.post(`/api/v1/canada/payments/${pid}/cancel`).set(await T(root)).set(h.idem()).send({ reason: "Erreur de montant" })).status).toBe(403);
    expect((await h.api.post(`/api/v1/canada/payments/${pid}/cancel`).set(await T(finMgr)).set(h.idem()).send({ reason: "Erreur de montant" })).status).toBe(200);
  });

  it("export financier CSV : autorisé, filtré par pays, refusé à l'agent", async () => {
    const q = `from=${encodeURIComponent(new Date(Date.now() - 86400000).toISOString())}&to=${encodeURIComponent(new Date(Date.now() + 86400000).toISOString())}`;
    const cn = await h.api.get(`/api/v1/canada/financial-reports/payments/export?${q}`).set(await T(adminCN));
    expect(cn.status).toBe(200);
    expect(cn.headers["content-type"]).toMatch(/text\/csv/);
    const cd = await h.api.get(`/api/v1/canada/financial-reports/payments/export?${q}`).set(await T(adminCM));
    expect(cd.status).toBe(200);
    expect(cn.text.split("\n").length).toBeGreaterThan(cd.text.split("\n").length); // le Cameroun ne voit pas les paiements de Chine
    expect((await h.api.get(`/api/v1/canada/financial-reports/payments/export?${q}`).set(await T(agentCN))).status).toBe(403);
  });
});

describe("Demandes, notifications, appareils, adresses, support (espace client)", () => {
  it("demandes : le client voit les siennes ; demande publique enregistrée et visible du pays concerné seulement", async () => {
    expect((await h.api.post("/api/v1/me/requests").set(await T(client)).set(h.idem()).send({ origin_country: "CN", destination_country: "CD" })).status).toBe(201);
    expect((await h.api.get("/api/v1/me/requests").set(await T(client))).body.data).toHaveLength(1);
    expect((await h.api.get("/api/v1/me/requests").set(await T(other))).body.data).toEqual([]);
    const pub = await h.api.post("/api/v1/public/requests").send({ full_name: "Visiteur Test", email: "visiteur@example.org", phone: "+243810000000", origin_country: "CN", destination_country: "CD" });
    expect(pub.status).toBe(201);
    const refs = async (u: any) => (await h.api.get("/api/v1/canada/requests").set(await T(u))).body.data.map((r: any) => r.reference);
    expect(await refs(adminCN)).toContain(pub.body.data.reference);
    expect(await refs(adminCD)).toContain(pub.body.data.reference);
    expect(await refs(adminCM)).not.toContain(pub.body.data.reference);
    expect((await h.api.post("/api/v1/public/requests").send({ full_name: "X", email: "pas-un-email", phone: "1", origin_country: "CN", destination_country: "CD" })).status).toBe(400);
  });

  it("notifications : le client lit les siennes, ne peut pas marquer celles d'autrui", async () => {
    const n = await h.api.get("/api/v1/me/notifications").set(await T(client));
    expect(n.status).toBe(200);
    expect(n.body.data.length).toBeGreaterThan(0); // publication du vol
    const unread = n.body.meta.unread;
    const id = n.body.data[0].id;
    expect((await h.api.post(`/api/v1/me/notifications/${id}/read`).set(await T(other))).status).toBe(404);
    expect((await h.api.post(`/api/v1/me/notifications/${id}/read`).set(await T(client))).status).toBe(200);
    expect((await h.api.get("/api/v1/me/notifications").set(await T(client))).body.meta.unread).toBe(unread - 1);
  });

  it("préférences et appareils push : enregistrement, validation, désinscription", async () => {
    const pref = await h.api.put("/api/v1/me/notification-preferences").set(await T(client)).send({ preferences: [{ channel: "email", category: "*", enabled: false }] });
    expect(pref.body.data).toContainEqual({ channel: "email", category: "*", enabled: false });
    expect((await h.api.put("/api/v1/me/notification-preferences").set(await T(client)).send({ preferences: [{ channel: "sms", enabled: true }] })).status).toBe(400);
    const token = "ExponentPushToken[test-device-0001]";
    expect((await h.api.post("/api/v1/me/devices").set(await T(client)).send({ push_token: token, platform: "android" })).status).toBe(201);
    await h.api.delete("/api/v1/me/devices").set(await T(other)).send({ push_token: token }); // sans effet : appareil d'autrui
    expect((await h.pool.query(`select status from shared.user_devices where push_token = $1`, [token])).rows[0].status).toBe("active");
    expect((await h.api.delete("/api/v1/me/devices").set(await T(client)).send({ push_token: token })).status).toBe(200);
    expect((await h.pool.query(`select status from shared.user_devices where push_token = $1`, [token])).rows[0].status).toBe("unregistered");
  });

  it("adresses : suppression de la sienne uniquement", async () => {
    const a = await h.api.post("/api/v1/me/addresses").set(await T(client)).send({ country_code: "CD", city: "Kinshasa", line1: "12 avenue du Commerce" });
    expect(a.status).toBe(201);
    expect([403, 404]).toContain((await h.api.delete(`/api/v1/me/addresses/${a.body.data.id}`).set(await T(other))).status);
    expect((await h.api.delete(`/api/v1/me/addresses/${a.body.data.id}`).set(await T(client))).status).toBe(200);
  });

  it("support : chacun ne liste que ses tickets ; le personnel liste par périmètre", async () => {
    expect((await h.api.post("/api/v1/me/support-tickets").set(await T(client)).set(h.idem())
      .send({ category: "delay", subject: "Retard du colis", message: "Mon colis est en retard.", parcel_id: parcel.id })).status).toBe(201);
    expect((await h.api.get("/api/v1/me/support-tickets").set(await T(client))).body.data).toHaveLength(1);
    expect((await h.api.get("/api/v1/me/support-tickets").set(await T(other))).body.data).toEqual([]);
    expect((await h.api.get("/api/v1/canada/support-tickets").set(await T(root))).body.data.length).toBeGreaterThan(0);
    expect((await h.api.get("/api/v1/canada/support-tickets").set(await T(client))).status).toBe(403);
  });
});

describe("Gouvernance et référentiels (routes non couvertes)", () => {
  it("catalogue des permissions : lisible par l'administration, pas par un client", async () => {
    const r = await h.api.get("/api/v1/access/permissions").set(await T(root));
    expect(r.status).toBe(200);
    expect(r.body.data.length).toBe(95);
    expect((await h.api.get("/api/v1/access/permissions").set(await T(client))).status).toBe(403);
  });

  it("invitation révoquée : plus acceptable ; révocation hors périmètre refusée", async () => {
    const inv = await h.api.post("/api/v1/access/invitations").set(await T(adminCD)).set(h.idem())
      .send({ email: "invite.revoque@ta.test", role_code: "canada_agent", scope_type: "agency", scope_id: w.cd });
    expect(inv.status).toBe(201);
    expect((await h.api.post(`/api/v1/access/invitations/${inv.body.data.invitation_id}/revoke`).set(await T(adminCN)).set(h.idem()).send({ reason: "Hors périmètre" })).status).toBe(403);
    expect((await h.api.post(`/api/v1/access/invitations/${inv.body.data.invitation_id}/revoke`).set(await T(adminCD)).set(h.idem()).send({ reason: "Poste supprimé" })).status).toBe(200);
    const invitee = await h.makeUser("invite.revoque@ta.test");
    const acc = await h.api.post("/api/v1/access/invitations/accept").set(await T(invitee)).send({ token: inv.body.data.dev_token });
    expect(acc.status).toBeGreaterThanOrEqual(400);
  });

  it("historique de sécurité personnel : contient sa connexion, jamais celle d'un autre", async () => {
    const login = await h.api.post("/api/v1/auth/login").send({ email: client.email, password: PASSWORD });
    expect(login.status).toBe(200);
    const ev = await h.api.get("/api/v1/identity/me/security-events").set(h.auth(login.body.data.session.access_token));
    expect(ev.body.data.map((e: any) => e.event_type)).toContain("auth.login_succeeded");
    expect((await h.api.get("/api/v1/identity/me/security-events").set(await T(other))).body.data.map((e: any) => e.event_type)).not.toContain("auth.login_succeeded");
  });

  it("paramètres pays : lecture de son pays seulement ; activation/désactivation d'un pays réservée au global", async () => {
    expect((await h.api.get("/api/v1/canada/countries/CN/settings").set(await T(adminCN))).status).toBe(200);
    expect((await h.api.get("/api/v1/canada/countries/CD/settings").set(await T(adminCN))).status).toBe(403);
    expect((await h.api.get("/api/v1/canada/countries/CN/settings").set(await T(mgrCN))).status).toBe(403);
    expect((await h.api.patch("/api/v1/canada/countries/CN").set(await T(adminCN)).send({ is_active: true })).status).toBe(403);
    expect((await h.api.patch("/api/v1/canada/countries/CM").set(await T(root)).send({ is_active: true })).status).toBe(200);
    expect((await h.api.get("/api/v1/canada/currencies").set(await T(mgrCN))).body.data).toHaveLength(6);
  });

  it("modification d'une fiche client : refusée à un pays sans lien avec le client et sans la permission", async () => {
    // NB (question G-7, non tranchée) : le périmètre d'ÉCRITURE est aujourd'hui celui de LECTURE (pays de
    // résidence + pays d'origine/destination de ses colis). Ce test ne fige pas ce choix.
    expect((await h.api.patch(`/api/v1/canada/clients/${client.clientId}`).set(await T(adminCM)).send({ notes: "Hors pays" })).status).toBe(403);
    expect((await h.api.patch(`/api/v1/canada/clients/${client.clientId}`).set(await T(mgrCD)).send({ notes: "Sans permission" })).status).toBe(403);
    const ok = await h.api.patch(`/api/v1/canada/clients/${client.clientId}`).set(await T(adminCD)).send({ notes: "Client fidèle" });
    expect(ok.status).toBe(200);
  });

  it("activation de l'accès Canada pour un compte existant : sans second compte ; refus si accès suspendu", async () => {
    const u = await h.makeUser("market.only@ta.test");
    await h.pool.query(`delete from access.user_platform_access where user_id = $1`, [u.id]);
    const r = await h.api.post("/api/v1/identity/me/platforms/canada/activate").set(await T(u));
    expect(r.status).toBe(200);
    expect(r.body.data.platforms).toEqual([{ code: "CANADA", access_status: "active" }]);
    expect(r.body.data.canada_client).toBeTruthy();
    const again = await h.api.post("/api/v1/identity/me/platforms/canada/activate").set(await T(u));
    expect(again.status).toBe(200);
    expect((await h.pool.query(`select count(*)::int n from canada.clients where user_id = $1`, [u.id])).rows[0].n).toBe(1);
    await h.pool.query(`update access.user_platform_access set access_status = 'suspended' where user_id = $1`, [u.id]);
    expect((await h.api.post("/api/v1/identity/me/platforms/canada/activate").set(await T(u))).body.error.code).toBe("PLATFORM_ACCESS_BLOCKED");
  });
});

describe("Tableaux de bord (Cahier §12) : comptages du périmètre", () => {
  it("clients, agences, personnel et réclamations comptés dans le seul périmètre de l'appelant", async () => {
    const ov = async (u: any) => (await h.api.get("/api/v1/canada/reports/overview").set(await T(u))).body.data;
    const cd = await ov(adminCD), cm = await ov(adminCM), cn = await ov(adminCN), mgr = await ov(mgrCN), all = await ov(root);
    expect(cd.clients_count).toBeGreaterThanOrEqual(2); // client et other résident en RDC
    expect(cm.clients_count).toBe(0);
    const managers = (o: any) => o.staff_by_role.find((r: any) => r.role === "canada_agency_manager")?.n ?? 0;
    expect(managers(cn)).toBe(1);   // seul le manager de l'agence chinoise
    expect(managers(mgr)).toBe(1);  // le manager ne voit que son agence
    expect(managers(all)).toBe(3);  // Super Admin : CN, CD, CM
    expect(cn.agencies_by_status).toEqual([{ status: "active", n: 1 }]);
    expect(cd.support_tickets_by_status.reduce((s: number, r: any) => s + r.n, 0)).toBeGreaterThanOrEqual(1); // réclamation « retard » → destination
    expect(cm.support_tickets_by_status).toEqual([]);
  });
});

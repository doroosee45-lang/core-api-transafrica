import path from "node:path";
import { pathToFileURL } from "node:url";
import { PASSWORD, setupHarness, type Harness } from "./support/harness.js";

/**
 * TEST DE CONTRAT avec l'application mobile (`../Mobile/src/backend/core.ts`) :
 * l'adaptateur mobile RÉEL est exécuté contre le Core API RÉEL (PostgreSQL 18). Seul le transport
 * HTTPS du mobile (`apiClient`, qui refuse HTTP) est remplacé par un appel direct à l'application
 * Express ; chemins, corps, en-têtes d'idempotence et analyse des réponses sont ceux du mobile.
 * Un changement de contrat d'un côté ou de l'autre fait échouer ce test.
 */
let h: Harness;
let w: Awaited<ReturnType<Harness["world"]>>;
let mobile: any;
let client: any, agentCN: any, mgrCN: any, adminCN: any, finCN: any;
const T = async (u: any) => h.auth(await u.token());
let n = 0;

/** Équivalent de `apiClient` (même contrat : Bearer, Idempotency-Key, erreurs typées, `parse`). */
function requestAs(token: () => Promise<string>) {
  return async (p: string, o: { method?: string; body?: unknown; idempotencyKey?: string; authenticated?: boolean; parse: (d: unknown) => unknown }) => {
    const m = (o.method ?? "GET").toLowerCase() as "get" | "post" | "patch" | "put" | "delete";
    let r = h.api[m](p);
    if (o.authenticated !== false) r = r.set("Authorization", `Bearer ${await token()}`);
    if (o.idempotencyKey) r = r.set("Idempotency-Key", o.idempotencyKey);
    const res = o.body !== undefined ? await r.send(o.body as object) : await r;
    if (res.status >= 400) throw Object.assign(new Error(`HTTP ${res.status} ${res.body?.error?.code ?? ""} ${res.body?.error?.message ?? ""} ${p}`), { status: res.status, code: res.body?.error?.code });
    return o.parse(res.body);
  };
}
const key = () => `mobile-contract-${++n}-${Date.now()}`;
const signal = () => new AbortController().signal;

beforeAll(async () => {
  h = await setupHarness();
  w = await h.world();
  mobile = await import(pathToFileURL(path.resolve("../Mobile/src/backend/core.ts")).href);
  client = await h.makeUser("mobile.client@ta.test", { roles: [{ role: "canada_client", scope_type: "own" }], client: { residence: "CD", agency: w.cd } });
  agentCN = await h.makeUser("mobile.agent@ta.test", { roles: [{ role: "canada_agent", scope_type: "agency", scope_id: w.cn }] });
  mgrCN = await h.makeUser("mobile.mgr@ta.test", { roles: [{ role: "canada_agency_manager", scope_type: "agency", scope_id: w.cn }] });
  adminCN = await h.makeUser("mobile.admin@ta.test", { mfa: true, roles: [{ role: "canada_administrator", scope_type: "country", scope_country: "CN" }] });
  finCN = await h.makeUser("mobile.fin@ta.test", { roles: [{ role: "canada_finance_agent", scope_type: "agency", scope_id: w.cn }] });
});
afterAll(async () => { await h?.teardown(); });

describe("Contrat mobile ↔ Core API (adaptateur mobile réel, base réelle)", () => {
  let parcelId: string, reference: string, quoteId: string;

  it("inscription mobile : POST /auth/register crée l'identité ET le profil Canada (connexion possible ensuite)", async () => {
    const req = requestAs(async () => "");
    await req("/api/v1/auth/register", { method: "POST", authenticated: false, parse: mobile.envelope(() => undefined), body: {
      first_name: "Ama", last_name: "Mobile", email: "ama.mobile@example.org", password: PASSWORD, password_confirmation: PASSWORD,
      accept_terms: true, platform: "CANADA", preferred_language: "fr" } });
    const u = (await h.pool.query(`select id from auth.users where email = 'ama.mobile@example.org'`)).rows[0];
    expect((await h.pool.query(`select count(*)::int n from canada.clients where user_id = $1`, [u.id])).rows[0].n).toBe(1);
  });

  it("colis et suivi : liste et détail lus par l'adaptateur mobile (vol publié distinct, position = scan)", async () => {
    const p = await h.api.post("/api/v1/canada/parcels").set(await T(agentCN)).set(h.idem())
      .send({ client_id: client.clientId, recipient_name: "Famille", origin_country: "CN", destination_country: "CD", origin_agency_id: w.cn, destination_agency_id: w.cd, received_now: true });
    parcelId = p.body.data.id; reference = p.body.data.reference;
    await h.api.post(`/api/v1/canada/parcels/${parcelId}/scans`).set(await T(agentCN)).set(h.idem()).send({ location_text: "Entrepôt Guangzhou" });
    await h.api.post(`/api/v1/canada/parcels/${parcelId}/measurements`).set(await T(agentCN)).set(h.idem()).send({ actual_weight_kg: "4.2" });
    for (const s of ["inspected", "ready_for_shipment"]) await h.api.post(`/api/v1/canada/parcels/${parcelId}/transitions`).set(await T(agentCN)).set(h.idem()).send({ to_status: s });
    const s = (await h.api.post("/api/v1/canada/shipments").set(await T(mgrCN)).set(h.idem()).send({ origin_country: "CN", destination_country: "CD", origin_agency_id: w.cn })).body.data.id;
    await h.api.post(`/api/v1/canada/shipments/${s}/parcels`).set(await T(mgrCN)).set(h.idem()).send({ parcel_ids: [parcelId] });
    await h.api.post(`/api/v1/canada/shipments/${s}/ready`).set(await T(mgrCN));
    const d = new Date(Date.now() + 6 * 86400000).toISOString().slice(0, 10);
    const f = (await h.api.post("/api/v1/canada/flights").set(h.auth(await adminCN.token("aal2"))).set(h.idem()).send({ airline_iata: "ET", flight_number: "620", flight_date: d,
      departure_airport: "CAN", arrival_airport: "FIH", scheduled_departure: `${d}T10:00:00+08:00`, scheduled_arrival: `${d}T20:00:00+01:00` })).body.data.id;
    await h.api.post(`/api/v1/canada/flights/${f}/schedule`).set(h.auth(await adminCN.token("aal2")));
    await h.api.post(`/api/v1/canada/flights/${f}/shipments`).set(await T(mgrCN)).set(h.idem()).send({ shipment_id: s });
    await h.api.post(`/api/v1/canada/flights/${f}/publish`).set(h.auth(await adminCN.token("aal2"))).set(h.idem());

    const parcels = mobile.parcelsService(requestAs(() => client.token()));
    const page = await parcels.list({ cursor: null, signal: signal() });
    expect(page.items.map((x: any) => x.reference)).toEqual([reference]);
    const detail = await parcels.get({ id: parcelId, signal: signal() });
    expect(detail.reference).toBe(reference);
    expect(detail.flight).toMatchObject({ number: "ET620", airline: "Ethiopian Airlines" });
    expect(detail.lastConfirmedLocation).toMatchObject({ kind: "scan", label: "Entrepôt Guangzhou" });
    expect(detail.events.length).toBeGreaterThan(0);
    // Un autre client n'y a pas accès.
    const other = await h.makeUser("mobile.other@ta.test", { roles: [{ role: "canada_client", scope_type: "own" }], client: { residence: "CD" } });
    await expect(mobile.parcelsService(requestAs(() => other.token())).get({ id: parcelId, signal: signal() })).rejects.toMatchObject({ status: 403 });
  });

  it("rubriques et listes : expéditions, vols, devis, paiements, notifications lus tels que le Core API les renvoie", async () => {
    const q = await h.api.post("/api/v1/canada/quotes").set(await T(mgrCN)).set(h.idem())
      .send({ client_id: client.clientId, agency_id: w.cn, origin_country: "CN", destination_country: "CD", currency: "USD", parcel_ids: [parcelId] });
    quoteId = q.body.data.id;
    await h.api.post(`/api/v1/canada/quotes/${quoteId}/issue`).set(await T(mgrCN)).set(h.idem());
    await h.api.post("/api/v1/canada/payments").set(await T(finCN)).set(h.idem())
      .send({ client_id: client.clientId, agency_id: w.cn, amount_due: "12", currency: "USD", purpose: "service" });
    await (await import("../src/modules/notifications/worker.js")).runWorkerOnce();

    const req = requestAs(() => client.token());
    const records = mobile.recordsService(req);
    expect((await records.list("shipments", { cursor: null, signal: signal() })).items).toHaveLength(1);
    const quote = await records.get("quotes", quoteId, { signal: signal() });
    expect(quote.status).toBe("Consulté"); // ouvrir le devis côté client le marque « consulté » (Core API)
    expect(quote.fields.find((x: any) => x.label === "Total")?.value).toMatch(/USD$/);
    const pays = await records.list("payments", { cursor: null, signal: signal() });
    expect(pays.items[0]).toMatchObject({ status: "En attente" });
    const notes = await records.list("notifications", { cursor: null, signal: signal() });
    expect(notes.items.length).toBeGreaterThan(0);
    await records.markNotificationRead(notes.items[0].id, { signal: signal() });
    expect((await h.pool.query(`select read_at from shared.notifications where id = $1`, [notes.items[0].id])).rows[0].read_at).not.toBeNull();

    const flights = await mobile.listLoader(req, "flights")(signal());
    expect(flights[0].title).toBe("Vol ET620");
    const flight = await mobile.detailLoader(req, "flights")(flights[0].id, signal());
    expect(flight.fields.find((x: any) => x.label === "Départ")?.value).toBe("CAN");
    for (const k of ["quotes", "payments"]) expect((await mobile.listLoader(req, k)(signal())).length).toBe(1);
  });

  it("actions client : demande, ticket lié au colis, adresse, profil, décision sur la version courante", async () => {
    const req = requestAs(() => client.token());
    const ports = mobile.corePorts(req, key);
    const r = await ports.createRequest({ origin: "Chine", destination: "RDC", description: "Vêtements", weightKg: "3", recipientName: "Grace", recipientPhone: "" });
    expect(r.reference).toMatch(/^REQ-/);
    expect((await mobile.listLoader(req, "requests")(signal())).map((x: any) => x.title)).toContain(r.reference);

    const t = await ports.createTicket({ subject: "Retard", category: "parcel", message: "Où est mon colis ?", reference });
    expect((await h.pool.query(`select parcel_id from canada.support_tickets where id = $1`, [t.id])).rows[0].parcel_id).toBe(parcelId);
    const ticket = await mobile.detailLoader(req, "tickets")(t.id, signal());
    expect(ticket.fields.some((x: any) => x.label === "Vous" && x.value === "Où est mon colis ?")).toBe(true);

    await ports.saveAddress({ label: "Maison", recipient: "Grace", phone: "+243810000000", line: "12 avenue du Commerce", city: "Kinshasa", country: "RDC" });
    const addresses = await mobile.listLoader(req, "addresses")(signal());
    expect(addresses[0].subtitle).toContain("À l’attention de : Grace");

    await ports.updateProfile({ name: "Ama K.", phone: "+243820000000" });
    expect((await h.pool.query(`select display_name from identity.profiles where id = $1`, [client.id])).rows[0].display_name).toBe("Ama K.");

    await ports.decideQuote({ id: quoteId, decision: "accept" });
    expect((await h.pool.query(`select status from canada.quotation_versions where quotation_id = $1 and version = 1`, [quoteId])).rows[0].status).toBe("accepted");
  });

  it("actions terrain : un agent consulte puis réceptionne un colis annoncé (received_now: false) par sa référence", async () => {
    const p = await h.api.post("/api/v1/canada/parcels").set(await T(agentCN)).set(h.idem())
      .send({ client_id: client.clientId, recipient_name: "Famille", origin_country: "CN", destination_country: "CD", origin_agency_id: w.cn, received_now: false });
    const ports = mobile.corePorts(requestAs(() => agentCN.token()), key);
    expect((await ports.lookupLocation({ reference: p.body.data.reference })).description).toMatch(/Statut/);
    await ports.receiveParcel({ reference: p.body.data.reference, condition: "damaged", note: "Carton enfoncé" });
    const ev = (await h.pool.query(`select to_status, comment from canada.parcel_events where parcel_id = $1 order by recorded_at desc limit 1`, [p.body.data.id])).rows[0];
    expect(ev).toEqual({ to_status: "received", comment: "État constaté : Endommagé. Carton enfoncé" });
    // Un client ne peut pas réceptionner (colis encore « attendu » : refus d'autorisation).
    const q = await h.api.post("/api/v1/canada/parcels").set(await T(agentCN)).set(h.idem())
      .send({ client_id: client.clientId, recipient_name: "Famille", origin_country: "CN", destination_country: "CD", origin_agency_id: w.cn, received_now: false });
    await expect(mobile.corePorts(requestAs(() => client.token()), key).receiveParcel({ reference: q.body.data.reference, condition: "good", note: "" })).rejects.toMatchObject({ status: 403 });
    expect((await h.pool.query(`select status from canada.parcels where id = $1`, [q.body.data.id])).rows[0].status).toBe("expected");
  });
});

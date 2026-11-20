import { setEmailTransportForTests, type EmailMessage } from "../src/integrations/email.js";
import { setupHarness, type Harness } from "./support/harness.js";

let h: Harness;
let w: Awaited<ReturnType<Harness["world"]>>;
let opsCN: any, opsCD: any, agentCN: any, agentCD: any, mgrCN: any, financeCN: any, financeMgr: any, client: any, other: any;
const sent: EmailMessage[] = [];
let worker: typeof import("../src/modules/notifications/worker.js");

const T = async (u: any, aal?: "aal1" | "aal2") => h.auth(await u.token(aal));

async function newParcel(by: any, clientId: string) {
  const r = await h.api.post("/api/v1/canada/parcels").set(await T(by)).set(h.idem())
    .send({ client_id: clientId, recipient_name: "Famille Mbuyi", origin_country: "CN", destination_country: "CD", origin_agency_id: w.cn, destination_agency_id: w.cd, warehouse_id: w.whCn, category: "clothing" });
  expect(r.status).toBe(201);
  return r.body.data.id as string;
}
async function step(by: any, id: string, to: string, extra: object = {}) {
  return h.api.post(`/api/v1/canada/parcels/${id}/transitions`).set(await T(by)).set(h.idem()).send({ to_status: to, ...extra });
}
async function readyParcel(clientId: string) {
  const id = await newParcel(agentCN, clientId);
  expect((await h.api.post(`/api/v1/canada/parcels/${id}/measurements`).set(await T(agentCN)).set(h.idem()).send({ actual_weight_kg: "4.2" })).status).toBe(201);
  expect((await step(agentCN, id, "inspected")).status).toBe(200);
  expect((await step(agentCN, id, "ready_for_shipment")).status).toBe(200);
  return id;
}
function futureLocal(days: number, hour: number, tzOffset: string) {
  const d = new Date(Date.now() + days * 86400000);
  const ymd = d.toISOString().slice(0, 10);
  return { date: ymd, iso: `${ymd}T${String(hour).padStart(2, "0")}:30:00${tzOffset}` };
}

beforeAll(async () => {
  h = await setupHarness();
  w = await h.world();
  worker = await import("../src/modules/notifications/worker.js");
  setEmailTransportForTests(async (m) => { sent.push(m); return { status: "accepted", providerMessageId: `msg_${sent.length}` }; });
  // Décision du 21/11/2026 : les vols sont gérés par l'administrateur pays (MFA), les managers restent à l'agence.
  opsCN = await h.makeUser("admin.cn@ta.test", { mfa: true, roles: [{ role: "canada_administrator", scope_type: "country", scope_country: "CN" }] });
  opsCD = await h.makeUser("admin.cd@ta.test", { mfa: true, roles: [{ role: "canada_administrator", scope_type: "country", scope_country: "CD" }] });
  agentCN = await h.makeUser("agent.cn@ta.test", { roles: [{ role: "canada_agent", scope_type: "agency", scope_id: w.cn }] });
  agentCD = await h.makeUser("agent.cd@ta.test", { roles: [{ role: "canada_agent", scope_type: "agency", scope_id: w.cd }] });
  mgrCN = await h.makeUser("mgr.cn@ta.test", { roles: [{ role: "canada_agency_manager", scope_type: "agency", scope_id: w.cn }] });
  financeCN = await h.makeUser("caisse.cn@ta.test", { roles: [{ role: "canada_finance_agent", scope_type: "agency", scope_id: w.cn }] });
  financeMgr = await h.makeUser("dfin@ta.test", { roles: [{ role: "canada_finance_manager", scope_type: "global" }] });
  client = await h.makeUser("client@ta.test", { first: "Grace", last: "Mbuyi", roles: [{ role: "canada_client", scope_type: "own" }], client: { residence: "CD", agency: w.cd } });
  other = await h.makeUser("other@ta.test", { roles: [{ role: "canada_client", scope_type: "own" }], client: { residence: "CD" } });
});
afterAll(async () => { setEmailTransportForTests(null); await h?.teardown(); });

describe("Colis : mesures et transitions (Spéc. backend §10, Dossier 05 Flux 09)", () => {
  it("poids réel, volumétrique (diviseur du barème) et facturable distincts ; re-pesée motivée", async () => {
    const id = await newParcel(agentCN, client.clientId);
    const m = await h.api.post(`/api/v1/canada/parcels/${id}/measurements`).set(await T(agentCN)).set(h.idem())
      .send({ actual_weight_kg: "8.5", length_cm: 50, width_cm: 40, height_cm: 30 });
    expect(m.status).toBe(201);
    expect(m.body.data).toMatchObject({ actual_weight_kg: "8.500", volumetric_divisor: 6000, volumetric_weight_kg: "10.000", billable_weight_kg: "10.000" });
    const again = await h.api.post(`/api/v1/canada/parcels/${id}/measurements`).set(await T(agentCN)).set(h.idem()).send({ actual_weight_kg: "9" });
    expect(again.body.error.code).toBe("REASON_REQUIRED");
    const ok = await h.api.post(`/api/v1/canada/parcels/${id}/measurements`).set(await T(agentCN)).set(h.idem()).send({ actual_weight_kg: "12", reason: "Erreur de balance" });
    expect(ok.body.data.billable_weight_kg).toBe("12.000");
    const hist = await h.pool.query(`select count(*)::int n from canada.parcel_measurements where parcel_id = $1`, [id]);
    expect(hist.rows[0].n).toBe(2);
  });

  it("transitions interdites refusées ; « prêt » exige une pesée ; « livré » exige une preuve", async () => {
    const id = await newParcel(agentCN, client.clientId);
    expect((await step(agentCN, id, "delivered", { proof_reference: "x" })).body.error.code).toBe("TRANSITION_NOT_ALLOWED");
    expect((await step(agentCN, id, "inspected")).status).toBe(200);
    expect((await step(agentCN, id, "ready_for_shipment")).body.error.code).toBe("MEASUREMENT_REQUIRED");
    expect((await step(agentCN, id, "in_shipment")).body.error.code).toBe("TRANSITION_NOT_ALLOWED");
    expect((await step(agentCN, id, "on_hold", { comment: "x" })).status).toBe(403); // exceptions : pas pour un agent
    expect((await step(mgrCN, id, "on_hold")).body.error.code).toBe("COMMENT_REQUIRED");
    // Sur un colis prêt, l'association à une expédition existe mais est réservée au module Expéditions.
    const ready = await readyParcel(client.clientId);
    expect((await step(agentCN, ready, "in_shipment")).body.error.code).toBe("TRANSITION_SYSTEM_ONLY");
  });
});

describe("Scénario A — parcours complet devis → paiement → vol → livraison (Dossier 05 §25)", () => {
  let parcel: string, quoteId: string, paymentId: string, shipmentId: string, flightId: string;

  it("devis calculé côté serveur depuis le barème, émis, consulté puis accepté par le client", async () => {
    parcel = await readyParcel(client.clientId);
    const q = await h.api.post("/api/v1/canada/quotes").set(await T(mgrCN)).set(h.idem())
      .send({ client_id: client.clientId, agency_id: w.cn, origin_country: "CN", destination_country: "CD", currency: "USD", parcel_ids: [parcel] });
    expect(q.status).toBe(201);
    // 4.2 kg × 8 = 33.60 USD (minimum 20) + 5 USD de frais de service
    expect(q.body.data.version.total).toBe("38.60");
    quoteId = q.body.data.id;
    expect((await h.api.get(`/api/v1/me/quotes/${quoteId}`).set(await T(client))).body.data.versions).toHaveLength(0); // brouillon invisible
    expect((await h.api.post(`/api/v1/canada/quotes/${quoteId}/issue`).set(await T(agentCN)).set(h.idem())).status).toBe(403); // agent : pas d'émission
    expect((await h.api.post(`/api/v1/canada/quotes/${quoteId}/issue`).set(await T(mgrCN)).set(h.idem())).status).toBe(200);
    await expect(h.pool.query(`update canada.quotation_versions set total = 1 where quotation_id = $1`, [quoteId])).rejects.toThrow(/QUOTE_VERSION_FROZEN/);
    expect((await h.api.post(`/api/v1/me/quotes/${quoteId}/versions/1/accept`).set(await T(other)).set(h.idem()).send({ accept_conditions: true })).status).toBe(403);
    const acc = await h.api.post(`/api/v1/me/quotes/${quoteId}/versions/1/accept`).set(await T(client)).set(h.idem()).send({ accept_conditions: true });
    expect(acc.status).toBe(200);
    expect(acc.body.data.payment).toMatchObject({ amount_due: "38.60", currency: "USD", status: "pending" });
    paymentId = acc.body.data.payment.id;
    const ev = await h.pool.query(`select acceptance_evidence from canada.quotation_versions where quotation_id = $1`, [quoteId]);
    expect(ev.rows[0].acceptance_evidence.total).toBe("38.60");
  });

  it("Scénario B/C — paiement confirmé seulement par encaissement vérifié ; rejeu idempotent sans double encaissement", async () => {
    expect((await h.api.post(`/api/v1/canada/payments/${paymentId}/counter-receipts`).set(await T(client)).set(h.idem())
      .send({ amount: "38.60", currency: "USD", method: "cash", receipt_reference: "R-1" })).status).toBe(403);
    expect((await h.api.post(`/api/v1/canada/payments/${paymentId}/counter-receipts`).set(await T(financeCN)).set(h.idem())
      .send({ amount: "38.60", currency: "CDF", method: "cash", receipt_reference: "R-0" })).body.error.code).toBe("CURRENCY_MISMATCH");
    const key = { "Idempotency-Key": "receipt-R-1-0001" };
    const body = { amount: "20", currency: "USD", method: "cash", receipt_reference: "R-1" };
    const a = await h.api.post(`/api/v1/canada/payments/${paymentId}/counter-receipts`).set(await T(financeCN)).set(key).send(body);
    expect(a.status).toBe(201);
    expect(a.body.data).toMatchObject({ status: "pending", amount_paid: "20.00", balance: "18.60" });
    const replay = await h.api.post(`/api/v1/canada/payments/${paymentId}/counter-receipts`).set(await T(financeCN)).set(key).send(body);
    expect(replay.status).toBe(201);
    expect(replay.headers["idempotent-replayed"]).toBe("true");
    expect(replay.body.data.transaction.id).toBe(a.body.data.transaction.id);
    const reuse = await h.api.post(`/api/v1/canada/payments/${paymentId}/counter-receipts`).set(await T(financeCN)).set(key).send({ ...body, amount: "18.60" });
    expect(reuse.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect((await h.api.post(`/api/v1/canada/payments/${paymentId}/counter-receipts`).set(await T(financeCN)).set(h.idem()).send(body)).body.error.code).toBe("RECEIPT_ALREADY_RECORDED");
    const done = await h.api.post(`/api/v1/canada/payments/${paymentId}/counter-receipts`).set(await T(financeCN)).set(h.idem())
      .send({ amount: "18.60", currency: "USD", method: "mobile_money", receipt_reference: "MM-778" });
    expect(done.body.data.status).toBe("succeeded");
    expect((await h.pool.query(`select count(*)::int n from canada.payment_transactions where payment_id = $1`, [paymentId])).rows[0].n).toBe(2);
  });

  it("expédition : regroupement, départ refusé sans vol, vol brouillon → validé → publié avec notification", async () => {
    const s = await h.api.post("/api/v1/canada/shipments").set(await T(mgrCN)).set(h.idem())
      .send({ origin_country: "CN", destination_country: "CD", origin_agency_id: w.cn, destination_agency_id: w.cd });
    shipmentId = s.body.data.id;
    expect((await h.api.post(`/api/v1/canada/shipments/${shipmentId}/parcels`).set(await T(mgrCN)).set(h.idem()).send({ parcel_ids: [parcel] })).status).toBe(200);
    const s2 = await h.api.post("/api/v1/canada/shipments").set(await T(mgrCN)).set(h.idem()).send({ origin_country: "CN", destination_country: "CD", origin_agency_id: w.cn });
    expect((await h.api.post(`/api/v1/canada/shipments/${s2.body.data.id}/parcels`).set(await T(mgrCN)).set(h.idem()).send({ parcel_ids: [parcel] })).body.error.code).toBe("PARCEL_NOT_READY");
    expect((await h.api.post(`/api/v1/canada/shipments/${shipmentId}/ready`).set(await T(mgrCN))).status).toBe(200);
    expect((await h.api.post(`/api/v1/canada/shipments/${shipmentId}/dispatch`).set(await T(mgrCN)).set(h.idem())).body.error.code).toBe("FLIGHT_REQUIRED");

    const dep = futureLocal(3, 23, "+08:00"), arr = futureLocal(4, 9, "+01:00");
    const bad = await h.api.post("/api/v1/canada/flights").set(await T(opsCN)).set(h.idem())
      .send({ airline_iata: "ET", flight_number: "607", flight_date: arr.date, departure_airport: "CAN", arrival_airport: "FIH", scheduled_departure: dep.iso, scheduled_arrival: arr.iso });
    expect(bad.body.error.code).toBe("FLIGHT_DATE_MISMATCH");
    const f = await h.api.post("/api/v1/canada/flights").set(await T(opsCN)).set(h.idem())
      .send({ airline_iata: "ET", flight_number: "607", flight_date: dep.date, departure_airport: "CAN", arrival_airport: "FIH", scheduled_departure: dep.iso, scheduled_arrival: arr.iso, departure_terminal: "T2" });
    expect(f.status).toBe(201);
    expect(f.body.data).toMatchObject({ status: "DRAFT", departure_timezone: "Asia/Shanghai", arrival_timezone: "Africa/Kinshasa" });
    flightId = f.body.data.id;
    const dup = await h.api.post("/api/v1/canada/flights").set(await T(opsCN)).set(h.idem())
      .send({ airline_iata: "ET", flight_number: "607", flight_date: dep.date, departure_airport: "CAN", arrival_airport: "FIH", scheduled_departure: dep.iso, scheduled_arrival: arr.iso });
    expect(dup.status).toBe(409); // compagnie + numéro + date uniques

    expect((await h.api.post(`/api/v1/canada/flights/${flightId}/publish`).set(await T(opsCN)).set(h.idem())).body.error.code).toBe("INVALID_STATE");
    expect((await h.api.post(`/api/v1/canada/flights/${flightId}/schedule`).set(await T(opsCN))).status).toBe(200);
    expect((await h.api.post(`/api/v1/canada/flights/${flightId}/shipments`).set(await T(mgrCN)).set(h.idem()).send({ shipment_id: shipmentId })).status).toBe(201);
    expect((await h.api.post(`/api/v1/canada/flights/${flightId}/publish`).set(await T(opsCN)).set(h.idem())).status).toBe(200);

    await worker.runWorkerOnce();
    await worker.runWorkerOnce(); // deuxième passage : aucun doublon
    const notes = await h.pool.query(`select title, body, source_event_id from shared.notifications where user_id = $1 and category = 'flight'`, [client.id]);
    expect(notes.rows).toHaveLength(1);
    expect(notes.rows[0].body).toContain("Ethiopian Airlines (ET)");
    expect(notes.rows[0].body).toContain("ET607");
    expect(notes.rows[0].body).toContain("UTC+8, Asia/Shanghai");
    expect(notes.rows[0].body).toContain("Africa/Kinshasa");
    expect((await h.pool.query(`select count(*)::int n from shared.notifications where user_id = $1 and category = 'flight'`, [other.id])).rows[0].n).toBe(0);
    const del = await h.pool.query(`select d.status, d.provider_message_id from shared.notification_deliveries d join shared.notifications n on n.id = d.notification_id where n.user_id = $1 and n.category = 'flight'`, [client.id]);
    expect(del.rows[0].status).toBe("accepted"); // accepté par le fournisseur ≠ délivré
  });

  it("modification d'un vol publié : motif obligatoire, nouvelle version, notification corrective", async () => {
    const f0 = (await h.api.get(`/api/v1/canada/flights/${flightId}`).set(await T(opsCN))).body.data;
    const later = new Date(new Date(f0.scheduled_arrival).getTime() + 2 * 3600_000).toISOString();
    expect((await h.api.patch(`/api/v1/canada/flights/${flightId}`).set(await T(opsCN)).send({ scheduled_arrival: later })).body.error.code).toBe("CHANGE_REASON_REQUIRED");
    const u = await h.api.patch(`/api/v1/canada/flights/${flightId}`).set(await T(opsCN)).send({ scheduled_arrival: later, change_reason: "Escale technique ajoutée par la compagnie" });
    expect(u.status).toBe(200);
    expect(u.body.data.current_version).toBe(2);
    await worker.runWorkerOnce();
    const n = await h.pool.query(`select title from shared.notifications where user_id = $1 and category = 'flight' order by created_at`, [client.id]);
    expect(n.rows.map((r) => r.title)).toEqual([expect.stringContaining("programmé"), expect.stringContaining("Modification du vol ET607")]);
    const v = await h.pool.query(`select version, changed_fields, change_reason from canada.flight_versions where flight_id = $1 order by version`, [flightId]);
    expect(v.rows[1]).toMatchObject({ version: 2, changed_fields: ["scheduled_arrival"] });
  });

  it("départ, vol, atterrissage ; l'arrivée du vol NE réceptionne PAS les colis ; arrivée confirmée par le pays d'arrivée", async () => {
    expect((await h.api.post(`/api/v1/canada/shipments/${shipmentId}/dispatch`).set(await T(mgrCN)).set(h.idem())).status).toBe(200);
    for (const s of ["BOARDING", "DEPARTED", "IN_AIR", "LANDED"]) {
      const r = await h.api.post(`/api/v1/canada/flights/${flightId}/status`).set(await T(opsCN)).set(h.idem()).send({ status: s });
      expect(r.status, s).toBe(200);
    }
    expect((await h.api.post(`/api/v1/canada/flights/${flightId}/status`).set(await T(opsCN)).set(h.idem()).send({ status: "ARRIVED" })).status).toBe(403);
    expect((await h.api.post(`/api/v1/canada/flights/${flightId}/status`).set(await T(opsCD)).set(h.idem()).send({ status: "ARRIVED" })).status).toBe(200);
    const p = await h.pool.query(`select status from canada.parcels where id = $1`, [parcel]);
    expect(p.rows[0].status).toBe("dispatched");
    const tr = await h.api.get(`/api/v1/canada/flights/${flightId}/tracking`).set(await T(opsCD));
    expect(tr.body.data).toMatchObject({ status: "ARRIVED", position: null, position_available: false, data_source: "operator" });
  });

  it("arrivée de l'expédition, réception physique à destination, livraison avec preuve, clôture", async () => {
    expect((await h.api.post(`/api/v1/canada/shipments/${shipmentId}/arrive`).set(await T(mgrCN)).set(h.idem())).status).toBe(403);
    expect((await h.api.post(`/api/v1/canada/shipments/${shipmentId}/arrive`).set(await T(opsCD)).set(h.idem())).status).toBe(200);
    expect((await h.pool.query(`select status from canada.parcels where id = $1`, [parcel])).rows[0].status).toBe("arrived_destination");
    expect((await h.api.post(`/api/v1/canada/shipments/${shipmentId}/complete`).set(await T(opsCD))).body.error.code).toBe("PARCELS_NOT_RECEIVED");
    expect((await step(agentCN, parcel, "received_destination")).status).toBe(403); // origine ≠ destination
    expect((await step(agentCD, parcel, "received_destination", { source: "scan", warehouse_id: w.whCd })).status).toBe(200);
    expect((await step(agentCD, parcel, "available")).status).toBe(200);
    expect((await step(opsCD, parcel, "delivered")).body.error.code).toBe("PROOF_REQUIRED");
    expect((await step(opsCD, parcel, "delivered", { proof_reference: "OTP-4821 + signature" })).status).toBe(200);
    expect((await step(opsCD, parcel, "on_hold", { comment: "x" })).body.error.code).toBe("PARCEL_TERMINAL");
    expect((await h.api.post(`/api/v1/canada/shipments/${shipmentId}/complete`).set(await T(opsCD))).status).toBe(200);
  });

  it("suivi client : historique horodaté, suivi colis et suivi vol distincts, aucune position inventée ; suivi public sans données personnelles", async () => {
    const t = await h.api.get(`/api/v1/me/parcels/${parcel}/tracking`).set(await T(client));
    expect(t.status).toBe(200);
    const statuses = t.body.data.package_tracking.events.map((e: any) => e.status);
    expect(statuses).toEqual(["expected", "received", "inspected", "ready_for_shipment", "in_shipment", "dispatched", "arrived_destination", "received_destination", "available", "delivered"]);
    // Dernière position confirmée = scan de réception à l'entrepôt de destination (jamais un GPS inventé).
    expect(t.body.data.package_tracking.last_confirmed_position).toMatchObject({ kind: "scan", country_code: "CD" });
    expect(t.body.data.flight_tracking).toMatchObject({ designator: "ET607", position: null });
    const ref = (await h.pool.query(`select reference from canada.parcels where id = $1`, [parcel])).rows[0].reference;
    const pub = await h.api.get(`/api/v1/public/tracking/${ref}`);
    expect(pub.status).toBe(200);
    expect(JSON.stringify(pub.body)).not.toMatch(/Mbuyi|Grace|client@|38\.60/);
  });

  it("version de devis : une nouvelle version rend l'ancienne inacceptable", async () => {
    const p2 = await readyParcel(client.clientId);
    const q = await h.api.post("/api/v1/canada/quotes").set(await T(mgrCN)).set(h.idem())
      .send({ client_id: client.clientId, agency_id: w.cn, origin_country: "CN", destination_country: "CD", currency: "CDF", parcel_ids: [p2] });
    expect(q.body.data.version.total).toBe("108080.00"); // (33.60 + 5) USD × 2800, taux enregistré dans la version
    expect(q.body.data.version.exchange_rates[0]).toMatchObject({ base: "USD", quote: "CDF", rate: "2800.0000000000" });
    await h.api.post(`/api/v1/canada/quotes/${q.body.data.id}/issue`).set(await T(mgrCN)).set(h.idem());
    const rev = await h.api.post(`/api/v1/canada/quotes/${q.body.data.id}/revisions`).set(await T(mgrCN)).set(h.idem())
      .send({ parcel_ids: [p2], lines: [{ category: "insurance", designation: "Assurance", quantity: "1", unit_price: "2", currency: "USD" }], reason: "Assurance demandée" });
    expect(rev.body.data.version).toBe(2);
    await h.api.post(`/api/v1/canada/quotes/${q.body.data.id}/issue`).set(await T(mgrCN)).set(h.idem());
    const old = await h.api.post(`/api/v1/me/quotes/${q.body.data.id}/versions/1/accept`).set(await T(client)).set(h.idem()).send({ accept_conditions: true });
    expect(old.body.error.code).toBe("QUOTE_VERSION_OUTDATED");
    const vs = await h.pool.query(`select version, status, total from canada.quotation_versions where quotation_id = $1 order by version`, [q.body.data.id]);
    expect(vs.rows).toEqual([{ version: 1, status: "superseded", total: "108080.00" }, { version: 2, status: "issued", total: "113680.00" }]);
  });
});

describe("Scénarios D et E (Dossier 05 §25)", () => {
  it("D — expédition partielle : deux colis partent, le troisième reste suivi indépendamment", async () => {
    const [a, b, c] = [await readyParcel(client.clientId), await readyParcel(client.clientId), await readyParcel(client.clientId)];
    const s = (await h.api.post("/api/v1/canada/shipments").set(await T(mgrCN)).set(h.idem()).send({ origin_country: "CN", destination_country: "CD", origin_agency_id: w.cn, transport_mode: "air" })).body.data;
    await h.api.post(`/api/v1/canada/shipments/${s.id}/parcels`).set(await T(mgrCN)).set(h.idem()).send({ parcel_ids: [a, b, c] });
    expect((await h.api.post(`/api/v1/canada/shipments/${s.id}/parcels/${c}/remove`).set(await T(mgrCN)).send({ reason: "Document douanier manquant" })).status).toBe(200);
    const st = await h.pool.query(`select id, status from canada.parcels where id = any($1::uuid[]) order by id`, [[a, b, c]]);
    expect(Object.fromEntries(st.rows.map((r) => [r.id, r.status]))).toEqual({ [a]: "in_shipment", [b]: "in_shipment", [c]: "ready_for_shipment" });
    const links = await h.pool.query(`select parcel_id, removed_at is not null as removed from canada.shipment_parcels where shipment_id = $1`, [s.id]);
    expect(links.rows).toHaveLength(3); // le retrait reste dans l'historique
  });

  it("E — vol annulé : expéditions libérées pour réaffectation, clients informés, aucun colis perdu", async () => {
    const p = await readyParcel(client.clientId);
    const s = (await h.api.post("/api/v1/canada/shipments").set(await T(mgrCN)).set(h.idem()).send({ origin_country: "CN", destination_country: "CD", origin_agency_id: w.cn })).body.data;
    await h.api.post(`/api/v1/canada/shipments/${s.id}/parcels`).set(await T(mgrCN)).set(h.idem()).send({ parcel_ids: [p] });
    const dep = futureLocal(6, 10, "+08:00"), arr = futureLocal(6, 20, "+01:00");
    const f = (await h.api.post("/api/v1/canada/flights").set(await T(opsCN)).set(h.idem())
      .send({ airline_iata: "ET", flight_number: "609", flight_date: dep.date, departure_airport: "CAN", arrival_airport: "FIH", scheduled_departure: dep.iso, scheduled_arrival: arr.iso })).body.data;
    await h.api.post(`/api/v1/canada/flights/${f.id}/schedule`).set(await T(opsCN));
    await h.api.post(`/api/v1/canada/flights/${f.id}/shipments`).set(await T(mgrCN)).set(h.idem()).send({ shipment_id: s.id });
    await h.api.post(`/api/v1/canada/flights/${f.id}/publish`).set(await T(opsCN)).set(h.idem());
    const c = await h.api.post(`/api/v1/canada/flights/${f.id}/cancel`).set(await T(opsCN)).set(h.idem()).send({ reason: "Annulation compagnie" });
    expect(c.body.data.released_shipment_ids).toEqual([s.id]);
    expect((await h.api.post(`/api/v1/canada/flights/${f.id}/status`).set(await T(opsCN)).set(h.idem()).send({ status: "DEPARTED" })).status).toBe(422);
    await worker.runWorkerOnce();
    const n = await h.pool.query(`select title from shared.notifications where user_id = $1 and data->>'flight_id' = $2 order by created_at`, [client.id, f.id]);
    expect(n.rows.map((r) => r.title)).toEqual([expect.stringContaining("programmé"), "Vol ET609 : Annulé"]);
    expect((await h.pool.query(`select status from canada.parcels where id = $1`, [p])).rows[0].status).toBe("in_shipment");
    expect((await h.pool.query(`select count(*)::int n from canada.flight_shipment_assignments where shipment_id = $1 and unassigned_at is not null`, [s.id])).rows[0].n).toBe(1);
  });
});

describe("Remboursement avec séparation des responsabilités (Dossier 03 §11)", () => {
  it("demande par l'agent financier, approbation par un autre (MFA), exécution", async () => {
    const pay = (await h.pool.query(`select id from canada.payments where status = 'succeeded' limit 1`)).rows[0].id;
    const r = await h.api.post(`/api/v1/canada/payments/${pay}/refunds`).set(await T(financeCN)).set(h.idem()).send({ amount: "5", reason: "Geste commercial" });
    expect(r.status).toBe(201);
    expect((await h.api.post(`/api/v1/canada/payments/${pay}/refunds`).set(await T(financeCN)).set(h.idem()).send({ amount: "1000", reason: "Trop" })).body.error.code).toBe("REFUND_AMOUNT_INVALID");
    expect((await h.api.post(`/api/v1/canada/refunds/${r.body.data.id}/execute`).set(await T(financeMgr, "aal2")).set(h.idem()).send({ method: "cash", receipt_reference: "RB-1" })).body.error.code).toBe("REFUND_NOT_APPROVED");
    expect((await h.api.post(`/api/v1/canada/refunds/${r.body.data.id}/decision`).set(await T(financeMgr)).send({ decision: "approve" })).status).toBe(403); // sans MFA
    expect((await h.api.post(`/api/v1/canada/refunds/${r.body.data.id}/decision`).set(await T(financeMgr, "aal2")).send({ decision: "approve" })).status).toBe(200);
    const ex = await h.api.post(`/api/v1/canada/refunds/${r.body.data.id}/execute`).set(await T(financeMgr, "aal2")).set(h.idem()).send({ method: "cash", receipt_reference: "RB-1" });
    expect(ex.body.data.payment_status).toBe("partially_refunded");
  });
});

describe("Annonce générale distincte et consentement", () => {
  it("l'annonce n'envoie d'e-mail qu'aux clients ayant consenti ; centre de notifications pour tous", async () => {
    const admin = await h.makeUser("com@ta.test", { roles: [{ role: "canada_administrator", scope_type: "country", scope_country: "CD" }] });
    await h.pool.query(`insert into shared.notification_preferences(user_id, channel, category, enabled) values ($1, 'email', 'announcement', true)`, [other.id]);
    const before = sent.length;
    expect((await h.api.post("/api/v1/canada/notifications/announcements").set(await T(admin, "aal2")).set(h.idem())
      .send({ title: "Nouvelle liaison", body: "Ouverture d'une liaison hebdomadaire.", countries: ["CM"] })).status).toBe(403);
    const a = await h.api.post("/api/v1/canada/notifications/announcements").set(await T(admin, "aal2")).set(h.idem())
      .send({ title: "Nouvelle liaison Guangzhou – Kinshasa", body: "Départs hebdomadaires.", countries: ["CD"] });
    expect(a.status).toBe(202);
    await worker.runWorkerOnce();
    const got = await h.pool.query(`select user_id from shared.notifications where campaign_id = $1`, [a.body.data.campaign_id]);
    expect(got.rows.map((r) => r.user_id).sort()).toEqual([client.id, other.id].sort());
    expect(sent.slice(before).filter((m) => m.subject.startsWith("Nouvelle liaison")).map((m) => m.to)).toEqual(["other@ta.test"]);
  });
});

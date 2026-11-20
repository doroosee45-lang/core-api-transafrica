import { setupHarness, type Harness } from "./support/harness.js";

let h: Harness;
let w: Awaited<ReturnType<Harness["world"]>>;
let root: any, adminCD: any, adminCN: any, mgrCN: any, mgrCD: any, agentCN: any, agentCD: any, finCN: any, client: any, other: any;
let worker: typeof import("../src/modules/notifications/worker.js");
const T = async (u: any, aal?: "aal1" | "aal2") => h.auth(await u.token(aal));

async function readyParcel(clientId: string) {
  const r = await h.api.post("/api/v1/canada/parcels").set(await T(agentCN)).set(h.idem())
    .send({ client_id: clientId, recipient_name: "Famille", origin_country: "CN", destination_country: "CD", origin_agency_id: w.cn, destination_agency_id: w.cd });
  expect(r.status).toBe(201);
  return r.body.data.id as string;
}

beforeAll(async () => {
  h = await setupHarness();
  w = await h.world();
  worker = await import("../src/modules/notifications/worker.js");
  root = await h.makeUser("root@ta.test", { mfa: true, roles: [{ role: "canada_administrator", scope_type: "global" }] });
  adminCD = await h.makeUser("admin.cd@ta.test", { mfa: true, roles: [{ role: "canada_administrator", scope_type: "country", scope_country: "CD" }] });
  adminCN = await h.makeUser("admin.cn@ta.test", { mfa: true, roles: [{ role: "canada_administrator", scope_type: "country", scope_country: "CN" }] });
  mgrCN = await h.makeUser("mgr.cn@ta.test", { roles: [{ role: "canada_agency_manager", scope_type: "agency", scope_id: w.cn }] });
  mgrCD = await h.makeUser("mgr.cd@ta.test", { roles: [{ role: "canada_agency_manager", scope_type: "agency", scope_id: w.cd }] });
  agentCN = await h.makeUser("agent.cn@ta.test", { roles: [{ role: "canada_agent", scope_type: "agency", scope_id: w.cn }] });
  agentCD = await h.makeUser("agent.cd@ta.test", { roles: [{ role: "canada_agent", scope_type: "agency", scope_id: w.cd }] });
  finCN = await h.makeUser("fin.cn@ta.test", { roles: [{ role: "canada_finance_agent", scope_type: "agency", scope_id: w.cn }] });
  client = await h.makeUser("client@ta.test", { roles: [{ role: "canada_client", scope_type: "own" }], client: { residence: "CD", agency: w.cd } });
  other = await h.makeUser("other@ta.test", { roles: [{ role: "canada_client", scope_type: "own" }], client: { residence: "CD" } });
});
afterAll(async () => { await h?.teardown(); });

describe("Décisions RBAC du 21/11/2026", () => {
  it("le rôle « responsable des opérations » (pays) est désactivé et n'accorde plus rien", async () => {
    const legacy = await h.makeUser("ops.legacy@ta.test", { roles: [{ role: "canada_operations_manager", scope_type: "country", scope_country: "CD" }] });
    expect((await h.api.get("/api/v1/canada/flights").set(await T(legacy))).status).toBe(403);
    const target = await h.makeUser("candidate@ta.test");
    const r = await h.api.post("/api/v1/access/user-roles").set(await T(root)).set(h.idem())
      .send({ user_id: target.id, role_code: "canada_operations_manager", scope_type: "country", scope_country: "CD" });
    expect(r.body.error.code).toBe("ROLE_UNKNOWN");
  });

  it("un manager d'agence ne crée ni ne publie de vol ; l'administrateur pays oui", async () => {
    const d = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
    const body = { airline_iata: "ET", flight_number: "611", flight_date: d, departure_airport: "CAN", arrival_airport: "FIH",
      scheduled_departure: `${d}T10:00:00+08:00`, scheduled_arrival: `${d}T20:00:00+01:00` };
    expect((await h.api.post("/api/v1/canada/flights").set(await T(mgrCN)).set(h.idem()).send(body)).status).toBe(403);
    expect((await h.api.post("/api/v1/canada/flights").set(await T(adminCN)).set(h.idem()).send(body)).status).toBe(201);
  });

  it("un agent ne peut recevoir qu'un périmètre agence ou entrepôt", async () => {
    const target = await h.makeUser("agent.pays@ta.test");
    const r = await h.api.post("/api/v1/access/user-roles").set(await T(root)).set(h.idem())
      .send({ user_id: target.id, role_code: "canada_agent", scope_type: "country", scope_country: "CD" });
    expect(r.body.error.code).toBe("SCOPE_NOT_ALLOWED");
  });

  it("Super Admin : gouvernance financière (barèmes, taux, export) mais aucune opération d'encaissement", async () => {
    const pr = await h.api.post("/api/v1/canada/exchange-rates").set(await T(root))
      .send({ base_currency: "USD", quote_currency: "XAF", rate: "600", effective_at: new Date().toISOString(), source: "BEAC" });
    expect(pr.status).toBe(201);
    const hist = await h.api.get("/api/v1/canada/exchange-rates?base=USD&quote=XAF").set(await T(root));
    expect(hist.status).toBe(200);
    expect(hist.body.data.map((r: any) => r.rate)).toEqual(["600.0000000000"]);
    const pay = await h.api.post("/api/v1/canada/payments").set(await T(finCN)).set(h.idem())
      .send({ client_id: client.clientId, agency_id: w.cn, amount_due: "10", currency: "USD", purpose: "service" });
    expect(pay.status).toBe(201);
    const verify = await h.api.post(`/api/v1/canada/payments/${pay.body.data.id}/counter-receipts`).set(await T(root)).set(h.idem())
      .send({ amount: "10", currency: "USD", method: "cash", receipt_reference: "R-ROOT" });
    expect(verify.status).toBe(403);
    expect((await h.api.get(`/api/v1/canada/payments/${pay.body.data.id}`).set(await T(root))).status).toBe(200);
  });

  it("rôle complémentaire configurable (ex. caissier) : création globale, catalogue fermé, anti-escalade à l'attribution", async () => {
    const created = await h.api.post("/api/v1/access/roles").set(await T(root)).set(h.idem())
      .send({ code: "canada_custom_cashier", name: "Caissier", permissions: ["canada.payments.read_scoped", "canada.payments.verify"], allowed_scopes: ["agency"] });
    expect(created.status).toBe(201);
    const bogus = await h.api.post("/api/v1/access/roles").set(await T(root)).set(h.idem())
      .send({ code: "canada_custom_xyz", name: "Xyz", permissions: ["canada.everything.all"], allowed_scopes: ["agency"] });
    expect(bogus.body.error.code).toBe("PERMISSION_UNKNOWN");
    expect((await h.api.post("/api/v1/access/roles").set(await T(adminCD)).set(h.idem())
      .send({ code: "canada_custom_y", name: "Y", permissions: ["canada.parcels.read_scoped"], allowed_scopes: ["agency"] })).status).toBe(403);
    expect((await h.api.patch("/api/v1/access/roles/canada_agent").set(await T(root)).send({ name: "Agent modifié", reason: "tentative de modification" })).body.error.code).toBe("SYSTEM_ROLE_LOCKED");
    // Le Super Admin ne détient pas payments.verify : il ne peut pas attribuer ce rôle (anti-escalade conservé).
    const target = await h.makeUser("caissier@ta.test");
    const grant = await h.api.post("/api/v1/access/user-roles").set(await T(root)).set(h.idem())
      .send({ user_id: target.id, role_code: "canada_custom_cashier", scope_type: "agency", scope_id: w.cn });
    expect(grant.body.error.code).toBe("PRIVILEGE_ESCALATION");
    const audit = await h.pool.query(`select count(*)::int n from audit.audit_events where action = 'access.role.created'`);
    expect(audit.rows[0].n).toBe(1);
  });

  it("historique des connexions : visible pour un utilisateur du périmètre, masqué hors périmètre", async () => {
    await h.api.post("/api/v1/auth/login").send({ email: "agent.cd@ta.test", password: "nope-nope-1" });
    const ok = await h.api.get(`/api/v1/access/users/${agentCD.id}/security-events`).set(await T(adminCD));
    expect(ok.status).toBe(200);
    const ko = await h.api.get(`/api/v1/access/users/${agentCN.id}/security-events`).set(await T(adminCD));
    expect(ko.status).toBe(404);
    const sessions = await h.api.get("/api/v1/identity/me/sessions").set(await T(client));
    expect(sessions.body.data.filter((s: any) => s.current)).toHaveLength(1);
  });
});

describe("Opérations logistiques complémentaires", () => {
  let parcel: string;
  it("classement avant préparation, scan physique, dernière position confirmée côté client", async () => {
    parcel = await readyParcel(client.clientId);
    const cls = await h.api.patch(`/api/v1/canada/parcels/${parcel}/classification`).set(await T(agentCN))
      .send({ category: "electronics", fragile: true, reason: "Contrôle visuel à la réception" });
    expect(cls.status).toBe(200);
    expect(cls.body.data).toMatchObject({ category: "electronics", fragile: true });
    const scan = await h.api.post(`/api/v1/canada/parcels/${parcel}/scans`).set(await T(agentCN)).set(h.idem())
      .send({ warehouse_id: w.whCn, location_text: "Entrepôt Guangzhou — allée B" });
    expect(scan.status).toBe(201);
    expect((await h.api.post(`/api/v1/canada/parcels/${parcel}/scans`).set(await T(agentCD)).set(h.idem()).send({ warehouse_id: w.whCn })).status).toBe(403);
    const t = await h.api.get(`/api/v1/me/parcels/${parcel}/tracking`).set(await T(client));
    expect(t.body.data.package_tracking.last_confirmed_position).toMatchObject({ kind: "scan", location: "Entrepôt Guangzhou — allée B", country_code: "CN" });
    expect(t.body.data.package_tracking.events.map((e: any) => e.status)).toEqual(["expected", "received"]); // le scan n'invente aucun statut
    const staff = await h.api.get(`/api/v1/canada/parcels/${parcel}/tracking`).set(await T(mgrCD));
    expect(staff.status).toBe(200);
    expect(staff.body.data.events.some((e: any) => e.event_type === "parcel.classified")).toBe(true);
  });

  it("affectation à un entrepôt : seulement dans le pays d'origine ou de destination et dans le périmètre", async () => {
    expect((await h.api.post(`/api/v1/canada/parcels/${parcel}/warehouse`).set(await T(mgrCN)).set(h.idem()).send({ warehouse_id: w.whCn })).status).toBe(200);
    expect((await h.api.post(`/api/v1/canada/parcels/${parcel}/warehouse`).set(await T(mgrCN)).set(h.idem()).send({ warehouse_id: w.whCd })).status).toBe(403);
  });

  it("responsables d'étape : chaque pays désigne le sien, parmi son personnel", async () => {
    const s = (await h.api.post("/api/v1/canada/shipments").set(await T(mgrCN)).set(h.idem())
      .send({ origin_country: "CN", destination_country: "CD", origin_agency_id: w.cn, destination_agency_id: w.cd })).body.data;
    expect((await h.api.post(`/api/v1/canada/shipments/${s.id}/responsibles`).set(await T(mgrCN)).send({ origin_responsible_id: agentCN.id })).status).toBe(200);
    expect((await h.api.post(`/api/v1/canada/shipments/${s.id}/responsibles`).set(await T(mgrCN)).send({ destination_responsible_id: agentCD.id })).status).toBe(403);
    expect((await h.api.post(`/api/v1/canada/shipments/${s.id}/responsibles`).set(await T(mgrCD)).send({ destination_responsible_id: agentCN.id })).body.error.code).toBe("RESPONSIBLE_INVALID");
    expect((await h.api.post(`/api/v1/canada/shipments/${s.id}/responsibles`).set(await T(mgrCD)).send({ destination_responsible_id: agentCD.id })).status).toBe(200);
  });

  it("entrepôt : modifiable par l'administrateur du pays, pas par celui d'un autre pays", async () => {
    expect((await h.api.patch(`/api/v1/canada/warehouses/${w.whCd}`).set(await T(adminCD)).send({ capacity_m3: 120 })).status).toBe(200);
    expect((await h.api.patch(`/api/v1/canada/warehouses/${w.whCd}`).set(await T(adminCN)).send({ status: "suspended" })).status).toBe(403);
  });
});

describe("Espace client complété", () => {
  it("fiche, coordonnées et adresses ; aucune modification du pays ou du statut", async () => {
    const me = await h.api.get("/api/v1/me/client").set(await T(client));
    expect(me.body.data.residence_country).toBe("CD");
    expect((await h.api.patch("/api/v1/me/client").set(await T(client)).send({ phone: "+243 81 000 0001" })).body.data.phone).toBe("+243 81 000 0001");
    expect((await h.api.patch("/api/v1/me/client").set(await T(client)).send({ residence_country: "CA" })).status).toBe(400);
    const a1 = await h.api.post("/api/v1/me/addresses").set(await T(client)).send({ country_code: "CD", city: "Kinshasa", line1: "Av. du Commerce 12", is_default: true });
    const a2 = await h.api.post("/api/v1/me/addresses").set(await T(client)).send({ country_code: "CD", city: "Lubumbashi", line1: "Rue 4", is_default: true });
    expect(a2.status).toBe(201);
    const list = (await h.api.get("/api/v1/me/addresses").set(await T(client))).body.data;
    expect(list.filter((a: any) => a.is_default).map((a: any) => a.city)).toEqual(["Lubumbashi"]);
    expect((await h.api.put(`/api/v1/me/addresses/${a1.body.data.id}`).set(await T(other)).send({ country_code: "CD", city: "Goma", line1: "Rue Y" })).status).toBe(404);
  });

  it("demande modifiable tant qu'elle n'est pas prise en charge", async () => {
    const r = await h.api.post("/api/v1/me/requests").set(await T(client)).set(h.idem()).send({ origin_country: "CN", destination_country: "CD" });
    expect((await h.api.patch(`/api/v1/me/requests/${r.body.data.id}`).set(await T(client)).send({ estimated_weight_kg: 12 })).status).toBe(200);
    expect((await h.api.patch(`/api/v1/me/requests/${r.body.data.id}`).set(await T(other)).send({ estimated_weight_kg: 1 })).status).toBe(404);
    await h.api.post(`/api/v1/canada/requests/${r.body.data.id}/status`).set(await T(adminCD)).send({ status: "under_review" });
    expect((await h.api.patch(`/api/v1/me/requests/${r.body.data.id}`).set(await T(client)).send({ cancel: true })).body.error.code).toBe("REQUEST_LOCKED");
  });
});

describe("Exports contrôlés", () => {
  it("audit CSV limité au périmètre, export journalisé, formules neutralisées", async () => {
    const from = new Date(Date.now() - 86400000).toISOString(), to = new Date(Date.now() + 86400000).toISOString();
    const r = await h.api.get(`/api/v1/canada/audit-events/export?from=${from}&to=${to}`).set(await T(adminCD));
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toMatch(/text\/csv/);
    const lines = r.text.trim().split("\r\n");
    expect(lines[0]).toBe("occurred_at,actor_user_id,actor_kind,action,resource_type,resource_id,country_code,agency_id,reason,correlation_id");
    expect(lines.slice(1).every((l) => !l.includes(",CN,"))).toBe(true);
    expect((await h.api.get(`/api/v1/canada/audit-events/export?from=${from}&to=${to}`).set(await T(mgrCD))).status).toBe(403);
    const { toCsv } = await import("../src/modules/canada/exports.routes.js");
    expect(toCsv(["a"], [{ a: "=HYPERLINK(\"x\")" }])).toContain(`"'=HYPERLINK(""x"")"`);
    expect((await h.pool.query(`select count(*)::int n from audit.audit_events where action = 'canada.audit.exported'`)).rows[0].n).toBe(1);
  });
});

describe("Documents (Supabase Storage, bucket privé)", () => {
  let parcel: string;
  it("déclaration → téléversement direct signé → vérification serveur → lien temporaire", async () => {
    parcel = await readyParcel(client.clientId);
    const bytes = Buffer.from("%PDF-1.4 preuve de reception");
    const dec = await h.api.post("/api/v1/canada/documents").set(await T(agentCN)).set(h.idem())
      .send({ entity_type: "parcel", entity_id: parcel, kind: "proof_of_receipt", original_name: "reception.pdf", mime_type: "application/pdf", size_bytes: bytes.length });
    expect(dec.status).toBe(201);
    expect(dec.body.data.upload.upload_url).toMatch(/\/storage\/v1\/object\/upload\/sign\/canada-documents\/parcel\//);
    expect((await h.api.post(`/api/v1/canada/documents/${dec.body.data.id}/complete`).set(await T(agentCN))).body.error.code).toBe("DOCUMENT_NOT_UPLOADED");
    const put = await fetch(dec.body.data.upload.upload_url, { method: "PUT", headers: { "Content-Type": "application/pdf" }, body: bytes });
    expect(put.status).toBe(200);
    const done = await h.api.post(`/api/v1/canada/documents/${dec.body.data.id}/complete`).set(await T(agentCN));
    expect(done.body.data).toMatchObject({ status: "uploaded", stored_size: bytes.length });
    const dl = await h.api.get(`/api/v1/canada/documents/${dec.body.data.id}/download`).set(await T(client));
    expect(dl.status).toBe(200);
    expect(dl.body.data).toMatchObject({ expires_in: 300 });
    expect(dl.body.data.url).toMatch(/\/storage\/v1\/object\/sign\//);
    expect((await h.api.get(`/api/v1/canada/documents/${dec.body.data.id}/download`).set(await T(other))).status).toBe(404);
    const list = await h.api.get(`/api/v1/canada/documents?entity_type=parcel&entity_id=${parcel}`).set(await T(mgrCD));
    expect(list.body.data).toHaveLength(1);
  });

  it("refus : type de fichier, taille, objet différent de la déclaration, preuve de livraison hors destination", async () => {
    const base = { entity_type: "parcel", entity_id: parcel, kind: "parcel_photo", original_name: "a.jpg", mime_type: "image/jpeg" };
    expect((await h.api.post("/api/v1/canada/documents").set(await T(agentCN)).set(h.idem()).send({ ...base, mime_type: "application/x-msdownload", size_bytes: 10 })).body.error.code).toBe("FILE_TYPE_NOT_ALLOWED");
    expect((await h.api.post("/api/v1/canada/documents").set(await T(agentCN)).set(h.idem()).send({ ...base, size_bytes: 50 * 1024 * 1024 })).body.error.code).toBe("FILE_TOO_LARGE");
    const dec = await h.api.post("/api/v1/canada/documents").set(await T(agentCN)).set(h.idem()).send({ ...base, size_bytes: 1000 });
    await fetch(dec.body.data.upload.upload_url, { method: "PUT", headers: { "Content-Type": "image/jpeg" }, body: Buffer.alloc(10) });
    expect((await h.api.post(`/api/v1/canada/documents/${dec.body.data.id}/complete`).set(await T(agentCN))).body.error.code).toBe("DOCUMENT_MISMATCH");
    expect((await h.pool.query(`select status from canada.documents where id = $1`, [dec.body.data.id])).rows[0].status).toBe("rejected");
    // Taille et type déclarés exacts (image/jpeg), mais contenu d'un exécutable renommé : rejet sur la signature binaire.
    const exe = Buffer.concat([Buffer.from("MZ"), Buffer.alloc(30)]);
    const fake = await h.api.post("/api/v1/canada/documents").set(await T(agentCN)).set(h.idem()).send({ ...base, size_bytes: exe.length });
    await fetch(fake.body.data.upload.upload_url, { method: "PUT", headers: { "Content-Type": "image/jpeg" }, body: exe });
    expect((await h.api.post(`/api/v1/canada/documents/${fake.body.data.id}/complete`).set(await T(agentCN))).body.error.code).toBe("DOCUMENT_MISMATCH");
    expect((await h.pool.query(`select status, rejection_reason from canada.documents where id = $1`, [fake.body.data.id])).rows[0])
      .toEqual({ status: "rejected", rejection_reason: "CONTENT_SIGNATURE_MISMATCH" });
    expect((await h.api.post("/api/v1/canada/documents").set(await T(mgrCN)).set(h.idem())
      .send({ ...base, kind: "proof_of_delivery", mime_type: "image/jpeg", size_bytes: 100 })).status).toBe(403);
    expect((await h.api.post("/api/v1/canada/documents").set(await T(agentCN)).set(h.idem())
      .send({ ...base, kind: "payment_receipt", size_bytes: 100 })).body.error.code).toBe("DOCUMENT_KIND_MISMATCH");
  });
});

describe("Support et réclamations (Module 14)", () => {
  it("cycle complet : ouverture client, traitement par la destination, note interne invisible, affectation contrôlée, clôture motivée", async () => {
    const parcel = await readyParcel(client.clientId);
    const open = await h.api.post("/api/v1/me/support-tickets").set(await T(client)).set(h.idem())
      .send({ category: "delivery", subject: "Livraison incomplète", message: "Il manque un carton.", parcel_id: parcel });
    expect(open.status).toBe(201);
    expect(open.body.data).toMatchObject({ country_code: "CD", agency_id: w.cd, status: "open" });
    const id = open.body.data.id;
    expect((await h.api.post("/api/v1/me/support-tickets").set(await T(other)).set(h.idem())
      .send({ category: "parcel", subject: "Colis", message: "Où est-il ?", parcel_id: parcel })).status).toBe(404);
    expect((await h.api.get(`/api/v1/canada/support-tickets/${id}`).set(await T(mgrCN))).status).toBe(403);
    expect((await h.api.post(`/api/v1/canada/support-tickets/${id}/messages`).set(await T(mgrCD)).send({ body: "Vérifier le manifeste", internal_note: true })).status).toBe(201);
    expect((await h.api.post(`/api/v1/canada/support-tickets/${id}/messages`).set(await T(mgrCD)).send({ body: "Nous vérifions votre colis." })).status).toBe(201);
    const mine = await h.api.get(`/api/v1/me/support-tickets/${id}`).set(await T(client));
    expect(mine.body.data.messages.map((m: any) => m.body)).toEqual(["Il manque un carton.", "Nous vérifions votre colis."]);
    expect(mine.body.data.status).toBe("in_progress");
    expect((await h.api.post(`/api/v1/canada/support-tickets/${id}/assign`).set(await T(mgrCD)).send({ user_id: mgrCN.id })).body.error.code).toBe("ASSIGNEE_NOT_ALLOWED");
    expect((await h.api.post(`/api/v1/canada/support-tickets/${id}/assign`).set(await T(adminCD)).send({ user_id: mgrCD.id })).status).toBe(200);
    expect((await h.api.post(`/api/v1/canada/support-tickets/${id}/status`).set(await T(mgrCD)).send({ status: "closed" })).body.error.code).toBe("COMMENT_REQUIRED");
    expect((await h.api.post(`/api/v1/canada/support-tickets/${id}/status`).set(await T(mgrCD)).send({ status: "closed", note: "Carton retrouvé et livré" })).status).toBe(200);
    expect((await h.api.post(`/api/v1/me/support-tickets/${id}/messages`).set(await T(client)).send({ body: "Merci" })).body.error.code).toBe("TICKET_CLOSED");
    await worker.runWorkerOnce();
    const n = await h.pool.query(`select title from shared.notifications where user_id = $1 and category = 'support'`, [client.id]);
    expect(n.rows).toHaveLength(1); // la note interne ne notifie pas le client
  });
});

describe("Signatures binaires des documents acceptés (Cahier §16, validation des fichiers)", () => {
  it("reconnaît PDF, JPEG, PNG, WebP et refuse un contenu d'un autre type", async () => {
    const { matchesSignature } = await import("../src/modules/canada/documents.routes.js");
    const b = (...x: number[]) => Buffer.from([...x, ...new Array(16).fill(0)]);
    expect(matchesSignature("application/pdf", Buffer.from("%PDF-1.7 ......."))).toBe(true);
    expect(matchesSignature("image/jpeg", b(0xff, 0xd8, 0xff, 0xe0))).toBe(true);
    expect(matchesSignature("image/png", b(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe(true);
    expect(matchesSignature("image/webp", Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 ")]))).toBe(true);
    expect(matchesSignature("image/png", b(0xff, 0xd8, 0xff))).toBe(false);
    expect(matchesSignature("application/pdf", Buffer.from("MZ\x90\x00"))).toBe(false);
    expect(matchesSignature("image/webp", Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("AVI LIST")]))).toBe(false);
    expect(matchesSignature("application/zip", Buffer.from("PK\x03\x04"))).toBe(false);
  });
});

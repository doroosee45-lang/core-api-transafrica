import { PASSWORD, setupHarness, type Harness } from "./support/harness.js";

/**
 * Audit du 20/11/2026 :
 *  - parcours e-mail complets (vérification, renvoi, réinitialisation) contre la doublure GoTrue ;
 *  - verrouillage temporaire par compte (en plus de la limite par IP) ;
 *  - précision des montants par devise (aucun arrondi silencieux) et taux de change.
 */
let h: Harness;
let w: Awaited<ReturnType<Harness["world"]>>;
let finCN: any, root: any, client: any;
const T = async (u: any, aal?: "aal1" | "aal2") => h.auth(await u.token(aal));

const registration = (email: string) => ({
  first_name: "Jean", last_name: "Mbala", email, password: PASSWORD, password_confirmation: PASSWORD,
  country_of_residence: "CG", accept_terms: true, platform: "CANADA", preferred_language: "en",
});

beforeAll(async () => {
  h = await setupHarness();
  w = await h.world();
  root = await h.makeUser("root.money@ta.test", { mfa: true, roles: [{ role: "canada_administrator", scope_type: "global" }] });
  finCN = await h.makeUser("fin.money@ta.test", { roles: [{ role: "canada_finance_agent", scope_type: "agency", scope_id: w.cn }] });
  client = await h.makeUser("client.money@ta.test", { roles: [{ role: "canada_client", scope_type: "own" }], client: { residence: "CM", agency: w.cn } });
});
afterAll(async () => { await h?.teardown(); });

describe("Vérification d'e-mail et réinitialisation (Spéc. identité §8, §13)", () => {
  it("le lien de vérification active le compte et ouvre la session ; il est à usage unique", async () => {
    expect((await h.api.post("/api/v1/auth/register").send(registration("jean@example.org"))).status).toBe(202);
    // Renvoi : la réponse est identique pour une adresse inconnue.
    const unknown = await h.api.post("/api/v1/auth/resend-verification").send({ email: "personne@example.org" });
    const known = await h.api.post("/api/v1/auth/resend-verification").send({ email: "jean@example.org" });
    expect(unknown.status).toBe(202);
    expect(known.body.data).toEqual(unknown.body.data);

    const token = h.stub.emailToken("jean@example.org", "signup")!;
    const v = await h.api.post("/api/v1/auth/verify-email").send({ token_hash: token, type: "signup" });
    expect(v.status).toBe(200);
    expect(v.body.data.context.roles).toEqual(["canada_client"]);
    const me = await h.api.get("/api/v1/identity/me").set(h.auth(v.body.data.session.access_token));
    expect(me.body.data.profile.account_status).toBe("active");

    const again = await h.api.post("/api/v1/auth/verify-email").set("Accept-Language", "en").send({ token_hash: token, type: "signup" });
    expect(again.status).toBe(400);
    expect(again.body.error).toMatchObject({ code: "TOKEN_INVALID_OR_EXPIRED", message: "Invalid or expired link." });
  });

  it("mot de passe oublié → lien → nouveau mot de passe ; l'ancien ne fonctionne plus ; lien à usage unique", async () => {
    expect((await h.api.post("/api/v1/auth/forgot-password").send({ email: "jean@example.org" })).status).toBe(202);
    const token = h.stub.emailToken("jean@example.org", "recovery")!;
    expect(token).toBeTruthy();
    const weak = await h.api.post("/api/v1/auth/reset-password").send({ token_hash: token, new_password: "court" });
    expect(weak.status).toBe(400);
    const r = await h.api.post("/api/v1/auth/reset-password").send({ token_hash: token, new_password: "Nouveau-Pass-2026" });
    expect(r.status).toBe(200);
    expect((await h.api.post("/api/v1/auth/login").send({ email: "jean@example.org", password: PASSWORD })).status).toBe(401);
    expect((await h.api.post("/api/v1/auth/login").send({ email: "jean@example.org", password: "Nouveau-Pass-2026" })).status).toBe(200);
    expect((await h.api.post("/api/v1/auth/reset-password").send({ token_hash: token, new_password: "Encore-Un-2026" })).body.error.code)
      .toBe("TOKEN_INVALID_OR_EXPIRED");
    // Un lien de vérification ne peut pas servir de lien de réinitialisation.
    expect((await h.pool.query(`select count(*)::int n from audit.security_events where event_type = 'auth.password_reset_completed'`)).rows[0].n).toBe(1);
  });

  it("changer son mot de passe ne laisse aucune session de contrôle ouverte", async () => {
    const login = await h.api.post("/api/v1/auth/login").send({ email: "jean@example.org", password: "Nouveau-Pass-2026" });
    const uid = login.body.data.context.user_id;
    const before = (await h.pool.query(`select count(*)::int n from auth.sessions where user_id = $1`, [uid])).rows[0].n;
    const r = await h.api.post("/api/v1/auth/change-password").set(h.auth(login.body.data.session.access_token))
      .send({ current_password: "Nouveau-Pass-2026", new_password: "Troisieme-Pass-2026" });
    expect(r.status).toBe(200);
    expect((await h.pool.query(`select count(*)::int n from auth.sessions where user_id = $1`, [uid])).rows[0].n).toBe(before);
  });
});

describe("Verrouillage par compte (Cahier §16 : limitation des tentatives)", () => {
  beforeAll(async () => { (await import("../src/core/security.js")).resetIpRateLimits(); });
  it("après 10 échecs, le compte est verrouillé même avec le bon mot de passe ; même réponse pour un compte inconnu", async () => {
    for (let i = 0; i < 10; i++) {
      const r = await h.api.post("/api/v1/auth/login")
        .send({ email: "jean@example.org", password: `Mauvais-pass-${i}` });
      expect(r.body.error.code).toBe("INVALID_CREDENTIALS");
    }
    const locked = await h.api.post("/api/v1/auth/login").send({ email: "jean@example.org", password: "Troisieme-Pass-2026" });
    expect(locked.status).toBe(429);
    expect(locked.body.error.code).toBe("ACCOUNT_TEMPORARILY_LOCKED");
    // La limite par IP (20 / 15 min) est un mécanisme distinct : on l'isole ici.
    (await import("../src/core/security.js")).resetIpRateLimits();
    for (let i = 0; i < 10; i++) await h.api.post("/api/v1/auth/login").send({ email: "fantome@example.org", password: `Mauvais-pass-${i}` });
    expect((await h.api.post("/api/v1/auth/login").send({ email: "fantome@example.org", password: "x" })).body.error.code).toBe("ACCOUNT_TEMPORARILY_LOCKED");
    // Les autres comptes ne sont pas affectés.
    (await import("../src/core/security.js")).resetIpRateLimits();
    expect((await h.api.post("/api/v1/auth/login").send({ email: client.email, password: PASSWORD })).status).toBe(200);
    expect((await h.pool.query(`select count(*)::int n from audit.security_events where event_type = 'auth.login_locked'`)).rows[0].n).toBeGreaterThanOrEqual(2);
  });
});

describe("Devises : précision et taux (Cahier §9.4, Spéc. backend §16)", () => {
  it("les unités mineures du code sont celles du référentiel et des cinq pays", async () => {
    const { minorUnits } = await import("../src/core/money.js");
    const cur = (await h.pool.query(`select code, minor_units from shared.currencies order by code`)).rows;
    expect(cur.map((c: any) => c.code)).toEqual(["CAD", "CDF", "CNY", "EUR", "USD", "XAF"]);
    for (const c of cur) expect(minorUnits(c.code)).toBe(c.minor_units);
    const countries = (await h.pool.query(`select code, default_currency, default_timezone from shared.countries where is_operating order by code`)).rows;
    expect(countries).toEqual([
      { code: "CA", default_currency: "CAD", default_timezone: "America/Toronto" },
      { code: "CD", default_currency: "CDF", default_timezone: "Africa/Kinshasa" },
      { code: "CG", default_currency: "XAF", default_timezone: "Africa/Brazzaville" },
      { code: "CM", default_currency: "XAF", default_timezone: "Africa/Douala" },
      { code: "CN", default_currency: "CNY", default_timezone: "Asia/Shanghai" },
    ]);
  });

  it("un montant XAF avec décimales est refusé (plus d'arrondi silencieux) ; le solde reste cohérent", async () => {
    const bad = await h.api.post("/api/v1/canada/payments").set(await T(finCN)).set(h.idem())
      .send({ client_id: client.clientId, agency_id: w.cn, amount_due: "100.5", currency: "XAF", purpose: "service" });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe("AMOUNT_PRECISION");

    const pay = await h.api.post("/api/v1/canada/payments").set(await T(finCN)).set(h.idem())
      .send({ client_id: client.clientId, agency_id: w.cn, amount_due: "101", currency: "XAF", purpose: "service" });
    expect(pay.status).toBe(201);
    const id = pay.body.data.id;
    const frac = await h.api.post(`/api/v1/canada/payments/${id}/counter-receipts`).set(await T(finCN)).set(h.idem())
      .send({ amount: "100.5", currency: "XAF", method: "cash", receipt_reference: "XAF-1" });
    expect(frac.body.error.code).toBe("AMOUNT_PRECISION");
    const ok = await h.api.post(`/api/v1/canada/payments/${id}/counter-receipts`).set(await T(finCN)).set(h.idem())
      .send({ amount: "101", currency: "XAF", method: "cash", receipt_reference: "XAF-2" });
    expect(ok.body.data).toMatchObject({ amount_paid: "101", balance: "0", status: "succeeded" });
    const row = (await h.pool.query(`select amount_due, amount_paid, status from canada.payments where id = $1`, [id])).rows[0];
    expect(row).toEqual({ amount_due: "101.00", amount_paid: "101.00", status: "succeeded" });

    // La base refuse elle-même une transaction dans une autre devise que celle du paiement.
    await expect(h.pool.query(
      `insert into canada.payment_transactions(payment_id, kind, method, amount, currency, status, source, receipt_reference, recorded_by)
       values ($1, 'charge', 'cash', 5, 'USD', 'succeeded', 'counter_receipt', 'XAF-USD', $2)`, [id, finCN.id])).rejects.toThrow(/CURRENCY_MISMATCH/);
    await expect(h.pool.query(`insert into canada.refunds(payment_id, amount, currency, reason, requested_by) values ($1, 1, 'EUR', 'Essai devise', $2)`, [id, finCN.id]))
      .rejects.toThrow(/CURRENCY_MISMATCH/);

    const usd = await h.api.post("/api/v1/canada/payments").set(await T(finCN)).set(h.idem())
      .send({ client_id: client.clientId, agency_id: w.cn, amount_due: "10.005", currency: "USD", purpose: "service" });
    expect(usd.body.error.code).toBe("AMOUNT_PRECISION");
  });

  it("taux de change : jusqu'à 10 décimales, jamais nul", async () => {
    const at = new Date().toISOString();
    const fine = await h.api.post("/api/v1/canada/exchange-rates").set(await T(root))
      .send({ base_currency: "CDF", quote_currency: "USD", rate: "0.0003571429", effective_at: at, source: "BCC" });
    expect(fine.status).toBe(201);
    expect(fine.body.data.rate).toBe("0.0003571429");
    const zero = await h.api.post("/api/v1/canada/exchange-rates").set(await T(root))
      .send({ base_currency: "CDF", quote_currency: "EUR", rate: "0.0000", effective_at: at, source: "BCC" });
    expect(zero.status).toBe(400);
  });

  it("devis : un colis d'un autre client ou une demande d'un autre client ne peut pas y figurer", async () => {
    const agent = await h.makeUser("agent.quote@ta.test", { roles: [{ role: "canada_agency_manager", scope_type: "agency", scope_id: w.cn }] });
    const stranger = await h.makeUser("stranger.money@ta.test", { roles: [{ role: "canada_client", scope_type: "own" }], client: { residence: "CD" } });
    const mk = async (clientId: string) => {
      const r = await h.api.post("/api/v1/canada/parcels").set(await T(agent)).set(h.idem())
        .send({ client_id: clientId, recipient_name: "Famille", origin_country: "CN", destination_country: "CD", origin_agency_id: w.cn, destination_agency_id: w.cd, received_now: true });
      expect(r.status).toBe(201);
      expect((await h.api.post(`/api/v1/canada/parcels/${r.body.data.id}/measurements`).set(await T(agent)).set(h.idem()).send({ actual_weight_kg: "3" })).status).toBe(201);
      return r.body.data.id as string;
    };
    const mine = await mk(client.clientId!);
    const theirs = await mk(stranger.clientId!);
    const base = { client_id: client.clientId, agency_id: w.cn, origin_country: "CN", destination_country: "CD", currency: "USD" };
    const bad = await h.api.post("/api/v1/canada/quotes").set(await T(agent)).set(h.idem()).send({ ...base, parcel_ids: [mine, theirs] });
    expect(bad.body.error.code).toBe("PARCEL_CLIENT_MISMATCH");
    const badLine = await h.api.post("/api/v1/canada/quotes").set(await T(agent)).set(h.idem()).send({ ...base,
      lines: [{ category: "handling", designation: "Manutention", quantity: "1", unit_price: "2", currency: "USD", parcel_id: theirs }] });
    expect(badLine.body.error.code).toBe("PARCEL_CLIENT_MISMATCH");
    const req = (await h.pool.query(
      `insert into canada.requests(reference, source, client_id, full_name, email, origin_country, destination_country)
       values ('RQ-T-OTHER', 'client_app', $1, 'Autre', 'autre@example.org', 'CN', 'CD') returning id`, [stranger.clientId])).rows[0].id;
    const badReq = await h.api.post("/api/v1/canada/quotes").set(await T(agent)).set(h.idem()).send({ ...base, parcel_ids: [mine], request_id: req });
    expect(badReq.body.error.code).toBe("REQUEST_CLIENT_MISMATCH");
    const ok = await h.api.post("/api/v1/canada/quotes").set(await T(agent)).set(h.idem()).send({ ...base, parcel_ids: [mine] });
    expect(ok.status).toBe(201);
    // Avis « devis émis » : échéance localisée dans le fuseau de l'agence (Chine), jamais une date UTC brute.
    expect((await h.api.post(`/api/v1/canada/quotes/${ok.body.data.id}/issue`).set(await T(agent)).set(h.idem())).status).toBe(200);
    await (await import("../src/modules/notifications/worker.js")).runWorkerOnce();
    const n = (await h.pool.query(`select body from shared.notifications where user_id = $1 and category = 'quote'`, [client.id])).rows[0];
    expect(n.body).toMatch(/\(UTC\+8, Asia\/Shanghai\)/);
    expect(n.body).not.toMatch(/\d{4}-\d{2}-\d{2}\./);
  });

  it("barème : frais minimum en XAF avec décimales refusés", async () => {
    const r = await h.api.post("/api/v1/canada/pricing-rules").set(await T(root))
      .send({ code: "CN-CM-AIR", origin_country: "CN", destination_country: "CM", transport_mode: "air", currency: "XAF",
        rate_per_kg: "4500", minimum_charge: "5000.50", service_fee: "0", volumetric_divisor: 6000, effective_from: new Date().toISOString() });
    expect(r.body.error.code).toBe("AMOUNT_PRECISION");
  });
});

describe("Idempotence : clés abandonnées et expirées", () => {
  it("une clé restée « en cours » après un arrêt du processus redevient utilisable après 5 minutes", async () => {
    const key = "stale-key-0001";
    const body = { client_id: client.clientId, agency_id: w.cn, amount_due: "15", currency: "USD", purpose: "service" };
    // Simule un arrêt brutal : clé réservée il y a 10 minutes, jamais terminée.
    const hash = "0".repeat(64);
    await h.pool.query(`insert into shared.idempotency_keys(principal_id, idempotency_key, method, route, request_hash, created_at)
                        values ($1, $2, 'POST', 'POST /api/v1/canada/payments', $3, now() - interval '10 minutes')`, [finCN.id, key, hash]);
    const r = await h.api.post("/api/v1/canada/payments").set(await T(finCN)).set("Idempotency-Key", key).send(body);
    expect(r.status).toBe(201);
    const replay = await h.api.post("/api/v1/canada/payments").set(await T(finCN)).set("Idempotency-Key", key).send(body);
    expect(replay.headers["idempotent-replayed"]).toBe("true");
    expect(replay.body.data.id).toBe(r.body.data.id);
  });

  it("une clé récente « en cours » reste protégée ; les clés expirées sont purgées par le worker", async () => {
    await h.pool.query(`insert into shared.idempotency_keys(principal_id, idempotency_key, method, route, request_hash)
                        values ($1, 'fresh-key-0001', 'POST', 'POST /api/v1/canada/payments', $2)`, [finCN.id, "1".repeat(64)]);
    const r = await h.api.post("/api/v1/canada/payments").set(await T(finCN)).set("Idempotency-Key", "fresh-key-0001")
      .send({ client_id: client.clientId, agency_id: w.cn, amount_due: "15", currency: "USD", purpose: "service" });
    expect(r.status).toBe(422); // empreinte différente : jamais d'exécution sous une clé déjà réservée
    await h.pool.query(`insert into shared.idempotency_keys(principal_id, idempotency_key, method, route, request_hash, expires_at)
                        values ($1, 'old-key-0001', 'POST', 'x', $2, now() - interval '1 hour')`, [finCN.id, "2".repeat(64)]);
    await (await import("../src/modules/notifications/worker.js")).runWorkerOnce();
    expect((await h.pool.query(`select count(*)::int n from shared.idempotency_keys where idempotency_key = 'old-key-0001'`)).rows[0].n).toBe(0);
  });
});

describe("Concurrence financière (verrouillage transactionnel)", () => {
  it("deux encaissements simultanés du solde complet : un seul aboutit, jamais de trop-perçu", async () => {
    const pay = await h.api.post("/api/v1/canada/payments").set(await T(finCN)).set(h.idem())
      .send({ client_id: client.clientId, agency_id: w.cn, amount_due: "50", currency: "USD", purpose: "service" });
    const id = pay.body.data.id;
    const tok = await T(finCN);
    const send = (ref: string) => h.api.post(`/api/v1/canada/payments/${id}/counter-receipts`).set(tok).set(h.idem())
      .send({ amount: "50", currency: "USD", method: "cash", receipt_reference: ref });
    const [a, b] = await Promise.all([send("CONC-A"), send("CONC-B")]);
    expect([a.status, b.status].sort()).toEqual([201, 409]); // le second trouve le paiement déjà soldé
    const row = (await h.pool.query(`select amount_paid, status from canada.payments where id = $1`, [id])).rows[0];
    expect(row).toEqual({ amount_paid: "50.00", status: "succeeded" });
    expect((await h.pool.query(`select count(*)::int n from canada.payment_transactions where payment_id = $1`, [id])).rows[0].n).toBe(1);
  });
});

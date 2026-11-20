import { readdirSync, readFileSync } from "node:fs";
import { extractMessages } from "../src/i18n/extract.js";
import { DB_RULES, EN } from "../src/i18n/en.js";
import { LABELS, negotiate } from "../src/i18n/index.js";
import { PASSWORD, setupHarness, type Harness } from "./support/harness.js";

describe("Complétude des traductions (preuve statique)", () => {
  it("chaque message utilisé dans le code a sa traduction anglaise", () => {
    const used = [...extractMessages("src")];
    expect(used.length).toBeGreaterThan(150);
    expect(used.filter((m) => !(m in EN))).toEqual([]);
  });

  it("chaque règle levée par la base a son message dans les deux langues", () => {
    const sql = readdirSync("supabase/migrations").map((f) => readFileSync(`supabase/migrations/${f}`, "utf8")).join("\n");
    const codes = [...new Set([...sql.matchAll(/raise exception '([A-Z_]+):/g)].map((m) => m[1]))];
    expect(codes.length).toBeGreaterThan(5);
    for (const c of codes) expect(DB_RULES[c], c).toMatchObject({ fr: expect.any(String), en: expect.any(String) });
  });

  it("chaque libellé de statut existe en français et en anglais", () => {
    for (const [domain, values] of Object.entries(LABELS)) {
      for (const [v, l] of Object.entries(values)) expect(l.fr && l.en, `${domain}.${v}`).toBeTruthy();
    }
    const sql = readFileSync("supabase/migrations/20261119000300_canada_logistics.sql", "utf8");
    const parcelStatuses = /status\s+varchar\(30\)[^]*?check \(status in \(([^)]*)\)\)/.exec(sql)![1].match(/'([a-z_]+)'/g)!.map((s) => s.slice(1, -1));
    expect(parcelStatuses.filter((s) => !LABELS.parcel_status[s])).toEqual([]);
  });

  it("négociation Accept-Language", () => {
    expect(negotiate("en-CA,en;q=0.9,fr;q=0.8")).toBe("en");
    expect(negotiate("de-DE,fr;q=0.5")).toBe("fr");
    expect(negotiate("zh-CN")).toBeNull();
    expect(negotiate(undefined)).toBeNull();
  });
});

describe("Langue des réponses et des notifications (API + PostgreSQL)", () => {
  let h: Harness;
  beforeAll(async () => { h = await setupHarness(); });
  afterAll(async () => { await h?.teardown(); });

  it("visiteur : français par défaut, anglais via Accept-Language", async () => {
    const fr = await h.api.get("/api/v1/public/tracking/TA-ZZZZZZZZ");
    expect(fr.body.error.message).toBe("Référence inconnue.");
    expect(fr.headers["content-language"]).toBe("fr");
    const en = await h.api.get("/api/v1/public/tracking/TA-ZZZZZZZZ").set("Accept-Language", "en-CA,en;q=0.9");
    expect(en.body.error.message).toBe("Unknown reference.");
    expect(en.body.meta.locale).toBe("en");
  });

  it("validation : messages de la bibliothèque et messages métier traduits", async () => {
    const r = await h.api.post("/api/v1/auth/register").set("Accept-Language", "en")
      .send({ first_name: "A", last_name: "B", email: "x@y.org", password: "abcdefghij", password_confirmation: "nope", accept_terms: true });
    expect(r.body.error.message).toBe("Invalid data.");
    const messages = r.body.error.details.map((d: any) => d.message);
    expect(messages).toEqual(expect.arrayContaining(["At least one digit"]));
    const fr = await h.api.post("/api/v1/auth/register").send({ email: "pas-un-email" });
    expect(fr.body.error.message).toBe("Données invalides.");
    expect(fr.body.error.details.some((d: any) => /Entrée invalide|Requis|requis/i.test(d.message))).toBe(true);
  });

  it("utilisateur : sa préférence enregistrée prime sur l'en-tête du navigateur", async () => {
    const u = await h.makeUser("anglo@ta.test", { language: "en", roles: [{ role: "canada_client", scope_type: "own" }], client: { residence: "CA" } });
    const r = await h.api.get(`/api/v1/me/parcels/00000000-0000-4000-8000-000000000000/tracking`).set(h.auth(await u.token())).set("Accept-Language", "fr");
    expect(r.status).toBe(404);
    expect(r.body.error.message).toBe("Parcel not found.");
    const fr = await h.makeUser("franco@ta.test", { roles: [{ role: "canada_client", scope_type: "own" }], client: { residence: "CD" } });
    const r2 = await h.api.get(`/api/v1/me/parcels/00000000-0000-4000-8000-000000000000/tracking`).set(h.auth(await fr.token())).set("Accept-Language", "en");
    expect(r2.body.error.message).toBe("Colis introuvable.");
    // Changement de langue par l'utilisateur, effectif immédiatement.
    await h.api.patch("/api/v1/identity/me").set(h.auth(await fr.token())).send({ preferred_language: "en" });
    const r3 = await h.api.get(`/api/v1/me/parcels/00000000-0000-4000-8000-000000000000/tracking`).set(h.auth(await fr.token()));
    expect(r3.body.error.message).toBe("Parcel not found.");
  });

  it("règle levée par la base traduite (historique non modifiable)", async () => {
    const { translate } = await import("../src/i18n/index.js");
    expect(translate("db:APPEND_ONLY", undefined, "en")).toBe("History cannot be modified.");
    expect(translate("Transition {p0} → {p1} interdite.", { p0: "a", p1: "b" }, "en")).toBe("Transition a → b is not allowed.");
  });

  it("référentiel /i18n : 5 pays opérants, français par défaut, libellés bilingues", async () => {
    const r = await h.api.get("/api/v1/i18n");
    expect(r.status).toBe(200);
    const operating = r.body.data.countries.filter((c: any) => c.is_operating);
    expect(operating.map((c: any) => c.code).sort()).toEqual(["CA", "CD", "CG", "CM", "CN"]);
    expect(operating.every((c: any) => c.default_locale === "fr" && c.supported_locales.includes("en"))).toBe(true);
    expect(r.body.data.labels.flight_status.CANCELLED).toEqual({ fr: "Annulé", en: "Cancelled" });
  });

  it("paramètres locaux : l'administrateur d'un pays modifie son pays, pas un autre", async () => {
    const admin = await h.makeUser("admin.cm.i18n@ta.test", { mfa: true, roles: [{ role: "canada_administrator", scope_type: "country", scope_country: "CM" }] });
    const ok = await h.api.patch("/api/v1/canada/countries/CM/settings").set(h.auth(await admin.token()))
      .send({ default_locale: "fr", supported_locales: ["fr", "en"], default_timezone: "Africa/Douala", reason: "Confirmation des paramètres" });
    expect(ok.status).toBe(200);
    const ko = await h.api.patch("/api/v1/canada/countries/CA/settings").set(h.auth(await admin.token()))
      .send({ default_locale: "en", reason: "Tentative hors périmètre" });
    expect(ko.status).toBe(403);
    const bad = await h.api.patch("/api/v1/canada/countries/CM/settings").set(h.auth(await admin.token()))
      .send({ default_locale: "en", supported_locales: ["fr"], reason: "Incohérent" });
    expect(bad.body.error.code).toBe("LOCALE_NOT_SUPPORTED");
  });

  it("notification : chaque destinataire la reçoit dans sa langue, avec date locale et devise", async () => {
    const w = await h.world();
    const agent = await h.makeUser("agent.i18n@ta.test", { roles: [{ role: "canada_agent", scope_type: "agency", scope_id: w.cn }] });
    const en = await h.makeUser("client.en@ta.test", { language: "en", roles: [{ role: "canada_client", scope_type: "own" }], client: { residence: "CD" } });
    const fr = await h.makeUser("client.fr@ta.test", { roles: [{ role: "canada_client", scope_type: "own" }], client: { residence: "CD" } });
    for (const c of [en, fr]) {
      const r = await h.api.post("/api/v1/canada/parcels").set(h.auth(await agent.token())).set(h.idem())
        .send({ client_id: c.clientId, recipient_name: "X", origin_country: "CN", destination_country: "CD", origin_agency_id: w.cn });
      expect(r.status).toBe(201);
    }
    const { runWorkerOnce } = await import("../src/modules/notifications/worker.js");
    await runWorkerOnce();
    const titles = async (uid: string) => (await h.pool.query(`select title from shared.notifications where user_id = $1 order by created_at`, [uid])).rows.map((r) => r.title);
    expect((await titles(en.id)).some((t) => /^Parcel TA-[A-Z0-9]+: Received$/.test(t))).toBe(true);
    expect((await titles(fr.id)).some((t) => /^Colis TA-[A-Z0-9]+ : Réceptionné$/.test(t))).toBe(true);
    const { formatMoney, formatDateTime } = await import("../src/i18n/index.js");
    expect(formatMoney("1234.5", "CAD", "fr", "CA")).toMatch(/1\s?234,50\s?CAD/);
    expect(formatMoney("1234.5", "USD", "en", "CA")).toMatch(/USD\s?1,234\.50/);
    expect(formatDateTime("2026-12-01T14:30:00Z", "Asia/Shanghai", "en", "CN")).toMatch(/10:30\s?PM.*UTC\+8, Asia\/Shanghai/);
    expect(formatDateTime("2026-12-01T14:30:00Z", "Asia/Shanghai", "fr", "CN")).toMatch(/22:30.*UTC\+8, Asia\/Shanghai/);
  });

  it("connexion d'un compte anglophone : contexte et messages en anglais", async () => {
    await h.makeUser("login.en@ta.test", { language: "en", roles: [{ role: "canada_client", scope_type: "own" }], client: { residence: "CA" } });
    const bad = await h.api.post("/api/v1/auth/login").set("Accept-Language", "en").send({ email: "login.en@ta.test", password: "wrong-password-1" });
    expect(bad.body.error.message).toBe("Invalid credentials.");
    const ok = await h.api.post("/api/v1/auth/login").send({ email: "login.en@ta.test", password: PASSWORD });
    expect(ok.status).toBe(200);
  });
});

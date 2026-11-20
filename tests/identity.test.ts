import { SignJWT } from "jose";
import { PASSWORD, setupHarness, type Harness } from "./support/harness.js";

let h: Harness;
beforeAll(async () => { h = await setupHarness(); });
afterAll(async () => { await h?.teardown(); });

const registration = (email: string) => ({
  first_name: "Amina", last_name: "Kabila", email, password: PASSWORD, password_confirmation: PASSWORD,
  country_of_residence: "CD", accept_terms: true, platform: "CANADA",
});

describe("Identité et authentification (Spéc. identité §7, §16)", () => {
  it("inscription commune → profil, accès Canada, rôle client, fiche client ; e-mail non vérifié bloqué", async () => {
    const r = await h.api.post("/api/v1/auth/register").send(registration("amina@example.org"));
    expect(r.status).toBe(202);
    expect(r.body.data.status).toBe("confirmation_required");

    const u = (await h.pool.query(`select id from auth.users where email = 'amina@example.org'`)).rows[0];
    const prof = (await h.pool.query(`select account_status from identity.profiles where id = $1`, [u.id])).rows[0];
    expect(prof.account_status).toBe("pending_verification");
    const roles = (await h.pool.query(`select r.code, ur.scope_type from access.user_roles ur join access.roles r on r.id = ur.role_id where ur.user_id = $1`, [u.id])).rows;
    expect(roles).toEqual([{ code: "canada_client", scope_type: "own" }]);
    expect((await h.pool.query(`select count(*)::int n from canada.clients where user_id = $1`, [u.id])).rows[0].n).toBe(1);

    const login = await h.api.post("/api/v1/auth/login").send({ email: "amina@example.org", password: PASSWORD });
    expect(login.status).toBe(403);
    expect(login.body.error.code).toBe("EMAIL_NOT_VERIFIED");
  });

  it("une seconde inscription avec le même e-mail ne crée aucune identité et répond à l'identique", async () => {
    const r = await h.api.post("/api/v1/auth/register").send(registration("amina@example.org"));
    expect(r.status).toBe(202);
    expect((await h.pool.query(`select count(*)::int n from auth.users where email = 'amina@example.org'`)).rows[0].n).toBe(1);
    expect((await h.pool.query(`select count(*)::int n from identity.profiles p join auth.users u on u.id = p.id where u.email = 'amina@example.org'`)).rows[0].n).toBe(1);
  });

  it("après vérification : connexion, activation du profil, contexte d'accès sans privilège", async () => {
    await h.pool.query(`update auth.users set email_confirmed_at = now() where email = 'amina@example.org'`);
    const login = await h.api.post("/api/v1/auth/login").send({ email: "amina@example.org", password: PASSWORD });
    expect(login.status).toBe(200);
    expect(login.body.data.context.roles).toEqual(["canada_client"]);
    expect(login.body.data.context.permissions).not.toContain("canada.parcels.read_scoped");
    const token = login.body.data.session.access_token;
    const me = await h.api.get("/api/v1/identity/me").set(h.auth(token));
    expect(me.status).toBe(200);
    expect(me.body.data.profile.account_status).toBe("active");
    expect(me.body.data.platforms).toEqual([{ code: "CANADA", access_status: "active" }]);
    expect(me.headers["x-correlation-id"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("mauvais mot de passe : message générique ; jeton falsifié ou expiré refusé", async () => {
    const bad = await h.api.post("/api/v1/auth/login").send({ email: "amina@example.org", password: "Wrong-pass-123" });
    expect(bad.status).toBe(401);
    expect(bad.body.error.code).toBe("INVALID_CREDENTIALS");
    const unknown = await h.api.post("/api/v1/auth/login").send({ email: "nobody@example.org", password: "Wrong-pass-123" });
    expect(unknown.body.error.code).toBe("INVALID_CREDENTIALS");

    const forged = await new SignJWT({ role: "authenticated", email: "x@y.z" }).setProtectedHeader({ alg: "HS256" })
      .setSubject("00000000-0000-4000-8000-000000000000").setAudience("authenticated").setExpirationTime("1h")
      .sign(new TextEncoder().encode("not-the-real-secret-not-the-real-secret"));
    const r = await h.api.get("/api/v1/identity/me").set(h.auth(forged));
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe("TOKEN_INVALID");
    expect((await h.api.get("/api/v1/identity/me")).status).toBe(401);
  });

  it("le profil ne permet ni de changer son statut ni ses rôles", async () => {
    const login = await h.api.post("/api/v1/auth/login").send({ email: "amina@example.org", password: PASSWORD });
    const token = login.body.data.session.access_token;
    const r = await h.api.patch("/api/v1/identity/me").set(h.auth(token)).send({ account_status: "active", roles: ["canada_administrator"] });
    expect(r.status).toBe(400);
    const ok = await h.api.patch("/api/v1/identity/me").set(h.auth(token)).send({ display_name: "Amina K." });
    expect(ok.status).toBe(200);
    expect(ok.body.data.profile.display_name).toBe("Amina K.");
  });

  it("déconnexion : la session est révoquée immédiatement ; le refresh fonctionne avant", async () => {
    const login = await h.api.post("/api/v1/auth/login").send({ email: "amina@example.org", password: PASSWORD });
    const { access_token, refresh_token } = login.body.data.session;
    const refreshed = await h.api.post("/api/v1/auth/refresh").send({ refresh_token });
    expect(refreshed.status).toBe(200);
    const out = await h.api.post("/api/v1/auth/logout").set(h.auth(access_token)).send({});
    expect(out.status).toBe(200);
    const after = await h.api.get("/api/v1/identity/me").set(h.auth(access_token));
    expect(after.status).toBe(401);
    expect(after.body.error.code).toBe("SESSION_REVOKED");
    const events = (await h.pool.query(`select event_type from audit.security_events where event_type like 'auth.%' order by occurred_at`)).rows.map((r) => r.event_type);
    expect(events).toEqual(expect.arrayContaining(["auth.registered", "auth.login_succeeded", "auth.login_failed", "auth.logout"]));
  });

  it("changement de mot de passe : ré-authentification exigée", async () => {
    const t = (await h.api.post("/api/v1/auth/login").send({ email: "amina@example.org", password: PASSWORD })).body.data.session.access_token;
    const wrong = await h.api.post("/api/v1/auth/change-password").set(h.auth(t)).send({ current_password: "nope-nope-1", new_password: "N3w-Password-ok" });
    expect(wrong.status).toBe(401);
    const ok = await h.api.post("/api/v1/auth/change-password").set(h.auth(t)).send({ current_password: PASSWORD, new_password: "N3w-Password-ok" });
    expect(ok.status).toBe(200);
    expect((await h.api.post("/api/v1/auth/login").send({ email: "amina@example.org", password: "N3w-Password-ok" })).status).toBe(200);
  });

  it("suspension de l'accès Canada : routes Canada refusées, identité commune intacte ; suspension globale bloque tout", async () => {
    const u = await h.makeUser("suspendu@example.org", { roles: [{ role: "canada_client", scope_type: "own" }], client: { residence: "CD" } });
    const t = await u.token();
    expect((await h.api.get("/api/v1/me/parcels").set(h.auth(t))).status).toBe(200);
    await h.pool.query(`update access.user_platform_access set access_status = 'suspended' where user_id = $1`, [u.id]);
    const blocked = await h.api.get("/api/v1/me/parcels").set(h.auth(t));
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe("PLATFORM_ACCESS_REQUIRED");
    expect((await h.api.get("/api/v1/identity/me").set(h.auth(t))).status).toBe(200);
    await h.pool.query(`update identity.profiles set account_status = 'suspended' where id = $1`, [u.id]);
    expect((await h.api.get("/api/v1/identity/me").set(h.auth(t))).body.error.code).toBe("ACCOUNT_NOT_ACTIVE");
  });

  it("validation stricte des entrées et en-têtes de sécurité", async () => {
    const r = await h.api.post("/api/v1/auth/register").send({ ...registration("weak@example.org"), password: "short", password_confirmation: "short" });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("VALIDATION_ERROR");
    const noTerms = await h.api.post("/api/v1/auth/register").send({ ...registration("weak@example.org"), accept_terms: false });
    expect(noTerms.status).toBe(400);
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    expect(r.headers["x-powered-by"]).toBeUndefined();
  });
});

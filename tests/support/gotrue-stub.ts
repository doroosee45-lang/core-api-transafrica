/**
 * DOUBLURE DE TEST de Supabase Auth (GoTrue) — tests uniquement.
 * Implémente le sous-ensemble d'API utilisé par le backend (signup, token password /
 * refresh_token, logout, recover, verify, resend, user, admin/users) sur les tables auth.* du
 * PostgreSQL de test, et signe des JWT HS256 comme un projet Supabase « legacy ».
 * Elle permet de tester le VRAI code d'intégration (supabase-js, vérification JWT,
 * contrôle de session) sans projet Supabase. Elle ne remplace pas une recette
 * sur un projet Supabase réel (voir docs/MIGRATION-PLAN.md).
 */
import { randomBytes, randomUUID } from "node:crypto";
import http from "node:http";
import bcrypt from "bcryptjs";
import { SignJWT, jwtVerify } from "jose";
import pg from "pg";

export interface StubOptions { pool: pg.Pool; jwtSecret: string; port: number; serviceKey: string }

export function startGoTrueStub(o: StubOptions) {
  const key = new TextEncoder().encode(o.jwtSecret);
  const base = `http://127.0.0.1:${o.port}`;
  const refresh = new Map<string, { sessionId: string; userId: string }>();
  // Doublure Supabase Storage (bucket privé) : objets en mémoire.
  const objects = new Map<string, { size: number; contentType: string | null; body: Buffer }>();
  const downloadTokens = new Map<string, string>();
  const uploadTokens = new Map<string, string>();
  // Liens e-mail ({{ .TokenHash }}) : usage unique, comme Supabase.
  const emailTokens = new Map<string, { userId: string; type: "signup" | "recovery" }>();
  const lastToken = new Map<string, string>();
  const newEmailToken = (userId: string, email: string, type: "signup" | "recovery") => {
    const th = randomBytes(20).toString("hex");
    emailTokens.set(th, { userId, type });
    lastToken.set(`${type}:${email}`, th);
    return th;
  };

  const sign = async (u: { id: string; email: string }, sessionId: string, aal = "aal1") =>
    new SignJWT({ email: u.email, role: "authenticated", aal, session_id: sessionId })
      .setProtectedHeader({ alg: "HS256" }).setSubject(u.id).setAudience("authenticated")
      .setIssuer(`${base}/auth/v1`).setIssuedAt().setExpirationTime("1h").sign(key);

  const userJson = (u: any) => ({
    id: u.id, aud: "authenticated", role: "authenticated", email: u.email, email_confirmed_at: u.email_confirmed_at,
    user_metadata: u.raw_user_meta_data ?? {}, app_metadata: {}, identities: [{ id: u.id, provider: "email" }],
    created_at: u.created_at, updated_at: u.updated_at,
  });

  async function session(u: any, aal = "aal1") {
    const s = await o.pool.query(`insert into auth.sessions(user_id, aal) values ($1, $2) returning id`, [u.id, aal]);
    const rt = randomBytes(24).toString("hex");
    refresh.set(rt, { sessionId: s.rows[0].id, userId: u.id });
    const access_token = await sign(u, s.rows[0].id, aal);
    return { access_token, token_type: "bearer", expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: rt, user: userJson(u) };
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", base);
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks);
    const isJson = (req.headers["content-type"] ?? "").includes("json");
    const body = raw.length && isJson ? JSON.parse(raw.toString("utf8")) : {};
    const send = (status: number, json?: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(json === undefined ? "" : JSON.stringify(json)); };
    const err = (status: number, code: string, msg: string) => send(status, { code: status, error_code: code, msg });
    const bearer = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : null;
    try {
      const st = /^\/storage\/v1\/object\/(upload\/sign|info|sign)\/([^/]+)\/(.+)$/.exec(url.pathname);
      // Téléchargement par lien signé (prise en charge de l'en-tête Range, comme Supabase Storage).
      if (st && st[1] === "sign" && req.method === "GET") {
        const key = downloadTokens.get(url.searchParams.get("token") ?? "");
        const obj = key && key === `${st[2]}/${decodeURIComponent(st[3])}` ? objects.get(key) : undefined;
        if (!obj) return err(400, "invalid_token", "Invalid signature");
        const m = /^bytes=(\d+)-(\d+)$/.exec((req.headers.range as string) ?? "");
        const part = m ? obj.body.subarray(Number(m[1]), Number(m[2]) + 1) : obj.body;
        res.writeHead(m ? 206 : 200, { "Content-Type": obj.contentType ?? "application/octet-stream" });
        return res.end(part);
      }
      if (st) {
        const [, op, bucketName, objectPath] = st;
        const key = `${bucketName}/${decodeURIComponent(objectPath)}`;
        if (op === "upload/sign" && req.method === "POST") {
          if (bearer !== o.serviceKey) return err(403, "unauthorized", "service role required");
          const tok = randomBytes(16).toString("hex");
          uploadTokens.set(tok, key);
          return send(200, { url: `/object/upload/sign/${bucketName}/${objectPath}?token=${tok}` });
        }
        if (op === "upload/sign" && req.method === "PUT") {
          const tok = url.searchParams.get("token") ?? "";
          if (uploadTokens.get(tok) !== key) return err(400, "invalid_token", "Invalid upload token");
          uploadTokens.delete(tok); // usage unique
          objects.set(key, { size: raw.length, contentType: (req.headers["content-type"] as string) ?? null, body: raw });
          return send(200, { Key: key });
        }
        if (op === "info" && req.method === "GET") {
          if (bearer !== o.serviceKey) return err(403, "unauthorized", "service role required");
          const obj = objects.get(key);
          if (!obj) { res.writeHead(404, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ statusCode: "404", error: "not_found", message: "Object not found" })); }
          return send(200, { id: key, name: objectPath, size: obj.size, content_type: obj.contentType, created_at: new Date().toISOString() });
        }
        if (op === "sign" && req.method === "POST") {
          if (bearer !== o.serviceKey) return err(403, "unauthorized", "service role required");
          if (!objects.has(key)) return err(404, "not_found", "Object not found");
          const dl = `dl-${randomBytes(8).toString("hex")}`;
          downloadTokens.set(dl, key);
          return send(200, { signedURL: `/object/sign/${bucketName}/${objectPath}?token=${dl}&exp=${body.expiresIn}` });
        }
      }
      if (req.method === "POST" && url.pathname === "/auth/v1/signup") {
        const email = String(body.email).toLowerCase();
        const exists = await o.pool.query(`select id from auth.users where email = $1`, [email]);
        // Comportement Supabase (confirmation activée) : réponse masquée, aucune identité créée.
        if (exists.rows[0]) return send(200, { id: randomUUID(), email, identities: [], user_metadata: {}, app_metadata: {}, aud: "authenticated" });
        const u = await o.pool.query(
          `insert into auth.users(email, encrypted_password, raw_user_meta_data) values ($1, $2, $3) returning *`,
          [email, await bcrypt.hash(body.password, 4), JSON.stringify(body.data ?? {})]);
        newEmailToken(u.rows[0].id, email, "signup");
        return send(200, userJson(u.rows[0]));
      }
      if (req.method === "POST" && url.pathname === "/auth/v1/token") {
        const grant = url.searchParams.get("grant_type");
        if (grant === "password") {
          const u = (await o.pool.query(`select * from auth.users where email = $1`, [String(body.email).toLowerCase()])).rows[0];
          if (!u || !(await bcrypt.compare(body.password, u.encrypted_password ?? ""))) return err(400, "invalid_credentials", "Invalid login credentials");
          if (!u.email_confirmed_at) return err(400, "email_not_confirmed", "Email not confirmed");
          return send(200, await session(u));
        }
        if (grant === "refresh_token") {
          const r = refresh.get(body.refresh_token);
          const alive = r && (await o.pool.query(`select 1 from auth.sessions where id = $1`, [r.sessionId])).rows[0];
          if (!r || !alive) return err(400, "refresh_token_not_found", "Invalid Refresh Token");
          refresh.delete(body.refresh_token);
          const u = (await o.pool.query(`select * from auth.users where id = $1`, [r.userId])).rows[0];
          const rt = randomBytes(24).toString("hex");
          refresh.set(rt, r);
          return send(200, { access_token: await sign(u, r.sessionId), token_type: "bearer", expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: rt, user: userJson(u) });
        }
        return err(400, "unsupported_grant_type", "unsupported");
      }
      if (req.method === "POST" && url.pathname === "/auth/v1/logout") {
        if (!bearer) return err(401, "no_authorization", "missing");
        const { payload } = await jwtVerify(bearer, key);
        if (url.searchParams.get("scope") === "global") await o.pool.query(`delete from auth.sessions where user_id = $1`, [payload.sub]);
        else await o.pool.query(`delete from auth.sessions where id = $1`, [payload.session_id]);
        return send(204);
      }
      if (req.method === "POST" && url.pathname === "/auth/v1/recover") {
        const email = String(body.email).toLowerCase();
        const u = (await o.pool.query(`select id from auth.users where email = $1`, [email])).rows[0];
        if (u) newEmailToken(u.id, email, "recovery");
        return send(200, {});
      }
      if (req.method === "POST" && url.pathname === "/auth/v1/resend") {
        const email = String(body.email).toLowerCase();
        const u = (await o.pool.query(`select id, email_confirmed_at from auth.users where email = $1`, [email])).rows[0];
        if (u && !u.email_confirmed_at && body.type === "signup") newEmailToken(u.id, email, "signup");
        return send(200, {});
      }
      if (req.method === "POST" && url.pathname === "/auth/v1/verify") {
        const tok = emailTokens.get(String(body.token_hash));
        const expected = body.type === "recovery" ? "recovery" : "signup";
        if (!tok || tok.type !== expected) return err(403, "otp_expired", "Token has expired or is invalid");
        emailTokens.delete(String(body.token_hash));
        const u = tok.type === "signup"
          ? (await o.pool.query(`update auth.users set email_confirmed_at = coalesce(email_confirmed_at, now()) where id = $1 returning *`, [tok.userId])).rows[0]
          : (await o.pool.query(`select * from auth.users where id = $1`, [tok.userId])).rows[0];
        return send(200, await session(u));
      }
      if (req.method === "PUT" && url.pathname === "/auth/v1/user") {
        const { payload } = await jwtVerify(bearer ?? "", key);
        const u = await o.pool.query(`update auth.users set encrypted_password = $2, updated_at = now() where id = $1 returning *`, [payload.sub, await bcrypt.hash(body.password, 4)]);
        return send(200, userJson(u.rows[0]));
      }
      if (req.method === "POST" && url.pathname === "/auth/v1/admin/users") {
        if (bearer !== o.serviceKey) return err(401, "not_admin", "service role required");
        const u = await o.pool.query(
          `insert into auth.users(email, encrypted_password, email_confirmed_at, raw_user_meta_data) values ($1,$2,$3,$4) returning *`,
          [String(body.email).toLowerCase(), body.password_hash ?? null, body.email_confirm ? new Date() : null, JSON.stringify(body.user_metadata ?? {})]);
        return send(200, userJson(u.rows[0]));
      }
      return err(404, "not_found", url.pathname);
    } catch (e: any) {
      if (e?.code === "23505") return err(422, "email_exists", "exists");
      return err(500, "stub_error", String(e?.message ?? e));
    }
  });

  return {
    url: base,
    listen: () => new Promise<void>((r) => server.listen(o.port, "127.0.0.1", () => r())),
    close: () => new Promise<void>((r) => server.close(() => r())),
    /** Dernier lien e-mail émis (ce que l'utilisateur recevrait dans sa boîte). */
    emailToken: (email: string, type: "signup" | "recovery") => lastToken.get(`${type}:${email.toLowerCase()}`) ?? null,
    /** Émet un jeton pour un utilisateur existant (ex. session MFA aal2). */
    issue: async (userId: string, aal: "aal1" | "aal2" = "aal1") => {
      const u = (await o.pool.query(`select * from auth.users where id = $1`, [userId])).rows[0];
      return (await session(u, aal)).access_token;
    },
  };
}

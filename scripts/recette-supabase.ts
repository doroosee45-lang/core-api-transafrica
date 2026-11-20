/**
 * RECETTE RÉELLE sur un projet Supabase de PRÉPRODUCTION (aucune doublure).
 *
 * Prérequis : Core API déployé et branché sur ce projet (migrations + seed appliqués),
 * bucket privé créé, MFA TOTP activée dans Auth, confirmation d'e-mail activée.
 *
 *   RECETTE_ENV=preproduction \
 *   RECETTE_API_URL=https://api-preprod.example/api/v1 \
 *   SUPABASE_URL=… SUPABASE_ANON_KEY=… SUPABASE_SERVICE_ROLE_KEY=… \
 *   RECETTE_EMAIL_DOMAIN=domaine-de-test-que-vous-controlez.example \
 *   STORAGE_BUCKET=canada-documents \
 *   npm run recette:supabase
 *
 * Les jetons d'e-mail sont obtenus par l'API d'administration Supabase (`generateLink`),
 * qui produit les MÊMES jetons que ceux envoyés par e-mail : le parcours testé est réel.
 * Comptes créés : `recette+<horodatage>-…@RECETTE_EMAIL_DOMAIN`, marqués `recette: true` ;
 * objet de test `recette/<horodatage>.pdf` dans le bucket. Rien n'est supprimé automatiquement.
 * Sortie : liste OK / ÉCHEC et code 1 si un contrôle échoue. Refuse de s'exécuter
 * sans RECETTE_ENV=preproduction.
 */
import { createHmac } from "node:crypto";
import bcrypt from "bcryptjs";
import { createClient } from "@supabase/supabase-js";

const need = ["RECETTE_API_URL", "SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY", "RECETTE_EMAIL_DOMAIN"];
const missing = need.filter((k) => !process.env[k]);
if (process.env.RECETTE_ENV !== "preproduction" || missing.length) {
  console.error(`Recette non lancée. RECETTE_ENV=preproduction requis${missing.length ? ` ; variables manquantes : ${missing.join(", ")}` : ""}.`);
  process.exit(2);
}
const API = process.env.RECETTE_API_URL!.replace(/\/$/, "");
const SB = process.env.SUPABASE_URL!.replace(/\/$/, "");
const admin = createClient(SB, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
const stamp = Date.now();
const email = (tag: string) => `recette+${stamp}-${tag}@${process.env.RECETTE_EMAIL_DOMAIN}`;
const PASSWORD = `Recette-${stamp}-a1`;
let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "OK    " : "ÉCHEC "} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};
async function call(method: string, path: string, body?: unknown, token?: string) {
  const r = await fetch(`${API}${path}`, {
    method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) as any };
}
/** TOTP RFC 6238 (SHA-1, 6 chiffres, 30 s) — pour valider un vrai facteur MFA Supabase. */
function totp(base32: string, at = Date.now()) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const c of base32.replace(/=+$/, "").toUpperCase()) bits += alphabet.indexOf(c).toString(2).padStart(5, "0");
  const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30000)));
  const h = createHmac("sha1", key).update(counter).digest();
  const o = h[h.length - 1] & 0xf;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

try {
  // 1. Signature des jetons
  const jwks = await fetch(`${SB}/auth/v1/.well-known/jwks.json`).then((r) => r.json()).catch(() => null);
  check("JWKS publié (clés asymétriques)", Array.isArray(jwks?.keys) && jwks.keys.length > 0,
    jwks?.keys?.length ? jwks.keys.map((k: any) => k.alg).join(",") : "projet HS256 legacy : SUPABASE_JWT_SECRET requis côté API");
  check("Core API joignable", (await call("GET", "/health")).status === 200);

  // 2. Inscription → vérification d'e-mail (jeton réel)
  const u1 = email("client");
  const reg = await call("POST", "/auth/register", { first_name: "Recette", last_name: "Client", email: u1, password: PASSWORD,
    password_confirmation: PASSWORD, country_of_residence: "CD", accept_terms: true, platform: "CANADA", preferred_language: "fr" });
  check("inscription", reg.status === 202, reg.body?.data?.status);
  check("connexion refusée avant vérification", (await call("POST", "/auth/login", { email: u1, password: PASSWORD })).body?.error?.code === "EMAIL_NOT_VERIFIED");
  const signupLink = await admin.auth.admin.generateLink({ type: "signup", email: u1, password: PASSWORD });
  const verify = await call("POST", "/auth/verify-email", { token_hash: signupLink.data.properties?.hashed_token, type: "signup" });
  check("vérification d'e-mail par jeton réel", verify.status === 200, verify.body?.error?.code);
  const login = await call("POST", "/auth/login", { email: u1, password: PASSWORD });
  check("connexion", login.status === 200);
  const token = login.body?.data?.session?.access_token;
  const me = await call("GET", "/identity/me", undefined, token);
  check("profil + rôle client uniquement", me.status === 200 && JSON.stringify(me.body.data.roles.map((r: any) => r.role)) === '["canada_client"]');
  check("mauvais mot de passe → message générique", (await call("POST", "/auth/login", { email: u1, password: "Faux-mot-2026" })).body?.error?.code === "INVALID_CREDENTIALS");

  // 3. Rafraîchissement et révocation de session
  const refreshed = await call("POST", "/auth/refresh", { refresh_token: login.body.data.session.refresh_token });
  check("refresh token", refreshed.status === 200);
  const t2 = refreshed.body?.data?.session?.access_token;
  check("déconnexion", (await call("POST", "/auth/logout", { scope: "local" }, t2)).status === 200);
  check("jeton de la session fermée refusé immédiatement", (await call("GET", "/identity/me", undefined, t2)).body?.error?.code === "SESSION_REVOKED");

  // 4. Mot de passe oublié → jeton réel → nouveau mot de passe
  check("demande de réinitialisation (anti-énumération)", (await call("POST", "/auth/forgot-password", { email: u1 })).status === 202
    && (await call("POST", "/auth/forgot-password", { email: email("inconnu") })).status === 202);
  const recovery = await admin.auth.admin.generateLink({ type: "recovery", email: u1 });
  const NEW = `${PASSWORD}-b2`;
  check("réinitialisation", (await call("POST", "/auth/reset-password", { token_hash: recovery.data.properties?.hashed_token, new_password: NEW })).status === 200);
  check("ancien mot de passe refusé", (await call("POST", "/auth/login", { email: u1, password: PASSWORD })).status === 401);
  const relog = await call("POST", "/auth/login", { email: u1, password: NEW });
  check("nouveau mot de passe accepté", relog.status === 200);

  // 5. MFA TOTP réelle (facteur Supabase) → session AAL2 vue par le Core API
  const user = createClient(SB, process.env.SUPABASE_ANON_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
  await user.auth.setSession({ access_token: relog.body.data.session.access_token, refresh_token: relog.body.data.session.refresh_token });
  const enroll = await user.auth.mfa.enroll({ factorType: "totp" });
  if (enroll.error) check("MFA TOTP activée dans le projet", false, enroll.error.message);
  else {
    const ch = await user.auth.mfa.challenge({ factorId: enroll.data.id });
    const vr = await user.auth.mfa.verify({ factorId: enroll.data.id, challengeId: ch.data!.id, code: totp(enroll.data.totp.secret) });
    const aal2 = vr.data?.access_token;
    const me2 = await call("GET", "/identity/me", undefined, aal2);
    check("session AAL2 reconnue par le Core API", me2.body?.data?.session?.aal === "aal2", vr.error?.message);
  }

  // 6. Reprise d'un compte existant : hash bcrypt de l'ancien backend
  const legacy = email("legacy");
  const created = await admin.auth.admin.createUser({ email: legacy, password_hash: await bcrypt.hash(PASSWORD, 10), email_confirm: true,
    user_metadata: { recette: true } } as any);
  check("création avec hash bcrypt hérité", !created.error, created.error?.message);
  const legacyLogin = await admin.auth.signInWithPassword({ email: legacy, password: PASSWORD });
  check("connexion avec l'ancien mot de passe (hash conservé)", !legacyLogin.error, legacyLogin.error?.message);

  // 7. Stockage des documents
  const bucket = await admin.storage.getBucket(process.env.STORAGE_BUCKET ?? "canada-documents");
  check("bucket documents existant et PRIVÉ (V-04)", !!bucket.data && bucket.data.public === false, bucket.error?.message);
  // Téléversement signé + lecture partielle (Range) : le contrôle de signature binaire du Core API en dépend.
  const store = admin.storage.from(process.env.STORAGE_BUCKET ?? "canada-documents");
  const objectPath = `recette/${stamp}.pdf`;
  const up = await store.createSignedUploadUrl(objectPath);
  const put = up.data ? await store.uploadToSignedUrl(objectPath, up.data.token, Buffer.from("%PDF-1.4 recette"), { contentType: "application/pdf" }) : null;
  check("téléversement par URL signée", !!put && !put.error, up.error?.message ?? put?.error?.message);
  const signed = await store.createSignedUrl(objectPath, 60);
  const part = signed.data ? await fetch(signed.data.signedUrl, { headers: { Range: "bytes=0-4" } }) : null;
  const head = part ? Buffer.from(await part.arrayBuffer()).toString("latin1") : "";
  check("lecture partielle (Range) des premiers octets", !!part && (part.status === 206 || part.status === 200) && head.startsWith("%PDF-"), `HTTP ${part?.status}`);
  const anonymous = await fetch(`${SB}/storage/v1/object/public/${process.env.STORAGE_BUCKET ?? "canada-documents"}/${objectPath}`);
  check("objet inaccessible sans lien signé", anonymous.status >= 400, `HTTP ${anonymous.status}`);
} catch (e) {
  check("exécution", false, (e as Error).message);
}
console.log(failures ? `\n${failures} contrôle(s) en échec : recette NON validée.` : "\nRecette Supabase : tous les contrôles sont OK.");
process.exit(failures ? 1 : 0);

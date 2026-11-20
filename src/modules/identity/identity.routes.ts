import { createHash } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { env } from "../../config/env.js";
import { securityEvent } from "../../core/audit.js";
import { db, one, withTransaction } from "../../core/db.js";
import { AppError, badRequest, t } from "../../core/errors.js";
import { clearFailures, isLockedOut, recordFailure } from "../../core/security.js";
import { mount, route } from "../../core/routes.js";
import { CountryCode, Email, Password } from "../../core/schemas.js";
import { allPermissions, loadPrincipal, rolesPendingMfa } from "../access/authorization.js";
import { authProvider } from "./authProvider.js";
import { verifySupabaseJwt } from "./jwt.js";
import { ensureCanadaClientProvisioned, getMe, grantCanadaClientAccess, updateMe } from "./identity.service.js";

const AUTH_LIMIT = { windowMs: 15 * 60_000, max: 20 };

const attemptKey = (email: string) => `auth:${createHash("sha256").update(email.toLowerCase()).digest("hex")}`;

/**
 * Vérifie un mot de passe en appliquant le verrouillage temporaire par compte.
 * Même comportement que le compte existe ou non (les échecs sont comptés par e-mail saisi).
 */
async function passwordCheck(email: string, password: string, req: import("express").Request) {
  const e = env();
  const key = attemptKey(email);
  const lock = isLockedOut(key, e.AUTH_MAX_FAILED_ATTEMPTS);
  if (lock.locked) {
    await securityEvent("auth.login_locked", { req });
    throw new AppError(429, "ACCOUNT_TEMPORARILY_LOCKED", "Trop d'échecs de connexion pour ce compte. Réessayez plus tard.", [{ retry_after_seconds: lock.retryAfterSec }]);
  }
  try {
    const session = await authProvider.signIn(email, password);
    clearFailures(key);
    return session;
  } catch (err) {
    if ((err as any)?.code === "INVALID_CREDENTIALS") recordFailure(key, e.AUTH_LOCKOUT_MINUTES * 60_000);
    throw err;
  }
}

const RegisterBody = z.object({
  first_name: z.string().trim().min(1).max(100),
  last_name: z.string().trim().min(1).max(100),
  email: Email,
  password: Password,
  password_confirmation: z.string(),
  country_of_residence: CountryCode.optional(),
  preferred_language: z.enum(["fr", "en"]).default("fr"),
  accept_terms: z.literal(true, { error: t("L'acceptation des conditions est obligatoire") }),
  platform: z.enum(["CANADA", "MARKET"]).default("CANADA"),
}).refine((b) => b.password === b.password_confirmation, { path: ["password_confirmation"], message: t("Les mots de passe diffèrent") });

/** Reprise : profil absent alors que l'identité Supabase existe (inscription interrompue). */
async function recoverProvisioning(userId: string, correlationId: string) {
  const u = await one(db, `select email, raw_user_meta_data as m from auth.users where id = $1`, [userId]);
  const m = u?.m ?? {};
  if (m.platform === "CANADA" && m.first_name && m.last_name) {
    await ensureCanadaClientProvisioned(userId, {
      firstName: m.first_name, lastName: m.last_name, country: m.country_of_residence ?? null,
      language: m.preferred_language, email: u.email,
    }, correlationId);
  }
}

async function sessionContext(accessToken: string, correlationId: string) {
  const claims = await verifySupabaseJwt(accessToken);
  let p = await loadPrincipal(db, claims);
  if (!p) { await recoverProvisioning(claims.sub, correlationId); p = await loadPrincipal(db, claims); }
  return {
    user_id: claims.sub,
    platform_access: p?.platformAccess ?? null,
    roles: p ? [...new Set(p.grants.map((g) => g.roleCode))] : [],
    permissions: p ? allPermissions(p) : [],
    roles_pending_mfa: p && p.aal !== "aal2" && env().AUTH_ENFORCE_MFA ? await rolesPendingMfa(db, claims.sub) : [],
  };
}

const routes = [
  route({
    method: "post", path: "/auth/register", tag: "Identité", auth: "public", rateLimit: AUTH_LIMIT,
    summary: "Inscription commune (compte Trans Afrique unique)",
    description: "Crée l'identité dans Supabase Auth puis, pour la plateforme CANADA, le profil, l'accès client et la fiche client. Réponse identique que l'adresse soit déjà connue ou non (anti-énumération).",
    body: RegisterBody,
    handler: async ({ body, req, correlationId }) => {
      if (body.platform !== "CANADA") {
        throw badRequest("PLATFORM_NOT_AVAILABLE", "L'inscription Market n'est pas encore disponible sur ce backend.");
      }
      const meta = {
        first_name: body.first_name, last_name: body.last_name, country_of_residence: body.country_of_residence ?? null,
        preferred_language: body.preferred_language, platform: body.platform,
      };
      const r = await authProvider.signUp(body.email, body.password, meta, `${env().APP_PUBLIC_URL}/auth/confirmed`);
      // identities = 0 : adresse déjà enregistrée (réponse masquée par Supabase) — rien n'est créé.
      if (r.userId && r.identities > 0) {
        await ensureCanadaClientProvisioned(r.userId, {
          firstName: body.first_name, lastName: body.last_name, country: body.country_of_residence,
          language: body.preferred_language, email: body.email,
        }, correlationId);
        await securityEvent("auth.registered", { userId: r.userId, req, metadata: { platform: "CANADA" } });
      }
      return { status: 202, data: { status: r.session ? "registered" : "confirmation_required", session: r.session } };
    },
  }),
  route({
    method: "post", path: "/auth/login", tag: "Identité", auth: "public", rateLimit: AUTH_LIMIT,
    summary: "Connexion e-mail + mot de passe (Supabase Auth)",
    body: z.object({ email: Email, password: z.string().min(1).max(128) }),
    handler: async ({ body, req, correlationId }) => {
      try {
        const session = await passwordCheck(body.email, body.password, req);
        const ctx = await sessionContext(session.access_token, correlationId);
        await securityEvent("auth.login_succeeded", { userId: ctx.user_id, req });
        return { data: { session, context: ctx } };
      } catch (err) {
        await securityEvent("auth.login_failed", { req, metadata: { code: (err as any)?.code ?? "UNKNOWN" } });
        throw err;
      }
    },
  }),
  route({
    method: "post", path: "/auth/refresh", tag: "Identité", auth: "public", rateLimit: { windowMs: 60_000, max: 60 },
    summary: "Renouvellement de session (refresh token Supabase)",
    body: z.object({ refresh_token: z.string().min(10).max(2000) }),
    handler: async ({ body }) => ({ data: { session: await authProvider.refresh(body.refresh_token) } }),
  }),
  route({
    method: "post", path: "/auth/logout", tag: "Identité", auth: "user",
    summary: "Déconnexion (session courante ou tous les appareils)",
    body: z.object({ scope: z.enum(["local", "global"]).default("local") }),
    handler: async ({ req, body, principal }) => {
      await authProvider.signOut(req.header("authorization")!.slice(7), body.scope);
      await securityEvent("auth.logout", { userId: principal.userId, req, metadata: { scope: body.scope } });
      return { data: { logged_out: true } };
    },
  }),
  route({
    method: "post", path: "/auth/forgot-password", tag: "Identité", auth: "public", rateLimit: { windowMs: 15 * 60_000, max: 5 },
    summary: "Demande de réinitialisation (réponse identique que le compte existe ou non)",
    body: z.object({ email: Email }),
    handler: async ({ body, req }) => {
      await authProvider.recover(body.email, `${env().APP_PUBLIC_URL}/auth/reset-password`);
      await securityEvent("auth.password_reset_requested", { req });
      return { status: 202, data: { status: "if_account_exists_email_sent" } };
    },
  }),
  route({
    method: "post", path: "/auth/reset-password", tag: "Identité", auth: "public", rateLimit: { windowMs: 15 * 60_000, max: 10 },
    summary: "Finaliser la réinitialisation du mot de passe (lien reçu par e-mail)",
    description: "Le lien de l'e-mail Supabase « Reset password » transmet `token_hash`. Le jeton est à usage unique ; la session de récupération est fermée après le changement : l'utilisateur se reconnecte avec son nouveau mot de passe.",
    body: z.object({ token_hash: z.string().trim().min(10).max(500), new_password: Password }),
    handler: async ({ body, req }) => {
      const recovery = await authProvider.verifyEmailToken(body.token_hash, "recovery");
      const claims = await verifySupabaseJwt(recovery.access_token);
      await authProvider.updatePassword(recovery.access_token, body.new_password);
      await authProvider.signOut(recovery.access_token, "local");
      if (claims.email) clearFailures(attemptKey(claims.email));
      await securityEvent("auth.password_reset_completed", { userId: claims.sub, req });
      return { data: { reset: true } };
    },
  }),
  route({
    method: "post", path: "/auth/verify-email", tag: "Identité", auth: "public", rateLimit: { windowMs: 15 * 60_000, max: 20 },
    summary: "Confirmer l'adresse e-mail (lien d'inscription) et ouvrir la session",
    body: z.object({ token_hash: z.string().trim().min(10).max(500), type: z.enum(["signup", "email"]).default("email") }),
    handler: async ({ body, req, correlationId }) => {
      const session = await authProvider.verifyEmailToken(body.token_hash, body.type);
      const ctx = await sessionContext(session.access_token, correlationId);
      await securityEvent("auth.email_verified", { userId: ctx.user_id, req });
      return { data: { session, context: ctx } };
    },
  }),
  route({
    method: "post", path: "/auth/resend-verification", tag: "Identité", auth: "public", rateLimit: { windowMs: 15 * 60_000, max: 5 },
    summary: "Renvoyer l'e-mail de vérification (réponse identique que le compte existe ou non)",
    body: z.object({ email: Email }),
    handler: async ({ body, req }) => {
      await authProvider.resendSignupConfirmation(body.email, `${env().APP_PUBLIC_URL}/auth/confirmed`);
      await securityEvent("auth.verification_resent", { req });
      return { status: 202, data: { status: "if_account_pending_email_sent" } };
    },
  }),
  route({
    method: "post", path: "/auth/change-password", tag: "Identité", auth: "user", rateLimit: AUTH_LIMIT,
    summary: "Changement de mot de passe (ré-authentification exigée)",
    body: z.object({ current_password: z.string().min(1), new_password: Password }),
    handler: async ({ body, req, principal }) => {
      if (!principal.email) throw badRequest("EMAIL_UNKNOWN", "Adresse de connexion introuvable.");
      // Vérification récente de l'identité ; la session ouverte pour ce contrôle est aussitôt fermée.
      const check = await passwordCheck(principal.email, body.current_password, req);
      await authProvider.signOut(check.access_token, "local");
      await authProvider.updatePassword(req.header("authorization")!.slice(7), body.new_password);
      await securityEvent("auth.password_changed", { userId: principal.userId, req });
      return { data: { changed: true } };
    },
  }),
  route({
    method: "get", path: "/identity/me", tag: "Identité", auth: "user",
    summary: "Profil commun, plateformes, rôles et permissions effectives",
    handler: async ({ principal }) => ({
      data: {
        ...(await getMe(db, principal.userId)),
        roles: principal.grants.map((g) => ({ role: g.roleCode, scope_type: g.scopeType, scope_id: g.scopeId, scope_country: g.scopeCountry })),
        permissions: allPermissions(principal),
        session: { aal: principal.aal },
        roles_pending_mfa: principal.aal !== "aal2" && env().AUTH_ENFORCE_MFA ? await rolesPendingMfa(db, principal.userId) : [],
      },
    }),
  }),
  route({
    method: "patch", path: "/identity/me", tag: "Identité", auth: "user",
    summary: "Mise à jour du profil commun (le statut et les rôles ne sont jamais modifiables ici)",
    body: z.strictObject({
      first_name: z.string().trim().min(1).max(100).optional(),
      last_name: z.string().trim().min(1).max(100).optional(),
      display_name: z.string().trim().max(160).nullable().optional(),
      preferred_language: z.enum(["fr", "en"]).optional(),
    }),
    handler: async ({ body, principal, correlationId }) => ({ data: await updateMe(db, principal.userId, body, correlationId) }),
  }),
  route({
    method: "post", path: "/identity/me/platforms/canada/activate", tag: "Identité", auth: "user",
    summary: "Activer l'accès client Canada pour un compte existant (sans second compte)",
    handler: async ({ principal, correlationId }) => {
      const existing = await one(db, `select access_status from access.user_platform_access where user_id = $1 and platform_id = 1`, [principal.userId]);
      if (existing && existing.access_status !== "active") {
        throw badRequest("PLATFORM_ACCESS_BLOCKED", "Accès Canada suspendu ou révoqué : contactez le support.");
      }
      await withTransaction((tx) => grantCanadaClientAccess(tx, principal.userId,
        { firstName: principal.firstName, lastName: principal.lastName, email: principal.email }, correlationId));
      return { data: await getMe(db, principal.userId) };
    },
  }),
];

export function identityRouter() {
  const r = Router();
  mount(r, routes);
  return r;
}

import type { NextFunction, Request, Response } from "express";
import { securityEvent } from "../../core/audit.js";
import { db } from "../../core/db.js";
import { AppError, forbidden, unauthorized } from "../../core/errors.js";
import { loadPrincipal } from "../access/authorization.js";
import { verifySupabaseJwt } from "./jwt.js";

/**
 * Chaîne d'authentification (Spéc. identité §7.3, §10.2) :
 * JWT vérifié → session non révoquée → compte non banni → profil →
 * e-mail vérifié → statut global actif → accès à la plateforme Canada.
 */
export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  try {
    const header = req.header("authorization");
    if (!header?.startsWith("Bearer ")) throw unauthorized();
    let claims;
    try {
      claims = await verifySupabaseJwt(header.slice(7).trim());
    } catch {
      throw unauthorized("TOKEN_INVALID", "Jeton invalide ou expiré.");
    }

    const auth = await db.query(
      `select u.email_confirmed_at, u.banned_until,
              ($2::uuid is null or exists (select 1 from auth.sessions s where s.id = $2::uuid)) as session_alive
         from auth.users u where u.id = $1`,
      [claims.sub, claims.session_id ?? null],
    );
    const a = auth.rows[0];
    if (!a) throw unauthorized("TOKEN_INVALID", "Jeton invalide ou expiré.");
    if (!a.session_alive) throw unauthorized("SESSION_REVOKED", "Session terminée : reconnectez-vous.");
    if (a.banned_until && new Date(a.banned_until) > new Date()) throw forbidden("ACCOUNT_BANNED", "Compte bloqué.");
    if (!a.email_confirmed_at) throw forbidden("EMAIL_NOT_VERIFIED", "Adresse e-mail non vérifiée.");

    let principal = await loadPrincipal(db, claims);
    if (!principal) throw forbidden("PROFILE_MISSING", "Profil Trans Afrique introuvable.");

    // Activation du profil à la première requête après vérification de l'e-mail.
    if (principal.accountStatus === "pending_verification") {
      await db.query(
        `update identity.profiles set account_status = 'active' where id = $1 and account_status = 'pending_verification'`,
        [principal.userId],
      );
      await securityEvent("account.activated", { userId: principal.userId, req });
      principal = { ...principal, accountStatus: "active" };
    }
    if (principal.accountStatus !== "active") {
      throw forbidden("ACCOUNT_NOT_ACTIVE", "Compte suspendu ou restreint.");
    }
    req.principal = principal;
    next();
  } catch (err) {
    next(err);
  }
}

/** L'accès à la plateforme Canada doit être actif (une suspension Market n'a aucun effet ici). */
export function requireCanadaAccess(req: Request, _res: Response, next: NextFunction) {
  const p = req.principal;
  if (!p) return next(unauthorized());
  if (p.platformAccess !== "active") {
    return next(new AppError(403, "PLATFORM_ACCESS_REQUIRED", "Accès à Trans Afrique Canada non actif pour ce compte."));
  }
  next();
}

import type { NextFunction, Request, Response } from "express";
import { AppError } from "./errors.js";

/** En-têtes de sécurité HTTP (repris du backend existant, conservé). */
export function securityHeaders(req: Request, res: Response, next: NextFunction) {
  res.removeHeader("X-Powered-By");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
  res.setHeader("Cross-Origin-Resource-Policy", "same-site");
  res.setHeader("Cache-Control", "no-store");
  if (req.secure) res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  next();
}

/**
 * Limitation de débit en mémoire (fenêtre fixe par IP + clé).
 * Suffisant pour une instance ; au-delà, remplacer le stockage (Redis) — décision
 * à prendre selon le mode d'hébergement (Spéc. backend §30 : pas de Redis sans besoin mesuré).
 */
const buckets = new Map<string, { count: number; resetAt: number }>();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of buckets) if (v.resetAt <= now) buckets.delete(k);
  for (const [k, v] of failures) if (v.resetAt <= now) failures.delete(k);
}, 60_000).unref();

export function rateLimit(opts: { key: string; windowMs: number; max: number }) {
  return (req: Request, res: Response, next: NextFunction) => {
    // req.ip respecte TRUST_PROXY : X-Forwarded-For n'est jamais lu directement (anti-usurpation).
    const k = `${opts.key}:${req.ip ?? "unknown"}`;
    const now = Date.now();
    let b = buckets.get(k);
    if (!b || b.resetAt <= now) { b = { count: 0, resetAt: now + opts.windowMs }; buckets.set(k, b); }
    b.count++;
    res.setHeader("RateLimit-Limit", String(opts.max));
    res.setHeader("RateLimit-Remaining", String(Math.max(0, opts.max - b.count)));
    if (b.count > opts.max) {
      res.setHeader("Retry-After", String(Math.ceil((b.resetAt - now) / 1000)));
      return next(new AppError(429, "RATE_LIMITED", "Trop de requêtes. Réessayez plus tard."));
    }
    next();
  };
}

/**
 * Échecs d'authentification par COMPTE (Cahier §16 « limitation des tentatives de
 * connexion ») : complète la limite par IP, qu'un attaquant contourne en changeant
 * d'adresse. Clé = empreinte de l'e-mail normalisé (aucune adresse en mémoire en clair).
 */
const failures = new Map<string, { count: number; resetAt: number }>();
export function isLockedOut(key: string, max: number): { locked: boolean; retryAfterSec: number } {
  const f = failures.get(key);
  const now = Date.now();
  if (!f || f.resetAt <= now) return { locked: false, retryAfterSec: 0 };
  return { locked: f.count >= max, retryAfterSec: Math.ceil((f.resetAt - now) / 1000) };
}
export function recordFailure(key: string, windowMs: number) {
  const now = Date.now();
  let f = failures.get(key);
  if (!f || f.resetAt <= now) { f = { count: 0, resetAt: now + windowMs }; failures.set(key, f); }
  f.count++;
}
export function clearFailures(key: string) { failures.delete(key); }

/** Tests : vide les compteurs par IP sans toucher aux verrouillages par compte. */
export function resetIpRateLimits() { buckets.clear(); }

export function resetRateLimits() { buckets.clear(); failures.clear(); }

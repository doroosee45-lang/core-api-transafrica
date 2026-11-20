import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import { requestLocale, translate } from "../i18n/index.js";
import { securityEvent } from "./audit.js";
import { AppError, fromPgError, t } from "./errors.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Identifiant de corrélation : repris de l'en-tête s'il est valide, sinon généré. */
export function correlation(req: Request, res: Response, next: NextFunction) {
  const incoming = req.header("x-correlation-id");
  req.correlationId = incoming && UUID_RE.test(incoming) ? incoming : randomUUID();
  res.setHeader("X-Correlation-Id", req.correlationId);
  next();
}

export interface Pagination { page: number; limit: number; total: number; pages: number }

export const PageQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export function notFoundHandler(req: Request, res: Response) {
  const locale = requestLocale(req);
  res.setHeader("Content-Language", locale);
  res.status(404).json({
    success: false,
    error: { code: "ROUTE_NOT_FOUND", message: translate(t("Route introuvable."), undefined, locale), details: [] },
    meta: { correlation_id: req.correlationId, locale },
  });
}

export function errorHandler(err: any, req: Request, res: Response, _next: NextFunction) {
  const locale = requestLocale(req);
  let appErr: AppError;
  if (err instanceof AppError) appErr = err;
  else if (err instanceof z.ZodError) {
    // Messages Zod déjà localisés (table d'erreurs par requête) ; messages personnalisés traduits par catalogue.
    appErr = new AppError(400, "VALIDATION_ERROR", "Données invalides.",
      err.issues.map((i) => ({ path: i.path.join("."), code: i.code, message: translate(i.message, undefined, locale) })));
  } else if (err?.type === "entity.parse.failed") {
    appErr = new AppError(400, "INVALID_JSON", "Corps JSON invalide.");
  } else if (err?.type === "entity.too.large") {
    appErr = new AppError(413, "PAYLOAD_TOO_LARGE", "Requête trop volumineuse.");
  } else {
    appErr = fromPgError(err) ?? new AppError(500, "INTERNAL_ERROR", "Erreur interne du serveur.");
  }
  if (appErr.status === 403) {
    // Tout refus d'autorisation est tracé (Dossier 05 scénario F, Dossier 03 §13).
    void securityEvent("access.denied", { userId: req.principal?.userId ?? null, req,
      metadata: { code: appErr.code, method: req.method, route: `${req.baseUrl}${req.route?.path ?? ""}` } });
  }
  if (appErr.status >= 500) {
    // Jamais de message brut ni de pile : codes uniquement (pas de secrets, pas de données personnelles).
    console.error(`[api] ${req.method} ${req.route?.path ?? "?"} échec; code=${err?.code ?? err?.name ?? "UNKNOWN"}; correlation=${req.correlationId}`);
  }
  res.setHeader("Content-Language", locale);
  res.status(appErr.status).json({
    success: false,
    error: { code: appErr.code, message: translate(appErr.template, appErr.params, locale), details: appErr.details },
    meta: { correlation_id: req.correlationId, locale },
  });
}

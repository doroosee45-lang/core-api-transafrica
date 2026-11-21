/**
 * REGISTRE DE ROUTES — une seule déclaration sert à la fois :
 *   1. au montage Express (validation, authentification, permission, idempotence) ;
 *   2. à la génération du contrat OpenAPI (Dossier 04 §9.5).
 * Une route ne peut donc pas exister sans être documentée, ni être documentée
 * avec une permission différente de celle réellement contrôlée.
 */
import { createHash } from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response, Router } from "express";
import { z } from "zod";
import { db, type Db, withTransaction } from "./db.js";
import { AppError, badRequest, conflict, forbidden, unprocessable } from "./errors.js";
import { rateLimit } from "./security.js";
import { requestLocale, zodErrorMap, type Locale } from "../i18n/index.js";
import { holds, type Principal } from "../modules/access/authorization.js";
import { authenticate, requireCanadaAccess } from "../modules/identity/authenticate.js";

type Method = "get" | "post" | "put" | "patch" | "delete";

export interface Ctx<B, Q, P> {
  req: Request;
  res: Response;
  body: B;
  query: Q;
  params: P;
  principal: Principal;
  correlationId: string;
  locale: Locale;
  /** Transaction shared with route work for atomic idempotency-sensitive operations. */
  transaction?: Db;
}

export interface Result {
  status?: number; data?: unknown; meta?: Record<string, unknown>;
  /** Réponse non JSON (export CSV) : jamais combinée à l'idempotence. */
  file?: { contentType: string; filename: string; body: string };
}

export interface RouteDef<B extends z.ZodType = z.ZodType, Q extends z.ZodType = z.ZodType, P extends z.ZodType = z.ZodType> {
  method: Method;
  path: string;
  tag: string;
  summary: string;
  description?: string;
  /** public | user (authentifié, sans exigence de plateforme) | canada (accès Canada actif) */
  auth: "public" | "user" | "canada";
  /** Contrôle grossier : au moins une des permissions détenue à un périmètre quelconque. */
  anyPermission?: string[];
  /** Exige l'en-tête Idempotency-Key (opérations sensibles, Spéc. backend §26). */
  idempotent?: boolean;
  /** Atomically persist the idempotency result with business writes for routes that receive `ctx.transaction`. */
  atomicIdempotency?: boolean;
  rateLimit?: { windowMs: number; max: number };
  body?: B;
  query?: Q;
  params?: P;
  handler: (ctx: Ctx<z.infer<B>, z.infer<Q>, z.infer<P>>) => Promise<Result>;
}

export const registry: RouteDef<any, any, any>[] = [];

export function route<B extends z.ZodType = z.ZodType, Q extends z.ZodType = z.ZodType, P extends z.ZodType = z.ZodType>(
  def: RouteDef<B, Q, P>,
): RouteDef<B, Q, P> {
  return def;
}

const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_.:-]{8,200}$/;

function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${stableStringify((v as any)[k])}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

type IdempotentResult = { status: number; body: unknown; file?: Result["file"] };

class AtomicServerResponse {
  constructor(readonly result: IdempotentResult) {}
}

async function withIdempotency(
  req: Request,
  res: Response,
  run: (transaction?: Db) => Promise<IdempotentResult>,
  atomic = false,
): Promise<IdempotentResult> {
  const key = req.header("idempotency-key");
  if (!key || !IDEMPOTENCY_KEY_RE.test(key)) {
    throw badRequest("IDEMPOTENCY_KEY_REQUIRED", "En-tête Idempotency-Key requis (8 à 200 caractères).");
  }
  const principalId = req.principal?.userId ?? "00000000-0000-0000-0000-000000000000";
  const routeKey = `${req.method} ${req.baseUrl}${req.route?.path ?? req.path}`;
  const hash = createHash("sha256").update(`${routeKey}|${stableStringify(req.params)}|${stableStringify(req.body ?? {})}`).digest("hex");

  if (atomic) {
    try {
      return await withTransaction(async (tx) => {
        // Expire only completed results. A committed `in_progress` row is legacy/ambiguous;
        // it must be reconciled rather than silently re-executed.
        await tx.query(
          `delete from shared.idempotency_keys where principal_id = $1 and idempotency_key = $2
             and status = 'completed' and expires_at < now()`, [principalId, key],
        );
        const claimed = await tx.query(
          `insert into shared.idempotency_keys(principal_id, idempotency_key, method, route, request_hash)
           values ($1, $2, $3, $4, $5) on conflict (principal_id, idempotency_key) do nothing returning id`,
          [principalId, key, req.method, routeKey, hash],
        );
        if (!claimed.rows[0]) {
          const prev = (await tx.query(
            `select request_hash, status, response_status, response_body, route from shared.idempotency_keys
              where principal_id = $1 and idempotency_key = $2 for update`, [principalId, key],
          )).rows[0];
          if (!prev || prev.request_hash !== hash || prev.route !== routeKey) {
            throw unprocessable("IDEMPOTENCY_KEY_REUSED", "Cette clé d'idempotence a déjà servi pour une autre requête.");
          }
          if (prev.status === "in_progress") throw conflict("IDEMPOTENCY_IN_PROGRESS", "Requête identique en cours ou état à réconcilier.");
          res.setHeader("Idempotent-Replayed", "true");
          return { status: prev.response_status, body: prev.response_body };
        }

        const out = await run(tx);
        if (out.status >= 500) throw new AtomicServerResponse(out);
        await tx.query(
          `update shared.idempotency_keys set status = 'completed', response_status = $3, response_body = $4
            where principal_id = $1 and idempotency_key = $2`,
          [principalId, key, out.status, JSON.stringify(out.body)],
        );
        return out;
      });
    } catch (err) {
      if (err instanceof AtomicServerResponse) return err.result;
      // The claim, business changes and response record share one transaction. On an
      // uncertain COMMIT, retry observes either the completed row or no row at all.
      throw err;
    }
  }

  // Clé expirée (24 h) ou abandonnée « en cours » depuis plus de 5 minutes (arrêt du processus) : libérée.
  await db.query(
    `delete from shared.idempotency_keys where principal_id = $1 and idempotency_key = $2
        and (expires_at < now() or (status = 'in_progress' and created_at < now() - interval '5 minutes'))`,
    [principalId, key],
  );
  const claimed = await db.query(
    `insert into shared.idempotency_keys(principal_id, idempotency_key, method, route, request_hash)
     values ($1, $2, $3, $4, $5) on conflict (principal_id, idempotency_key) do nothing returning id`,
    [principalId, key, req.method, routeKey, hash],
  );
  if (!claimed.rows[0]) {
    const prev = (await db.query(
      `select request_hash, status, response_status, response_body, route from shared.idempotency_keys
        where principal_id = $1 and idempotency_key = $2`, [principalId, key])).rows[0];
    if (prev.request_hash !== hash || prev.route !== routeKey) {
      throw unprocessable("IDEMPOTENCY_KEY_REUSED", "Cette clé d'idempotence a déjà servi pour une autre requête.");
    }
    if (prev.status === "in_progress") throw conflict("IDEMPOTENCY_IN_PROGRESS", "Requête identique en cours de traitement.");
    res.setHeader("Idempotent-Replayed", "true");
    return { status: prev.response_status, body: prev.response_body };
  }
  try {
    const out = await run();
    if (out.status < 500) {
      await db.query(
        `update shared.idempotency_keys set status = 'completed', response_status = $3, response_body = $4
          where principal_id = $1 and idempotency_key = $2`,
        [principalId, key, out.status, JSON.stringify(out.body)],
      );
    } else {
      await db.query(`delete from shared.idempotency_keys where principal_id = $1 and idempotency_key = $2`, [principalId, key]);
    }
    return out;
  } catch (err) {
    // Échec : la clé est libérée pour permettre une nouvelle tentative contrôlée.
    await db.query(`delete from shared.idempotency_keys where principal_id = $1 and idempotency_key = $2`, [principalId, key]);
    throw err;
  }
}

export function mount(router: Router, defs: RouteDef<any, any, any>[]) {
  for (const def of defs) {
    registry.push(def);
    const chain: RequestHandler[] = [];
    if (def.rateLimit) chain.push(rateLimit({ key: `${def.method}:${def.path}`, ...def.rateLimit }));
    if (def.auth !== "public") chain.push(authenticate);
    if (def.auth === "canada") chain.push(requireCanadaAccess);
    if (def.anyPermission?.length) {
      chain.push((req, _res, next) => {
        const p = req.principal!;
        if (!def.anyPermission!.some((perm) => holds(p, perm))) return next(forbidden("PERMISSION_REQUIRED", "Permission requise pour cette action."));
        next();
      });
    }
    chain.push(async (req: Request, res: Response, next: NextFunction) => {
      try {
        const locale = requestLocale(req);
        const zctx = { error: zodErrorMap(locale) };
        const body = def.body ? def.body.parse(req.body ?? {}, zctx) : undefined;
        const query = def.query ? def.query.parse(req.query ?? {}, zctx) : undefined;
        const params = def.params ? def.params.parse(req.params ?? {}, zctx) : undefined;
        const exec = async (transaction?: Db) => {
          const r = await def.handler({ req, res, body, query, params, principal: req.principal as Principal, correlationId: req.correlationId, locale, transaction });
          if (r.file) return { status: r.status ?? 200, body: undefined, file: r.file };
          const status = r.status ?? 200;
          return { status, body: { success: true, data: r.data ?? null, meta: { correlation_id: req.correlationId, ...(r.meta ?? {}) } } };
        };
        if (def.atomicIdempotency && !def.idempotent) throw new Error(`Route ${def.method.toUpperCase()} ${def.path} enables atomicIdempotency without idempotent=true.`);
        const out: { status: number; body: unknown; file?: Result["file"] } = def.idempotent
          ? await withIdempotency(req, res, exec, def.atomicIdempotency)
          : await exec();
        res.setHeader("Content-Language", locale);
        if (out.file) {
          res.setHeader("Content-Type", out.file.contentType);
          res.setHeader("Content-Disposition", `attachment; filename="${out.file.filename.replace(/[^\w.-]/g, "_")}"`);
          res.status(out.status).send(out.file.body);
          return;
        }
        res.status(out.status).json(out.body);
      } catch (err) {
        next(err);
      }
    });
    (router as any)[def.method](def.path, ...chain);
  }
}

export type { Db };

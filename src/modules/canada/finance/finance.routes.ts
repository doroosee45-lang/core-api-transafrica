import { Router } from "express";
import { z } from "zod";
import { db, one, withTransaction } from "../../../core/db.js";
import { audit } from "../../../core/audit.js";
import { conflict, notFound, unprocessable } from "../../../core/errors.js";
import { PageQuery } from "../../../core/http.js";
import { mount, route } from "../../../core/routes.js";
import { assertAmountPrecision } from "../../../core/money.js";
import { CountryCode, CurrencyCode, ExchangeRateValue, IdParams, Money, ParcelCategory, Reason, TransportMode } from "../../../core/schemas.js";
import { assertCan, GLOBAL_RESOURCE, isEmptyScope, scopeClause, scopeFilter } from "../../access/authorization.js";
import { paginate } from "../common.js";
import { cancelQuote, createQuote, issueQuote, loadQuote, quoteDetail, quoteResource, reviseQuote } from "./quote.service.js";
import { cancelPayment, createPayment, decideRefund, executeRefund, loadPayment, paymentResource, recordCounterReceipt, requestRefund } from "./payment.service.js";

const Line = z.object({
  category: z.enum(["purchase", "transport", "service", "handling", "insurance", "customs", "delivery", "other"]),
  designation: z.string().trim().min(2).max(240), quantity: Money, unit_price: Money, currency: CurrencyCode,
  parcel_id: z.uuid().nullable().optional(),
});
const Method = z.enum(["cash", "mobile_money", "bank_transfer", "card", "cheque"]);

const routes = [
  // ---------------- Taux de change ----------------
  route({
    method: "get", path: "/canada/exchange-rates", tag: "Finance", auth: "canada", anyPermission: ["canada.pricing.read", "canada.exchange_rates.manage"],
    summary: "Historique des taux publiés", query: z.object({ base: CurrencyCode.optional(), quote: CurrencyCode.optional() }),
    handler: async ({ query }) => ({ data: (await db.query(
      `select * from canada.exchange_rates where ($1::text is null or base_currency = $1::text) and ($2::text is null or quote_currency = $2::text)
        order by effective_at desc limit 200`, [query.base ?? null, query.quote ?? null])).rows }),
  }),
  route({
    method: "post", path: "/canada/exchange-rates", tag: "Finance", auth: "canada", anyPermission: ["canada.exchange_rates.manage"],
    summary: "Publier un taux daté et sourcé (jamais de modification rétroactive)",
    body: z.object({ base_currency: CurrencyCode, quote_currency: CurrencyCode, rate: ExchangeRateValue, effective_at: z.iso.datetime({ offset: true }), source: z.string().trim().min(2).max(120) }),
    handler: async ({ body, principal, correlationId }) => {
      assertCan(principal, "canada.exchange_rates.manage", GLOBAL_RESOURCE);
      if (body.base_currency === body.quote_currency) throw unprocessable("RATE_PAIR_INVALID", "Devises identiques.");
      return withTransaction(async (tx) => {
        const r = await one(tx, `insert into canada.exchange_rates(base_currency, quote_currency, rate, effective_at, source, created_by)
                                 values ($1,$2,$3,$4,$5,$6) returning *`, [body.base_currency, body.quote_currency, body.rate, body.effective_at, body.source, principal.userId]);
        await audit(tx, { actorUserId: principal.userId, action: "canada.exchange_rate.published", resourceType: "exchange_rate", resourceId: r.id, next: r, correlationId });
        return { status: 201, data: r };
      });
    },
  }),
  // ---------------- Barèmes ----------------
  route({
    method: "get", path: "/canada/pricing-rules", tag: "Finance", auth: "canada", anyPermission: ["canada.pricing.read"],
    summary: "Barèmes (toutes versions)",
    handler: async () => ({ data: (await db.query(`select * from canada.pricing_rules order by code, version desc`)).rows }),
  }),
  route({
    method: "post", path: "/canada/pricing-rules", tag: "Finance", auth: "canada", anyPermission: ["canada.pricing.manage"],
    summary: "Créer une version de barème (brouillon)",
    body: z.object({
      code: z.string().trim().regex(/^[A-Z0-9_-]{3,60}$/), origin_country: CountryCode, destination_country: CountryCode,
      transport_mode: TransportMode, category: ParcelCategory.nullable().optional(), currency: CurrencyCode,
      rate_per_kg: Money, minimum_charge: Money.default("0"), service_fee: Money.default("0"),
      volumetric_divisor: z.number().int().min(1000).max(10000), effective_from: z.iso.datetime({ offset: true }),
    }),
    handler: async ({ body, principal, correlationId }) => {
      assertCan(principal, "canada.pricing.manage", GLOBAL_RESOURCE);
      assertAmountPrecision(body.minimum_charge, body.currency, "minimum_charge");
      assertAmountPrecision(body.service_fee, body.currency, "service_fee");
      return withTransaction(async (tx) => {
        const v = await one(tx, `select coalesce(max(version), 0) + 1 as v from canada.pricing_rules where code = $1`, [body.code]);
        const r = await one(tx,
          `insert into canada.pricing_rules(code, version, origin_country, destination_country, transport_mode, category, currency, rate_per_kg,
             minimum_charge, service_fee, volumetric_divisor, effective_from, created_by)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning *`,
          [body.code, v.v, body.origin_country, body.destination_country, body.transport_mode, body.category ?? null, body.currency,
           body.rate_per_kg, body.minimum_charge, body.service_fee, body.volumetric_divisor, body.effective_from, principal.userId]);
        await audit(tx, { actorUserId: principal.userId, action: "canada.pricing_rule.drafted", resourceType: "pricing_rule", resourceId: r.id, next: r, correlationId });
        return { status: 201, data: r };
      });
    },
  }),
  route({
    method: "post", path: "/canada/pricing-rules/:id/activate", tag: "Finance", auth: "canada", anyPermission: ["canada.pricing.manage"],
    summary: "Activer une version (la version active précédente du même code est retirée)", params: IdParams,
    handler: async ({ params, principal, correlationId }) => {
      assertCan(principal, "canada.pricing.manage", GLOBAL_RESOURCE);
      return withTransaction(async (tx) => {
        const r = await one(tx, `select * from canada.pricing_rules where id = $1 for update`, [params.id]);
        if (!r) throw notFound("PRICING_RULE_NOT_FOUND", "Barème introuvable.");
        if (r.status !== "draft") throw conflict("INVALID_STATE", "Seul un brouillon peut être activé.");
        await tx.query(`update canada.pricing_rules set status = 'retired', effective_to = greatest($2::timestamptz, effective_from + interval '1 second')
                         where code = $1 and status = 'active'`, [r.code, r.effective_from]);
        await tx.query(`update canada.pricing_rules set status = 'active', activated_by = $2, activated_at = now() where id = $1`, [r.id, principal.userId]);
        await audit(tx, { actorUserId: principal.userId, action: "canada.pricing_rule.activated", resourceType: "pricing_rule", resourceId: r.id, correlationId });
        return { data: await one(tx, `select * from canada.pricing_rules where id = $1`, [r.id]) };
      });
    },
  }),
  // ---------------- Devis ----------------
  route({
    method: "get", path: "/canada/quotes", tag: "Devis", auth: "canada", anyPermission: ["canada.quotes.read_scoped"],
    summary: "Devis du périmètre", query: PageQuery,
    handler: async ({ query, principal }) => {
      const f = scopeFilter(principal, ["canada.quotes.read_scoped"]);
      if (isEmptyScope(f)) return { data: [], meta: paginate(query.page, query.limit, 0) };
      const params: unknown[] = [];
      const where = scopeClause(f, { countries: ["q.origin_country", "q.destination_country"], agencies: ["q.agency_id"] }, params);
      const total = (await db.query(`select count(*)::int n from canada.quotations q where ${where}`, params)).rows[0].n;
      const rows = (await db.query(
        `select q.id, q.reference, q.client_id, q.origin_country, q.destination_country, q.agency_id, q.current_version,
                v.status, v.total, v.currency, v.valid_until, q.created_at
           from canada.quotations q join canada.quotation_versions v on v.quotation_id = q.id and v.version = q.current_version
          where ${where} order by q.created_at desc limit ${query.limit} offset ${(query.page - 1) * query.limit}`, params)).rows;
      return { data: rows, meta: paginate(query.page, query.limit, total) };
    },
  }),
  route({
    method: "post", path: "/canada/quotes", tag: "Devis", auth: "canada", anyPermission: ["canada.quotes.create"], idempotent: true,
    summary: "Préparer un devis (lignes calculées depuis les colis pesés et le barème actif, ou saisies)",
    body: z.object({
      client_id: z.uuid(), agency_id: z.uuid(), origin_country: CountryCode, destination_country: CountryCode,
      request_id: z.uuid().nullable().optional(), currency: CurrencyCode, parcel_ids: z.array(z.uuid()).max(200).default([]),
      lines: z.array(Line).max(100).default([]), conditions: z.string().trim().max(4000).nullable().optional(),
      valid_days: z.number().int().min(1).max(90).default(14),
    }),
    handler: async ({ body, principal, correlationId }) => ({ status: 201, data: await createQuote(principal, body, correlationId) }),
  }),
  route({
    method: "get", path: "/canada/quotes/:id", tag: "Devis", auth: "canada", anyPermission: ["canada.quotes.read_scoped"],
    summary: "Devis et toutes ses versions", params: IdParams,
    handler: async ({ params, principal }) => {
      const q = await loadQuote(db, params.id);
      assertCan(principal, "canada.quotes.read_scoped", quoteResource(q));
      return { data: await quoteDetail(db, q) };
    },
  }),
  route({
    method: "post", path: "/canada/quotes/:id/revisions", tag: "Devis", auth: "canada", anyPermission: ["canada.quotes.update_draft"], idempotent: true,
    summary: "Remplacer le brouillon ou créer une nouvelle version", params: IdParams,
    body: z.object({ currency: CurrencyCode.optional(), parcel_ids: z.array(z.uuid()).max(200).default([]), lines: z.array(Line).max(100).default([]),
      conditions: z.string().trim().max(4000).nullable().optional(), valid_days: z.number().int().min(1).max(90).default(14), reason: z.string().trim().max(1000).optional() }),
    handler: async ({ params, body, principal, correlationId }) => ({ data: await reviseQuote(principal, params.id, body, correlationId) }),
  }),
  route({
    method: "post", path: "/canada/quotes/:id/issue", tag: "Devis", auth: "canada", anyPermission: ["canada.quotes.issue"], idempotent: true,
    summary: "Émettre officiellement la version courante", params: IdParams,
    handler: async ({ params, principal, correlationId }) => ({ data: await issueQuote(principal, params.id, correlationId) }),
  }),
  route({
    method: "post", path: "/canada/quotes/:id/cancel", tag: "Devis", auth: "canada", anyPermission: ["canada.quotes.cancel"],
    summary: "Annuler la version courante (impossible si déjà payée)", params: IdParams, body: z.object({ reason: Reason }),
    handler: async ({ params, body, principal, correlationId }) => ({ data: await cancelQuote(principal, params.id, body.reason, correlationId) }),
  }),
  // ---------------- Paiements ----------------
  route({
    method: "get", path: "/canada/payments", tag: "Paiements", auth: "canada", anyPermission: ["canada.payments.read_scoped"],
    summary: "Paiements du périmètre (montants par devise, jamais additionnés entre devises)", query: PageQuery.extend({ status: z.string().max(30).optional() }),
    handler: async ({ query, principal }) => {
      const f = scopeFilter(principal, ["canada.payments.read_scoped"]);
      if (isEmptyScope(f)) return { data: [], meta: paginate(query.page, query.limit, 0) };
      const params: unknown[] = [];
      let where = scopeClause(f, { countries: ["a.country_code"], agencies: ["p.agency_id"] }, params);
      if (query.status) { params.push(query.status); where += ` and p.status = $${params.length}`; }
      const total = (await db.query(`select count(*)::int n from canada.payments p join canada.agencies a on a.id = p.agency_id where ${where}`, params)).rows[0].n;
      const rows = (await db.query(
        `select p.* from canada.payments p join canada.agencies a on a.id = p.agency_id where ${where}
          order by p.created_at desc limit ${query.limit} offset ${(query.page - 1) * query.limit}`, params)).rows;
      return { data: rows, meta: paginate(query.page, query.limit, total) };
    },
  }),
  route({
    method: "post", path: "/canada/payments", tag: "Paiements", auth: "canada", anyPermission: ["canada.payments.create"], idempotent: true,
    summary: "Créer une demande de paiement (obligation financière identifiée)",
    body: z.object({ client_id: z.uuid(), agency_id: z.uuid(), amount_due: Money, currency: CurrencyCode,
      purpose: z.enum(["logistics", "goods", "service", "insurance", "balance", "other"]), due_date: z.iso.date().nullable().optional(),
      quotation_version_id: z.uuid().nullable().optional() }),
    handler: async ({ body, principal, correlationId }) => ({ status: 201, data: await createPayment(principal, body, correlationId) }),
  }),
  route({
    method: "get", path: "/canada/payments/:id", tag: "Paiements", auth: "canada", anyPermission: ["canada.payments.read_scoped"],
    summary: "Paiement, transactions et remboursements", params: IdParams,
    handler: async ({ params, principal }) => {
      const p = await loadPayment(db, params.id);
      assertCan(principal, "canada.payments.read_scoped", paymentResource(p));
      const [tx, refunds] = await Promise.all([
        db.query(`select id, kind, method, amount, currency, status, source, receipt_reference, occurred_at from canada.payment_transactions where payment_id = $1 order by occurred_at`, [p.id]),
        db.query(`select * from canada.refunds where payment_id = $1 order by requested_at`, [p.id]),
      ]);
      return { data: { ...p, client_user_id: undefined, transactions: tx.rows, refunds: refunds.rows } };
    },
  }),
  route({
    method: "post", path: "/canada/payments/:id/counter-receipts", tag: "Paiements", auth: "canada", anyPermission: ["canada.payments.verify"], idempotent: true,
    summary: "Enregistrer un encaissement au guichet (reçu obligatoire, unique, audité)", params: IdParams,
    body: z.object({ amount: Money, currency: CurrencyCode, method: Method, receipt_reference: z.string().trim().min(3).max(120),
      occurred_at: z.iso.datetime({ offset: true }).nullable().optional(), note: z.string().trim().max(1000).nullable().optional() }),
    handler: async ({ params, body, principal, correlationId }) => ({ status: 201, data: await recordCounterReceipt(principal, params.id, body, correlationId) }),
  }),
  route({
    method: "post", path: "/canada/payments/:id/cancel", tag: "Paiements", auth: "canada", anyPermission: ["canada.payments.reconcile"],
    summary: "Annuler une demande sans encaissement", params: IdParams, body: z.object({ reason: Reason }),
    handler: async ({ params, body, principal, correlationId }) => ({ data: await cancelPayment(principal, params.id, body.reason, correlationId) }),
  }),
  route({
    method: "post", path: "/canada/payments/:id/refunds", tag: "Paiements", auth: "canada", anyPermission: ["canada.refunds.request"], idempotent: true,
    summary: "Demander un remboursement", params: IdParams, body: z.object({ amount: Money, reason: Reason }),
    handler: async ({ params, body, principal, correlationId }) => ({ status: 201, data: await requestRefund(principal, params.id, body, correlationId) }),
  }),
  route({
    method: "post", path: "/canada/refunds/:id/decision", tag: "Paiements", auth: "canada", anyPermission: ["canada.refunds.approve"],
    summary: "Approuver / rejeter (séparation des responsabilités)", params: IdParams,
    body: z.object({ decision: z.enum(["approve", "reject"]), note: z.string().trim().max(1000).nullable().optional() }),
    handler: async ({ params, body, principal, correlationId }) => ({ data: await decideRefund(principal, params.id, body.decision, body.note ?? null, correlationId) }),
  }),
  route({
    method: "post", path: "/canada/refunds/:id/execute", tag: "Paiements", auth: "canada", anyPermission: ["canada.refunds.execute"], idempotent: true,
    summary: "Exécuter un remboursement approuvé", params: IdParams,
    body: z.object({ method: Method, receipt_reference: z.string().trim().min(3).max(120) }),
    handler: async ({ params, body, principal, correlationId }) => ({ data: await executeRefund(principal, params.id, body, correlationId) }),
  }),
];

export function financeRouter() {
  const r = Router();
  mount(r, routes);
  return r;
}

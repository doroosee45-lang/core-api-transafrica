/**
 * Exports contrôlés (Dossier 03 §4.6, §4.9 ; Dossier 04 §14.4 « exports contrôlés ») :
 * filtrés par le périmètre de l'appelant, bornés dans le temps, eux-mêmes audités.
 * CSV RFC 4180 ; les cellules commençant par = + - @ sont neutralisées (injection de formules).
 */
import { Router } from "express";
import { z } from "zod";
import { audit } from "../../core/audit.js";
import { db } from "../../core/db.js";
import { t } from "../../core/errors.js";
import { mount, route } from "../../core/routes.js";
import { isEmptyScope, scopeClause, scopeFilter } from "../access/authorization.js";

const Period = z.object({ from: z.iso.datetime({ offset: true }), to: z.iso.datetime({ offset: true }) })
  .refine((p) => new Date(p.to) > new Date(p.from) && new Date(p.to).getTime() - new Date(p.from).getTime() <= 366 * 86_400_000,
    { message: t("Période invalide (366 jours maximum)") });

export function toCsv(columns: string[], rows: Record<string, unknown>[]) {
  const cell = (v: unknown) => {
    let s = v === null || v === undefined ? "" : v instanceof Date ? v.toISOString() : typeof v === "object" ? JSON.stringify(v) : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.join(","), ...rows.map((r) => columns.map((c) => cell(r[c])).join(","))].join("\r\n") + "\r\n";
}

const routes = [
  route({
    method: "get", path: "/canada/audit-events/export", tag: "Audit", auth: "canada", anyPermission: ["canada.audit.export"],
    summary: "Export CSV du journal d'audit du périmètre (période bornée)", query: Period,
    handler: async ({ query, principal, correlationId }) => {
      const f = scopeFilter(principal, ["canada.audit.export"]);
      const params: unknown[] = [query.from, query.to];
      const where = `occurred_at >= $1 and occurred_at < $2 and ${scopeClause(f, { countries: ["country_code"], agencies: ["agency_id"] }, params)}`;
      const rows = (await db.query(`select occurred_at, actor_user_id, actor_kind, action, resource_type, resource_id, country_code, agency_id, reason, correlation_id
                                      from audit.audit_events where ${where} order by occurred_at limit 100000`, params)).rows;
      await audit(db, { actorUserId: principal.userId, action: "canada.audit.exported", resourceType: "audit_events", next: { ...query, rows: rows.length }, correlationId });
      return { file: { contentType: "text/csv; charset=utf-8", filename: `audit-${query.from.slice(0, 10)}-${query.to.slice(0, 10)}.csv`,
        body: toCsv(["occurred_at", "actor_user_id", "actor_kind", "action", "resource_type", "resource_id", "country_code", "agency_id", "reason", "correlation_id"], rows) } };
    },
  }),
  route({
    method: "get", path: "/canada/financial-reports/payments/export", tag: "Rapports", auth: "canada", anyPermission: ["canada.financial_reports.export"],
    summary: "Export CSV des paiements et transactions du périmètre (montants par devise, jamais convertis)", query: Period,
    handler: async ({ query, principal, correlationId }) => {
      const f = scopeFilter(principal, ["canada.financial_reports.export"]);
      const columns = ["reference", "agency_code", "country_code", "client_number", "purpose", "currency", "amount_due", "amount_paid", "amount_refunded", "status", "created_at", "confirmed_at"];
      if (isEmptyScope(f)) return { file: { contentType: "text/csv; charset=utf-8", filename: "payments.csv", body: toCsv(columns, []) } };
      const params: unknown[] = [query.from, query.to];
      const where = `p.created_at >= $1 and p.created_at < $2 and ${scopeClause(f, { countries: ["a.country_code"], agencies: ["p.agency_id"] }, params)}`;
      const rows = (await db.query(
        `select p.reference, a.code as agency_code, a.country_code, c.client_number, p.purpose, p.currency, p.amount_due, p.amount_paid,
                p.amount_refunded, p.status, p.created_at, p.confirmed_at
           from canada.payments p join canada.agencies a on a.id = p.agency_id join canada.clients c on c.id = p.client_id
          where ${where} order by p.created_at limit 100000`, params)).rows;
      await audit(db, { actorUserId: principal.userId, action: "canada.financial_report.exported", resourceType: "payments", next: { ...query, rows: rows.length }, correlationId });
      return { file: { contentType: "text/csv; charset=utf-8", filename: `payments-${query.from.slice(0, 10)}-${query.to.slice(0, 10)}.csv`, body: toCsv(columns, rows) } };
    },
  }),
];

export function exportsRouter() {
  const r = Router();
  mount(r, routes);
  return r;
}

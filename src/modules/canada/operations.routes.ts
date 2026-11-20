/** Annonces générales, tableau de bord, journal d'audit (Cahier Modules 11 et 15, §3.2). */
import { Router } from "express";
import { z } from "zod";
import { db, one, withTransaction } from "../../core/db.js";
import { audit } from "../../core/audit.js";
import { emit } from "../../core/outbox.js";
import { PageQuery } from "../../core/http.js";
import { mount, route } from "../../core/routes.js";
import { CountryCode } from "../../core/schemas.js";
import { assertCan, GLOBAL_RESOURCE, scopeClause, scopeFilter, isEmptyScope, can } from "../access/authorization.js";
import { paginate } from "./common.js";

const routes = [
  route({
    method: "post", path: "/canada/notifications/announcements", tag: "Notifications", auth: "canada", anyPermission: ["canada.notifications.announce"], idempotent: true,
    summary: "Annonce générale (action distincte de la publication d'un vol ; e-mail aux seuls clients ayant consenti)",
    body: z.object({ title: z.string().trim().min(3).max(200), body: z.string().trim().min(3).max(4000), countries: z.array(CountryCode).min(1).max(10).nullable().optional(),
      // Version anglaise facultative : envoyée aux destinataires dont la langue préférée est l'anglais.
      translations: z.object({ en: z.object({ title: z.string().trim().min(3).max(200), body: z.string().trim().min(3).max(4000) }) }).optional() }),
    handler: async ({ body, principal, correlationId }) => {
      assertCan(principal, "canada.notifications.announce", body.countries ? { countries: body.countries } : GLOBAL_RESOURCE,
        "Annonce hors de votre périmètre (préciser vos pays).");
      for (const c of body.countries ?? []) assertCan(principal, "canada.notifications.announce", { countries: [c] });
      return withTransaction(async (tx) => {
        const c = await one(tx, `insert into shared.notification_campaigns(kind, title, body, audience, created_by) values ('announcement',$1,$2,$3,$4) returning id`,
          [body.title, body.body, JSON.stringify({ countries: body.countries ?? "all", translations: body.translations ?? {} }), principal.userId]);
        await emit(tx, { type: "canada.announcement.created", aggregateType: "campaign", aggregateId: c.id, correlationId, payload: { campaign_id: c.id, countries: body.countries ?? null } });
        await audit(tx, { actorUserId: principal.userId, action: "canada.announcement.created", resourceType: "campaign", resourceId: c.id, next: body, correlationId });
        return { status: 202, data: { campaign_id: c.id, status: "queued" } };
      });
    },
  }),
  route({
    method: "get", path: "/canada/reports/overview", tag: "Rapports", auth: "canada", anyPermission: ["canada.reports.read", "canada.financial_reports.read"],
    summary: "Tableau de bord du périmètre (montants ventilés par devise ; indicateurs techniques au niveau global)",
    handler: async ({ principal }) => {
      const f = scopeFilter(principal, ["canada.reports.read", "canada.financial_reports.read"]);
      if (isEmptyScope(f)) return { data: {} };
      const pp: unknown[] = [];
      const parcelScope = scopeClause(f, { countries: ["origin_country", "destination_country"], agencies: ["origin_agency_id", "destination_agency_id"], warehouses: ["current_warehouse_id"] }, pp);
      const sp: unknown[] = [];
      const shipScope = scopeClause(f, { countries: ["origin_country", "destination_country"], agencies: ["origin_agency_id", "destination_agency_id"] }, sp);
      const qp: unknown[] = [];
      const quoteScope = scopeClause(f, { countries: ["q.origin_country", "q.destination_country"], agencies: ["q.agency_id"] }, qp);
      const data: Record<string, unknown> = {
        scope: { global: f.global, countries: f.countries, agencies: f.agencyIds },
        parcels_by_status: (await db.query(`select status, count(*)::int n from canada.parcels where ${parcelScope} group by status order by status`, pp)).rows,
        parcels_by_country: (await db.query(`select origin_country, destination_country, count(*)::int n from canada.parcels where ${parcelScope} group by 1,2 order by 3 desc`, pp)).rows,
        shipments_by_status: (await db.query(`select status, count(*)::int n from canada.shipments where ${shipScope} group by status`, sp)).rows,
        // Les agrégats ne contournent pas l'isolation : vols des pays du périmètre uniquement.
        flights_by_status: (await db.query(
          `select f.status, count(*)::int n from canada.flights f join canada.airports da on da.iata_code = f.departure_airport
             join canada.airports aa on aa.iata_code = f.arrival_airport
            where $1::boolean or da.country_code = any($2::text[]) or aa.country_code = any($2::text[]) group by f.status`, [f.global, f.countries])).rows,
        // Cahier §12.1-12.3 : clients, agences, personnel et réclamations du périmètre (comptages directs).
        ...(await (async () => {
          const cp: unknown[] = [];
          const clientScope = scopeClause(f, { countries: ["residence_country"], agencies: ["home_agency_id"] }, cp);
          const ap: unknown[] = [];
          const agencyScope = scopeClause(f, { countries: ["country_code"], agencies: ["id"] }, ap);
          const rp: unknown[] = [];
          const staffScope = scopeClause(f, { countries: ["ur.scope_country", "a.country_code", "w.country_code"], agencies: ["a.id", "w.agency_id"], warehouses: ["w.id"] }, rp);
          const tp: unknown[] = [];
          const ticketScope = scopeClause(f, { countries: ["country_code"], agencies: ["agency_id"] }, tp);
          return {
            clients_count: (await db.query(`select count(*)::int n from canada.clients where status = 'active' and ${clientScope}`, cp)).rows[0].n,
            agencies_by_status: (await db.query(`select status, count(*)::int n from canada.agencies where ${agencyScope} group by status order by status`, ap)).rows,
            staff_by_role: (await db.query(
              `select r.code as role, count(distinct ur.user_id)::int n from access.user_roles ur join access.roles r on r.id = ur.role_id
                 left join canada.agencies a on ur.scope_type = 'agency' and a.id = ur.scope_id
                 left join canada.warehouses w on ur.scope_type = 'warehouse' and w.id = ur.scope_id
                where ur.revoked_at is null and (ur.expires_at is null or ur.expires_at > now()) and ur.scope_type <> 'own' and ${staffScope}
                group by r.code order by r.code`, rp)).rows,
            support_tickets_by_status: (await db.query(`select status, count(*)::int n from canada.support_tickets where ${ticketScope} group by status order by status`, tp)).rows,
          };
        })()),
        quotes_pending: (await db.query(`select count(*)::int n from canada.quotation_versions v join canada.quotations q on q.id = v.quotation_id and q.current_version = v.version
                                          where v.status in ('issued','viewed') and ${quoteScope}`, qp)).rows[0].n,
      };
      if (principal.grants.some((g) => g.permissions.has("canada.financial_reports.read"))) {
        const fp: unknown[] = [];
        const ff = scopeFilter(principal, ["canada.financial_reports.read"]);
        data.payments_by_currency = (await db.query(
          `select p.currency, p.status, count(*)::int n, sum(p.amount_paid - p.amount_refunded) as net_collected
             from canada.payments p join canada.agencies a on a.id = p.agency_id where ${scopeClause(ff, { countries: ["a.country_code"], agencies: ["p.agency_id"] }, fp)}
            group by 1,2 order by 1,2`, fp)).rows;
      }
      if (can(principal, "canada.reports.read", GLOBAL_RESOURCE)) {
        data.notification_failures = (await db.query(`select channel, status, count(*)::int n from shared.notification_deliveries where status in ('failed','bounced','complained','skipped') group by 1,2`)).rows;
        data.outbox = (await db.query(`select status, count(*)::int n from shared.outbox_events group by status`)).rows;
      }
      return { data };
    },
  }),
  route({
    method: "get", path: "/canada/audit-events", tag: "Audit", auth: "canada", anyPermission: ["canada.audit.read"],
    summary: "Journal d'audit (lecture seule ; périmètre pays pour un auditeur ou administrateur national)",
    query: PageQuery.extend({ resource_type: z.string().max(80).optional(), resource_id: z.string().max(80).optional() }),
    handler: async ({ query, principal }) => {
      const f = scopeFilter(principal, ["canada.audit.read"]);
      const params: unknown[] = [];
      let where = scopeClause(f, { countries: ["country_code"], agencies: ["agency_id"] }, params);
      if (query.resource_type) { params.push(query.resource_type); where += ` and resource_type = $${params.length}`; }
      if (query.resource_id) { params.push(query.resource_id); where += ` and resource_id = $${params.length}`; }
      const total = (await db.query(`select count(*)::int n from audit.audit_events where ${where}`, params)).rows[0].n;
      const rows = (await db.query(`select * from audit.audit_events where ${where} order by occurred_at desc limit ${query.limit} offset ${(query.page - 1) * query.limit}`, params)).rows;
      return { data: rows, meta: paginate(query.page, query.limit, total) };
    },
  }),
];

export function operationsRouter() {
  const r = Router();
  mount(r, routes);
  return r;
}

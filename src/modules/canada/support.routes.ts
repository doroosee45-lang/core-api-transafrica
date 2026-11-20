/**
 * Support et réclamations (Cahier Module 14, Spéc. backend §21).
 * Règle de périmètre (proposée, docs/DECISIONS.md D-14) : une réclamation sur un colis
 * est traitée par le pays de DESTINATION pour « livraison » et « retard », par le pays
 * d'ORIGINE sinon ; sans colis, par le pays de résidence du client.
 * Les notes internes ne sont jamais visibles du client.
 */
import { Router } from "express";
import { z } from "zod";
import { audit } from "../../core/audit.js";
import { db, one, type Db, withTransaction } from "../../core/db.js";
import { badRequest, conflict, forbidden, msg, notFound, t, unprocessable } from "../../core/errors.js";
import { emit } from "../../core/outbox.js";
import { PageQuery } from "../../core/http.js";
import { mount, route } from "../../core/routes.js";
import { randomReference } from "../../core/references.js";
import { IdParams } from "../../core/schemas.js";
import { label } from "../../i18n/index.js";
import { assertCan, can, isEmptyScope, loadPrincipal, scopeClause, scopeFilter, type Principal, type ResourceScope } from "../access/authorization.js";
import { paginate } from "./common.js";

const TRANSITIONS: Record<string, string[]> = {
  open: ["in_progress", "closed"],
  in_progress: ["waiting_client", "resolved", "closed"],
  waiting_client: ["in_progress", "resolved", "closed"],
  resolved: ["closed", "in_progress"],
};

async function loadTicket(d: Db, id: string, lock = false) {
  const tk = await one(d, `select s.*, c.user_id as client_user_id, c.client_number from canada.support_tickets s
                             join canada.clients c on c.id = s.client_id where s.id = $1 ${lock ? "for update of s" : ""}`, [id]);
  if (!tk) throw notFound("TICKET_NOT_FOUND", t("Réclamation introuvable."));
  return tk;
}
const ticketScope = (tk: any): ResourceScope => ({ countries: [tk.country_code], agencyIds: [tk.agency_id] });

async function messages(ticketId: string, includeInternal: boolean) {
  return (await db.query(`select id, author_side, body, internal_note, created_at from canada.support_messages
                           where ticket_id = $1 ${includeInternal ? "" : "and not internal_note"} order by created_at`, [ticketId])).rows;
}

async function postMessage(tx: Db, tk: any, principal: Principal, side: "client" | "staff", body: string, internal: boolean, correlationId: string) {
  const m = await one(tx, `insert into canada.support_messages(ticket_id, author_id, author_side, body, internal_note) values ($1,$2,$3,$4,$5) returning id, created_at`,
    [tk.id, principal.userId, side, body, internal]);
  if (!internal) {
    await emit(tx, { type: "canada.support.message_posted", aggregateType: "support_ticket", aggregateId: tk.id, correlationId,
      payload: { ticket_id: tk.id, reference: tk.reference, client_id: tk.client_id, author_side: side, assigned_to: tk.assigned_to } });
  }
  return m;
}

const routes = [
  // ---------------------------------------------------------------- Client
  route({
    method: "post", path: "/me/support-tickets", tag: "Support", auth: "canada", anyPermission: ["canada.support.create_own"], idempotent: true,
    summary: "Ouvrir une réclamation (colis, retard, livraison, paiement, autre)",
    body: z.object({ category: z.enum(["parcel", "delay", "delivery", "payment", "other"]), subject: z.string().trim().min(3).max(200),
      message: z.string().trim().min(3).max(4000), parcel_id: z.uuid().nullable().optional() }),
    handler: async ({ body, principal, correlationId }) => withTransaction(async (tx) => {
      const c = await one(tx, `select id, residence_country, home_agency_id from canada.clients where user_id = $1`, [principal.userId]);
      if (!c) throw forbidden("CLIENT_PROFILE_MISSING", "Aucune fiche client rattachée à ce compte.");
      let country = c.residence_country as string | null, agency = c.home_agency_id as string | null;
      if (body.parcel_id) {
        const p = await one(tx, `select * from canada.parcels where id = $1 and (client_id = $2 or recipient_client_id = $2)`, [body.parcel_id, c.id]);
        if (!p) throw notFound("PARCEL_NOT_FOUND", "Colis introuvable.");
        const destSide = ["delivery", "delay"].includes(body.category);
        country = destSide ? p.destination_country : p.origin_country;
        agency = destSide ? p.destination_agency_id : p.origin_agency_id;
      }
      if (!country) throw badRequest("COUNTRY_REQUIRED", t("Pays de résidence requis pour ouvrir une réclamation sans colis."));
      const tk = await one(tx,
        `insert into canada.support_tickets(reference, client_id, opened_by, category, parcel_id, subject, country_code, agency_id)
         values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
        [randomReference("SUP", 8), c.id, principal.userId, body.category, body.parcel_id ?? null, body.subject, country, agency]);
      await postMessage(tx, { ...tk, assigned_to: null }, principal, "client", body.message, false, correlationId);
      await audit(tx, { actorUserId: principal.userId, action: "canada.support.opened", resourceType: "support_ticket", resourceId: tk.id,
        countryCode: country, agencyId: agency, correlationId });
      return { status: 201, data: tk };
    }),
  }),
  route({
    method: "get", path: "/me/support-tickets", tag: "Support", auth: "canada", anyPermission: ["canada.support.read_own"], summary: "Mes réclamations",
    handler: async ({ principal, locale }) => ({ data: (await db.query(
      `select s.id, s.reference, s.category, s.subject, s.status, s.parcel_id, s.created_at, s.updated_at from canada.support_tickets s
         join canada.clients c on c.id = s.client_id where c.user_id = $1 order by s.created_at desc`, [principal.userId])).rows
      .map((r) => ({ ...r, status_label: label("support_status", r.status, locale), category_label: label("support_category", r.category, locale) })) }),
  }),
  route({
    method: "get", path: "/me/support-tickets/:id", tag: "Support", auth: "canada", anyPermission: ["canada.support.read_own"],
    summary: "Ma réclamation et ses échanges (sans notes internes)", params: IdParams,
    handler: async ({ params, principal, locale }) => {
      const tk = await loadTicket(db, params.id);
      if (tk.client_user_id !== principal.userId) throw notFound("TICKET_NOT_FOUND", t("Réclamation introuvable."));
      const { client_user_id, assigned_to, ...pub } = tk;
      return { data: { ...pub, status_label: label("support_status", tk.status, locale), messages: await messages(tk.id, false) } };
    },
  }),
  route({
    method: "post", path: "/me/support-tickets/:id/messages", tag: "Support", auth: "canada", anyPermission: ["canada.support.create_own"],
    summary: "Répondre à ma réclamation", params: IdParams, body: z.object({ body: z.string().trim().min(1).max(4000) }),
    handler: async ({ params, body, principal, correlationId }) => withTransaction(async (tx) => {
      const tk = await loadTicket(tx, params.id, true);
      if (tk.client_user_id !== principal.userId) throw notFound("TICKET_NOT_FOUND", t("Réclamation introuvable."));
      if (tk.status === "closed") throw conflict("TICKET_CLOSED", t("Réclamation clôturée."));
      const m = await postMessage(tx, tk, principal, "client", body.body, false, correlationId);
      if (["waiting_client", "resolved"].includes(tk.status)) await tx.query(`update canada.support_tickets set status = 'in_progress' where id = $1`, [tk.id]);
      return { status: 201, data: m };
    }),
  }),
  // ------------------------------------------------------------- Personnel
  route({
    method: "get", path: "/canada/support-tickets", tag: "Support", auth: "canada", anyPermission: ["canada.support.read_scoped"],
    summary: "Réclamations du périmètre", query: PageQuery.extend({ status: z.string().max(20).optional() }),
    handler: async ({ query, principal, locale }) => {
      const f = scopeFilter(principal, ["canada.support.read_scoped"]);
      if (isEmptyScope(f)) return { data: [], meta: paginate(query.page, query.limit, 0) };
      const params: unknown[] = [];
      let where = scopeClause(f, { countries: ["s.country_code"], agencies: ["s.agency_id"] }, params);
      if (query.status) { params.push(query.status); where += ` and s.status = $${params.length}`; }
      const total = (await db.query(`select count(*)::int n from canada.support_tickets s where ${where}`, params)).rows[0].n;
      const rows = (await db.query(`select s.* from canada.support_tickets s where ${where} order by s.created_at desc
                                     limit ${query.limit} offset ${(query.page - 1) * query.limit}`, params)).rows;
      return { data: rows.map((r) => ({ ...r, status_label: label("support_status", r.status, locale) })), meta: paginate(query.page, query.limit, total) };
    },
  }),
  route({
    method: "get", path: "/canada/support-tickets/:id", tag: "Support", auth: "canada", anyPermission: ["canada.support.read_scoped"],
    summary: "Réclamation, échanges et notes internes", params: IdParams,
    handler: async ({ params, principal }) => {
      const tk = await loadTicket(db, params.id);
      assertCan(principal, "canada.support.read_scoped", ticketScope(tk));
      return { data: { ...tk, client_user_id: undefined, messages: await messages(tk.id, true) } };
    },
  }),
  route({
    method: "post", path: "/canada/support-tickets/:id/messages", tag: "Support", auth: "canada", anyPermission: ["canada.support.reply"],
    summary: "Répondre au client ou ajouter une note interne", params: IdParams,
    body: z.object({ body: z.string().trim().min(1).max(4000), internal_note: z.boolean().default(false) }),
    handler: async ({ params, body, principal, correlationId }) => withTransaction(async (tx) => {
      const tk = await loadTicket(tx, params.id, true);
      assertCan(principal, "canada.support.reply", ticketScope(tk));
      if (tk.status === "closed") throw conflict("TICKET_CLOSED", t("Réclamation clôturée."));
      const m = await postMessage(tx, tk, principal, "staff", body.body, body.internal_note, correlationId);
      if (tk.status === "open" && !body.internal_note) await tx.query(`update canada.support_tickets set status = 'in_progress' where id = $1`, [tk.id]);
      return { status: 201, data: m };
    }),
  }),
  route({
    method: "post", path: "/canada/support-tickets/:id/assign", tag: "Support", auth: "canada", anyPermission: ["canada.support.assign"],
    summary: "Affecter la réclamation à un agent habilité sur ce périmètre", params: IdParams, body: z.object({ user_id: z.uuid() }),
    handler: async ({ params, body, principal, correlationId }) => withTransaction(async (tx) => {
      const tk = await loadTicket(tx, params.id, true);
      assertCan(principal, "canada.support.assign", ticketScope(tk));
      if (tk.status === "closed") throw conflict("TICKET_CLOSED", t("Réclamation clôturée."));
      const assignee = await loadPrincipal(tx, { sub: body.user_id, aal: "aal2" });
      if (!assignee || assignee.accountStatus !== "active" || !can(assignee, "canada.support.reply", ticketScope(tk))) {
        throw unprocessable("ASSIGNEE_NOT_ALLOWED", t("Agent de support hors du périmètre de la réclamation."));
      }
      await tx.query(`update canada.support_tickets set assigned_to = $2 where id = $1`, [tk.id, body.user_id]);
      await audit(tx, { actorUserId: principal.userId, action: "canada.support.assigned", resourceType: "support_ticket", resourceId: tk.id,
        previous: { assigned_to: tk.assigned_to }, next: { assigned_to: body.user_id }, correlationId });
      return { data: { ticket_id: tk.id, assigned_to: body.user_id } };
    }),
  }),
  route({
    method: "post", path: "/canada/support-tickets/:id/status", tag: "Support", auth: "canada", anyPermission: ["canada.support.reply"],
    summary: "Faire avancer la réclamation (clôture motivée)", params: IdParams,
    body: z.object({ status: z.enum(["in_progress", "waiting_client", "resolved", "closed"]), note: z.string().trim().max(2000).optional() }),
    handler: async ({ params, body, principal, correlationId }) => withTransaction(async (tx) => {
      const tk = await loadTicket(tx, params.id, true);
      assertCan(principal, "canada.support.reply", ticketScope(tk));
      if (!(TRANSITIONS[tk.status] ?? []).includes(body.status)) {
        throw unprocessable("TRANSITION_NOT_ALLOWED", msg("Transition de réclamation {p0} → {p1} interdite.", { p0: tk.status, p1: body.status }));
      }
      if (body.status === "closed" && !body.note?.trim()) throw badRequest("COMMENT_REQUIRED", "Un motif est obligatoire pour cette étape.");
      await tx.query(`update canada.support_tickets set status = $2::text, closed_at = case when $2::text = 'closed' then now() else closed_at end,
                        closure_note = case when $2::text = 'closed' then $3 else closure_note end where id = $1`, [tk.id, body.status, body.note ?? null]);
      await audit(tx, { actorUserId: principal.userId, action: "canada.support.status_changed", resourceType: "support_ticket", resourceId: tk.id,
        previous: { status: tk.status }, next: { status: body.status }, reason: body.note ?? null, correlationId });
      return { data: { ticket_id: tk.id, status: body.status } };
    }),
  }),
];

export function supportRouter() {
  const r = Router();
  mount(r, routes);
  return r;
}

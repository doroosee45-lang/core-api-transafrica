/**
 * Espace client (application mobile) et suivi public.
 * Le client consulte uniquement SES données ; il ne modifie jamais un statut,
 * une position, une association ou une donnée de vol (Cahier §7.5).
 * Suivi colis et suivi aérien sont présentés séparément (Cahier §6.4).
 */
import { Router } from "express";
import { z } from "zod";
import { db, one, withTransaction } from "../../core/db.js";
import { notFound } from "../../core/errors.js";
import { PageQuery } from "../../core/http.js";
import { mount, route } from "../../core/routes.js";
import { CountryCode, Email, IdParams } from "../../core/schemas.js";
import { assertCan } from "../access/authorization.js";
import { loadParcel, paginate, parcelResource } from "./common.js";
import { flightTracking } from "./flights/flight.routes.js";
import { label, type Locale } from "../../i18n/index.js";
import { lastConfirmedPosition } from "./logistics.extra.routes.js";
import { createClientRequest, createPublicRequest } from "./request.service.js";
import { loadQuote, quoteDetail, respondToQuote } from "./finance/quote.service.js";

async function myClientIds(userId: string): Promise<string[]> {
  return (await db.query(`select id from canada.clients where user_id = $1`, [userId])).rows.map((r) => r.id);
}

async function clientTracking(parcelId: string, locale: Locale) {
  const p = (await db.query(
    `select reference, status, origin_country, destination_country, estimated_delivery_at, delivered_at, updated_at
       from canada.parcels where id = $1`, [parcelId])).rows[0];
  const events = (await db.query(
    `select to_status as status, event_type, occurred_at, location_text, source from canada.parcel_events
      where parcel_id = $1 and visibility = 'client' and to_status is not null and from_status is distinct from to_status
      order by occurred_at, recorded_at`, [parcelId])).rows;
  const last = events.at(-1) ?? null;
  // Vol éventuel : expédition active du colis → affectation active → vol (informations aériennes distinctes).
  const flight = (await db.query(
    `select f.id from canada.shipment_parcels sp join canada.flight_shipment_assignments a on a.shipment_id = sp.shipment_id and a.unassigned_at is null
       join canada.flights f on f.id = a.flight_id
      where sp.parcel_id = $1 and sp.removed_at is null and f.current_version > 0 order by a.leg_sequence`, [parcelId])).rows[0];
  let flightInfo = null;
  if (flight) {
    const f = (await db.query(
      `select f.*, al.iata_code as airline_iata, al.name as airline_name from canada.flights f join canada.airlines al on al.id = f.airline_id where f.id = $1`, [flight.id])).rows[0];
    const lastEvent = (await db.query(`select to_status, source, occurred_at from canada.flight_events where flight_id = $1 and to_status is not null order by occurred_at desc limit 1`, [f.id])).rows[0];
    flightInfo = flightTracking(f, lastEvent ?? null, locale);
  }
  return {
    parcel: { ...p, status_label: label("parcel_status", p.status, locale) },
    package_tracking: {
      events: events.map((e) => ({ ...e, status_label: label("parcel_status", e.status, locale) })),
      last_confirmed_event: last,
      // Dernière position confirmée = dernier scan physique (« kind: scan »). Aucune position GPS
      // n'est publiée tant qu'aucune source n'est retenue et autorisée (Cahier §7.4).
      last_confirmed_position: await lastConfirmedPosition(parcelId),
      last_update_at: p.updated_at,
    },
    flight_tracking: flightInfo,
  };
}

const routes = [
  route({
    method: "get", path: "/me/parcels", tag: "Espace client", auth: "canada", anyPermission: ["canada.parcels.read_own"],
    summary: "Mes colis (expédiés ou à recevoir)", query: PageQuery,
    handler: async ({ query, principal, locale }) => {
      const ids = await myClientIds(principal.userId);
      if (!ids.length) return { data: [], meta: paginate(query.page, query.limit, 0) };
      const total = (await db.query(`select count(*)::int n from canada.parcels where client_id = any($1::uuid[]) or recipient_client_id = any($1::uuid[])`, [ids])).rows[0].n;
      const rows = (await db.query(
        `select id, reference, status, origin_country, destination_country, billable_weight_kg, created_at, updated_at,
                (client_id = any($1::uuid[])) as is_sender
           from canada.parcels where client_id = any($1::uuid[]) or recipient_client_id = any($1::uuid[])
          order by created_at desc limit ${query.limit} offset ${(query.page - 1) * query.limit}`, [ids])).rows;
      return { data: rows.map((r) => ({ ...r, status_label: label("parcel_status", r.status, locale) })), meta: paginate(query.page, query.limit, total) };
    },
  }),
  route({
    method: "get", path: "/me/parcels/:id/tracking", tag: "Espace client", auth: "canada", anyPermission: ["canada.tracking.read_own"],
    summary: "Suivi de mon colis (événements confirmés) + informations du vol associé, présentées séparément", params: IdParams,
    handler: async ({ params, principal, locale }) => {
      const p = await loadParcel(db, params.id);
      assertCan(principal, "canada.tracking.read_own", { ownerUserIds: parcelResource(p).ownerUserIds }, "Ce colis ne vous appartient pas.");
      return { data: await clientTracking(p.id, locale) };
    },
  }),
  route({
    method: "get", path: "/me/quotes", tag: "Espace client", auth: "canada", anyPermission: ["canada.quotes.read_own"], summary: "Mes devis",
    handler: async ({ principal }) => ({ data: (await db.query(
      `select q.id, q.reference, q.current_version, v.status, v.total, v.currency, v.valid_until, q.created_at
         from canada.quotations q join canada.clients c on c.id = q.client_id
         join canada.quotation_versions v on v.quotation_id = q.id and v.version = q.current_version
        where c.user_id = $1 and v.status <> 'draft' order by q.created_at desc`, [principal.userId])).rows }),
  }),
  route({
    method: "get", path: "/me/quotes/:id", tag: "Espace client", auth: "canada", anyPermission: ["canada.quotes.read_own"],
    summary: "Détail d'un de mes devis (marqué « consulté »)", params: IdParams,
    handler: async ({ params, principal }) => {
      const q = await loadQuote(db, params.id);
      assertCan(principal, "canada.quotes.read_own", { ownerUserIds: [q.client_user_id] }, "Ce devis ne vous appartient pas.");
      await db.query(`update canada.quotation_versions set status = 'viewed' where quotation_id = $1 and version = $2 and status = 'issued'`, [q.id, q.current_version]);
      const d = await quoteDetail(db, q);
      // Les brouillons internes ne sont jamais montrés au client.
      return { data: { ...d, versions: d.versions.filter((v: any) => v.status !== "draft") } };
    },
  }),
  route({
    method: "post", path: "/me/quotes/:id/versions/:version/accept", tag: "Espace client", auth: "canada", anyPermission: ["canada.quotes.respond_own"], idempotent: true,
    summary: "Accepter explicitement une version précise (crée l'obligation de paiement)",
    params: z.object({ id: z.uuid(), version: z.coerce.number().int().positive() }), body: z.object({ accept_conditions: z.literal(true) }),
    handler: async ({ params, principal, req, correlationId }) => ({
      data: await respondToQuote(principal, params.id, params.version, "accept", { ip: req.ip ?? null, userAgent: req.header("user-agent") ?? null }, null, correlationId),
    }),
  }),
  route({
    method: "post", path: "/me/quotes/:id/versions/:version/reject", tag: "Espace client", auth: "canada", anyPermission: ["canada.quotes.respond_own"],
    summary: "Refuser une version", params: z.object({ id: z.uuid(), version: z.coerce.number().int().positive() }),
    body: z.object({ reason: z.string().trim().max(1000).nullable().optional() }),
    handler: async ({ params, body, principal, req, correlationId }) => ({
      data: await respondToQuote(principal, params.id, params.version, "reject", { ip: req.ip ?? null, userAgent: null }, body.reason ?? null, correlationId),
    }),
  }),
  route({
    method: "get", path: "/me/payments", tag: "Espace client", auth: "canada", anyPermission: ["canada.payments.read_own"],
    summary: "Mes paiements (statut vérifié par Trans Afrique)",
    handler: async ({ principal }) => ({ data: (await db.query(
      `select p.id, p.reference, p.purpose, p.amount_due, p.amount_paid, p.amount_refunded, p.currency, p.status, p.due_date, p.confirmed_at, p.created_at
         from canada.payments p join canada.clients c on c.id = p.client_id where c.user_id = $1 order by p.created_at desc`, [principal.userId])).rows }),
  }),
  route({
    method: "get", path: "/me/requests", tag: "Espace client", auth: "canada", anyPermission: ["canada.requests.read_own"], summary: "Mes demandes",
    handler: async ({ principal }) => ({ data: (await db.query(
      `select id, reference, origin_country, destination_country, shipment_type, status, created_at from canada.requests where requester_user_id = $1 order by created_at desc`,
      [principal.userId])).rows }),
  }),
  route({
    method: "post", path: "/me/requests", tag: "Espace client", auth: "canada", anyPermission: ["canada.requests.create_own"], idempotent: true, atomicIdempotency: true,
    summary: "Nouvelle demande d'expédition / de devis",
    body: z.object({ origin_country: CountryCode, destination_country: CountryCode, shipment_type: z.enum(["parcel", "kilogram", "pallet", "documents", "other"]).default("parcel"),
      estimated_weight_kg: z.number().nonnegative().max(100000).optional(), message: z.string().trim().max(2000).optional(), preferred_agency_id: z.uuid().optional() }),
    handler: async ({ body, principal, correlationId, transaction }) => {
      if (!transaction) throw new Error("Atomic idempotency transaction missing for POST /me/requests.");
      return { status: 201, data: await createClientRequest(transaction, principal, body, correlationId) };
    },
  }),
  route({
    method: "get", path: "/me/notifications", tag: "Espace client", auth: "user", summary: "Centre de notifications", query: PageQuery,
    handler: async ({ query, principal }) => {
      const total = (await db.query(`select count(*)::int n from shared.notifications where user_id = $1`, [principal.userId])).rows[0].n;
      const rows = (await db.query(`select id, category, title, body, data, read_at, created_at from shared.notifications where user_id = $1
                                     order by created_at desc limit ${query.limit} offset ${(query.page - 1) * query.limit}`, [principal.userId])).rows;
      return { data: rows, meta: { ...paginate(query.page, query.limit, total), unread: (await db.query(`select count(*)::int n from shared.notifications where user_id = $1 and read_at is null`, [principal.userId])).rows[0].n } };
    },
  }),
  route({
    method: "post", path: "/me/notifications/:id/read", tag: "Espace client", auth: "user", summary: "Marquer comme lue", params: IdParams,
    handler: async ({ params, principal }) => {
      const r = await db.query(`update shared.notifications set read_at = coalesce(read_at, now()) where id = $1 and user_id = $2 returning id`, [params.id, principal.userId]);
      if (!r.rowCount) throw notFound("NOTIFICATION_NOT_FOUND", "Notification introuvable.");
      return { data: { id: params.id, read: true } };
    },
  }),
  route({
    method: "put", path: "/me/notification-preferences", tag: "Espace client", auth: "user", summary: "Préférences de notification par canal",
    body: z.object({ preferences: z.array(z.object({ channel: z.enum(["email", "push", "in_app"]), category: z.string().max(60).default("*"), enabled: z.boolean() })).max(50) }),
    handler: async ({ body, principal }) => withTransaction(async (tx) => {
      for (const p of body.preferences) {
        await tx.query(`insert into shared.notification_preferences(user_id, channel, category, enabled) values ($1,$2,$3,$4)
                        on conflict (user_id, channel, category) do update set enabled = excluded.enabled, updated_at = now()`, [principal.userId, p.channel, p.category, p.enabled]);
      }
      return { data: (await tx.query(`select channel, category, enabled from shared.notification_preferences where user_id = $1`, [principal.userId])).rows };
    }),
  }),
  route({
    method: "post", path: "/me/devices", tag: "Espace client", auth: "user", summary: "Enregistrer un appareil pour les notifications push",
    body: z.object({ push_token: z.string().trim().min(10).max(500), platform: z.enum(["ios", "android", "web"]) }),
    handler: async ({ body, principal }) => {
      const r = await one(db, `insert into shared.user_devices(user_id, push_token, platform) values ($1,$2,$3)
                               on conflict (push_token) do update set user_id = excluded.user_id, platform = excluded.platform, status = 'active', last_seen_at = now()
                               returning id, platform, status`, [principal.userId, body.push_token, body.platform]);
      return { status: 201, data: r };
    },
  }),
  route({
    method: "delete", path: "/me/devices", tag: "Espace client", auth: "user", summary: "Désinscrire un appareil",
    body: z.object({ push_token: z.string().trim().min(10).max(500) }),
    handler: async ({ body, principal }) => {
      await db.query(`update shared.user_devices set status = 'unregistered' where push_token = $1 and user_id = $2`, [body.push_token, principal.userId]);
      return { data: { unregistered: true } };
    },
  }),
  // ------------------------- Public -------------------------
  route({
    method: "get", path: "/public/tracking/:reference", tag: "Public", auth: "public", rateLimit: { windowMs: 60_000, max: 30 },
    summary: "Suivi public par référence (aucune donnée personnelle ni financière)",
    params: z.object({ reference: z.string().trim().toUpperCase().regex(/^TAC?-[A-Z0-9]{6,20}$/) }),
    handler: async ({ params, locale }) => {
      const p = await one(db, `select id from canada.parcels where reference = $1`, [params.reference]);
      if (!p) throw notFound("TRACKING_NOT_FOUND", "Référence inconnue.");
      const t = await clientTracking(p.id, locale);
      return { data: {
        reference: t.parcel.reference, status: t.parcel.status, status_label: t.parcel.status_label,
        origin_country: t.parcel.origin_country, destination_country: t.parcel.destination_country,
        events: t.package_tracking.events.map((e: any) => ({ status: e.status, status_label: e.status_label, occurred_at: e.occurred_at })),
        last_update_at: t.package_tracking.last_update_at,
      } };
    },
  }),
  route({
    method: "post", path: "/public/requests", tag: "Public", auth: "public", rateLimit: { windowMs: 60 * 60_000, max: 10 },
    summary: "Demande de devis publique (enregistrée réellement, notifiée au personnel habilité)",
    body: z.object({ full_name: z.string().trim().min(2).max(160), company: z.string().trim().max(160).optional(), email: Email,
      phone: z.string().trim().min(6).max(40), origin_country: CountryCode, destination_country: CountryCode,
      shipment_type: z.enum(["parcel", "kilogram", "pallet", "documents", "other"]).default("parcel"),
      estimated_weight_kg: z.number().nonnegative().max(100000).optional(), estimated_volume_m3: z.number().nonnegative().max(10000).optional(),
      message: z.string().trim().max(2000).optional() }),
    handler: async ({ body, correlationId }) => ({
      status: 201,
      data: await withTransaction((tx) => createPublicRequest(tx, body, correlationId)),
    }),
  }),
];

export function clientRouter() {
  const r = Router();
  mount(r, routes);
  return r;
}

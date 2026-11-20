/**
 * Espace client — compléments (Cahier §3.6, Module 4) :
 * consulter / gérer ses coordonnées (canada.clients.read_own / update_own), enregistrer
 * ses adresses, modifier une demande non encore traitée (canada.requests.update_own),
 * consulter ses expéditions (canada.shipments.read_own).
 * Le client ne modifie jamais son pays de rattachement, son agence, son statut ni son lien de compte.
 */
import { Router } from "express";
import { z } from "zod";
import { audit } from "../../core/audit.js";
import { db, one, withTransaction } from "../../core/db.js";
import { conflict, forbidden, notFound, t } from "../../core/errors.js";
import { mount, route } from "../../core/routes.js";
import { CountryCode, Email, IdParams } from "../../core/schemas.js";
import { label } from "../../i18n/index.js";
import { assertCan, type Principal } from "../access/authorization.js";

async function myClient(principal: Principal) {
  const c = await one(db, `select * from canada.clients where user_id = $1`, [principal.userId]);
  if (!c) throw forbidden("CLIENT_PROFILE_MISSING", "Aucune fiche client rattachée à ce compte.");
  assertCan(principal, "canada.clients.read_own", { ownerUserIds: [c.user_id] });
  return c;
}

const Address = z.object({
  label: z.string().trim().max(60).nullable().optional(), country_code: CountryCode, city: z.string().trim().min(1).max(120),
  line1: z.string().trim().min(2).max(300), line2: z.string().trim().max(300).nullable().optional(),
  postal_code: z.string().trim().max(20).nullable().optional(), phone: z.string().trim().max(40).nullable().optional(),
  is_default: z.boolean().default(false),
});

const routes = [
  route({
    method: "get", path: "/me/client", tag: "Espace client", auth: "canada", anyPermission: ["canada.clients.read_own"],
    summary: "Ma fiche client (identifiant unique, coordonnées, pays de rattachement)",
    handler: async ({ principal }) => {
      const c = await myClient(principal);
      return { data: { id: c.id, client_number: c.client_number, first_name: c.first_name, last_name: c.last_name, email: c.email,
        phone: c.phone, residence_country: c.residence_country, home_agency_id: c.home_agency_id, status: c.status } };
    },
  }),
  route({
    method: "patch", path: "/me/client", tag: "Espace client", auth: "canada", anyPermission: ["canada.clients.update_own"],
    summary: "Mettre à jour mes coordonnées de contact (téléphone, e-mail de contact)",
    body: z.strictObject({ phone: z.string().trim().min(6).max(40).optional(), email: Email.nullable().optional() }),
    handler: async ({ body, principal, correlationId }) => {
      const c = await myClient(principal);
      assertCan(principal, "canada.clients.update_own", { ownerUserIds: [c.user_id] });
      const keys = Object.keys(body) as (keyof typeof body)[];
      if (!keys.length) return { data: c };
      return withTransaction(async (tx) => {
        const r = await one(tx, `update canada.clients set ${keys.map((k, i) => `${k} = $${i + 2}`).join(", ")}, updated_by = $${keys.length + 2}
                                  where id = $1 returning id, client_number, phone, email`, [c.id, ...keys.map((k) => body[k]), principal.userId]);
        await audit(tx, { actorUserId: principal.userId, action: "canada.client.self_updated", resourceType: "client", resourceId: c.id,
          previous: Object.fromEntries(keys.map((k) => [k, c[k]])), next: body, correlationId });
        return { data: r };
      });
    },
  }),
  route({
    method: "get", path: "/me/addresses", tag: "Espace client", auth: "canada", anyPermission: ["canada.clients.read_own"],
    summary: "Mes adresses enregistrées",
    handler: async ({ principal }) => {
      const c = await myClient(principal);
      return { data: (await db.query(`select * from canada.client_addresses where client_id = $1 order by is_default desc, created_at`, [c.id])).rows };
    },
  }),
  route({
    method: "post", path: "/me/addresses", tag: "Espace client", auth: "canada", anyPermission: ["canada.clients.update_own"],
    summary: "Ajouter une adresse (une seule adresse par défaut)", body: Address,
    handler: async ({ body, principal }) => {
      const c = await myClient(principal);
      return withTransaction(async (tx) => {
        if (body.is_default) await tx.query(`update canada.client_addresses set is_default = false where client_id = $1 and is_default`, [c.id]);
        const a = await one(tx,
          `insert into canada.client_addresses(client_id, label, country_code, city, line1, line2, postal_code, phone, is_default)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`,
          [c.id, body.label ?? null, body.country_code, body.city, body.line1, body.line2 ?? null, body.postal_code ?? null, body.phone ?? null, body.is_default]);
        return { status: 201, data: a };
      });
    },
  }),
  route({
    method: "put", path: "/me/addresses/:id", tag: "Espace client", auth: "canada", anyPermission: ["canada.clients.update_own"],
    summary: "Remplacer une de mes adresses", params: IdParams, body: Address,
    handler: async ({ params, body, principal }) => {
      const c = await myClient(principal);
      return withTransaction(async (tx) => {
        const own = await one(tx, `select id from canada.client_addresses where id = $1 and client_id = $2 for update`, [params.id, c.id]);
        if (!own) throw notFound("ADDRESS_NOT_FOUND", t("Adresse introuvable."));
        if (body.is_default) await tx.query(`update canada.client_addresses set is_default = false where client_id = $1 and is_default and id <> $2`, [c.id, params.id]);
        const a = await one(tx,
          `update canada.client_addresses set label = $3, country_code = $4, city = $5, line1 = $6, line2 = $7, postal_code = $8, phone = $9, is_default = $10
            where id = $1 and client_id = $2 returning *`,
          [params.id, c.id, body.label ?? null, body.country_code, body.city, body.line1, body.line2 ?? null, body.postal_code ?? null, body.phone ?? null, body.is_default]);
        return { data: a };
      });
    },
  }),
  route({
    method: "delete", path: "/me/addresses/:id", tag: "Espace client", auth: "canada", anyPermission: ["canada.clients.update_own"],
    summary: "Supprimer une de mes adresses (donnée personnelle non opérationnelle)", params: IdParams,
    handler: async ({ params, principal }) => {
      const c = await myClient(principal);
      const r = await db.query(`delete from canada.client_addresses where id = $1 and client_id = $2`, [params.id, c.id]);
      if (!r.rowCount) throw notFound("ADDRESS_NOT_FOUND", t("Adresse introuvable."));
      return { data: { deleted: true } };
    },
  }),
  route({
    method: "patch", path: "/me/requests/:id", tag: "Espace client", auth: "canada", anyPermission: ["canada.requests.update_own"],
    summary: "Modifier ou annuler ma demande tant qu'elle n'est pas prise en charge", params: IdParams,
    body: z.strictObject({ estimated_weight_kg: z.number().nonnegative().max(100000).optional(), message: z.string().trim().max(2000).optional(),
      cancel: z.literal(true).optional() }),
    handler: async ({ params, body, principal, correlationId }) => withTransaction(async (tx) => {
      const r = await one(tx, `select * from canada.requests where id = $1 for update`, [params.id]);
      if (!r || r.requester_user_id !== principal.userId) throw notFound("REQUEST_NOT_FOUND", "Demande introuvable.");
      assertCan(principal, "canada.requests.update_own", { ownerUserIds: [r.requester_user_id] });
      if (r.status !== "new") throw conflict("REQUEST_LOCKED", t("Demande déjà prise en charge : modification impossible."));
      const u = await one(tx,
        `update canada.requests set estimated_weight_kg = coalesce($2, estimated_weight_kg), message = coalesce($3, message),
                status = case when $4::boolean then 'cancelled' else status end where id = $1 returning id, reference, status, estimated_weight_kg, message`,
        [r.id, body.estimated_weight_kg ?? null, body.message ?? null, body.cancel === true]);
      await audit(tx, { actorUserId: principal.userId, action: "canada.request.self_updated", resourceType: "request", resourceId: r.id,
        previous: { status: r.status, estimated_weight_kg: r.estimated_weight_kg }, next: body, correlationId });
      return { data: u };
    }),
  }),
  route({
    method: "get", path: "/me/shipments", tag: "Espace client", auth: "canada", anyPermission: ["canada.shipments.read_own"],
    summary: "Mes expéditions (celles qui transportent mes colis) et leurs vols publiés",
    handler: async ({ principal, locale }) => {
      const rows = (await db.query(
        `select distinct s.id, s.reference, s.status, s.origin_country, s.destination_country, s.transport_mode, s.dispatched_at, s.arrived_at
           from canada.shipments s join canada.shipment_parcels sp on sp.shipment_id = s.id and sp.removed_at is null
           join canada.parcels p on p.id = sp.parcel_id join canada.clients c on c.id in (p.client_id, p.recipient_client_id)
          where c.user_id = $1 order by s.dispatched_at desc nulls first`, [principal.userId])).rows;
      for (const r of rows) {
        r.status_label = label("shipment_status", r.status, locale);
        // Seuls les vols publiés sont montrés au client (un brouillon n'est pas une information officielle).
        r.flights = (await db.query(
          `select al.iata_code || f.flight_number as designator, f.flight_date, f.status, f.departure_airport, f.arrival_airport, a.leg_sequence
             from canada.flight_shipment_assignments a join canada.flights f on f.id = a.flight_id join canada.airlines al on al.id = f.airline_id
            where a.shipment_id = $1 and a.unassigned_at is null and f.current_version > 0 order by a.leg_sequence`, [r.id])).rows
          .map((f) => ({ ...f, status_label: label("flight_status", f.status, locale) }));
      }
      return { data: rows };
    },
  }),
];

export function clientSelfRouter() {
  const r = Router();
  mount(r, routes);
  return r;
}

/**
 * Opérations logistiques complémentaires (permissions du Dossier 03 sans route jusqu'ici) :
 *   canada.parcels.assign      → affectation à un entrepôt (Module 6)
 *   canada.parcels.classify    → classement / description avant préparation
 *   canada.tracking.update     → scan physique (« dernière position confirmée », Cahier §7.2, §7.4)
 *   canada.tracking.read_scoped→ suivi interne complet
 *   canada.shipments.assign    → responsables d'étape origine / destination (Cahier §17)
 *   canada.warehouses.manage   → modification / suspension d'un entrepôt
 */
import { Router } from "express";
import { z } from "zod";
import { audit } from "../../core/audit.js";
import { db, one, withTransaction } from "../../core/db.js";
import { conflict, notFound, t, unprocessable } from "../../core/errors.js";
import { mount, route } from "../../core/routes.js";
import { CurrencyCode, IdParams, Money, ParcelCategory, Reason } from "../../core/schemas.js";
import { label } from "../../i18n/index.js";
import { assertCan, type ResourceScope } from "../access/authorization.js";
import { loadParcel, originResource, parcelResource } from "./common.js";
import { recordParcelEvent } from "./parcels/parcel.service.js";
import { loadShipment, shipmentDestination, shipmentOrigin } from "./shipments/shipment.service.js";

const IN_FLIGHT = ["dispatched", "in_transit"];
const TERMINAL = ["delivered", "returned", "cancelled"];

/** Dernière position confirmée = dernier scan physique (jamais une estimation, jamais un GPS inventé). */
export async function lastConfirmedPosition(parcelId: string) {
  const s = await one(db,
    `select e.occurred_at, e.location_text, w.name as warehouse_name, w.country_code
       from canada.parcel_events e left join canada.warehouses w on w.id = e.warehouse_id
      where e.parcel_id = $1 and e.source = 'scan' order by e.occurred_at desc, e.recorded_at desc limit 1`, [parcelId]);
  return s ? { kind: "scan", at: s.occurred_at, location: s.location_text ?? s.warehouse_name, warehouse: s.warehouse_name, country_code: s.country_code } : null;
}

/** Un utilisateur détient-il un rôle opérationnel couvrant ce pays ? */
async function isStaffOfCountry(userId: string, country: string) {
  return !!(await one(db,
    `select 1 from access.user_roles ur join access.roles r on r.id = ur.role_id and r.is_active
       left join canada.agencies a on ur.scope_type = 'agency' and a.id = ur.scope_id
       left join canada.warehouses w on ur.scope_type = 'warehouse' and w.id = ur.scope_id
      where ur.user_id = $1 and ur.revoked_at is null and (ur.expires_at is null or ur.expires_at > now()) and ur.scope_type <> 'own'
        and (ur.scope_type = 'global' or ur.scope_country = $2 or a.country_code = $2 or w.country_code = $2) limit 1`, [userId, country]));
}

const routes = [
  route({
    method: "post", path: "/canada/parcels/:id/warehouse", tag: "Colis", auth: "canada", anyPermission: ["canada.parcels.assign"], idempotent: true,
    summary: "Affecter le colis à un entrepôt du pays d'origine ou de destination", params: IdParams,
    body: z.object({ warehouse_id: z.uuid(), comment: z.string().trim().max(1000).nullable().optional() }),
    handler: async ({ params, body, principal, correlationId }) => withTransaction(async (tx) => {
      const p = await loadParcel(tx, params.id, true);
      if (TERMINAL.includes(p.status) || IN_FLIGHT.includes(p.status)) throw conflict("PARCEL_NOT_ASSIGNABLE", t("Affectation impossible au statut actuel du colis."));
      const w = await one(tx, `select id, agency_id, country_code from canada.warehouses where id = $1 and status = 'active'`, [body.warehouse_id]);
      if (!w || ![p.origin_country, p.destination_country].includes(w.country_code)) throw unprocessable("WAREHOUSE_INVALID", "Entrepôt invalide pour cette étape.");
      const resource: ResourceScope = { countries: [w.country_code], agencyIds: [w.agency_id], warehouseIds: [w.id] };
      assertCan(principal, "canada.parcels.assign", resource);
      await tx.query(`update canada.parcels set current_warehouse_id = $2, updated_by = $3, row_version = row_version + 1 where id = $1`, [p.id, w.id, principal.userId]);
      await recordParcelEvent(tx, { parcel: p, type: "parcel.warehouse_assigned", from: p.status, to: p.status, actor: principal.userId,
        warehouseId: w.id, agencyId: w.agency_id, visibility: "internal", comment: body.comment ?? null, correlationId });
      await audit(tx, { actorUserId: principal.userId, action: "canada.parcel.warehouse_assigned", resourceType: "parcel", resourceId: p.id,
        countryCode: w.country_code, previous: { warehouse_id: p.current_warehouse_id }, next: { warehouse_id: w.id }, correlationId });
      return { data: { parcel_id: p.id, warehouse_id: w.id } };
    }),
  }),
  route({
    method: "patch", path: "/canada/parcels/:id/classification", tag: "Colis", auth: "canada", anyPermission: ["canada.parcels.classify"],
    summary: "Classer / décrire la marchandise avant préparation (audité, motif obligatoire)", params: IdParams,
    body: z.strictObject({ category: ParcelCategory.optional(), description: z.string().trim().max(2000).nullable().optional(),
      fragile: z.boolean().optional(), declared_value: Money.nullable().optional(), declared_value_currency: CurrencyCode.nullable().optional(), reason: Reason }),
    handler: async ({ params, body, principal, correlationId }) => withTransaction(async (tx) => {
      const p = await loadParcel(tx, params.id, true);
      assertCan(principal, "canada.parcels.classify", originResource(p));
      if (!["expected", "received", "inspected"].includes(p.status)) throw conflict("PARCEL_NOT_CLASSIFIABLE", t("Classement impossible : colis déjà associé à une expédition ou parti."));
      const keys = (["category", "description", "fragile", "declared_value", "declared_value_currency"] as const).filter((k) => body[k] !== undefined);
      if (!keys.length) return { data: p };
      const before = await one(tx, `select ${keys.join(", ")} from canada.parcels where id = $1`, [p.id]);
      const r = await one(tx, `update canada.parcels set ${keys.map((k, i) => `${k} = $${i + 2}`).join(", ")}, updated_by = $${keys.length + 2},
                                 row_version = row_version + 1 where id = $1 returning id, category, description, fragile, declared_value, declared_value_currency`,
        [p.id, ...keys.map((k) => body[k]), principal.userId]);
      await recordParcelEvent(tx, { parcel: p, type: "parcel.classified", from: p.status, to: p.status, actor: principal.userId,
        visibility: "internal", comment: body.reason, correlationId });
      await audit(tx, { actorUserId: principal.userId, action: "canada.parcel.classified", resourceType: "parcel", resourceId: p.id,
        previous: before, next: Object.fromEntries(keys.map((k) => [k, body[k]])), reason: body.reason, correlationId });
      return { data: r };
    }),
  }),
  route({
    method: "post", path: "/canada/parcels/:id/scans", tag: "Colis", auth: "canada", anyPermission: ["canada.tracking.update"], idempotent: true,
    summary: "Enregistrer un scan physique (mouvement confirmé, sans changement de statut)", params: IdParams,
    body: z.object({ warehouse_id: z.uuid().nullable().optional(), location_text: z.string().trim().max(200).nullable().optional(),
      occurred_at: z.iso.datetime({ offset: true }).nullable().optional(), comment: z.string().trim().max(1000).nullable().optional() }),
    handler: async ({ params, body, principal, correlationId }) => withTransaction(async (tx) => {
      const p = await loadParcel(tx, params.id, true);
      if (TERMINAL.includes(p.status)) throw conflict("PARCEL_TERMINAL", "Ce colis est dans un état final.");
      let resource: ResourceScope = parcelResource(p);
      let agencyId: string | null = null;
      if (body.warehouse_id) {
        const w = await one(tx, `select id, agency_id, country_code from canada.warehouses where id = $1 and status = 'active'`, [body.warehouse_id]);
        if (!w || ![p.origin_country, p.destination_country].includes(w.country_code)) throw unprocessable("WAREHOUSE_INVALID", "Entrepôt invalide pour cette étape.");
        resource = { countries: [w.country_code], agencyIds: [w.agency_id], warehouseIds: [w.id] };
        agencyId = w.agency_id;
      }
      assertCan(principal, "canada.tracking.update", resource);
      if (body.occurred_at && new Date(body.occurred_at).getTime() > Date.now() + 5 * 60_000) {
        throw unprocessable("OCCURRED_AT_IN_FUTURE", t("La date du scan ne peut pas être dans le futur."));
      }
      const e = await recordParcelEvent(tx, { parcel: p, type: "parcel.scanned", from: p.status, to: p.status, actor: principal.userId,
        warehouseId: body.warehouse_id ?? null, agencyId, location: body.location_text ?? null, source: "scan", visibility: "client",
        comment: body.comment ?? null, occurredAt: body.occurred_at ?? null, correlationId });
      return { status: 201, data: { event_id: e.id, occurred_at: e.occurred_at } };
    }),
  }),
  route({
    method: "get", path: "/canada/parcels/:id/tracking", tag: "Colis", auth: "canada", anyPermission: ["canada.tracking.read_scoped"],
    summary: "Suivi interne complet (événements internes inclus, dernière position confirmée)", params: IdParams,
    handler: async ({ params, principal, locale }) => {
      const p = await loadParcel(db, params.id);
      assertCan(principal, "canada.tracking.read_scoped", parcelResource(p));
      const events = (await db.query(
        `select e.id, e.event_type, e.from_status, e.to_status, e.occurred_at, e.recorded_at, e.source, e.visibility, e.location_text,
                e.comment, e.proof_reference, e.corrects_event_id, w.name as warehouse_name
           from canada.parcel_events e left join canada.warehouses w on w.id = e.warehouse_id where e.parcel_id = $1 order by e.occurred_at, e.recorded_at`, [p.id])).rows;
      return { data: { parcel_id: p.id, reference: p.reference, status: p.status, status_label: label("parcel_status", p.status, locale),
        last_confirmed_position: await lastConfirmedPosition(p.id), events } };
    },
  }),
  route({
    method: "post", path: "/canada/shipments/:id/responsibles", tag: "Expéditions", auth: "canada", anyPermission: ["canada.shipments.assign"],
    summary: "Désigner le responsable de l'étape d'origine et/ou de destination (Cahier §17)", params: IdParams,
    body: z.object({ origin_responsible_id: z.uuid().nullable().optional(), destination_responsible_id: z.uuid().nullable().optional() })
      .refine((b) => b.origin_responsible_id !== undefined || b.destination_responsible_id !== undefined),
    handler: async ({ params, body, principal, correlationId }) => withTransaction(async (tx) => {
      const s = await loadShipment(tx, params.id, true);
      if (["completed", "cancelled"].includes(s.status)) throw conflict("SHIPMENT_LOCKED", "Expédition déjà partie ou annulée.");
      if (body.origin_responsible_id !== undefined) {
        assertCan(principal, "canada.shipments.assign", shipmentOrigin(s));
        if (body.origin_responsible_id && !(await isStaffOfCountry(body.origin_responsible_id, s.origin_country))) {
          throw unprocessable("RESPONSIBLE_INVALID", t("Responsable inconnu ou hors du pays concerné."));
        }
      }
      if (body.destination_responsible_id !== undefined) {
        assertCan(principal, "canada.shipments.assign", shipmentDestination(s));
        if (body.destination_responsible_id && !(await isStaffOfCountry(body.destination_responsible_id, s.destination_country))) {
          throw unprocessable("RESPONSIBLE_INVALID", t("Responsable inconnu ou hors du pays concerné."));
        }
      }
      const r = await one(tx,
        `update canada.shipments set origin_responsible_id = case when $2::boolean then $3::uuid else origin_responsible_id end,
                destination_responsible_id = case when $4::boolean then $5::uuid else destination_responsible_id end,
                updated_by = $6, row_version = row_version + 1 where id = $1
         returning id, origin_responsible_id, destination_responsible_id`,
        [s.id, body.origin_responsible_id !== undefined, body.origin_responsible_id ?? null,
         body.destination_responsible_id !== undefined, body.destination_responsible_id ?? null, principal.userId]);
      await tx.query(`insert into canada.shipment_events(shipment_id, event_type, actor_user_id, metadata, correlation_id) values ($1,'shipment.responsibles_assigned',$2,$3,$4)`,
        [s.id, principal.userId, JSON.stringify(body), correlationId]);
      await audit(tx, { actorUserId: principal.userId, action: "canada.shipment.responsibles_assigned", resourceType: "shipment", resourceId: s.id,
        previous: { origin_responsible_id: s.origin_responsible_id, destination_responsible_id: s.destination_responsible_id }, next: body, correlationId });
      return { data: r };
    }),
  }),
  route({
    method: "patch", path: "/canada/warehouses/:id", tag: "Agences", auth: "canada", anyPermission: ["canada.warehouses.manage"],
    summary: "Modifier ou suspendre un entrepôt (l'agence et le pays ne changent pas)", params: IdParams,
    body: z.strictObject({ name: z.string().trim().min(2).max(160).optional(), address: z.string().trim().max(500).nullable().optional(),
      capacity_m3: z.number().positive().max(1e7).nullable().optional(), status: z.enum(["active", "suspended", "closed"]).optional() }),
    handler: async ({ params, body, principal, correlationId }) => withTransaction(async (tx) => {
      const w = await one(tx, `select * from canada.warehouses where id = $1 for update`, [params.id]);
      if (!w) throw notFound("WAREHOUSE_NOT_FOUND", t("Entrepôt introuvable."));
      assertCan(principal, "canada.warehouses.manage", { countries: [w.country_code], agencyIds: [w.agency_id], warehouseIds: [w.id] });
      const keys = Object.keys(body) as (keyof typeof body)[];
      if (!keys.length) return { data: w };
      const r = await one(tx, `update canada.warehouses set ${keys.map((k, i) => `${k} = $${i + 2}`).join(", ")}, updated_by = $${keys.length + 2} where id = $1 returning *`,
        [w.id, ...keys.map((k) => body[k]), principal.userId]);
      await audit(tx, { actorUserId: principal.userId, action: "canada.warehouse.updated", resourceType: "warehouse", resourceId: w.id,
        countryCode: w.country_code, agencyId: w.agency_id, previous: Object.fromEntries(keys.map((k) => [k, w[k]])), next: body, correlationId });
      return { data: r };
    }),
  }),
];

export function logisticsExtraRouter() {
  const r = Router();
  mount(r, routes);
  return r;
}


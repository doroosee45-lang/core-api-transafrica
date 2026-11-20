import { Router } from "express";
import { z } from "zod";
import { db } from "../../../core/db.js";
import { PageQuery } from "../../../core/http.js";
import { mount, route } from "../../../core/routes.js";
import { CountryCode, IdParams, Reason, TransportMode } from "../../../core/schemas.js";
import { assertCan, isEmptyScope, scopeClause, scopeFilter } from "../../access/authorization.js";
import { paginate } from "../common.js";
import {
  addParcels, arriveShipment, cancelShipment, completeShipment, createShipment, dispatchShipment, loadShipment, markReady,
  removeParcel, shipmentResource,
} from "./shipment.service.js";

const READ = ["canada.shipments.read_scoped"];

const routes = [
  route({
    method: "get", path: "/canada/shipments", tag: "Expéditions", auth: "canada", anyPermission: READ,
    summary: "Expéditions du périmètre (origine ou destination)",
    query: PageQuery.extend({ status: z.string().max(20).optional(), origin_country: CountryCode.optional(), destination_country: CountryCode.optional() }),
    handler: async ({ query, principal }) => {
      const f = scopeFilter(principal, READ);
      if (isEmptyScope(f)) return { data: [], meta: paginate(query.page, query.limit, 0) };
      const params: unknown[] = [];
      const where = [scopeClause(f, { countries: ["s.origin_country", "s.destination_country"], agencies: ["s.origin_agency_id", "s.destination_agency_id"] }, params)];
      for (const [col, v] of [["s.status", query.status], ["s.origin_country", query.origin_country], ["s.destination_country", query.destination_country]] as const) {
        if (v) { params.push(v); where.push(`${col} = $${params.length}`); }
      }
      const total = (await db.query(`select count(*)::int n from canada.shipments s where ${where.join(" and ")}`, params)).rows[0].n;
      const rows = (await db.query(
        `select s.*, (select count(*)::int from canada.shipment_parcels sp where sp.shipment_id = s.id and sp.removed_at is null) as parcel_count
           from canada.shipments s where ${where.join(" and ")} order by s.created_at desc
          limit ${query.limit} offset ${(query.page - 1) * query.limit}`, params)).rows;
      return { data: rows, meta: paginate(query.page, query.limit, total) };
    },
  }),
  route({
    method: "post", path: "/canada/shipments", tag: "Expéditions", auth: "canada", anyPermission: ["canada.shipments.create"], idempotent: true,
    summary: "Créer une expédition (agence d'origine du périmètre)",
    body: z.object({
      origin_country: CountryCode, destination_country: CountryCode, origin_agency_id: z.uuid(),
      destination_agency_id: z.uuid().nullable().optional(), transport_mode: TransportMode.default("air"),
      carrier_name: z.string().trim().max(160).nullable().optional(), notes: z.string().trim().max(2000).nullable().optional(),
    }),
    handler: async ({ body, principal, correlationId }) => ({ status: 201, data: await createShipment(principal, body, correlationId) }),
  }),
  route({
    method: "get", path: "/canada/shipments/:id", tag: "Expéditions", auth: "canada", anyPermission: READ,
    summary: "Détail : colis actifs, historique des associations, vols, événements",
    params: IdParams,
    handler: async ({ params, principal }) => {
      const s = await loadShipment(db, params.id);
      assertCan(principal, "canada.shipments.read_scoped", shipmentResource(s));
      const parcels = (await db.query(
        `select sp.parcel_id, p.reference, p.status, p.client_id, sp.added_at, sp.removed_at, sp.removal_reason
           from canada.shipment_parcels sp join canada.parcels p on p.id = sp.parcel_id where sp.shipment_id = $1 order by sp.added_at`, [s.id])).rows;
      const flights = (await db.query(
        `select a.flight_id, a.leg_sequence, a.assigned_at, a.unassigned_at, a.unassign_reason, al.iata_code || f.flight_number as designator,
                f.flight_date, f.status from canada.flight_shipment_assignments a join canada.flights f on f.id = a.flight_id
           join canada.airlines al on al.id = f.airline_id where a.shipment_id = $1 order by a.assigned_at`, [s.id])).rows;
      const events = (await db.query(`select * from canada.shipment_events where shipment_id = $1 order by occurred_at`, [s.id])).rows;
      return { data: { ...s, parcels, flights, events } };
    },
  }),
  route({
    method: "post", path: "/canada/shipments/:id/parcels", tag: "Expéditions", auth: "canada", anyPermission: ["canada.shipments.consolidate"], idempotent: true,
    summary: "Regrouper des colis prêts (traçabilité individuelle conservée)",
    params: IdParams, body: z.object({ parcel_ids: z.array(z.uuid()).min(1).max(500) }),
    handler: async ({ params, body, principal, correlationId }) => ({ data: await addParcels(principal, params.id, body.parcel_ids, correlationId) }),
  }),
  route({
    method: "post", path: "/canada/shipments/:id/parcels/:parcelId/remove", tag: "Expéditions", auth: "canada", anyPermission: ["canada.shipments.split"],
    summary: "Retirer un colis avant le départ (motif obligatoire)",
    params: z.object({ id: z.uuid(), parcelId: z.uuid() }), body: z.object({ reason: Reason }),
    handler: async ({ params, body, principal, correlationId }) => ({ data: await removeParcel(principal, params.id, params.parcelId, body.reason, correlationId) }),
  }),
  route({
    method: "post", path: "/canada/shipments/:id/ready", tag: "Expéditions", auth: "canada", anyPermission: ["canada.shipments.plan"],
    summary: "Déclarer l'expédition prête", params: IdParams,
    handler: async ({ params, principal, correlationId }) => ({ data: await markReady(principal, params.id, correlationId) }),
  }),
  route({
    method: "post", path: "/canada/shipments/:id/dispatch", tag: "Expéditions", auth: "canada", anyPermission: ["canada.shipments.dispatch"], idempotent: true,
    summary: "Confirmer le départ (vol requis en aérien)", params: IdParams,
    handler: async ({ params, principal, correlationId }) => ({ data: await dispatchShipment(principal, params.id, correlationId) }),
  }),
  route({
    method: "post", path: "/canada/shipments/:id/arrive", tag: "Expéditions", auth: "canada", anyPermission: ["canada.shipments.receive"], idempotent: true,
    summary: "Confirmer l'arrivée dans le pays de destination (n'équivaut pas à la réception physique des colis)", params: IdParams,
    handler: async ({ params, principal, correlationId }) => ({ data: await arriveShipment(principal, params.id, correlationId) }),
  }),
  route({
    method: "post", path: "/canada/shipments/:id/complete", tag: "Expéditions", auth: "canada", anyPermission: ["canada.shipments.close"],
    summary: "Clôturer (tous les colis réceptionnés ou en exception)", params: IdParams,
    handler: async ({ params, principal, correlationId }) => ({ data: await completeShipment(principal, params.id, correlationId) }),
  }),
  route({
    method: "post", path: "/canada/shipments/:id/cancel", tag: "Expéditions", auth: "canada", anyPermission: ["canada.shipments.cancel"],
    summary: "Annuler une expédition non partie (colis libérés, historique conservé)", params: IdParams, body: z.object({ reason: Reason }),
    handler: async ({ params, body, principal, correlationId }) => ({ data: await cancelShipment(principal, params.id, body.reason, correlationId) }),
  }),
];

export function shipmentRouter() {
  const r = Router();
  mount(r, routes);
  return r;
}

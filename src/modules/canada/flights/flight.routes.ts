import { t } from "../../../core/errors.js";
import { label, type Locale } from "../../../i18n/index.js";
import { Router } from "express";
import { z } from "zod";
import { db } from "../../../core/db.js";
import { PageQuery } from "../../../core/http.js";
import { mount, route } from "../../../core/routes.js";
import { IdParams, Reason } from "../../../core/schemas.js";
import { assertCan, isEmptyScope, scopeFilter } from "../../access/authorization.js";
import { paginate } from "../common.js";
import {
  assignShipment, cancelFlight, changeOperationalStatus, createFlight, flightResource, loadFlight, publishFlight, scheduleFlight,
  unassignShipment, updateFlight,
} from "./flight.service.js";

const Iata2 = z.string().trim().toUpperCase().regex(/^[A-Z0-9]{2}$/);
const Iata3 = z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/);
const Instant = z.iso.datetime({ offset: true });
const FlightNumber = z.string().trim().toUpperCase().regex(/^[0-9]{1,4}[A-Z]?$/, t("Numéro sans préfixe compagnie (ex. 890)"));

const FlightFields = {
  airline_iata: Iata2, flight_number: FlightNumber, flight_date: z.iso.date(),
  departure_airport: Iata3, arrival_airport: Iata3,
  scheduled_departure: Instant, scheduled_arrival: Instant,
  departure_terminal: z.string().trim().max(20).nullable().optional(), arrival_terminal: z.string().trim().max(20).nullable().optional(),
  operating_reference: z.string().trim().max(80).nullable().optional(), notes: z.string().trim().max(2000).nullable().optional(),
};

/** Pays couverts par les attributions agence/entrepôt (un vol se rattache à des pays). */
async function readableCountries(principal: any) {
  const f = scopeFilter(principal, ["canada.flights.read"]);
  if (f.global) return null;
  const ids = [...f.agencyIds];
  if (f.warehouseIds.length) {
    ids.push(...(await db.query(`select agency_id from canada.warehouses where id = any($1::uuid[])`, [f.warehouseIds])).rows.map((r) => r.agency_id));
  }
  const fromAgencies = ids.length ? (await db.query(`select distinct country_code from canada.agencies where id = any($1::uuid[])`, [ids])).rows.map((r) => r.country_code) : [];
  return isEmptyScope(f) ? [] : [...new Set([...f.countries, ...fromAgencies])];
}

const routes = [
  route({
    method: "get", path: "/canada/flights", tag: "Vols", auth: "canada", anyPermission: ["canada.flights.read"],
    summary: "Vols concernant les pays du périmètre (recherche par compagnie, numéro, date)",
    query: PageQuery.extend({ airline_iata: Iata2.optional(), flight_number: FlightNumber.optional(), flight_date: z.iso.date().optional(), status: z.string().max(20).optional() }),
    handler: async ({ query, principal }) => {
      const countries = await readableCountries(principal);
      if (countries && !countries.length) return { data: [], meta: paginate(query.page, query.limit, 0) };
      const params: unknown[] = [];
      const where: string[] = [];
      if (countries) { params.push(countries); where.push(`(da.country_code = any($1::text[]) or aa.country_code = any($1::text[]))`); }
      for (const [col, v] of [["al.iata_code", query.airline_iata], ["f.flight_number", query.flight_number], ["f.flight_date", query.flight_date], ["f.status", query.status]] as const) {
        if (v) { params.push(v); where.push(`${col} = $${params.length}`); }
      }
      const from = `from canada.flights f join canada.airlines al on al.id = f.airline_id
        join canada.airports da on da.iata_code = f.departure_airport join canada.airports aa on aa.iata_code = f.arrival_airport
        ${where.length ? `where ${where.join(" and ")}` : ""}`;
      const total = (await db.query(`select count(*)::int n ${from}`, params)).rows[0].n;
      const rows = (await db.query(
        `select f.id, al.iata_code as airline_iata, al.name as airline_name, f.flight_number, f.flight_date, f.departure_airport,
                f.arrival_airport, f.scheduled_departure, f.scheduled_arrival, f.departure_timezone, f.arrival_timezone, f.status,
                f.current_version, f.estimated_arrival
           ${from} order by f.flight_date desc, f.scheduled_departure desc limit ${query.limit} offset ${(query.page - 1) * query.limit}`, params)).rows;
      return { data: rows, meta: paginate(query.page, query.limit, total) };
    },
  }),
  route({
    method: "post", path: "/canada/flights", tag: "Vols", auth: "canada", anyPermission: ["canada.flights.create"], idempotent: true,
    summary: "Créer un vol en brouillon (heures avec fuseau, date locale de départ)",
    body: z.object(FlightFields),
    handler: async ({ body, principal, correlationId }) => ({ status: 201, data: await createFlight(principal, body, correlationId) }),
  }),
  route({
    method: "get", path: "/canada/flights/:id", tag: "Vols", auth: "canada", anyPermission: ["canada.flights.read"],
    summary: "Fiche du vol, versions publiées, expéditions associées, événements", params: IdParams,
    handler: async ({ params, principal }) => {
      const f = await loadFlight(db, params.id);
      assertCan(principal, "canada.flights.read", await flightResource(db, f));
      const [versions, shipments, events] = await Promise.all([
        db.query(`select version, changed_fields, previous_values, change_reason, is_significant, created_at from canada.flight_versions where flight_id = $1 order by version`, [f.id]),
        db.query(`select a.shipment_id, s.reference, s.status, a.leg_sequence, a.assigned_at, a.unassigned_at, a.unassign_reason
                    from canada.flight_shipment_assignments a join canada.shipments s on s.id = a.shipment_id where a.flight_id = $1 order by a.assigned_at`, [f.id]),
        db.query(`select event_type, from_status, to_status, source, occurred_at, details from canada.flight_events where flight_id = $1 order by occurred_at`, [f.id]),
      ]);
      return { data: { ...f, versions: versions.rows, shipments: shipments.rows, events: events.rows } };
    },
  }),
  route({
    method: "patch", path: "/canada/flights/:id", tag: "Vols", auth: "canada", anyPermission: ["canada.flights.update"],
    summary: "Modifier un vol (après publication : nouvelle version, motif et notification corrective)",
    params: IdParams, body: z.object(FlightFields).partial().extend({ change_reason: z.string().trim().max(1000).optional() }),
    handler: async ({ params, body, principal, correlationId }) => ({ data: await updateFlight(principal, params.id, body, correlationId) }),
  }),
  route({
    method: "post", path: "/canada/flights/:id/schedule", tag: "Vols", auth: "canada", anyPermission: ["canada.flights.update"],
    summary: "Valider le brouillon (DRAFT → SCHEDULED)", params: IdParams,
    handler: async ({ params, principal, correlationId }) => ({ data: await scheduleFlight(principal, params.id, correlationId) }),
  }),
  route({
    method: "post", path: "/canada/flights/:id/publish", tag: "Vols", auth: "canada", anyPermission: ["canada.flights.publish"], idempotent: true,
    summary: "Publier : version publiée + notification des clients réellement concernés", params: IdParams,
    handler: async ({ params, principal, correlationId }) => ({ data: await publishFlight(principal, params.id, correlationId) }),
  }),
  route({
    method: "post", path: "/canada/flights/:id/status", tag: "Vols", auth: "canada", anyPermission: ["canada.flights.update_operational_status"], idempotent: true,
    summary: "Statut opérationnel (embarquement, départ, retard, déroutement, atterrissage, arrivée confirmée)",
    params: IdParams,
    body: z.object({
      status: z.enum(["BOARDING", "DEPARTED", "IN_AIR", "DELAYED", "DIVERTED", "LANDED", "ARRIVED"]),
      reason: z.string().trim().max(1000).nullable().optional(), estimated_departure: Instant.nullable().optional(),
      estimated_arrival: Instant.nullable().optional(), actual_departure: Instant.nullable().optional(),
      actual_arrival: Instant.nullable().optional(), diverted_to_airport: Iata3.nullable().optional(),
    }),
    handler: async ({ params, body, principal, correlationId }) => ({ data: await changeOperationalStatus(principal, params.id, body, correlationId) }),
  }),
  route({
    method: "post", path: "/canada/flights/:id/cancel", tag: "Vols", auth: "canada", anyPermission: ["canada.flights.cancel"], idempotent: true,
    summary: "Annuler (expéditions non parties libérées pour réaffectation)", params: IdParams, body: z.object({ reason: Reason }),
    handler: async ({ params, body, principal, correlationId }) => ({ data: await cancelFlight(principal, params.id, body.reason, correlationId) }),
  }),
  route({
    method: "post", path: "/canada/flights/:id/shipments", tag: "Vols", auth: "canada", anyPermission: ["canada.flights.assign_shipments"], idempotent: true,
    summary: "Associer une expédition au vol (historisé, étape de correspondance)",
    params: IdParams, body: z.object({ shipment_id: z.uuid(), leg_sequence: z.number().int().min(1).max(5).default(1) }),
    handler: async ({ params, body, principal, correlationId }) => ({ status: 201, data: await assignShipment(principal, params.id, body.shipment_id, body.leg_sequence, correlationId) }),
  }),
  route({
    method: "post", path: "/canada/flights/:id/shipments/:shipmentId/unassign", tag: "Vols", auth: "canada", anyPermission: ["canada.flights.assign_shipments"],
    summary: "Dissocier une expédition non partie (motif obligatoire)",
    params: z.object({ id: z.uuid(), shipmentId: z.uuid() }), body: z.object({ reason: Reason }),
    handler: async ({ params, body, principal, correlationId }) => ({ data: await unassignShipment(principal, params.id, params.shipmentId, body.reason, correlationId) }),
  }),
  route({
    method: "get", path: "/canada/flights/:id/tracking", tag: "Vols", auth: "canada", anyPermission: ["canada.flights.read"],
    summary: "Suivi du vol : dernière information confirmée (aucune position n'est inventée)", params: IdParams,
    handler: async ({ params, principal, locale }) => {
      const f = await loadFlight(db, params.id);
      assertCan(principal, "canada.flights.read", await flightResource(db, f));
      return { data: flightTracking(f, (await db.query(
        `select event_type, to_status, source, occurred_at from canada.flight_events where flight_id = $1 and to_status is not null order by occurred_at desc limit 1`, [f.id])).rows[0] ?? null, locale) };
    },
  }),
];

/** Représentation du suivi aérien : jamais de position sans fournisseur vérifié (Cahier §6.3, §19.4). */
export function flightTracking(f: any, lastEvent: any, locale: Locale = "fr") {
  return {
    flight_id: f.id, designator: `${f.airline_iata}${f.flight_number}`, airline: f.airline_name, flight_date: f.flight_date,
    route: { from: f.departure_airport, to: f.arrival_airport, diverted_to: f.diverted_to_airport },
    status: f.status,
    status_label: label("flight_status", f.status, locale),
    times: {
      scheduled_departure: f.scheduled_departure, scheduled_arrival: f.scheduled_arrival,
      estimated_departure: f.estimated_departure, estimated_arrival: f.estimated_arrival,
      actual_departure: f.actual_departure, actual_arrival: f.actual_arrival,
      departure_timezone: f.departure_timezone, arrival_timezone: f.arrival_timezone,
    },
    last_confirmed: lastEvent ? { status: lastEvent.to_status, source: lastEvent.source, at: lastEvent.occurred_at } : null,
    position: null,
    position_available: false,
    data_source: "operator",
    notice: locale === "en"
      ? "No aviation data provider has been selected yet: only information confirmed by our teams is shown."
      : "Aucun fournisseur de données aéronautiques n'est encore retenu : seules les informations confirmées par les équipes sont affichées.",
  };
}

export function flightRouter() {
  const r = Router();
  mount(r, routes);
  return r;
}

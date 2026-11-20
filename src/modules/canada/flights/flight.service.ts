/**
 * Vols internationaux (Cahier Module 8, Spéc. backend §12, Dossier 05 Flux 11).
 * - Identité fonctionnelle : compagnie + numéro + date (contrainte d'unicité).
 * - DRAFT → SCHEDULED (validation) → PUBLISHED (version publiée + notifications).
 * - Toute modification significative après publication = nouvelle version,
 *   motif obligatoire, notification corrective.
 * - ARRIVED (confirmation logistique) ne modifie jamais le statut des colis.
 */
import type { Db } from "../../../core/db.js";
import { one, withTransaction } from "../../../core/db.js";
import { audit } from "../../../core/audit.js";
import { badRequest, conflict, notFound, unprocessable, msg } from "../../../core/errors.js";
import { emit } from "../../../core/outbox.js";
import { assertCan, type Principal, type ResourceScope } from "../../access/authorization.js";
import { shipmentOrigin } from "../shipments/shipment.service.js";

export const OPERATIONAL: Record<string, string[]> = {
  PUBLISHED: ["BOARDING", "DELAYED", "DEPARTED"],
  DELAYED: ["DELAYED", "BOARDING", "DEPARTED"],
  BOARDING: ["DELAYED", "DEPARTED"],
  DEPARTED: ["IN_AIR", "LANDED", "DIVERTED"],
  IN_AIR: ["LANDED", "DIVERTED"],
  DIVERTED: ["LANDED"],
  LANDED: ["ARRIVED"],
};
const CANCELLABLE = ["DRAFT", "SCHEDULED", "PUBLISHED", "DELAYED", "BOARDING"];
const SIGNIFICANT = ["airline_id", "flight_number", "flight_date", "departure_airport", "arrival_airport", "scheduled_departure",
  "scheduled_arrival", "departure_terminal", "arrival_terminal"];
const EDITABLE = [...SIGNIFICANT, "operating_reference", "notes"];

export async function loadFlight(d: Db, id: string, lock = false) {
  const f = await one(d,
    `select f.*, al.iata_code as airline_iata, al.name as airline_name,
            da.country_code as departure_country, aa.country_code as arrival_country,
            da.name as departure_airport_name, aa.name as arrival_airport_name, da.city as departure_city, aa.city as arrival_city
       from canada.flights f join canada.airlines al on al.id = f.airline_id
       join canada.airports da on da.iata_code = f.departure_airport join canada.airports aa on aa.iata_code = f.arrival_airport
      where f.id = $1 ${lock ? "for update of f" : ""}`, [id]);
  if (!f) throw notFound("FLIGHT_NOT_FOUND", "Vol introuvable.");
  return f;
}

/** Périmètre d'un vol : pays des deux aéroports (+ leurs agences). */
export async function flightResource(d: Db, f: { departure_country: string; arrival_country: string }): Promise<ResourceScope> {
  const ag = await d.query(`select id from canada.agencies where country_code = any($1::text[])`, [[f.departure_country, f.arrival_country]]);
  return { countries: [f.departure_country, f.arrival_country], agencyIds: ag.rows.map((r) => r.id) };
}

/** Date locale (YYYY-MM-DD) d'un instant dans un fuseau IANA. */
export function localDate(instant: string | Date, tz: string) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(instant));
}

async function resolveRefs(d: Db, input: { airline_iata?: string; departure_airport?: string; arrival_airport?: string }) {
  const out: any = {};
  if (input.airline_iata) {
    const a = await one(d, `select id from canada.airlines where iata_code = $1 and is_active`, [input.airline_iata]);
    if (!a) throw unprocessable("AIRLINE_UNKNOWN", "Compagnie inconnue ou inactive (référentiel à compléter par l'administration).");
    out.airline_id = a.id;
  }
  for (const k of ["departure_airport", "arrival_airport"] as const) {
    if (input[k]) {
      const ap = await one(d, `select iata_code, timezone, country_code from canada.airports where iata_code = $1 and is_active`, [input[k]]);
      if (!ap) throw unprocessable("AIRPORT_UNKNOWN", msg("Aéroport inconnu : {p0}.", { p0: input[k] }));
      out[k] = ap;
    }
  }
  return out;
}

function snapshot(f: any) {
  return {
    airline_iata: f.airline_iata, airline_name: f.airline_name, flight_number: f.flight_number, flight_date: f.flight_date,
    departure_airport: f.departure_airport, departure_airport_name: f.departure_airport_name, departure_city: f.departure_city,
    arrival_airport: f.arrival_airport, arrival_airport_name: f.arrival_airport_name, arrival_city: f.arrival_city,
    scheduled_departure: f.scheduled_departure, scheduled_arrival: f.scheduled_arrival,
    departure_timezone: f.departure_timezone, arrival_timezone: f.arrival_timezone,
    departure_terminal: f.departure_terminal, arrival_terminal: f.arrival_terminal, status: f.status,
  };
}

/**
 * Expéditions actives du vol AU MOMENT de l'événement : les destinataires sont
 * déterminés à la publication (Cahier §8.4), pas au moment du traitement asynchrone.
 */
async function activeShipmentIds(tx: Db, flightId: string): Promise<string[]> {
  return (await tx.query(`select shipment_id from canada.flight_shipment_assignments where flight_id = $1 and unassigned_at is null`, [flightId]))
    .rows.map((r) => r.shipment_id);
}

async function flightEvent(tx: Db, flightId: string, type: string, from: string | null, to: string | null, actor: string, details: object, correlationId: string) {
  await tx.query(
    `insert into canada.flight_events(flight_id, event_type, from_status, to_status, actor_user_id, details, correlation_id)
     values ($1,$2,$3,$4,$5,$6,$7)`, [flightId, type, from, to, actor, JSON.stringify(details), correlationId]);
}

export async function createFlight(actor: Principal, input: any, correlationId: string) {
  return withTransaction(async (tx) => {
    const refs = await resolveRefs(tx, input);
    const dep = refs.departure_airport, arr = refs.arrival_airport;
    if (dep.iata_code === arr.iata_code) throw unprocessable("AIRPORTS_IDENTICAL", "Aéroports de départ et d'arrivée identiques.");
    if (new Date(input.scheduled_arrival) <= new Date(input.scheduled_departure)) throw unprocessable("TIMES_INVALID", "L'arrivée doit suivre le départ.");
    if (localDate(input.scheduled_departure, dep.timezone) !== input.flight_date) {
      throw unprocessable("FLIGHT_DATE_MISMATCH", "La date du vol doit être la date locale de départ à l'aéroport d'origine.");
    }
    assertCan(actor, "canada.flights.create", await flightResource(tx, { departure_country: dep.country_code, arrival_country: arr.country_code }));
    const row = await one(tx,
      `insert into canada.flights(airline_id, flight_number, flight_date, departure_airport, arrival_airport, scheduled_departure,
         scheduled_arrival, departure_timezone, arrival_timezone, departure_terminal, arrival_terminal, operating_reference, notes, created_by, updated_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14) returning id`,
      [refs.airline_id, input.flight_number, input.flight_date, dep.iata_code, arr.iata_code, input.scheduled_departure,
       input.scheduled_arrival, dep.timezone, arr.timezone, input.departure_terminal ?? null, input.arrival_terminal ?? null,
       input.operating_reference ?? null, input.notes ?? null, actor.userId]);
    await flightEvent(tx, row.id, "flight.created", null, "DRAFT", actor.userId, {}, correlationId);
    await audit(tx, { actorUserId: actor.userId, action: "canada.flight.created", resourceType: "flight", resourceId: row.id,
      countryCode: dep.country_code, next: { designator: `${input.airline_iata}${input.flight_number}`, date: input.flight_date }, correlationId });
    return loadFlight(tx, row.id);
  });
}

export async function updateFlight(actor: Principal, id: string, input: any, correlationId: string) {
  return withTransaction(async (tx) => {
    const f = await loadFlight(tx, id, true);
    assertCan(actor, "canada.flights.update", await flightResource(tx, f));
    if (["CANCELLED", "ARRIVED"].includes(f.status)) throw conflict("FLIGHT_CLOSED", "Vol annulé ou terminé : non modifiable.");
    const refs = await resolveRefs(tx, input);
    const next: Record<string, any> = {};
    if (refs.airline_id) next.airline_id = refs.airline_id;
    if (refs.departure_airport) { next.departure_airport = refs.departure_airport.iata_code; next.departure_timezone = refs.departure_airport.timezone; }
    if (refs.arrival_airport) { next.arrival_airport = refs.arrival_airport.iata_code; next.arrival_timezone = refs.arrival_airport.timezone; }
    for (const k of ["flight_number", "flight_date", "scheduled_departure", "scheduled_arrival", "departure_terminal", "arrival_terminal", "operating_reference", "notes"]) {
      if (input[k] !== undefined) next[k] = input[k];
    }
    const norm = (k: string, v: any) => (v == null ? "" : k.startsWith("scheduled_") ? new Date(v).toISOString() : String(v));
    const changed = Object.keys(next).filter((k) => EDITABLE.includes(k) && norm(k, next[k]) !== norm(k, f[k]));
    if (!changed.length) return f;
    const significant = changed.filter((k) => SIGNIFICANT.includes(k));
    const published = f.current_version > 0;
    if (published && significant.length && !input.change_reason?.trim()) {
      throw badRequest("CHANGE_REASON_REQUIRED", "Motif obligatoire pour modifier un vol publié.");
    }
    if (published && ["DEPARTED", "IN_AIR", "LANDED", "DIVERTED"].includes(f.status) && significant.length) {
      throw conflict("FLIGHT_IN_PROGRESS", "Les informations de programmation d'un vol parti ne se modifient plus ; utilisez les statuts opérationnels.");
    }
    const merged = { ...f, ...next };
    if (new Date(merged.scheduled_arrival) <= new Date(merged.scheduled_departure)) throw unprocessable("TIMES_INVALID", "L'arrivée doit suivre le départ.");
    if (localDate(merged.scheduled_departure, merged.departure_timezone) !== merged.flight_date) {
      throw unprocessable("FLIGHT_DATE_MISMATCH", "La date du vol doit être la date locale de départ.");
    }
    const sets = changed.concat(changed.includes("departure_airport") ? ["departure_timezone"] : [], changed.includes("arrival_airport") ? ["arrival_timezone"] : []);
    await tx.query(
      `update canada.flights set ${sets.map((k, i) => `${k} = $${i + 3}`).join(", ")}, updated_by = $2, row_version = row_version + 1 where id = $1`,
      [f.id, actor.userId, ...sets.map((k) => next[k])]);
    const previous = Object.fromEntries(changed.map((k) => [k, f[k]]));
    await flightEvent(tx, f.id, "flight.updated", f.status, f.status, actor.userId, { changed, previous, reason: input.change_reason ?? null }, correlationId);
    if (published) {
      const after = await loadFlight(tx, f.id);
      const version = f.current_version + 1;
      await tx.query(
        `insert into canada.flight_versions(flight_id, version, snapshot, changed_fields, previous_values, change_reason, is_significant, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [f.id, version, JSON.stringify(snapshot(after)), changed, JSON.stringify(previous), input.change_reason ?? null, significant.length > 0, actor.userId]);
      await tx.query(`update canada.flights set current_version = $2 where id = $1`, [f.id, version]);
      if (significant.length) {
        await emit(tx, { type: "canada.flight.updated", aggregateType: "flight", aggregateId: f.id, correlationId,
          payload: { flight_id: f.id, shipment_ids: await activeShipmentIds(tx, f.id), version, changed_fields: significant, previous, snapshot: snapshot(after), reason: input.change_reason } });
      }
    }
    await audit(tx, { actorUserId: actor.userId, action: "canada.flight.updated", resourceType: "flight", resourceId: f.id,
      previous, next: Object.fromEntries(changed.map((k) => [k, next[k]])), reason: input.change_reason ?? null, correlationId });
    return loadFlight(tx, f.id);
  });
}

export async function scheduleFlight(actor: Principal, id: string, correlationId: string) {
  return withTransaction(async (tx) => {
    const f = await loadFlight(tx, id, true);
    assertCan(actor, "canada.flights.update", await flightResource(tx, f));
    if (f.status !== "DRAFT") throw conflict("INVALID_STATE", "Seul un brouillon peut être validé.");
    await tx.query(`update canada.flights set status = 'SCHEDULED', updated_by = $2, row_version = row_version + 1 where id = $1`, [f.id, actor.userId]);
    await flightEvent(tx, f.id, "flight.scheduled", "DRAFT", "SCHEDULED", actor.userId, {}, correlationId);
    return loadFlight(tx, f.id);
  });
}

export async function publishFlight(actor: Principal, id: string, correlationId: string) {
  return withTransaction(async (tx) => {
    const f = await loadFlight(tx, id, true);
    assertCan(actor, "canada.flights.publish", await flightResource(tx, f));
    if (f.status !== "SCHEDULED") throw conflict("INVALID_STATE", "Le vol doit être validé (SCHEDULED) avant publication.");
    if (new Date(f.scheduled_departure) <= new Date()) throw unprocessable("FLIGHT_IN_PAST", "Impossible de publier un vol déjà parti.");
    const version = f.current_version + 1;
    await tx.query(`update canada.flights set status = 'PUBLISHED', current_version = $2, published_at = now(), published_by = $3,
                      updated_by = $3, row_version = row_version + 1 where id = $1`, [f.id, version, actor.userId]);
    const after = await loadFlight(tx, f.id);
    await tx.query(
      `insert into canada.flight_versions(flight_id, version, snapshot, change_reason, is_significant, created_by)
       values ($1,$2,$3,'Publication',true,$4)`, [f.id, version, JSON.stringify(snapshot(after)), actor.userId]);
    await flightEvent(tx, f.id, "flight.published", "SCHEDULED", "PUBLISHED", actor.userId, { version }, correlationId);
    await emit(tx, { type: "canada.flight.published", aggregateType: "flight", aggregateId: f.id, correlationId,
      payload: { flight_id: f.id, shipment_ids: await activeShipmentIds(tx, f.id), version, snapshot: snapshot(after) } });
    await audit(tx, { actorUserId: actor.userId, action: "canada.flight.published", resourceType: "flight", resourceId: f.id,
      countryCode: f.departure_country, next: { version }, correlationId });
    return after;
  });
}

export async function changeOperationalStatus(actor: Principal, id: string, input: {
  status: string; reason?: string | null; estimated_departure?: string | null; estimated_arrival?: string | null;
  actual_departure?: string | null; actual_arrival?: string | null; diverted_to_airport?: string | null;
}, correlationId: string) {
  return withTransaction(async (tx) => {
    const f = await loadFlight(tx, id, true);
    const resource = await flightResource(tx, f);
    assertCan(actor, "canada.flights.update_operational_status", resource);
    const allowed = OPERATIONAL[f.status] ?? [];
    if (!allowed.includes(input.status)) throw unprocessable("TRANSITION_NOT_ALLOWED", msg("Transition {p0} → {p1} interdite.", { p0: f.status, p1: input.status }));
    if (input.status === "ARRIVED") {
      // Confirmation logistique : réservée au pays d'arrivée.
      assertCan(actor, "canada.flights.update_operational_status", { countries: [f.arrival_country] }, "Arrivée confirmée par le pays d'arrivée.");
    }
    if (input.status === "DELAYED" && !input.estimated_departure && !input.estimated_arrival) {
      throw badRequest("ESTIMATE_REQUIRED", "Un retard doit indiquer l'heure estimée connue.");
    }
    if (input.status === "DIVERTED") {
      if (!input.diverted_to_airport) throw badRequest("DIVERSION_AIRPORT_REQUIRED", "Aéroport de déroutement requis.");
      if (!(await one(tx, `select 1 from canada.airports where iata_code = $1`, [input.diverted_to_airport]))) throw unprocessable("AIRPORT_UNKNOWN", "Aéroport inconnu.");
    }
    await tx.query(
      `update canada.flights set status = $2::text, updated_by = $3, row_version = row_version + 1,
              estimated_departure = coalesce($4::timestamptz, estimated_departure), estimated_arrival = coalesce($5::timestamptz, estimated_arrival),
              actual_departure = coalesce($6::timestamptz, actual_departure, case when $2::text = 'DEPARTED' then now() end),
              actual_arrival = coalesce($7::timestamptz, actual_arrival, case when $2::text = 'LANDED' then now() end),
              diverted_to_airport = coalesce($8::char(3), diverted_to_airport)
        where id = $1`,
      [f.id, input.status, actor.userId, input.estimated_departure ?? null, input.estimated_arrival ?? null,
       input.actual_departure ?? null, input.actual_arrival ?? null, input.diverted_to_airport ?? null]);
    await flightEvent(tx, f.id, `flight.${input.status.toLowerCase()}`, f.status, input.status, actor.userId,
      { reason: input.reason ?? null, estimated_departure: input.estimated_departure, estimated_arrival: input.estimated_arrival,
        diverted_to_airport: input.diverted_to_airport }, correlationId);
    if (input.status !== "ARRIVED") {
      await emit(tx, { type: "canada.flight.status_changed", aggregateType: "flight", aggregateId: f.id, correlationId,
        payload: { flight_id: f.id, shipment_ids: await activeShipmentIds(tx, f.id), from: f.status, to: input.status, reason: input.reason ?? null,
                   estimated_departure: input.estimated_departure ?? null, estimated_arrival: input.estimated_arrival ?? null,
                   diverted_to_airport: input.diverted_to_airport ?? null } });
    }
    await audit(tx, { actorUserId: actor.userId, action: "canada.flight.status_changed", resourceType: "flight", resourceId: f.id,
      previous: { status: f.status }, next: { status: input.status }, reason: input.reason ?? null, correlationId });
    return loadFlight(tx, f.id);
  });
}

export async function cancelFlight(actor: Principal, id: string, reason: string, correlationId: string) {
  return withTransaction(async (tx) => {
    const f = await loadFlight(tx, id, true);
    assertCan(actor, "canada.flights.cancel", await flightResource(tx, f));
    if (!CANCELLABLE.includes(f.status)) throw conflict("INVALID_STATE", msg("Un vol au statut {p0} ne peut plus être annulé.", { p0: f.status }));
    // Les expéditions non parties sont libérées pour réaffectation (Dossier 05 scénario E) ; rien ne disparaît.
    const released = await tx.query(
      `update canada.flight_shipment_assignments a set unassigned_at = now(), unassigned_by = $2, unassign_reason = $3
         from canada.shipments s
        where a.flight_id = $1 and a.unassigned_at is null and s.id = a.shipment_id and s.status in ('planned','ready')
        returning a.shipment_id`, [f.id, actor.userId, `Vol annulé : ${reason}`]);
    for (const r of released.rows) {
      await tx.query(
        `insert into canada.shipment_events(shipment_id, event_type, actor_user_id, comment, metadata, correlation_id)
         values ($1, 'shipment.flight_cancelled', $2, $3, $4, $5)`,
        [r.shipment_id, actor.userId, reason, JSON.stringify({ flight_id: f.id, requires_reassignment: true }), correlationId]);
    }
    await tx.query(`update canada.flights set status = 'CANCELLED', cancelled_at = now(), cancelled_by = $2, cancellation_reason = $3,
                      updated_by = $2, row_version = row_version + 1 where id = $1`, [f.id, actor.userId, reason]);
    await flightEvent(tx, f.id, "flight.cancelled", f.status, "CANCELLED", actor.userId, { reason, released_shipments: released.rows.map((r) => r.shipment_id) }, correlationId);
    if (f.current_version > 0) {
      await emit(tx, { type: "canada.flight.status_changed", aggregateType: "flight", aggregateId: f.id, correlationId,
        payload: { flight_id: f.id, from: f.status, to: "CANCELLED", reason,
                   shipment_ids: [...released.rows.map((r) => r.shipment_id), ...(await activeShipmentIds(tx, f.id))] } });
    }
    await audit(tx, { actorUserId: actor.userId, action: "canada.flight.cancelled", resourceType: "flight", resourceId: f.id, reason, correlationId });
    return { ...(await loadFlight(tx, f.id)), released_shipment_ids: released.rows.map((r) => r.shipment_id) };
  });
}

export async function assignShipment(actor: Principal, flightId: string, shipmentId: string, leg: number, correlationId: string) {
  return withTransaction(async (tx) => {
    const f = await loadFlight(tx, flightId, true);
    const s = await one(tx, `select * from canada.shipments where id = $1 for update`, [shipmentId]);
    if (!s) throw notFound("SHIPMENT_NOT_FOUND", "Expédition introuvable.");
    assertCan(actor, "canada.flights.assign_shipments", shipmentOrigin(s));
    if (!["DRAFT", "SCHEDULED", "PUBLISHED", "DELAYED", "BOARDING"].includes(f.status)) throw conflict("FLIGHT_NOT_ASSIGNABLE", msg("Vol au statut {p0}.", { p0: f.status }));
    if (s.transport_mode !== "air") throw unprocessable("MODE_MISMATCH", "Seule une expédition aérienne peut être associée à un vol.");
    if (!["planned", "ready"].includes(s.status)) throw conflict("SHIPMENT_LOCKED", "Expédition déjà partie ou annulée.");
    if (leg === 1 && f.departure_country !== s.origin_country) {
      throw unprocessable("ROUTE_MISMATCH", "Le premier vol doit partir du pays d'origine de l'expédition.");
    }
    try {
      await tx.query(`insert into canada.flight_shipment_assignments(flight_id, shipment_id, leg_sequence, assigned_by) values ($1,$2,$3,$4)`,
        [f.id, s.id, leg, actor.userId]);
    } catch (err: any) {
      if (err?.code === "23505") throw conflict("SHIPMENT_ALREADY_ASSIGNED", "Cette étape de l'expédition est déjà associée à un vol actif.");
      throw err;
    }
    await tx.query(`insert into canada.shipment_events(shipment_id, event_type, actor_user_id, metadata, correlation_id)
                    values ($1, 'shipment.assigned_to_flight', $2, $3, $4)`, [s.id, actor.userId, JSON.stringify({ flight_id: f.id, leg }), correlationId]);
    await flightEvent(tx, f.id, "flight.shipment_assigned", f.status, f.status, actor.userId, { shipment_id: s.id, leg }, correlationId);
    if (f.current_version > 0) {
      await emit(tx, { type: "canada.flight.shipment_assigned", aggregateType: "flight", aggregateId: f.id, correlationId,
        payload: { flight_id: f.id, shipment_id: s.id, version: f.current_version } });
    }
    await audit(tx, { actorUserId: actor.userId, action: "canada.flight.shipment_assigned", resourceType: "flight", resourceId: f.id,
      next: { shipment_id: s.id, leg }, correlationId });
    return { flight_id: f.id, shipment_id: s.id, leg_sequence: leg };
  });
}

export async function unassignShipment(actor: Principal, flightId: string, shipmentId: string, reason: string, correlationId: string) {
  return withTransaction(async (tx) => {
    const s = await one(tx, `select * from canada.shipments where id = $1 for update`, [shipmentId]);
    if (!s) throw notFound("SHIPMENT_NOT_FOUND", "Expédition introuvable.");
    assertCan(actor, "canada.flights.assign_shipments", shipmentOrigin(s));
    if (!["planned", "ready"].includes(s.status)) throw conflict("SHIPMENT_LOCKED", "Expédition déjà partie : utilisez la procédure d'exception.");
    const r = await tx.query(`update canada.flight_shipment_assignments set unassigned_at = now(), unassigned_by = $3, unassign_reason = $4
                               where flight_id = $1 and shipment_id = $2 and unassigned_at is null returning id`, [flightId, shipmentId, actor.userId, reason]);
    if (!r.rowCount) throw notFound("ASSIGNMENT_NOT_FOUND", "Aucune association active.");
    await flightEvent(tx, flightId, "flight.shipment_unassigned", null, null, actor.userId, { shipment_id: shipmentId, reason }, correlationId);
    await audit(tx, { actorUserId: actor.userId, action: "canada.flight.shipment_unassigned", resourceType: "flight", resourceId: flightId, reason, correlationId });
    return { flight_id: flightId, shipment_id: shipmentId, unassigned: true };
  });
}

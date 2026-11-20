/**
 * Expéditions (Module 7, Spéc. backend §11, Dossier 05 Flux 10 et 12).
 * Un regroupement ne fusionne jamais les colis : chaque association est une
 * ligne datée (ajout / retrait), chaque colis garde propriétaire et historique.
 * L'arrivée d'une expédition place les colis en « arrivé dans le pays » ;
 * la réception physique reste une opération par colis, au pays de destination.
 */
import type { Db } from "../../../core/db.js";
import { one, withTransaction } from "../../../core/db.js";
import { audit } from "../../../core/audit.js";
import { badRequest, conflict, notFound, unprocessable, msg } from "../../../core/errors.js";
import { emit } from "../../../core/outbox.js";
import { randomReference } from "../../../core/references.js";
import { assertCan, type Principal, type ResourceScope } from "../../access/authorization.js";
import { loadAgency } from "../common.js";
import { recordParcelEvent } from "../parcels/parcel.service.js";

export async function loadShipment(d: Db, id: string, lock = false) {
  const s = await one(d, `select * from canada.shipments where id = $1 ${lock ? "for update" : ""}`, [id]);
  if (!s) throw notFound("SHIPMENT_NOT_FOUND", "Expédition introuvable.");
  return s;
}

export const shipmentOrigin = (s: any): ResourceScope => ({ countries: [s.origin_country], agencyIds: [s.origin_agency_id] });
export const shipmentDestination = (s: any): ResourceScope => ({ countries: [s.destination_country], agencyIds: [s.destination_agency_id] });
export const shipmentResource = (s: any): ResourceScope => ({
  countries: [s.origin_country, s.destination_country], agencyIds: [s.origin_agency_id, s.destination_agency_id],
});

async function shipmentEvent(tx: Db, s: any, type: string, from: string | null, to: string | null, actor: string, country: string, correlationId: string, comment?: string | null, metadata: object = {}) {
  await tx.query(
    `insert into canada.shipment_events(shipment_id, event_type, from_status, to_status, actor_user_id, country_code, comment, metadata, correlation_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [s.id, type, from, to, actor, country, comment ?? null, JSON.stringify(metadata), correlationId]);
}

async function activeParcels(tx: Db, shipmentId: string) {
  return (await tx.query(
    `select p.id, p.reference, p.client_id, p.status from canada.shipment_parcels sp join canada.parcels p on p.id = sp.parcel_id
      where sp.shipment_id = $1 and sp.removed_at is null for update of p`, [shipmentId])).rows;
}

export async function createShipment(actor: Principal, input: {
  origin_country: string; destination_country: string; origin_agency_id: string; destination_agency_id?: string | null;
  transport_mode: string; carrier_name?: string | null; notes?: string | null;
}, correlationId: string) {
  if (input.origin_country === input.destination_country) throw unprocessable("ROUTE_INVALID", "Origine et destination identiques.");
  return withTransaction(async (tx) => {
    const oa = await loadAgency(tx, input.origin_agency_id);
    if (oa.country_code !== input.origin_country) throw unprocessable("AGENCY_COUNTRY_MISMATCH", "Agence d'origine hors du pays d'origine.");
    if (input.destination_agency_id) {
      const da = await loadAgency(tx, input.destination_agency_id);
      if (da.country_code !== input.destination_country) throw unprocessable("AGENCY_COUNTRY_MISMATCH", "Agence de destination hors du pays de destination.");
    }
    assertCan(actor, "canada.shipments.create", { countries: [input.origin_country], agencyIds: [input.origin_agency_id] });
    const s = await one(tx,
      `insert into canada.shipments(reference, origin_country, destination_country, origin_agency_id, destination_agency_id,
         transport_mode, carrier_name, notes, origin_responsible_id, created_by, updated_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$9) returning *`,
      [randomReference("SHP"), input.origin_country, input.destination_country, input.origin_agency_id,
       input.destination_agency_id ?? null, input.transport_mode, input.carrier_name ?? null, input.notes ?? null, actor.userId]);
    await shipmentEvent(tx, s, "shipment.created", null, "planned", actor.userId, s.origin_country, correlationId);
    await audit(tx, { actorUserId: actor.userId, action: "canada.shipment.created", resourceType: "shipment", resourceId: s.id,
      countryCode: s.origin_country, agencyId: s.origin_agency_id, next: { reference: s.reference }, correlationId });
    return s;
  });
}

export async function addParcels(actor: Principal, shipmentId: string, parcelIds: string[], correlationId: string) {
  return withTransaction(async (tx) => {
    const s = await loadShipment(tx, shipmentId, true);
    assertCan(actor, "canada.shipments.consolidate", shipmentOrigin(s));
    if (!["planned", "ready"].includes(s.status)) throw conflict("SHIPMENT_LOCKED", "Expédition déjà partie ou annulée.");
    const added: string[] = [];
    for (const pid of [...new Set(parcelIds)]) {
      const p = await one(tx, `select * from canada.parcels where id = $1 for update`, [pid]);
      if (!p) throw unprocessable("PARCEL_UNKNOWN", msg("Colis inconnu : {p0}.", { p0: pid }));
      if (p.origin_country !== s.origin_country || p.destination_country !== s.destination_country) {
        throw unprocessable("ROUTE_MISMATCH", msg("Le colis {p0} n'a pas la même origine/destination que l'expédition.", { p0: p.reference }));
      }
      if (p.transport_mode !== s.transport_mode) throw unprocessable("MODE_MISMATCH", msg("Mode de transport incompatible pour {p0}.", { p0: p.reference }));
      if (p.status !== "ready_for_shipment") throw unprocessable("PARCEL_NOT_READY", msg("Le colis {p0} n'est pas prêt (statut {p1}).", { p0: p.reference, p1: p.status }));
      assertCan(actor, "canada.shipments.consolidate", { countries: [p.origin_country], agencyIds: [p.origin_agency_id], warehouseIds: [p.current_warehouse_id] });
      try {
        await tx.query(`insert into canada.shipment_parcels(shipment_id, parcel_id, added_by) values ($1, $2, $3)`, [s.id, p.id, actor.userId]);
      } catch (err: any) {
        if (err?.code === "23505") throw conflict("PARCEL_ALREADY_IN_SHIPMENT", msg("Le colis {p0} appartient déjà à une expédition active.", { p0: p.reference }));
        throw err;
      }
      await tx.query(`update canada.parcels set status = 'in_shipment', updated_by = $2, row_version = row_version + 1 where id = $1`, [p.id, actor.userId]);
      await recordParcelEvent(tx, { parcel: p, type: "parcel.added_to_shipment", from: p.status, to: "in_shipment", actor: actor.userId,
        shipmentId: s.id, agencyId: s.origin_agency_id, source: "system", correlationId });
      added.push(p.id);
    }
    await shipmentEvent(tx, s, "shipment.parcels_added", s.status, s.status, actor.userId, s.origin_country, correlationId, null, { parcel_ids: added });
    await audit(tx, { actorUserId: actor.userId, action: "canada.shipment.consolidated", resourceType: "shipment", resourceId: s.id,
      countryCode: s.origin_country, next: { parcel_ids: added }, correlationId });
    return { shipment_id: s.id, added };
  });
}

export async function removeParcel(actor: Principal, shipmentId: string, parcelId: string, reason: string, correlationId: string) {
  return withTransaction(async (tx) => {
    const s = await loadShipment(tx, shipmentId, true);
    assertCan(actor, "canada.shipments.split", shipmentOrigin(s));
    if (!["planned", "ready"].includes(s.status)) throw conflict("SHIPMENT_LOCKED", "Retrait impossible après le départ.");
    const link = await one(tx,
      `update canada.shipment_parcels set removed_at = now(), removed_by = $3, removal_reason = $4
        where shipment_id = $1 and parcel_id = $2 and removed_at is null returning id`, [s.id, parcelId, actor.userId, reason]);
    if (!link) throw notFound("PARCEL_NOT_IN_SHIPMENT", "Ce colis n'est pas dans cette expédition.");
    const p = await one(tx, `update canada.parcels set status = 'ready_for_shipment', updated_by = $2, row_version = row_version + 1
                               where id = $1 returning id, reference, client_id`, [parcelId, actor.userId]);
    await recordParcelEvent(tx, { parcel: p, type: "parcel.removed_from_shipment", from: "in_shipment", to: "ready_for_shipment",
      actor: actor.userId, shipmentId: s.id, comment: reason, source: "system", correlationId });
    await shipmentEvent(tx, s, "shipment.parcel_removed", s.status, s.status, actor.userId, s.origin_country, correlationId, reason, { parcel_id: parcelId });
    return { shipment_id: s.id, removed: parcelId };
  });
}

async function setStatus(tx: Db, s: any, to: string, actor: string, extra = "") {
  await tx.query(`update canada.shipments set status = $2, updated_by = $3, row_version = row_version + 1 ${extra} where id = $1`, [s.id, to, actor]);
}

export async function markReady(actor: Principal, id: string, correlationId: string) {
  return withTransaction(async (tx) => {
    const s = await loadShipment(tx, id, true);
    assertCan(actor, "canada.shipments.plan", shipmentOrigin(s));
    if (s.status !== "planned") throw conflict("INVALID_STATE", msg("Statut actuel : {p0}.", { p0: s.status }));
    if (!(await activeParcels(tx, s.id)).length) throw unprocessable("SHIPMENT_EMPTY", "Aucun colis dans l'expédition.");
    await setStatus(tx, s, "ready", actor.userId);
    await shipmentEvent(tx, s, "shipment.ready", "planned", "ready", actor.userId, s.origin_country, correlationId);
    return { id: s.id, status: "ready" };
  });
}

export async function dispatchShipment(actor: Principal, id: string, correlationId: string) {
  return withTransaction(async (tx) => {
    const s = await loadShipment(tx, id, true);
    assertCan(actor, "canada.shipments.dispatch", shipmentOrigin(s));
    if (s.status !== "ready") throw conflict("INVALID_STATE", "L'expédition doit être prête avant le départ.");
    const flight = await one(tx,
      `select f.id, f.status from canada.flight_shipment_assignments a join canada.flights f on f.id = a.flight_id
        where a.shipment_id = $1 and a.unassigned_at is null order by a.leg_sequence limit 1`, [s.id]);
    if (s.transport_mode === "air") {
      if (!flight) throw unprocessable("FLIGHT_REQUIRED", "Une expédition aérienne doit être associée à un vol avant le départ.");
      if (flight.status === "CANCELLED") throw unprocessable("FLIGHT_CANCELLED", "Le vol associé est annulé : réaffectez l'expédition.");
    }
    const parcels = await activeParcels(tx, s.id);
    await setStatus(tx, s, "dispatched", actor.userId, ", dispatched_at = now()");
    for (const p of parcels) {
      await tx.query(`update canada.parcels set status = 'dispatched', row_version = row_version + 1, updated_by = $2 where id = $1`, [p.id, actor.userId]);
      await recordParcelEvent(tx, { parcel: p, type: "parcel.dispatched", from: p.status, to: "dispatched", actor: actor.userId,
        shipmentId: s.id, agencyId: s.origin_agency_id, source: "system", correlationId });
    }
    await shipmentEvent(tx, s, "shipment.dispatched", "ready", "dispatched", actor.userId, s.origin_country, correlationId);
    await emit(tx, { type: "canada.shipment.dispatched", aggregateType: "shipment", aggregateId: s.id, correlationId,
      payload: { shipment_id: s.id, reference: s.reference, parcel_count: parcels.length } });
    await audit(tx, { actorUserId: actor.userId, action: "canada.shipment.dispatched", resourceType: "shipment", resourceId: s.id,
      countryCode: s.origin_country, agencyId: s.origin_agency_id, correlationId });
    return { id: s.id, status: "dispatched", parcels: parcels.length };
  });
}

export async function arriveShipment(actor: Principal, id: string, correlationId: string) {
  return withTransaction(async (tx) => {
    const s = await loadShipment(tx, id, true);
    assertCan(actor, "canada.shipments.receive", shipmentDestination(s), "Arrivée confirmée par le pays de destination uniquement.");
    if (!["dispatched", "in_transit"].includes(s.status)) throw conflict("INVALID_STATE", msg("Statut actuel : {p0}.", { p0: s.status }));
    const parcels = await activeParcels(tx, s.id);
    await setStatus(tx, s, "arrived", actor.userId, ", arrived_at = now()");
    for (const p of parcels.filter((x) => ["dispatched", "in_transit"].includes(x.status))) {
      await tx.query(`update canada.parcels set status = 'arrived_destination', row_version = row_version + 1, updated_by = $2 where id = $1`, [p.id, actor.userId]);
      await recordParcelEvent(tx, { parcel: p, type: "parcel.arrived_destination", from: p.status, to: "arrived_destination",
        actor: actor.userId, shipmentId: s.id, agencyId: s.destination_agency_id, source: "system", correlationId });
    }
    await shipmentEvent(tx, s, "shipment.arrived", s.status, "arrived", actor.userId, s.destination_country, correlationId);
    await audit(tx, { actorUserId: actor.userId, action: "canada.shipment.arrived", resourceType: "shipment", resourceId: s.id,
      countryCode: s.destination_country, correlationId });
    return { id: s.id, status: "arrived", parcels: parcels.length };
  });
}

export async function completeShipment(actor: Principal, id: string, correlationId: string) {
  return withTransaction(async (tx) => {
    const s = await loadShipment(tx, id, true);
    assertCan(actor, "canada.shipments.close", shipmentDestination(s));
    if (s.status !== "arrived") throw conflict("INVALID_STATE", "L'expédition doit être arrivée.");
    const pending = (await activeParcels(tx, s.id)).filter((p) => ["dispatched", "in_transit", "arrived_destination", "in_customs"].includes(p.status));
    if (pending.length) {
      throw unprocessable("PARCELS_NOT_RECEIVED", "Des colis n'ont pas encore été réceptionnés physiquement.", pending.map((p) => p.reference));
    }
    await setStatus(tx, s, "completed", actor.userId, ", completed_at = now()");
    await shipmentEvent(tx, s, "shipment.completed", "arrived", "completed", actor.userId, s.destination_country, correlationId);
    return { id: s.id, status: "completed" };
  });
}

export async function cancelShipment(actor: Principal, id: string, reason: string, correlationId: string) {
  if (!reason?.trim()) throw badRequest("REASON_REQUIRED", "Motif obligatoire.");
  return withTransaction(async (tx) => {
    const s = await loadShipment(tx, id, true);
    assertCan(actor, "canada.shipments.cancel", shipmentOrigin(s));
    if (!["planned", "ready"].includes(s.status)) throw conflict("INVALID_STATE", "Seule une expédition non partie peut être annulée.");
    for (const p of await activeParcels(tx, s.id)) {
      await tx.query(`update canada.shipment_parcels set removed_at = now(), removed_by = $3, removal_reason = $4
                       where shipment_id = $1 and parcel_id = $2 and removed_at is null`, [s.id, p.id, actor.userId, `Annulation : ${reason}`]);
      await tx.query(`update canada.parcels set status = 'ready_for_shipment', row_version = row_version + 1, updated_by = $2 where id = $1`, [p.id, actor.userId]);
      await recordParcelEvent(tx, { parcel: p, type: "parcel.removed_from_shipment", from: p.status, to: "ready_for_shipment",
        actor: actor.userId, shipmentId: s.id, comment: reason, source: "system", correlationId });
    }
    await tx.query(`update canada.flight_shipment_assignments set unassigned_at = now(), unassigned_by = $2, unassign_reason = $3
                     where shipment_id = $1 and unassigned_at is null`, [s.id, actor.userId, `Annulation de l'expédition : ${reason}`]);
    await setStatus(tx, s, "cancelled", actor.userId, ", cancelled_at = now()");
    await shipmentEvent(tx, s, "shipment.cancelled", s.status, "cancelled", actor.userId, s.origin_country, correlationId, reason);
    await audit(tx, { actorUserId: actor.userId, action: "canada.shipment.cancelled", resourceType: "shipment", resourceId: s.id, reason, correlationId });
    return { id: s.id, status: "cancelled" };
  });
}

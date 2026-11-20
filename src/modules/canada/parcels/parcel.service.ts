import type { Db } from "../../../core/db.js";
import { one, withTransaction } from "../../../core/db.js";
import { audit } from "../../../core/audit.js";
import { badRequest, conflict, forbidden, unprocessable, msg, t } from "../../../core/errors.js";
import { emit } from "../../../core/outbox.js";
import { randomReference } from "../../../core/references.js";
import { assertCan, can, type Principal, type ResourceScope } from "../../access/authorization.js";
import { destinationResource, findActivePricingRule, loadAgency, loadParcel, originResource, parcelResource, type ParcelRow } from "../common.js";
import { computeWeights, TERMINAL, transitionRule } from "./parcel.rules.js";

export interface CreateParcelInput {
  client_id: string;
  recipient_client_id?: string | null;
  recipient_name?: string | null;
  recipient_phone?: string | null;
  origin_country: string;
  destination_country: string;
  origin_agency_id: string;
  destination_agency_id?: string | null;
  transport_mode: "air" | "sea" | "road";
  category: string;
  description?: string | null;
  item_count: number;
  declared_value?: string | null;
  declared_value_currency?: string | null;
  fragile: boolean;
  received_now: boolean;
  warehouse_id?: string | null;
}

/** Écrit l'événement de colis + l'événement outbox (notification) dans la transaction. */
export async function recordParcelEvent(tx: Db, e: {
  parcel: Pick<ParcelRow, "id" | "reference" | "client_id">; type: string; from: string | null; to: string | null;
  actor: string | null; agencyId?: string | null; warehouseId?: string | null; shipmentId?: string | null;
  location?: string | null; source?: string; visibility?: "client" | "internal"; comment?: string | null;
  proof?: string | null; occurredAt?: string | null; correctsEventId?: string | null; correlationId?: string | null;
}) {
  const r = await tx.query(
    `insert into canada.parcel_events(parcel_id, event_type, from_status, to_status, occurred_at, actor_user_id, agency_id,
       warehouse_id, shipment_id, location_text, source, visibility, comment, proof_reference, corrects_event_id, correlation_id)
     values ($1,$2,$3,$4,coalesce($5::timestamptz, now()),$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) returning id, occurred_at`,
    [e.parcel.id, e.type, e.from, e.to, e.occurredAt ?? null, e.actor, e.agencyId ?? null, e.warehouseId ?? null,
     e.shipmentId ?? null, e.location ?? null, e.source ?? "manual", e.visibility ?? "client", e.comment ?? null,
     e.proof ?? null, e.correctsEventId ?? null, e.correlationId ?? null]);
  if (e.to && e.from !== e.to && (e.visibility ?? "client") === "client") {
    await emit(tx, {
      type: "canada.parcel.status_changed", aggregateType: "parcel", aggregateId: e.parcel.id, correlationId: e.correlationId,
      payload: { parcel_id: e.parcel.id, reference: e.parcel.reference, client_id: e.parcel.client_id, from: e.from, to: e.to,
                 event_id: r.rows[0].id, occurred_at: r.rows[0].occurred_at },
    });
  }
  return r.rows[0];
}

export async function createParcel(actor: Principal, input: CreateParcelInput, correlationId: string) {
  if (input.origin_country === input.destination_country) {
    throw unprocessable("ROUTE_INVALID", "L'origine et la destination doivent être différentes.");
  }
  if (!input.recipient_client_id && !input.recipient_name) {
    throw badRequest("RECIPIENT_REQUIRED", "Destinataire requis (fiche client ou nom).");
  }
  return withTransaction(async (tx) => {
    const originAgency = await loadAgency(tx, input.origin_agency_id);
    if (originAgency.country_code !== input.origin_country || originAgency.status !== "active") {
      throw unprocessable("AGENCY_COUNTRY_MISMATCH", "L'agence d'origine doit être active et située dans le pays d'origine.");
    }
    if (input.destination_agency_id) {
      const dest = await loadAgency(tx, input.destination_agency_id);
      if (dest.country_code !== input.destination_country) {
        throw unprocessable("AGENCY_COUNTRY_MISMATCH", "L'agence de destination doit être dans le pays de destination.");
      }
    }
    const scope: ResourceScope = { countries: [input.origin_country], agencyIds: [input.origin_agency_id], warehouseIds: [input.warehouse_id] };
    assertCan(actor, "canada.parcels.create", scope, "Création de colis hors de votre périmètre (agence d'origine).");
    if (input.received_now) assertCan(actor, "canada.parcels.receive", scope);

    if (input.warehouse_id) {
      const w = await one(tx, `select agency_id from canada.warehouses where id = $1 and status = 'active'`, [input.warehouse_id]);
      if (!w || w.agency_id !== input.origin_agency_id) throw unprocessable("WAREHOUSE_INVALID", "Entrepôt inactif ou d'une autre agence.");
    }
    for (const cid of [input.client_id, input.recipient_client_id].filter(Boolean)) {
      const c = await one(tx, `select status from canada.clients where id = $1`, [cid]);
      if (!c) throw unprocessable("CLIENT_UNKNOWN", "Client inconnu.");
      if (c.status !== "active") throw unprocessable("CLIENT_INACTIVE", "Client inactif ou bloqué.");
    }

    const status = input.received_now ? "received" : "expected";
    const reference = randomReference("TA");
    const p = await one(tx,
      `insert into canada.parcels(reference, client_id, recipient_client_id, recipient_name, recipient_phone, origin_country,
         destination_country, origin_agency_id, destination_agency_id, current_warehouse_id, transport_mode, category, description,
         item_count, declared_value, declared_value_currency, fragile, status, created_by, updated_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$19) returning *`,
      [reference, input.client_id, input.recipient_client_id ?? null, input.recipient_name ?? null, input.recipient_phone ?? null,
       input.origin_country, input.destination_country, input.origin_agency_id, input.destination_agency_id ?? null,
       input.warehouse_id ?? null, input.transport_mode, input.category, input.description ?? null, input.item_count,
       input.declared_value ?? null, input.declared_value_currency ?? null, input.fragile, status, actor.userId]);
    await recordParcelEvent(tx, {
      parcel: p, type: "parcel.registered", from: null, to: "expected", actor: actor.userId, agencyId: input.origin_agency_id,
      source: "manual", correlationId,
    });
    if (input.received_now) {
      await recordParcelEvent(tx, {
        parcel: p, type: "parcel.received", from: "expected", to: "received", actor: actor.userId,
        agencyId: input.origin_agency_id, warehouseId: input.warehouse_id, source: "manual", correlationId,
      });
    }
    await audit(tx, { actorUserId: actor.userId, action: "canada.parcel.created", resourceType: "parcel", resourceId: p.id,
      countryCode: input.origin_country, agencyId: input.origin_agency_id, next: { reference, status }, correlationId });
    return p;
  });
}

export async function transitionParcel(actor: Principal, parcelId: string, input: {
  to_status: string; comment?: string | null; location_text?: string | null; proof_reference?: string | null;
  occurred_at?: string | null; source?: "scan" | "manual"; warehouse_id?: string | null; expected_row_version?: number;
}, correlationId: string) {
  return withTransaction(async (tx) => {
    const p = await loadParcel(tx, parcelId, true);
    if (input.expected_row_version !== undefined && input.expected_row_version !== p.row_version) {
      throw conflict("STALE_VERSION", "Le colis a été modifié entre-temps ; rechargez-le.");
    }
    if (TERMINAL.includes(p.status as any)) throw conflict("PARCEL_TERMINAL", "Ce colis est dans un état final.");
    const rule = transitionRule(p.status, input.to_status);
    if (!rule) throw unprocessable("TRANSITION_NOT_ALLOWED", msg("Transition {p0} → {p1} interdite.", { p0: p.status, p1: input.to_status }));
    if (rule.system) throw unprocessable("TRANSITION_SYSTEM_ONLY", "Cette étape est pilotée par l'expédition, pas par une saisie directe.");
    const resource = rule.phase === "origin" ? originResource(p) : rule.phase === "destination" ? destinationResource(p) : parcelResource(p);
    assertCan(actor, rule.permission, resource,
      rule.phase === "destination" ? t("Étape réservée au pays / à l'agence de destination.") :
      rule.phase === "origin" ? t("Étape réservée au pays / à l'agence d'origine.") : undefined);
    if (rule.requiresComment && !input.comment?.trim()) throw badRequest("COMMENT_REQUIRED", "Un motif est obligatoire pour cette étape.");
    if (rule.requiresProof && !input.proof_reference?.trim()) {
      throw badRequest("PROOF_REQUIRED", "Une preuve de remise est obligatoire pour déclarer la livraison.");
    }
    if (rule.requiresMeasurement && !p.billable_weight_kg) {
      throw unprocessable("MEASUREMENT_REQUIRED", "Le colis doit être pesé avant d'être déclaré prêt.");
    }
    let warehouseId = p.current_warehouse_id;
    if (input.warehouse_id) {
      const w = await one(tx, `select id, country_code, agency_id from canada.warehouses where id = $1 and status = 'active'`, [input.warehouse_id]);
      const expectedCountry = rule.phase === "destination" ? p.destination_country : p.origin_country;
      if (!w || (rule.phase !== "any" && w.country_code !== expectedCountry)) throw unprocessable("WAREHOUSE_INVALID", "Entrepôt invalide pour cette étape.");
      warehouseId = w.id;
    }
    await tx.query(
      `update canada.parcels set status = $2::text, current_warehouse_id = $3, updated_by = $4, row_version = row_version + 1,
              delivered_at = case when $2::text = 'delivered' then coalesce($5::timestamptz, now()) else delivered_at end
        where id = $1`, [p.id, input.to_status, warehouseId, actor.userId, input.occurred_at ?? null]);
    const evt = await recordParcelEvent(tx, {
      parcel: p, type: `parcel.${input.to_status}`, from: p.status, to: input.to_status, actor: actor.userId,
      agencyId: rule.phase === "destination" ? p.destination_agency_id : p.origin_agency_id, warehouseId,
      location: input.location_text, source: input.source ?? "manual", comment: input.comment, proof: input.proof_reference,
      occurredAt: input.occurred_at, correlationId,
    });
    await audit(tx, { actorUserId: actor.userId, action: "canada.parcel.status_changed", resourceType: "parcel", resourceId: p.id,
      countryCode: rule.phase === "destination" ? p.destination_country : p.origin_country,
      previous: { status: p.status }, next: { status: input.to_status }, reason: input.comment ?? null, correlationId });
    return { id: p.id, reference: p.reference, from: p.status, status: input.to_status, event_id: evt.id, row_version: p.row_version + 1 };
  });
}

export async function measureParcel(actor: Principal, parcelId: string, input: {
  actual_weight_kg: string; length_cm?: string | null; width_cm?: string | null; height_cm?: string | null; reason?: string | null; warehouse_id?: string | null;
}, correlationId: string) {
  const dims = [input.length_cm, input.width_cm, input.height_cm];
  if (dims.some(Boolean) && !dims.every(Boolean)) throw badRequest("DIMENSIONS_INCOMPLETE", "Longueur, largeur et hauteur vont ensemble.");
  return withTransaction(async (tx) => {
    const p = await loadParcel(tx, parcelId, true);
    const atDestination = ["arrived_destination", "received_destination", "available", "in_customs"].includes(p.status);
    const resource = atDestination ? destinationResource(p) : originResource(p);
    assertCan(actor, "canada.parcels.weigh", resource);
    if (dims.some(Boolean)) assertCan(actor, "canada.parcels.measure", resource);
    if (!["received", "inspected", "received_destination", "on_hold", "damaged"].includes(p.status)) {
      throw unprocessable("MEASUREMENT_NOT_ALLOWED", msg("Pesée impossible au statut « {p0} ».", { p0: p.status }));
    }
    const isRemeasure = p.billable_weight_kg !== null;
    if (isRemeasure && !input.reason?.trim()) throw badRequest("REASON_REQUIRED", "Motif obligatoire pour une nouvelle pesée.");

    const rule = await findActivePricingRule(tx, { origin: p.origin_country, destination: p.destination_country, mode: p.transport_mode, category: p.category });
    if (!rule) {
      throw unprocessable("PRICING_RULE_MISSING", "Aucun barème actif pour cette route : diviseur volumétrique inconnu (à configurer par la finance).");
    }
    const w = computeWeights(input.actual_weight_kg, { length: input.length_cm, width: input.width_cm, height: input.height_cm }, rule.volumetric_divisor);
    const m = await one(tx,
      `insert into canada.parcel_measurements(parcel_id, actual_weight_kg, length_cm, width_cm, height_cm, volumetric_divisor,
         volumetric_weight_kg, billable_weight_kg, warehouse_id, measured_by, reason)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning *`,
      [p.id, w.actual, input.length_cm ?? null, input.width_cm ?? null, input.height_cm ?? null, rule.volumetric_divisor,
       w.volumetric, w.billable, input.warehouse_id ?? p.current_warehouse_id, actor.userId, input.reason ?? null]);
    await tx.query(
      `update canada.parcels set actual_weight_kg = $2, length_cm = $3, width_cm = $4, height_cm = $5, volumetric_divisor = $6,
              volumetric_weight_kg = $7, billable_weight_kg = $8, measured_at = now(), updated_by = $9, row_version = row_version + 1
        where id = $1`,
      [p.id, w.actual, input.length_cm ?? null, input.width_cm ?? null, input.height_cm ?? null, rule.volumetric_divisor, w.volumetric, w.billable, actor.userId]);
    await recordParcelEvent(tx, { parcel: p, type: "parcel.measured", from: p.status, to: p.status, actor: actor.userId,
      warehouseId: input.warehouse_id ?? p.current_warehouse_id, visibility: "internal",
      comment: isRemeasure ? `Nouvelle pesée : ${input.reason}` : null, correlationId });

    // Écart de poids après un devis émis : régularisation requise (Dossier 05 §12.4).
    if (isRemeasure && p.billable_weight_kg !== w.billable) {
      const quoted = await one(tx,
        `select qv.id from canada.quotation_lines ql join canada.quotation_versions qv on qv.id = ql.quotation_version_id
          where ql.parcel_id = $1 and qv.status in ('issued','viewed','accepted') limit 1`, [p.id]);
      if (quoted) {
        await emit(tx, { type: "canada.parcel.weight_discrepancy", aggregateType: "parcel", aggregateId: p.id, correlationId,
          payload: { parcel_id: p.id, reference: p.reference, client_id: p.client_id, previous_billable_kg: p.billable_weight_kg,
                     new_billable_kg: w.billable, quotation_version_id: quoted.id } });
      }
    }
    await audit(tx, { actorUserId: actor.userId, action: isRemeasure ? "canada.parcel.remeasured" : "canada.parcel.measured",
      resourceType: "parcel", resourceId: p.id, previous: isRemeasure ? { billable_weight_kg: p.billable_weight_kg } : undefined,
      next: { actual: w.actual, volumetric: w.volumetric, billable: w.billable, divisor: rule.volumetric_divisor, pricing_rule_id: rule.id },
      reason: input.reason ?? null, correlationId });
    return m;
  });
}

/** Correction d'un événement : nouvelle trace motivée, l'original n'est jamais modifié (Dossier 05 §15.3). */
export async function correctParcelEvent(actor: Principal, parcelId: string, eventId: string, comment: string, correlationId: string) {
  return withTransaction(async (tx) => {
    const p = await loadParcel(tx, parcelId, true);
    assertCan(actor, "canada.parcels.manage_exception", parcelResource(p));
    const e = await one(tx, `select id, event_type from canada.parcel_events where id = $1 and parcel_id = $2`, [eventId, p.id]);
    if (!e) throw unprocessable("EVENT_UNKNOWN", "Événement inconnu pour ce colis.");
    const c = await recordParcelEvent(tx, { parcel: p, type: "parcel.event_corrected", from: p.status, to: p.status, actor: actor.userId,
      comment, correctsEventId: e.id, visibility: "internal", correlationId });
    await audit(tx, { actorUserId: actor.userId, action: "canada.parcel.event_corrected", resourceType: "parcel_event",
      resourceId: e.id, reason: comment, correlationId });
    return c;
  });
}

export function canReadParcel(actor: Principal, p: ParcelRow) {
  const r = parcelResource(p);
  return can(actor, "canada.parcels.read_scoped", r) || can(actor, "canada.parcels.read_own", r);
}

export function assertReadParcel(actor: Principal, p: ParcelRow) {
  if (!canReadParcel(actor, p)) throw forbidden("FORBIDDEN", "Colis hors de votre périmètre.");
}

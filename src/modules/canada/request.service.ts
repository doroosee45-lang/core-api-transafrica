import type { Db } from "../../core/db.js";
import { one } from "../../core/db.js";
import { forbidden } from "../../core/errors.js";
import { emit } from "../../core/outbox.js";
import { randomReference } from "../../core/references.js";
import type { Principal } from "../access/authorization.js";

export interface ClientRequestInput {
  origin_country: string;
  destination_country: string;
  shipment_type: "parcel" | "kilogram" | "pallet" | "documents" | "other";
  estimated_weight_kg?: number;
  message?: string;
  preferred_agency_id?: string;
}

export interface PublicRequestInput extends ClientRequestInput {
  full_name: string;
  company?: string;
  email: string;
  phone: string;
  estimated_volume_m3?: number;
}

/** All writes use the caller's transaction: request and outbox event commit or roll back together. */
export async function createClientRequest(d: Db, principal: Principal, body: ClientRequestInput, correlationId: string) {
  const c = await one(d, `select id, first_name, last_name, email, phone from canada.clients where user_id = $1`, [principal.userId]);
  if (!c) throw forbidden("CLIENT_PROFILE_MISSING", "Aucune fiche client rattachée à ce compte.");
  const r = await one(d,
    `insert into canada.requests(reference, source, client_id, requester_user_id, full_name, email, phone, origin_country, destination_country,
       preferred_agency_id, shipment_type, estimated_weight_kg, message, correlation_id)
     values ($1,'client_app',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning id, reference, status, created_at`,
    [randomReference("REQ", 8), c.id, principal.userId, `${c.first_name} ${c.last_name}`, c.email ?? principal.email, c.phone,
     body.origin_country, body.destination_country, body.preferred_agency_id ?? null, body.shipment_type, body.estimated_weight_kg ?? null, body.message ?? null, correlationId]);
  await emit(d, { type: "canada.request.created", aggregateType: "request", aggregateId: r.id, correlationId,
    payload: { request_id: r.id, reference: r.reference, origin_country: body.origin_country, destination_country: body.destination_country } });
  return r;
}

export async function createPublicRequest(d: Db, body: PublicRequestInput, correlationId: string) {
  const r = await one(d,
    `insert into canada.requests(reference, source, full_name, company, email, phone, origin_country, destination_country, shipment_type,
       estimated_weight_kg, estimated_volume_m3, message, correlation_id)
     values ($1,'public_form',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning id, reference, status, created_at`,
    [randomReference("REQ", 8), body.full_name, body.company ?? null, body.email, body.phone, body.origin_country, body.destination_country,
     body.shipment_type, body.estimated_weight_kg ?? null, body.estimated_volume_m3 ?? null, body.message ?? null, correlationId]);
  await emit(d, { type: "canada.request.created", aggregateType: "request", aggregateId: r.id, correlationId,
    payload: { request_id: r.id, reference: r.reference, origin_country: body.origin_country, destination_country: body.destination_country } });
  const { id: _id, ...response } = r;
  return response;
}

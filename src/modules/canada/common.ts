import type { Db } from "../../core/db.js";
import { one } from "../../core/db.js";
import { notFound, unprocessable } from "../../core/errors.js";
import type { ResourceScope } from "../access/authorization.js";

export interface ParcelRow {
  id: string; reference: string; client_id: string; recipient_client_id: string | null; status: string;
  origin_country: string; destination_country: string; origin_agency_id: string; destination_agency_id: string | null;
  current_warehouse_id: string | null; transport_mode: string; category: string; row_version: number;
  billable_weight_kg: string | null; owner_user_id: string | null; recipient_user_id: string | null;
}

export async function loadParcel(d: Db, id: string, lock = false): Promise<ParcelRow> {
  const p = await one<ParcelRow>(d,
    `select p.*, c.user_id as owner_user_id, rc.user_id as recipient_user_id
       from canada.parcels p join canada.clients c on c.id = p.client_id
       left join canada.clients rc on rc.id = p.recipient_client_id
      where p.id = $1 ${lock ? "for update of p" : ""}`, [id]);
  if (!p) throw notFound("PARCEL_NOT_FOUND", "Colis introuvable.");
  return p;
}

/** Périmètre complet du colis (lecture, exceptions). */
export const parcelResource = (p: ParcelRow): ResourceScope => ({
  countries: [p.origin_country, p.destination_country],
  agencyIds: [p.origin_agency_id, p.destination_agency_id],
  warehouseIds: [p.current_warehouse_id],
  ownerUserIds: [p.owner_user_id, p.recipient_user_id],
});

/** Responsabilités du pays d'origine / de destination (Cahier §17). */
export const originResource = (p: ParcelRow): ResourceScope => ({
  countries: [p.origin_country], agencyIds: [p.origin_agency_id], warehouseIds: [p.current_warehouse_id],
});
export const destinationResource = (p: ParcelRow): ResourceScope => ({
  countries: [p.destination_country], agencyIds: [p.destination_agency_id], warehouseIds: [p.current_warehouse_id],
});

export async function loadAgency(d: Db, id: string) {
  const a = await one(d, `select id, code, name, country_code, status, timezone from canada.agencies where id = $1`, [id]);
  if (!a) throw unprocessable("AGENCY_UNKNOWN", "Agence inconnue.");
  return a;
}

/** Barème actif applicable (route + mode + catégorie, sinon règle générique de la route). */
export async function findActivePricingRule(d: Db, q: { origin: string; destination: string; mode: string; category?: string | null; at?: Date }) {
  return one(d,
    `select * from canada.pricing_rules
      where status = 'active' and origin_country = $1 and destination_country = $2 and transport_mode = $3
        and (category = $4 or category is null)
        and effective_from <= $5 and (effective_to is null or effective_to > $5)
      order by (category is not null) desc, effective_from desc limit 1`,
    [q.origin, q.destination, q.mode, q.category ?? null, q.at ?? new Date()]);
}

export function paginate(page: number, limit: number, total: number) {
  return { pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
}

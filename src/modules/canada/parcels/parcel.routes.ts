import { Router } from "express";
import { z } from "zod";
import { db } from "../../../core/db.js";
import { notFound, t } from "../../../core/errors.js";
import { PageQuery } from "../../../core/http.js";
import { mount, route } from "../../../core/routes.js";
import { CountryCode, CurrencyCode, IdParams, Money, ParcelCategory, TransportMode } from "../../../core/schemas.js";
import { isEmptyScope, scopeClause, scopeFilter } from "../../access/authorization.js";
import { loadParcel, paginate } from "../common.js";
import { assertReadParcel, correctParcelEvent, createParcel, measureParcel, transitionParcel } from "./parcel.service.js";

const READ = ["canada.parcels.read_scoped", "canada.parcels.read_own"];
const Dim = z.union([z.string(), z.number()]).transform(String).refine((v) => /^\d{1,6}(\.\d{1,2})?$/.test(v) && Number(v) > 0, t("Dimension positive (cm)"));

export async function parcelDetail(id: string, includeInternal: boolean) {
  const p = (await db.query(
    `select p.*, c.client_number, c.first_name as client_first_name, c.last_name as client_last_name,
            oa.name as origin_agency_name, da.name as destination_agency_name
       from canada.parcels p join canada.clients c on c.id = p.client_id
       join canada.agencies oa on oa.id = p.origin_agency_id left join canada.agencies da on da.id = p.destination_agency_id
      where p.id = $1`, [id])).rows[0];
  const events = (await db.query(
    `select id, event_type, from_status, to_status, occurred_at, recorded_at, location_text, source, visibility, comment,
            proof_reference, corrects_event_id, shipment_id
       from canada.parcel_events where parcel_id = $1 ${includeInternal ? "" : "and visibility = 'client'"} order by occurred_at, recorded_at`, [id])).rows;
  const measurements = includeInternal ? (await db.query(
    `select * from canada.parcel_measurements where parcel_id = $1 order by measured_at`, [id])).rows : undefined;
  const shipment = (await db.query(
    `select s.id, s.reference, s.status, s.transport_mode, sp.added_at
       from canada.shipment_parcels sp join canada.shipments s on s.id = sp.shipment_id
      where sp.parcel_id = $1 and sp.removed_at is null`, [id])).rows[0] ?? null;
  return { ...p, events, measurements, shipment };
}

const routes = [
  route({
    method: "get", path: "/canada/parcels", tag: "Colis", auth: "canada", anyPermission: READ,
    summary: "Liste des colis du périmètre (ou de l'appelant s'il est client)",
    query: PageQuery.extend({
      status: z.string().max(30).optional(), origin_country: CountryCode.optional(), destination_country: CountryCode.optional(),
      agency_id: z.uuid().optional(), client_id: z.uuid().optional(), reference: z.string().trim().max(30).optional(),
    }),
    handler: async ({ query, principal }) => {
      const f = scopeFilter(principal, READ);
      if (isEmptyScope(f)) return { data: [], meta: paginate(query.page, query.limit, 0) };
      const params: unknown[] = [];
      const where = [scopeClause(f, {
        countries: ["p.origin_country", "p.destination_country"], agencies: ["p.origin_agency_id", "p.destination_agency_id"],
        warehouses: ["p.current_warehouse_id"], ownerUser: ["c.user_id", "rc.user_id"],
      }, params)];
      // Les filtres demandés s'AJOUTENT au périmètre (and) : ils ne peuvent jamais l'élargir.
      const add = (sql: string, v: unknown) => { params.push(v); where.push(sql.replace(/\?/g, `$${params.length}`)); };
      if (query.status) add("p.status = ?", query.status);
      if (query.origin_country) add("p.origin_country = ?", query.origin_country);
      if (query.destination_country) add("p.destination_country = ?", query.destination_country);
      if (query.agency_id) add("(p.origin_agency_id = ? or p.destination_agency_id = ?)", query.agency_id);
      if (query.client_id) add("(p.client_id = ? or p.recipient_client_id = ?)", query.client_id);
      if (query.reference) add("p.reference ilike ?", `${query.reference.replace(/[%_\\]/g, "")}%`);
      const from = `from canada.parcels p join canada.clients c on c.id = p.client_id left join canada.clients rc on rc.id = p.recipient_client_id where ${where.join(" and ")}`;
      const total = (await db.query(`select count(*)::int n ${from}`, params)).rows[0].n;
      const rows = (await db.query(
        `select p.id, p.reference, p.status, p.origin_country, p.destination_country, p.origin_agency_id, p.destination_agency_id,
                p.transport_mode, p.category, p.billable_weight_kg, p.created_at, c.client_number,
                c.first_name || ' ' || c.last_name as client_name
           ${from} order by p.created_at desc limit ${query.limit} offset ${(query.page - 1) * query.limit}`, params)).rows;
      return { data: rows, meta: paginate(query.page, query.limit, total) };
    },
  }),
  route({
    method: "post", path: "/canada/parcels", tag: "Colis", auth: "canada", anyPermission: ["canada.parcels.create"], idempotent: true,
    summary: "Enregistrer un colis (agence d'origine du périmètre)",
    body: z.object({
      client_id: z.uuid(), recipient_client_id: z.uuid().nullable().optional(),
      recipient_name: z.string().trim().max(200).nullable().optional(), recipient_phone: z.string().trim().max(40).nullable().optional(),
      origin_country: CountryCode, destination_country: CountryCode, origin_agency_id: z.uuid(),
      destination_agency_id: z.uuid().nullable().optional(), transport_mode: TransportMode.default("air"),
      category: ParcelCategory.default("other"), description: z.string().trim().max(2000).nullable().optional(),
      item_count: z.number().int().min(1).max(10000).default(1), declared_value: Money.nullable().optional(),
      declared_value_currency: CurrencyCode.nullable().optional(), fragile: z.boolean().default(false),
      received_now: z.boolean().default(true), warehouse_id: z.uuid().nullable().optional(),
    }),
    handler: async ({ body, principal, correlationId }) => ({ status: 201, data: await createParcel(principal, body, correlationId) }),
  }),
  route({
    method: "get", path: "/canada/parcels/by-reference/:reference", tag: "Colis", auth: "canada", anyPermission: READ,
    summary: "Recherche par référence scannée (QR / code-barres)",
    params: z.object({ reference: z.string().trim().toUpperCase().regex(/^TAC?-[A-Z0-9]{6,20}$/) }),
    handler: async ({ params, principal }) => {
      const r = (await db.query(`select id from canada.parcels where reference = $1`, [params.reference])).rows[0];
      if (!r) throw notFound("PARCEL_NOT_FOUND", "Colis introuvable.");
      const p = await loadParcel(db, r.id);
      assertReadParcel(principal, p);
      return { data: await parcelDetail(p.id, principal.grants.some((g) => g.scopeType !== "own")) };
    },
  }),
  route({
    method: "get", path: "/canada/parcels/:id", tag: "Colis", auth: "canada", anyPermission: READ,
    summary: "Détail d'un colis (historique, mesures, expédition)",
    params: IdParams,
    handler: async ({ params, principal }) => {
      const p = await loadParcel(db, params.id);
      assertReadParcel(principal, p);
      const staff = principal.grants.some((g) => g.scopeType !== "own" && g.permissions.has("canada.parcels.read_scoped"));
      return { data: await parcelDetail(p.id, staff) };
    },
  }),
  route({
    method: "post", path: "/canada/parcels/:id/transitions", tag: "Colis", auth: "canada", idempotent: true,
    anyPermission: ["canada.parcels.receive", "canada.parcels.update_status", "canada.parcels.release", "canada.parcels.report_damage", "canada.parcels.manage_exception"],
    summary: "Faire avancer le statut logistique (transitions contrôlées, origine/destination)",
    params: IdParams,
    body: z.object({
      to_status: z.string().max(30), comment: z.string().trim().max(2000).nullable().optional(),
      location_text: z.string().trim().max(200).nullable().optional(), proof_reference: z.string().trim().max(500).nullable().optional(),
      occurred_at: z.iso.datetime({ offset: true }).nullable().optional(), source: z.enum(["scan", "manual"]).default("manual"),
      warehouse_id: z.uuid().nullable().optional(), expected_row_version: z.number().int().positive().optional(),
    }),
    handler: async ({ params, body, principal, correlationId }) => ({ data: await transitionParcel(principal, params.id, body, correlationId) }),
  }),
  route({
    method: "post", path: "/canada/parcels/:id/measurements", tag: "Colis", auth: "canada", anyPermission: ["canada.parcels.weigh"], idempotent: true,
    summary: "Pesée et dimensions : poids réel, volumétrique (diviseur du barème) et facturable",
    params: IdParams,
    body: z.object({
      actual_weight_kg: z.union([z.string(), z.number()]).transform(String).refine((v) => /^\d{1,6}(\.\d{1,3})?$/.test(v) && Number(v) > 0, t("Poids positif (kg)")),
      length_cm: Dim.nullable().optional(), width_cm: Dim.nullable().optional(), height_cm: Dim.nullable().optional(),
      reason: z.string().trim().max(1000).nullable().optional(), warehouse_id: z.uuid().nullable().optional(),
    }),
    handler: async ({ params, body, principal, correlationId }) => ({ status: 201, data: await measureParcel(principal, params.id, body, correlationId) }),
  }),
  route({
    method: "post", path: "/canada/parcels/:id/events/:eventId/corrections", tag: "Colis", auth: "canada", anyPermission: ["canada.parcels.manage_exception"],
    summary: "Corriger un événement (nouvelle trace motivée, l'original reste intact)",
    params: z.object({ id: z.uuid(), eventId: z.uuid() }), body: z.object({ comment: z.string().trim().min(5).max(2000) }),
    handler: async ({ params, body, principal, correlationId }) => ({ status: 201, data: await correctParcelEvent(principal, params.id, params.eventId, body.comment, correlationId) }),
  }),
];

export function parcelRouter() {
  const r = Router();
  mount(r, routes);
  return r;
}

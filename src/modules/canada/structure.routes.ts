import { Router } from "express";
import { z } from "zod";
import { db, one, withTransaction } from "../../core/db.js";
import { audit } from "../../core/audit.js";
import { conflict, notFound, unprocessable } from "../../core/errors.js";
import { PageQuery } from "../../core/http.js";
import { mount, route } from "../../core/routes.js";
import { sequentialReference } from "../../core/references.js";
import { CountryCode, Email, IanaTimeZone, IdParams } from "../../core/schemas.js";
import { assertCan, GLOBAL_RESOURCE, isEmptyScope, scopeClause, scopeFilter } from "../access/authorization.js";
import { loadAgency, paginate } from "./common.js";

const Code = z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{2,20}$/);

async function loadClient(id: string) {
  const c = await one(db, `select * from canada.clients where id = $1`, [id]);
  if (!c) throw notFound("CLIENT_NOT_FOUND", "Client introuvable.");
  return c;
}

const clientResource = async (c: any) => {
  // Un client est visible du pays/agence de rattachement ET de ceux où il a des colis.
  const routes = (await db.query(
    `select distinct unnest(array[origin_country, destination_country]) as cc, unnest(array[origin_agency_id, destination_agency_id]) as ag
       from canada.parcels where client_id = $1 or recipient_client_id = $1`, [c.id])).rows;
  return {
    countries: [c.residence_country, ...routes.map((r) => r.cc)],
    agencyIds: [c.home_agency_id, ...routes.map((r) => r.ag)],
    ownerUserIds: [c.user_id],
  };
};

const routes = [
  // ---------- Pays et devises ----------
  route({
    method: "get", path: "/canada/countries", tag: "Référentiels", auth: "canada",
    summary: "Pays (les cinq pays d'exploitation et les pays de transit déclarés)",
    handler: async () => ({ data: (await db.query(`select * from shared.countries order by is_operating desc, name_fr`)).rows }),
  }),
  route({
    method: "patch", path: "/canada/countries/:code", tag: "Référentiels", auth: "canada", anyPermission: ["canada.countries.manage"],
    summary: "Activer / désactiver un pays (administration globale)",
    params: z.object({ code: CountryCode }), body: z.object({ is_active: z.boolean().optional(), is_operating: z.boolean().optional() }),
    handler: async ({ params, body, principal, correlationId }) => {
      assertCan(principal, "canada.countries.manage", GLOBAL_RESOURCE);
      return withTransaction(async (tx) => {
        const prev = await one(tx, `select * from shared.countries where code = $1 for update`, [params.code]);
        if (!prev) throw notFound("COUNTRY_NOT_FOUND", "Pays inconnu.");
        const r = await one(tx, `update shared.countries set is_active = coalesce($2, is_active), is_operating = coalesce($3, is_operating) where code = $1 returning *`,
          [params.code, body.is_active ?? null, body.is_operating ?? null]);
        await audit(tx, { actorUserId: principal.userId, action: "shared.country.updated", resourceType: "country", resourceId: params.code, previous: prev, next: r, correlationId });
        return { data: r };
      });
    },
  }),
  route({
    method: "post", path: "/canada/countries", tag: "Référentiels", auth: "canada", anyPermission: ["canada.countries.manage"],
    summary: "Déclarer un pays de transit (escale) — non opérant par défaut",
    body: z.object({ code: CountryCode, name_fr: z.string().trim().min(2).max(120), name_en: z.string().trim().min(2).max(120), default_timezone: IanaTimeZone.optional() }),
    handler: async ({ body, principal, correlationId }) => {
      assertCan(principal, "canada.countries.manage", GLOBAL_RESOURCE);
      return withTransaction(async (tx) => {
        const r = await one(tx, `insert into shared.countries(code, name_fr, name_en, default_timezone) values ($1,$2,$3,$4) returning *`,
          [body.code, body.name_fr, body.name_en, body.default_timezone ?? null]);
        await audit(tx, { actorUserId: principal.userId, action: "shared.country.created", resourceType: "country", resourceId: body.code, next: r, correlationId });
        return { status: 201, data: r };
      });
    },
  }),
  route({
    method: "get", path: "/canada/currencies", tag: "Référentiels", auth: "canada", summary: "Devises gérées",
    handler: async () => ({ data: (await db.query(`select * from shared.currencies order by code`)).rows }),
  }),
  // ---------- Compagnies et aéroports ----------
  route({
    method: "get", path: "/canada/airlines", tag: "Référentiels", auth: "canada", anyPermission: ["canada.flights.read"], summary: "Compagnies aériennes",
    handler: async () => ({ data: (await db.query(`select * from canada.airlines order by name`)).rows }),
  }),
  route({
    method: "post", path: "/canada/airlines", tag: "Référentiels", auth: "canada", anyPermission: ["canada.airlines.manage"],
    summary: "Ajouter une compagnie réellement exploitée",
    body: z.object({ iata_code: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{2}$/), icao_code: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).nullable().optional(), name: z.string().trim().min(2).max(160) }),
    handler: async ({ body, principal, correlationId }) => {
      assertCan(principal, "canada.airlines.manage", GLOBAL_RESOURCE);
      return withTransaction(async (tx) => {
        const r = await one(tx, `insert into canada.airlines(iata_code, icao_code, name, created_by) values ($1,$2,$3,$4) returning *`, [body.iata_code, body.icao_code ?? null, body.name, principal.userId]);
        await audit(tx, { actorUserId: principal.userId, action: "canada.airline.created", resourceType: "airline", resourceId: r.id, next: r, correlationId });
        return { status: 201, data: r };
      });
    },
  }),
  route({
    method: "get", path: "/canada/airports", tag: "Référentiels", auth: "canada", anyPermission: ["canada.flights.read"], summary: "Aéroports",
    handler: async () => ({ data: (await db.query(`select * from canada.airports order by country_code, city`)).rows }),
  }),
  route({
    method: "post", path: "/canada/airports", tag: "Référentiels", auth: "canada", anyPermission: ["canada.airports.manage"],
    summary: "Ajouter un aéroport (fuseau IANA obligatoire)",
    body: z.object({ iata_code: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/), icao_code: z.string().trim().toUpperCase().regex(/^[A-Z]{4}$/).nullable().optional(),
      name: z.string().trim().min(2).max(200), city: z.string().trim().min(1).max(120), country_code: CountryCode, timezone: IanaTimeZone }),
    handler: async ({ body, principal, correlationId }) => {
      assertCan(principal, "canada.airports.manage", GLOBAL_RESOURCE);
      return withTransaction(async (tx) => {
        const r = await one(tx, `insert into canada.airports(iata_code, icao_code, name, city, country_code, timezone, created_by) values ($1,$2,$3,$4,$5,$6,$7) returning *`,
          [body.iata_code, body.icao_code ?? null, body.name, body.city, body.country_code, body.timezone, principal.userId]);
        await audit(tx, { actorUserId: principal.userId, action: "canada.airport.created", resourceType: "airport", resourceId: body.iata_code, next: r, correlationId });
        return { status: 201, data: r };
      });
    },
  }),
  // ---------- Agences et entrepôts ----------
  route({
    method: "get", path: "/canada/agencies", tag: "Agences", auth: "canada", anyPermission: ["canada.agencies.read_scoped"],
    summary: "Agences du périmètre", query: z.object({ country: CountryCode.optional(), status: z.enum(["active", "suspended", "closed"]).optional() }),
    handler: async ({ query, principal }) => {
      const f = scopeFilter(principal, ["canada.agencies.read_scoped"]);
      if (isEmptyScope(f)) return { data: [] };
      const params: unknown[] = [];
      let where = scopeClause(f, { countries: ["a.country_code"], agencies: ["a.id"] }, params);
      if (query.country) { params.push(query.country); where += ` and a.country_code = $${params.length}`; }
      if (query.status) { params.push(query.status); where += ` and a.status = $${params.length}`; }
      return { data: (await db.query(`select a.* from canada.agencies a where ${where} order by a.country_code, a.name`, params)).rows };
    },
  }),
  route({
    method: "post", path: "/canada/agencies", tag: "Agences", auth: "canada", anyPermission: ["canada.agencies.manage"],
    summary: "Créer une agence dans un pays du périmètre",
    body: z.object({ code: Code, name: z.string().trim().min(2).max(160), country_code: CountryCode, city: z.string().trim().max(120).optional(),
      address: z.string().trim().max(500).optional(), phone: z.string().trim().max(40).optional(), email: Email.optional(), timezone: IanaTimeZone }),
    handler: async ({ body, principal, correlationId }) => {
      assertCan(principal, "canada.agencies.manage", { countries: [body.country_code] });
      const c = await one(db, `select is_operating, is_active from shared.countries where code = $1`, [body.country_code]);
      if (!c?.is_operating || !c.is_active) throw unprocessable("COUNTRY_NOT_OPERATING", "Pays non opérant : une agence ne peut y être créée.");
      return withTransaction(async (tx) => {
        const a = await one(tx, `insert into canada.agencies(code, name, country_code, city, address, phone, email, timezone, created_by, updated_by)
                                 values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) returning *`,
          [body.code, body.name, body.country_code, body.city ?? null, body.address ?? null, body.phone ?? null, body.email ?? null, body.timezone, principal.userId]);
        await audit(tx, { actorUserId: principal.userId, action: "canada.agency.created", resourceType: "agency", resourceId: a.id, countryCode: a.country_code, next: a, correlationId });
        return { status: 201, data: a };
      });
    },
  }),
  route({
    method: "patch", path: "/canada/agencies/:id", tag: "Agences", auth: "canada", anyPermission: ["canada.agencies.manage"],
    summary: "Modifier / suspendre une agence (le pays ne change pas)", params: IdParams,
    body: z.strictObject({ name: z.string().trim().min(2).max(160).optional(), city: z.string().trim().max(120).optional(), address: z.string().trim().max(500).optional(),
      phone: z.string().trim().max(40).optional(), email: Email.optional(), timezone: IanaTimeZone.optional(), status: z.enum(["active", "suspended", "closed"]).optional() }),
    handler: async ({ params, body, principal, correlationId }) => {
      const a = await loadAgency(db, params.id);
      assertCan(principal, "canada.agencies.manage", { countries: [a.country_code], agencyIds: [a.id] });
      const keys = Object.keys(body);
      if (!keys.length) return { data: a };
      return withTransaction(async (tx) => {
        const r = await one(tx, `update canada.agencies set ${keys.map((k, i) => `${k} = $${i + 2}`).join(", ")}, updated_by = $${keys.length + 2} where id = $1 returning *`,
          [a.id, ...keys.map((k) => (body as any)[k]), principal.userId]);
        await audit(tx, { actorUserId: principal.userId, action: "canada.agency.updated", resourceType: "agency", resourceId: a.id, countryCode: a.country_code, previous: a, next: body, correlationId });
        return { data: r };
      });
    },
  }),
  route({
    method: "get", path: "/canada/agencies/:id/warehouses", tag: "Agences", auth: "canada", anyPermission: ["canada.warehouses.read_scoped"],
    summary: "Entrepôts d'une agence", params: IdParams,
    handler: async ({ params, principal }) => {
      const a = await loadAgency(db, params.id);
      assertCan(principal, "canada.warehouses.read_scoped", { countries: [a.country_code], agencyIds: [a.id] });
      return { data: (await db.query(`select * from canada.warehouses where agency_id = $1 order by name`, [a.id])).rows };
    },
  }),
  route({
    method: "post", path: "/canada/agencies/:id/warehouses", tag: "Agences", auth: "canada", anyPermission: ["canada.warehouses.manage"],
    summary: "Créer un entrepôt rattaché à l'agence", params: IdParams,
    body: z.object({ code: Code, name: z.string().trim().min(2).max(160), address: z.string().trim().max(500).optional(), capacity_m3: z.number().positive().max(1e7).optional() }),
    handler: async ({ params, body, principal, correlationId }) => {
      const a = await loadAgency(db, params.id);
      assertCan(principal, "canada.warehouses.manage", { countries: [a.country_code], agencyIds: [a.id] });
      return withTransaction(async (tx) => {
        const w = await one(tx, `insert into canada.warehouses(agency_id, country_code, code, name, address, capacity_m3, created_by, updated_by)
                                 values ($1,$2,$3,$4,$5,$6,$7,$7) returning *`, [a.id, a.country_code, body.code, body.name, body.address ?? null, body.capacity_m3 ?? null, principal.userId]);
        await audit(tx, { actorUserId: principal.userId, action: "canada.warehouse.created", resourceType: "warehouse", resourceId: w.id, countryCode: a.country_code, agencyId: a.id, next: w, correlationId });
        return { status: 201, data: w };
      });
    },
  }),
  // ---------- Clients ----------
  route({
    method: "get", path: "/canada/clients", tag: "Clients", auth: "canada", anyPermission: ["canada.clients.read_scoped"],
    summary: "Clients du périmètre (rattachement ou colis dans le périmètre)",
    query: PageQuery.extend({ search: z.string().trim().max(100).optional() }),
    handler: async ({ query, principal }) => {
      const f = scopeFilter(principal, ["canada.clients.read_scoped"]);
      if (isEmptyScope(f)) return { data: [], meta: paginate(query.page, query.limit, 0) };
      const params: unknown[] = [];
      const parcelScope = scopeClause(f, { countries: ["p.origin_country", "p.destination_country"], agencies: ["p.origin_agency_id", "p.destination_agency_id"] }, params);
      const direct = scopeClause(f, { countries: ["c.residence_country"], agencies: ["c.home_agency_id"] }, params);
      let where = `(${direct} or exists (select 1 from canada.parcels p where (p.client_id = c.id or p.recipient_client_id = c.id) and ${parcelScope}))`;
      if (query.search) {
        params.push(`%${query.search.replace(/[%_\\]/g, "")}%`);
        const n = params.length;
        where += ` and (c.last_name ilike $${n} or c.first_name ilike $${n} or c.phone ilike $${n} or c.email ilike $${n} or c.client_number ilike $${n})`;
      }
      const total = (await db.query(`select count(*)::int n from canada.clients c where ${where}`, params)).rows[0].n;
      const rows = (await db.query(`select c.id, c.client_number, c.first_name, c.last_name, c.email, c.phone, c.residence_country, c.home_agency_id, c.status, c.created_at
                                      from canada.clients c where ${where} order by c.last_name, c.first_name limit ${query.limit} offset ${(query.page - 1) * query.limit}`, params)).rows;
      return { data: rows, meta: paginate(query.page, query.limit, total) };
    },
  }),
  route({
    method: "post", path: "/canada/clients", tag: "Clients", auth: "canada", anyPermission: ["canada.clients.create"], idempotent: true,
    summary: "Créer une fiche client au guichet (sans lien de compte)",
    body: z.object({ first_name: z.string().trim().min(1).max(100), last_name: z.string().trim().min(1).max(100), email: Email.optional(),
      phone: z.string().trim().min(6).max(40), residence_country: CountryCode, home_agency_id: z.uuid(), notes: z.string().trim().max(2000).optional() }),
    handler: async ({ body, principal, correlationId }) => {
      const a = await loadAgency(db, body.home_agency_id);
      assertCan(principal, "canada.clients.create", { countries: [a.country_code], agencyIds: [a.id] });
      return withTransaction(async (tx) => {
        const c = await one(tx, `insert into canada.clients(client_number, first_name, last_name, email, phone, residence_country, home_agency_id, notes, created_by, updated_by)
                                 values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) returning *`,
          [await sequentialReference(tx, "CL"), body.first_name, body.last_name, body.email ?? null, body.phone, body.residence_country, a.id, body.notes ?? null, principal.userId]);
        await audit(tx, { actorUserId: principal.userId, action: "canada.client.created", resourceType: "client", resourceId: c.id, agencyId: a.id, countryCode: a.country_code, correlationId });
        return { status: 201, data: c };
      });
    },
  }),
  route({
    method: "get", path: "/canada/clients/:id", tag: "Clients", auth: "canada", anyPermission: ["canada.clients.read_scoped"],
    summary: "Fiche client", params: IdParams,
    handler: async ({ params, principal }) => {
      const c = await loadClient(params.id);
      assertCan(principal, "canada.clients.read_scoped", await clientResource(c));
      return { data: c };
    },
  }),
  route({
    method: "patch", path: "/canada/clients/:id", tag: "Clients", auth: "canada", anyPermission: ["canada.clients.manage"],
    summary: "Modifier une fiche client (audité)", params: IdParams,
    body: z.strictObject({ first_name: z.string().trim().min(1).max(100).optional(), last_name: z.string().trim().min(1).max(100).optional(),
      email: Email.nullable().optional(), phone: z.string().trim().min(6).max(40).optional(), residence_country: CountryCode.optional(),
      home_agency_id: z.uuid().optional(), status: z.enum(["active", "inactive", "blocked"]).optional(), notes: z.string().trim().max(2000).nullable().optional() }),
    handler: async ({ params, body, principal, correlationId }) => {
      const c = await loadClient(params.id);
      assertCan(principal, "canada.clients.manage", await clientResource(c));
      if (body.home_agency_id) {
        const a = await loadAgency(db, body.home_agency_id);
        assertCan(principal, "canada.clients.manage", { countries: [a.country_code], agencyIds: [a.id] });
      }
      const keys = Object.keys(body);
      if (!keys.length) return { data: c };
      return withTransaction(async (tx) => {
        const r = await one(tx, `update canada.clients set ${keys.map((k, i) => `${k} = $${i + 2}`).join(", ")}, updated_by = $${keys.length + 2} where id = $1 returning *`,
          [c.id, ...keys.map((k) => (body as any)[k]), principal.userId]);
        await audit(tx, { actorUserId: principal.userId, action: "canada.client.updated", resourceType: "client", resourceId: c.id,
          previous: Object.fromEntries(keys.map((k) => [k, c[k]])), next: body, correlationId });
        return { data: r };
      });
    },
  }),
  route({
    method: "post", path: "/canada/clients/:id/link-account", tag: "Clients", auth: "canada", anyPermission: ["canada.clients.manage"],
    summary: "Rattacher une fiche à un compte (jamais déduit d'une adresse e-mail)", params: IdParams,
    body: z.object({ user_id: z.uuid(), reason: z.string().trim().min(5).max(1000) }),
    handler: async ({ params, body, principal, correlationId }) => {
      const c = await loadClient(params.id);
      assertCan(principal, "canada.clients.manage", await clientResource(c));
      if (c.user_id) throw conflict("CLIENT_ALREADY_LINKED", "Fiche déjà rattachée à un compte.");
      return withTransaction(async (tx) => {
        const other = await one(tx, `select id from canada.clients where user_id = $1`, [body.user_id]);
        if (other) throw conflict("ACCOUNT_ALREADY_LINKED", "Ce compte possède déjà une fiche client : fusion à traiter manuellement.");
        await tx.query(`update canada.clients set user_id = $2, updated_by = $3 where id = $1`, [c.id, body.user_id, principal.userId]);
        await audit(tx, { actorUserId: principal.userId, action: "canada.client.account_linked", resourceType: "client", resourceId: c.id, next: { user_id: body.user_id }, reason: body.reason, correlationId });
        return { data: { client_id: c.id, user_id: body.user_id } };
      });
    },
  }),
  // ---------- Demandes ----------
  route({
    method: "get", path: "/canada/requests", tag: "Demandes", auth: "canada", anyPermission: ["canada.requests.read_scoped"],
    summary: "Demandes (devis publics, application, Market) du périmètre", query: PageQuery.extend({ status: z.string().max(20).optional() }),
    handler: async ({ query, principal }) => {
      const f = scopeFilter(principal, ["canada.requests.read_scoped"]);
      if (isEmptyScope(f)) return { data: [], meta: paginate(query.page, query.limit, 0) };
      const params: unknown[] = [];
      let where = scopeClause(f, { countries: ["r.origin_country", "r.destination_country"], agencies: ["r.preferred_agency_id"] }, params);
      if (query.status) { params.push(query.status); where += ` and r.status = $${params.length}`; }
      const total = (await db.query(`select count(*)::int n from canada.requests r where ${where}`, params)).rows[0].n;
      const rows = (await db.query(`select r.* from canada.requests r where ${where} order by r.created_at desc limit ${query.limit} offset ${(query.page - 1) * query.limit}`, params)).rows;
      return { data: rows, meta: paginate(query.page, query.limit, total) };
    },
  }),
  route({
    method: "post", path: "/canada/requests/:id/status", tag: "Demandes", auth: "canada", anyPermission: ["canada.requests.process"],
    summary: "Faire avancer une demande (prise en charge, gagnée, perdue)", params: IdParams,
    body: z.object({ status: z.enum(["under_review", "won", "lost", "cancelled"]) }),
    handler: async ({ params, body, principal, correlationId }) => withTransaction(async (tx) => {
      const r = await one(tx, `select * from canada.requests where id = $1 for update`, [params.id]);
      if (!r) throw notFound("REQUEST_NOT_FOUND", "Demande introuvable.");
      assertCan(principal, "canada.requests.process", { countries: [r.origin_country, r.destination_country], agencyIds: [r.preferred_agency_id] });
      const u = await one(tx, `update canada.requests set status = $2, handled_by = $3, handled_at = now() where id = $1 returning *`, [r.id, body.status, principal.userId]);
      await audit(tx, { actorUserId: principal.userId, action: "canada.request.status_changed", resourceType: "request", resourceId: r.id, previous: { status: r.status }, next: { status: body.status }, correlationId });
      return { data: u };
    }),
  }),
];

export function structureRouter() {
  const r = Router();
  mount(r, routes);
  return r;
}

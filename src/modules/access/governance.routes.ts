/**
 * Gouvernance des accès (Cahier §3.7 rôles complémentaires configurables, Module 3) :
 *  - rôles personnalisés construits à partir du catalogue de permissions existant
 *    (aucune permission n'est créée par l'API : le catalogue est défini par migration) ;
 *  - historique des connexions et événements de sécurité d'un utilisateur ;
 *  - sessions actives de l'utilisateur connecté.
 * Un rôle personnalisé ne contourne pas l'anti-escalade : pour l'ATTRIBUER, l'acteur
 * doit toujours détenir chacune de ses permissions sur le périmètre visé.
 */
import { Router } from "express";
import { z } from "zod";
import { audit } from "../../core/audit.js";
import { db, one, withTransaction } from "../../core/db.js";
import { conflict, forbidden, notFound, t, unprocessable } from "../../core/errors.js";
import { PageQuery } from "../../core/http.js";
import { mount, route } from "../../core/routes.js";
import { IdParams } from "../../core/schemas.js";
import { assertCan, can, GLOBAL_RESOURCE, scopeClause, scopeFilter, type Principal } from "./authorization.js";

const CUSTOM_CODE = z.string().trim().regex(/^canada_custom_[a-z0-9_]{3,50}$/, t("Format attendu : canada_custom_<nom>"));
const Scopes = z.array(z.enum(["global", "country", "agency", "warehouse"])).min(1).max(4);

async function validatePermissions(codes: string[]) {
  const unique = [...new Set(codes)];
  const known = (await db.query(`select code from access.permissions where platform_id = 1 and is_active and code = any($1::text[])`, [unique])).rows.map((r) => r.code);
  const missing = unique.filter((c) => !known.includes(c));
  if (missing.length) throw unprocessable("PERMISSION_UNKNOWN", "Permission inconnue ou réservée au périmètre global.", missing);
  return unique;
}

/** L'utilisateur cible est-il visible par l'appelant (rôle dans son périmètre) ? */
async function assertUserVisible(principal: Principal, userId: string) {
  const f = scopeFilter(principal, ["canada.users.read"]);
  if (f.global) return;
  const params: unknown[] = [userId];
  const clause = scopeClause(f, { countries: ["ur.scope_country", "a.country_code", "w.country_code"], agencies: ["a.id", "w.agency_id"], warehouses: ["w.id"] }, params);
  const ok = await one(db,
    `select 1 from access.user_roles ur
       left join canada.agencies a on ur.scope_type = 'agency' and a.id = ur.scope_id
       left join canada.warehouses w on ur.scope_type = 'warehouse' and w.id = ur.scope_id
      where ur.user_id = $1 and ur.scope_type <> 'own' and ${clause} limit 1`, params);
  if (!ok) throw notFound("USER_NOT_FOUND", "Utilisateur introuvable.");
}

const routes = [
  route({
    method: "post", path: "/access/roles", tag: "Accès", auth: "canada", anyPermission: ["canada.roles.manage"], idempotent: true,
    summary: "Créer un rôle complémentaire (ex. caissier, responsable douane) à partir du catalogue de permissions",
    body: z.object({ code: CUSTOM_CODE, name: z.string().trim().min(3).max(120), description: z.string().trim().max(1000).optional(),
      permissions: z.array(z.string().max(120)).min(1).max(100), allowed_scopes: Scopes, requires_mfa: z.boolean().default(false) }),
    handler: async ({ body, principal, correlationId }) => {
      assertCan(principal, "canada.roles.manage", GLOBAL_RESOURCE);
      const perms = await validatePermissions(body.permissions);
      return withTransaction(async (tx) => {
        if (await one(tx, `select 1 from access.roles where platform_id = 1 and code = $1`, [body.code])) {
          throw conflict("ROLE_CODE_TAKEN", "Code de rôle réservé ou déjà utilisé.");
        }
        const r = await one(tx,
          `insert into access.roles(platform_id, code, name, description, is_system_role, requires_mfa, is_exceptional, allowed_scopes)
           values (1,$1,$2,$3,false,$4,false,$5) returning *`, [body.code, body.name, body.description ?? null, body.requires_mfa, body.allowed_scopes]);
        await tx.query(`insert into access.role_permissions(role_id, permission_id, granted_by)
                        select $1, id, $3 from access.permissions where platform_id = 1 and code = any($2::text[])`, [r.id, perms, principal.userId]);
        await audit(tx, { actorUserId: principal.userId, action: "access.role.created", resourceType: "role", resourceId: r.id,
          next: { code: r.code, permissions: perms, allowed_scopes: body.allowed_scopes, requires_mfa: body.requires_mfa }, correlationId });
        return { status: 201, data: { ...r, permissions: perms } };
      });
    },
  }),
  route({
    method: "patch", path: "/access/roles/:code", tag: "Accès", auth: "canada", anyPermission: ["canada.roles.manage"],
    summary: "Modifier ou désactiver un rôle personnalisé (les rôles système sont gérés par migration)",
    params: z.object({ code: z.string().max(80) }),
    body: z.strictObject({ name: z.string().trim().min(3).max(120).optional(), description: z.string().trim().max(1000).nullable().optional(),
      permissions: z.array(z.string().max(120)).min(1).max(100).optional(), allowed_scopes: Scopes.optional(), is_active: z.boolean().optional(),
      reason: z.string().trim().min(5).max(1000) }),
    handler: async ({ params, body, principal, correlationId }) => {
      assertCan(principal, "canada.roles.manage", GLOBAL_RESOURCE);
      const perms = body.permissions ? await validatePermissions(body.permissions) : null;
      return withTransaction(async (tx) => {
        const r = await one(tx, `select * from access.roles where platform_id = 1 and code = $1 for update`, [params.code]);
        if (!r) throw notFound("ROLE_NOT_FOUND", "Rôle inconnu ou inactif.");
        if (r.is_system_role) throw conflict("SYSTEM_ROLE_LOCKED", "Un rôle système ne se modifie pas par l'API.");
        const before = { name: r.name, description: r.description, allowed_scopes: r.allowed_scopes, is_active: r.is_active,
          permissions: (await tx.query(`select p.code from access.role_permissions rp join access.permissions p on p.id = rp.permission_id where rp.role_id = $1 order by 1`, [r.id])).rows.map((x) => x.code) as string[] };
        // Ajouter une permission à un rôle revient à l'accorder à tous ses titulaires actuels et futurs :
        // l'acteur doit la détenir lui-même au périmètre global (anti-escalade, Dossier 03 §13 ; V-02).
        // Réactiver un rôle rend ses permissions à tous ses titulaires : même exigence.
        const reactivating = body.is_active === true && !r.is_active;
        const added = reactivating ? (perms ?? before.permissions) : (perms ?? []).filter((p) => !before.permissions.includes(p));
        if (added.some((p) => !can(principal, p, GLOBAL_RESOURCE))) {
          throw forbidden("PRIVILEGE_ESCALATION", "Vous ne pouvez pas attribuer des permissions que vous ne détenez pas sur ce périmètre.");
        }
        await tx.query(`update access.roles set name = coalesce($2, name), description = case when $3::boolean then $4 else description end,
                          allowed_scopes = coalesce($5, allowed_scopes), is_active = coalesce($6, is_active) where id = $1`,
          [r.id, body.name ?? null, body.description !== undefined, body.description ?? null, body.allowed_scopes ?? null, body.is_active ?? null]);
        if (perms) {
          await tx.query(`delete from access.role_permissions where role_id = $1`, [r.id]);
          await tx.query(`insert into access.role_permissions(role_id, permission_id, granted_by)
                          select $1, id, $3 from access.permissions where platform_id = 1 and code = any($2::text[])`, [r.id, perms, principal.userId]);
        }
        await audit(tx, { actorUserId: principal.userId, action: "access.role.updated", resourceType: "role", resourceId: r.id,
          previous: before, next: { ...body, permissions: perms ?? before.permissions }, reason: body.reason, correlationId });
        return { data: await one(tx, `select * from access.roles where id = $1`, [r.id]) };
      });
    },
  }),
  route({
    method: "get", path: "/access/users/:id/security-events", tag: "Accès", auth: "canada", anyPermission: ["canada.users.read"],
    summary: "Historique des connexions et événements de sécurité d'un utilisateur du périmètre",
    params: IdParams, query: PageQuery,
    handler: async ({ params, query, principal }) => {
      await assertUserVisible(principal, params.id);
      const rows = await db.query(
        `select event_type, occurred_at, ip_address, user_agent, metadata from audit.security_events
          where user_id = $1 order by occurred_at desc limit $2 offset $3`, [params.id, query.limit, (query.page - 1) * query.limit]);
      return { data: rows.rows };
    },
  }),
  route({
    method: "get", path: "/identity/me/sessions", tag: "Identité", auth: "user",
    summary: "Mes sessions actives (Supabase Auth) ; la session courante est signalée",
    handler: async ({ principal }) => ({
      data: (await db.query(`select id, created_at, aal, (id = $2::uuid) as current from auth.sessions where user_id = $1 order by created_at desc`,
        [principal.userId, principal.sessionId])).rows,
    }),
  }),
  route({
    method: "get", path: "/identity/me/security-events", tag: "Identité", auth: "user",
    summary: "Mon historique de connexions et d'événements de sécurité", query: PageQuery,
    handler: async ({ principal, query }) => ({
      data: (await db.query(`select event_type, occurred_at, ip_address, user_agent from audit.security_events where user_id = $1
                               order by occurred_at desc limit $2 offset $3`, [principal.userId, query.limit, (query.page - 1) * query.limit])).rows,
    }),
  }),
];

export function governanceRouter() {
  const r = Router();
  mount(r, routes);
  return r;
}

import { Router } from "express";
import { formatDateTime } from "../../i18n/index.js";
import { z } from "zod";
import { env } from "../../config/env.js";
import { db, one } from "../../core/db.js";
import { notFound } from "../../core/errors.js";
import { PageQuery } from "../../core/http.js";
import { mount, route } from "../../core/routes.js";
import { CountryCode, Email, IdParams, Reason } from "../../core/schemas.js";
import { sendEmail } from "../../integrations/email.js";
import { assertCan, scopeClause, scopeFilter } from "./authorization.js";
import { acceptInvitation, assignRole, createInvitation, resourceForScope, revokeRole, setAccountStatus, setPlatformAccess } from "./access.service.js";

const Scope = z.object({
  scope_type: z.enum(["global", "country", "agency", "warehouse", "own"]),
  scope_id: z.uuid().nullable().optional(),
  scope_country: CountryCode.nullable().optional(),
});

const routes = [
  route({
    method: "get", path: "/access/roles", tag: "Accès", auth: "canada", anyPermission: ["canada.roles.read"],
    summary: "Catalogue des rôles Canada et de leurs permissions",
    handler: async () => {
      const r = await db.query(
        `select r.code, r.name, r.description, r.requires_mfa, r.is_exceptional, r.allowed_scopes,
                coalesce(array_agg(p.code order by p.code) filter (where p.code is not null), '{}') as permissions
           from access.roles r left join access.role_permissions rp on rp.role_id = r.id
           left join access.permissions p on p.id = rp.permission_id
          where r.platform_id = 1 and r.is_active group by r.id order by r.code`);
      return { data: r.rows };
    },
  }),
  route({
    method: "get", path: "/access/permissions", tag: "Accès", auth: "canada", anyPermission: ["canada.permissions.read"],
    summary: "Catalogue des permissions Canada",
    handler: async () => ({ data: (await db.query(
      `select code, module, action, global_only, description from access.permissions where platform_id = 1 and is_active order by code`)).rows }),
  }),
  route({
    method: "get", path: "/access/users", tag: "Accès", auth: "canada", anyPermission: ["canada.users.read"],
    summary: "Utilisateurs ayant un rôle dans le périmètre de l'appelant",
    query: PageQuery.extend({ search: z.string().trim().max(100).optional() }),
    handler: async ({ query, principal }) => {
      const f = scopeFilter(principal, ["canada.users.read"]);
      const params: unknown[] = [];
      const scope = f.global ? "true" : `exists (select 1 from access.user_roles ur2
          left join canada.agencies a2 on ur2.scope_type = 'agency' and a2.id = ur2.scope_id
          left join canada.warehouses w2 on ur2.scope_type = 'warehouse' and w2.id = ur2.scope_id
         where ur2.user_id = p.id and ur2.revoked_at is null and ur2.scope_type <> 'own'
           and ${scopeClause(f, { countries: ["ur2.scope_country", "a2.country_code", "w2.country_code"], agencies: ["a2.id", "w2.agency_id"], warehouses: ["w2.id"] }, params)})`;
      let where = scope;
      if (query.search) { params.push(`%${query.search}%`); where += ` and (u.email ilike $${params.length} or p.last_name ilike $${params.length} or p.first_name ilike $${params.length})`; }
      const total = (await db.query(`select count(*)::int n from identity.profiles p join auth.users u on u.id = p.id where ${where}`, params)).rows[0].n;
      params.push(query.limit, (query.page - 1) * query.limit);
      const rows = await db.query(
        `select p.id, u.email, p.first_name, p.last_name, p.account_status,
                (select coalesce(json_agg(json_build_object('assignment_id', ur.id, 'role', r.code, 'scope_type', ur.scope_type,
                         'scope_id', ur.scope_id, 'scope_country', ur.scope_country, 'expires_at', ur.expires_at)), '[]')
                   from access.user_roles ur join access.roles r on r.id = ur.role_id
                  where ur.user_id = p.id and ur.revoked_at is null and r.platform_id = 1) as roles
           from identity.profiles p join auth.users u on u.id = p.id
          where ${where} order by p.last_name, p.first_name limit $${params.length - 1} offset $${params.length}`, params);
      return { data: rows.rows, meta: { pagination: { page: query.page, limit: query.limit, total, pages: Math.ceil(total / query.limit) } } };
    },
  }),
  route({
    method: "post", path: "/access/user-roles", tag: "Accès", auth: "canada", anyPermission: ["canada.users.manage_access"], idempotent: true,
    summary: "Attribuer un rôle à périmètre (contrôles anti-escalade)",
    body: Scope.extend({
      user_id: z.uuid(), role_code: z.string().min(3).max(80),
      expires_at: z.iso.datetime().nullable().optional(), justification: z.string().trim().max(1000).nullable().optional(),
    }),
    handler: async ({ body, principal, correlationId }) => ({ status: 201, data: await assignRole(principal, body, correlationId) }),
  }),
  route({
    method: "post", path: "/access/user-roles/:id/revoke", tag: "Accès", auth: "canada", anyPermission: ["canada.users.manage_access"],
    summary: "Révoquer une attribution (conservée pour l'audit)",
    params: IdParams, body: z.object({ reason: Reason }),
    handler: async ({ params, body, principal, correlationId }) => ({ data: await revokeRole(principal, params.id, body.reason, correlationId) }),
  }),
  route({
    method: "post", path: "/access/invitations", tag: "Accès", auth: "canada", anyPermission: ["canada.users.manage_access"], idempotent: true,
    summary: "Inviter un professionnel (jeton à usage unique, haché en base)",
    body: Scope.extend({ email: Email, role_code: z.string().min(3).max(80), expires_in_hours: z.number().int().min(1).max(168).default(72) }),
    handler: async ({ body, principal, correlationId }) => {
      const { invitation, token } = await createInvitation(principal, body, correlationId);
      const link = `${env().APP_PUBLIC_URL}/invitations/accept#token=${token}`;
      const mail = await sendEmail({
        to: body.email, subject: "Invitation — Trans Afrique Canada",
        // Langue du destinataire encore inconnue : message bilingue FR / EN.
        text: `Vous êtes invité(e) à rejoindre Trans Afrique Canada.\nLien (valable jusqu'au ${formatDateTime(invitation.expires_at, "UTC", "fr")}) : ${link}\nSi vous n'attendiez pas cette invitation, ignorez ce message.`
          + `\n\n---\n\nYou have been invited to join Trans Afrique Canada.\nLink (valid until ${formatDateTime(invitation.expires_at, "UTC", "en")}): ${link}\nIf you were not expecting this invitation, please ignore this message.`,
        idempotencyKey: `invitation:${invitation.id}`,
      });
      return {
        status: 201,
        data: {
          invitation_id: invitation.id, expires_at: invitation.expires_at, email_delivery: mail.status,
          // Le jeton n'est jamais renvoyé en production : il ne transite que par l'e-mail.
          ...(env().NODE_ENV !== "production" && mail.status !== "accepted" ? { dev_token: token } : {}),
        },
      };
    },
  }),
  route({
    method: "post", path: "/access/invitations/accept", tag: "Accès", auth: "user",
    summary: "Accepter une invitation (l'adresse vérifiée doit correspondre)",
    body: z.object({ token: z.string().min(20).max(200) }),
    handler: async ({ body, principal, correlationId }) => ({ data: await acceptInvitation(principal, body.token, correlationId) }),
  }),
  route({
    method: "post", path: "/access/invitations/:id/revoke", tag: "Accès", auth: "canada", anyPermission: ["canada.users.manage_access"],
    summary: "Révoquer une invitation en attente",
    params: IdParams,
    handler: async ({ params, principal, correlationId }) => {
      const inv = await one(db, `select * from access.invitations where id = $1`, [params.id]);
      if (!inv) throw notFound("INVITATION_NOT_FOUND", "Invitation introuvable.");
      assertCan(principal, "canada.users.manage_access", await resourceForScope(db, inv));
      const r = await db.query(`update access.invitations set status = 'revoked', revoked_at = now() where id = $1 and status = 'pending' returning id`, [params.id]);
      await db.query(`insert into audit.access_changes(actor_user_id, target_user_id, platform_id, role_id, change_type, reason, correlation_id)
                      values ($1, $1, 1, $2, 'invite_revoke', 'Invitation révoquée', $3)`, [principal.userId, inv.role_id, correlationId]);
      return { data: { revoked: r.rowCount === 1 } };
    },
  }),
  route({
    method: "post", path: "/access/users/:id/platform-access", tag: "Accès", auth: "canada", anyPermission: ["canada.users.manage_access"],
    summary: "Suspendre / réactiver l'accès Canada d'un utilisateur (sans effet sur Market)",
    params: IdParams, body: z.object({ status: z.enum(["active", "suspended", "revoked"]), reason: Reason }),
    handler: async ({ params, body, principal, correlationId }) => ({ data: await setPlatformAccess(principal, params.id, body.status, body.reason, correlationId) }),
  }),
  route({
    method: "post", path: "/access/users/:id/account-status", tag: "Accès", auth: "canada", anyPermission: ["canada.users.manage_access"],
    summary: "Suspension globale du compte Trans Afrique (administration globale)",
    params: IdParams, body: z.object({ status: z.enum(["active", "suspended", "restricted"]), reason: Reason }),
    handler: async ({ params, body, principal, correlationId }) => ({ data: await setAccountStatus(principal, params.id, body.status, body.reason, correlationId) }),
  }),
];

export function accessRouter() {
  const r = Router();
  mount(r, routes);
  return r;
}

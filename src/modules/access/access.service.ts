/**
 * Attribution / révocation des rôles et invitations (Dossier 03 §6, §11, §12).
 * Règles anti-escalade :
 *   1. on ne s'attribue (ni ne se retire) jamais un rôle soi-même ;
 *   2. l'acteur doit détenir canada.users.manage_access sur le périmètre cible ;
 *   3. l'acteur doit détenir CHACUNE des permissions du rôle sur ce périmètre ;
 *   4. les rôles sensibles (MFA, auditeur) ne s'attribuent qu'au périmètre global ;
 *   5. le rôle exceptionnel exige un super-administrateur, une justification
 *      et une durée limitée (7 jours maximum).
 */
import { createHash, randomBytes } from "node:crypto";
import type { Db } from "../../core/db.js";
import { one, withTransaction } from "../../core/db.js";
import { badRequest, conflict, forbidden, notFound, unprocessable, msg, t } from "../../core/errors.js";
import { assertCan, can, GLOBAL_RESOURCE, loadPrincipal, type Principal, type ResourceScope } from "./authorization.js";

const CANADA = 1;
const MAX_EXCEPTIONAL_DAYS = 7;

export interface ScopeInput { scope_type: "global" | "country" | "agency" | "warehouse" | "own"; scope_id?: string | null; scope_country?: string | null }

export async function resourceForScope(d: Db, s: ScopeInput, targetUserId?: string): Promise<ResourceScope> {
  switch (s.scope_type) {
    case "global": return GLOBAL_RESOURCE;
    case "country":
      if (!s.scope_country) throw badRequest("SCOPE_INVALID", "scope_country requis.");
      return { countries: [s.scope_country] };
    case "agency": {
      const a = s.scope_id ? await one(d, `select id, country_code from canada.agencies where id = $1`, [s.scope_id]) : null;
      if (!a) throw unprocessable("SCOPE_INVALID", "Agence inconnue.");
      return { agencyIds: [a.id], countries: [a.country_code] };
    }
    case "warehouse": {
      const w = s.scope_id ? await one(d, `select id, agency_id, country_code from canada.warehouses where id = $1`, [s.scope_id]) : null;
      if (!w) throw unprocessable("SCOPE_INVALID", "Entrepôt inconnu.");
      return { warehouseIds: [w.id], agencyIds: [w.agency_id], countries: [w.country_code] };
    }
    case "own": {
      const c = targetUserId ? await one(d, `select residence_country, home_agency_id from canada.clients where user_id = $1`, [targetUserId]) : null;
      return { countries: [c?.residence_country], agencyIds: [c?.home_agency_id] };
    }
  }
}

async function loadRole(d: Db, code: string) {
  const r = await one(d,
    `select r.id, r.code, r.requires_mfa, r.is_exceptional, r.allowed_scopes, r.is_active,
            coalesce(array_agg(p.code) filter (where p.code is not null), '{}') as perms
       from access.roles r left join access.role_permissions rp on rp.role_id = r.id
       left join access.permissions p on p.id = rp.permission_id
      where r.platform_id = $1 and r.code = $2 group by r.id`, [CANADA, code]);
  if (!r || !r.is_active) throw unprocessable("ROLE_UNKNOWN", "Rôle inconnu ou inactif.");
  return r;
}

function assertGrantAuthority(actor: Principal, role: any, s: ScopeInput, resource: ResourceScope, expiresAt: string | null | undefined, justification: string | null | undefined) {
  if (!role.allowed_scopes.includes(s.scope_type)) {
    throw unprocessable("SCOPE_NOT_ALLOWED", msg("Périmètre « {p0} » non autorisé pour ce rôle.", { p0: s.scope_type }));
  }
  const sensitive = role.requires_mfa || role.code === "canada_security_auditor";
  assertCan(actor, "canada.users.manage_access", sensitive ? GLOBAL_RESOURCE : resource,
    sensitive ? t("Ce rôle sensible ne peut être attribué que par un administrateur global.") : t("Périmètre cible hors de votre autorité."));
  const missing = (role.perms as string[]).filter((p) => !can(actor, p, resource));
  if (missing.length) {
    throw forbidden("PRIVILEGE_ESCALATION", "Vous ne pouvez pas attribuer des permissions que vous ne détenez pas sur ce périmètre.");
  }
  if (role.is_exceptional) {
    if (!actor.grants.some((g) => g.roleCode === "canada_super_administrator")) {
      throw forbidden("EXCEPTIONAL_ROLE", "Seul un administrateur exceptionnel peut attribuer ce rôle.");
    }
    if (!justification || justification.trim().length < 10) throw badRequest("JUSTIFICATION_REQUIRED", "Justification obligatoire.");
    const max = Date.now() + MAX_EXCEPTIONAL_DAYS * 86_400_000;
    if (!expiresAt || new Date(expiresAt).getTime() > max) {
      throw badRequest("EXPIRY_REQUIRED", msg("Attribution exceptionnelle limitée à {p0} jours.", { p0: MAX_EXCEPTIONAL_DAYS }));
    }
  }
}

export async function assignRole(actor: Principal, input: ScopeInput & {
  user_id: string; role_code: string; expires_at?: string | null; justification?: string | null;
}, correlationId: string) {
  if (input.user_id === actor.userId) throw forbidden("SELF_ASSIGNMENT", "Impossible de modifier ses propres accès.");
  return withTransaction(async (tx) => {
    const target = await one(tx, `select id, account_status from identity.profiles where id = $1`, [input.user_id]);
    if (!target) throw notFound("USER_NOT_FOUND", "Utilisateur introuvable.");
    const role = await loadRole(tx, input.role_code);
    const resource = await resourceForScope(tx, input, input.user_id);
    assertGrantAuthority(actor, role, input, resource, input.expires_at, input.justification);

    await tx.query(
      `insert into access.user_platform_access(user_id, platform_id, access_status, granted_by)
       values ($1, $2, 'active', $3) on conflict (user_id, platform_id) do nothing`, [input.user_id, CANADA, actor.userId]);
    const ins = await tx.query(
      `insert into access.user_roles(user_id, role_id, scope_type, scope_id, scope_country, assigned_by, expires_at, justification)
       values ($1, $2, $3, $4, $5, $6, $7, $8) returning id, assigned_at`,
      [input.user_id, role.id, input.scope_type, input.scope_id ?? null, input.scope_country ?? null, actor.userId,
       input.expires_at ?? null, input.justification ?? null]);
    await tx.query(
      `insert into audit.access_changes(actor_user_id, target_user_id, platform_id, role_id, change_type, reason, new_state, correlation_id)
       values ($1, $2, $3, $4, 'grant', $5, $6, $7)`,
      [actor.userId, input.user_id, CANADA, role.id, input.justification ?? null,
       JSON.stringify({ role: role.code, scope_type: input.scope_type, scope_id: input.scope_id ?? null, scope_country: input.scope_country ?? null, expires_at: input.expires_at ?? null }),
       correlationId]);
    return { id: ins.rows[0].id, role: role.code, scope_type: input.scope_type, scope_id: input.scope_id ?? null, scope_country: input.scope_country ?? null };
  });
}

export async function revokeRole(actor: Principal, assignmentId: string, reason: string, correlationId: string) {
  return withTransaction(async (tx) => {
    const a = await one(tx,
      `select ur.*, r.code as role_code, r.requires_mfa from access.user_roles ur join access.roles r on r.id = ur.role_id
        where ur.id = $1 for update of ur`, [assignmentId]);
    if (!a) throw notFound("ASSIGNMENT_NOT_FOUND", "Attribution introuvable.");
    if (a.user_id === actor.userId) throw forbidden("SELF_ASSIGNMENT", "Impossible de modifier ses propres accès.");
    if (a.revoked_at) throw conflict("ALREADY_REVOKED", "Attribution déjà révoquée.");
    const resource = await resourceForScope(tx, a, a.user_id);
    const sensitive = a.requires_mfa || a.role_code === "canada_security_auditor";
    assertCan(actor, "canada.users.manage_access", sensitive ? GLOBAL_RESOURCE : resource, "Attribution hors de votre autorité.");
    await tx.query(`update access.user_roles set revoked_at = now(), revoked_by = $2, revocation_reason = $3 where id = $1`,
      [assignmentId, actor.userId, reason]);
    await tx.query(
      `insert into audit.access_changes(actor_user_id, target_user_id, platform_id, role_id, change_type, reason, previous_state, correlation_id)
       values ($1, $2, $3, $4, 'revoke', $5, $6, $7)`,
      [actor.userId, a.user_id, CANADA, a.role_id, reason,
       JSON.stringify({ role: a.role_code, scope_type: a.scope_type, scope_id: a.scope_id, scope_country: a.scope_country }), correlationId]);
    return { id: assignmentId, revoked: true };
  });
}

export const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");

export async function createInvitation(actor: Principal, input: ScopeInput & {
  email: string; role_code: string; expires_in_hours: number;
}, correlationId: string) {
  if (actor.email && input.email === actor.email.toLowerCase()) throw forbidden("SELF_ASSIGNMENT", "Impossible de s'inviter soi-même.");
  return withTransaction(async (tx) => {
    const role = await loadRole(tx, input.role_code);
    if (role.is_exceptional) throw forbidden("EXCEPTIONAL_ROLE", "Le rôle exceptionnel ne s'attribue pas par invitation.");
    const resource = await resourceForScope(tx, input);
    assertGrantAuthority(actor, role, input, resource, null, null);
    const token = randomBytes(32).toString("base64url");
    const inv = await tx.query(
      `insert into access.invitations(email_normalized, platform_id, role_id, scope_type, scope_id, scope_country, token_hash, invited_by, expires_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, now() + make_interval(hours => $9)) returning id, expires_at`,
      [input.email, CANADA, role.id, input.scope_type, input.scope_id ?? null, input.scope_country ?? null, hashToken(token), actor.userId, input.expires_in_hours]);
    await tx.query(
      `insert into audit.access_changes(actor_user_id, target_user_id, platform_id, role_id, change_type, reason, new_state, correlation_id)
       values ($1, $1, $2, $3, 'invite', 'Invitation professionnelle', $4, $5)`,
      [actor.userId, CANADA, role.id, JSON.stringify({ invitation_id: inv.rows[0].id, email: input.email, role: role.code, scope_type: input.scope_type }), correlationId]);
    return { invitation: inv.rows[0], token };
  });
}

export async function acceptInvitation(principal: Principal, token: string, correlationId: string) {
  return withTransaction(async (tx) => {
    const inv = await one(tx,
      `select i.*, r.code as role_code from access.invitations i join access.roles r on r.id = i.role_id
        where i.token_hash = $1 for update of i`, [hashToken(token)]);
    if (!inv) throw notFound("INVITATION_INVALID", "Invitation invalide.");
    if (inv.status !== "pending") throw conflict("INVITATION_NOT_PENDING", "Invitation déjà utilisée ou révoquée.");
    if (new Date(inv.expires_at) <= new Date()) {
      await tx.query(`update access.invitations set status = 'expired' where id = $1`, [inv.id]);
      throw conflict("INVITATION_EXPIRED", "Invitation expirée.");
    }
    if (!principal.email || principal.email.toLowerCase() !== inv.email_normalized) {
      throw forbidden("INVITATION_EMAIL_MISMATCH", "Cette invitation est destinée à une autre adresse.");
    }
    // L'invitant doit toujours détenir l'autorité au moment de l'acceptation.
    const inviter = await loadPrincipal(tx, { sub: inv.invited_by, aal: "aal2" });
    const role = await loadRole(tx, inv.role_code);
    const resource = await resourceForScope(tx, inv, principal.userId);
    if (!inviter) throw forbidden("INVITER_NO_LONGER_AUTHORIZED", "L'invitant n'a plus l'autorité nécessaire.");
    try { assertGrantAuthority(inviter, role, inv, resource, null, null); }
    catch { throw forbidden("INVITER_NO_LONGER_AUTHORIZED", "L'invitant n'a plus l'autorité nécessaire."); }

    await tx.query(
      `insert into access.user_platform_access(user_id, platform_id, access_status, granted_by)
       values ($1, $2, 'active', $3) on conflict (user_id, platform_id) do update set access_status = 'active'
       where access.user_platform_access.access_status = 'pending'`, [principal.userId, CANADA, inv.invited_by]);
    await tx.query(
      `insert into access.user_roles(user_id, role_id, scope_type, scope_id, scope_country, assigned_by, justification)
       values ($1, $2, $3, $4, $5, $6, 'Invitation acceptée') on conflict do nothing`,
      [principal.userId, inv.role_id, inv.scope_type, inv.scope_id, inv.scope_country, inv.invited_by]);
    await tx.query(`update access.invitations set status = 'accepted', accepted_at = now(), accepted_by = $2 where id = $1`, [inv.id, principal.userId]);
    await tx.query(
      `insert into audit.access_changes(actor_user_id, target_user_id, platform_id, role_id, change_type, reason, new_state, correlation_id)
       values ($1, $1, $2, $3, 'invite_accept', 'Invitation acceptée', $4, $5)`,
      [principal.userId, CANADA, inv.role_id, JSON.stringify({ invitation_id: inv.id, role: inv.role_code, scope_type: inv.scope_type }), correlationId]);
    return { role: inv.role_code, scope_type: inv.scope_type, scope_id: inv.scope_id, scope_country: inv.scope_country };
  });
}

/** Suspension de l'accès Canada (n'affecte pas Market) ou du compte global (administrateur global). */
export async function setPlatformAccess(actor: Principal, userId: string, status: "active" | "suspended" | "revoked", reason: string, correlationId: string) {
  if (userId === actor.userId) throw forbidden("SELF_ASSIGNMENT", "Impossible de modifier ses propres accès.");
  assertCan(actor, "canada.users.manage_access", GLOBAL_RESOURCE, "Réservé à l'administration globale.");
  return withTransaction(async (tx) => {
    const prev = await one(tx, `select access_status from access.user_platform_access where user_id = $1 and platform_id = $2 for update`, [userId, CANADA]);
    if (!prev) throw notFound("ACCESS_NOT_FOUND", "Aucun accès Canada pour cet utilisateur.");
    await tx.query(
      `update access.user_platform_access set access_status = $3::text,
              suspended_at = case when $3::text = 'suspended' then now() else suspended_at end,
              revoked_at = case when $3::text = 'revoked' then now() else revoked_at end
        where user_id = $1 and platform_id = $2`, [userId, CANADA, status]);
    await tx.query(
      `insert into audit.access_changes(actor_user_id, target_user_id, platform_id, change_type, reason, previous_state, new_state, correlation_id)
       values ($1, $2, $3, 'platform_access', $4, $5, $6, $7)`,
      [actor.userId, userId, CANADA, reason, JSON.stringify(prev), JSON.stringify({ access_status: status }), correlationId]);
    return { user_id: userId, platform: "CANADA", access_status: status };
  });
}

export async function setAccountStatus(actor: Principal, userId: string, status: "active" | "suspended" | "restricted", reason: string, correlationId: string) {
  if (userId === actor.userId) throw forbidden("SELF_ASSIGNMENT", "Impossible de modifier son propre compte.");
  assertCan(actor, "canada.users.manage_access", GLOBAL_RESOURCE, "Réservé à l'administration globale.");
  return withTransaction(async (tx) => {
    const prev = await one(tx, `select account_status from identity.profiles where id = $1 for update`, [userId]);
    if (!prev) throw notFound("USER_NOT_FOUND", "Utilisateur introuvable.");
    if (["deletion_pending", "anonymized"].includes(prev.account_status)) throw conflict("ACCOUNT_STATUS_LOCKED", "Statut non modifiable.");
    await tx.query(`update identity.profiles set account_status = $2 where id = $1`, [userId, status]);
    await tx.query(
      `insert into audit.security_events(user_id, platform_id, event_type, actor_user_id, correlation_id, metadata)
       values ($1, 1, 'account.status_changed', $2, $3, $4)`,
      [userId, actor.userId, correlationId, JSON.stringify({ from: prev.account_status, to: status, reason })]);
    return { user_id: userId, account_status: status };
  });
}

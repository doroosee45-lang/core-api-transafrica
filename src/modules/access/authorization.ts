/**
 * MOTEUR D'AUTORISATION — RBAC + périmètres (Dossier 03 §2.3, §7, §10).
 *
 * Une décision vérifie : identité, accès plateforme, rôle actif (non révoqué,
 * non expiré, MFA si exigée), permission demandée et PÉRIMÈTRE de la ressource.
 * Posséder une permission ne donne jamais accès à toutes les données.
 * Refus par défaut : toute combinaison non explicitement couverte est refusée.
 */
import { env } from "../../config/env.js";
import type { Db } from "../../core/db.js";
import { forbidden, t } from "../../core/errors.js";

export type ScopeType = "global" | "country" | "organization" | "agency" | "warehouse" | "own";

export interface Grant {
  assignmentId: string;
  roleCode: string;
  scopeType: ScopeType;
  scopeId: string | null;
  scopeCountry: string | null;
  permissions: Set<string>;
  globalOnly: Set<string>;
}

export interface Principal {
  userId: string;
  email: string | null;
  sessionId: string | null;
  aal: "aal1" | "aal2";
  accountStatus: string;
  preferredLanguage: "fr" | "en";
  firstName: string;
  lastName: string;
  platformAccess: string | null;
  grants: Grant[];
}

/** Description de la ressource ciblée, telle que connue du serveur (jamais du client). */
export interface ResourceScope {
  countries?: (string | null | undefined)[];
  agencyIds?: (string | null | undefined)[];
  warehouseIds?: (string | null | undefined)[];
  organizationIds?: (string | null | undefined)[];
  ownerUserIds?: (string | null | undefined)[];
}

/** Ressource « globale » : seule une attribution de périmètre global la couvre. */
export const GLOBAL_RESOURCE: ResourceScope = {};

const has = (list: (string | null | undefined)[] | undefined, v: string | null) =>
  !!v && !!list && list.some((x) => x != null && x === v);

function grantCovers(p: Principal, g: Grant, permission: string, r: ResourceScope): boolean {
  if (!g.permissions.has(permission)) return false;
  if (g.globalOnly.has(permission) && g.scopeType !== "global") return false;
  switch (g.scopeType) {
    case "global": return true;
    case "country": return has(r.countries, g.scopeCountry);
    case "agency": return has(r.agencyIds, g.scopeId);
    case "warehouse": return has(r.warehouseIds, g.scopeId);
    case "organization": return has(r.organizationIds, g.scopeId);
    case "own": return has(r.ownerUserIds, p.userId);
  }
}

export function can(p: Principal, permission: string, resource: ResourceScope): boolean {
  return p.grants.some((g) => grantCovers(p, g, permission, resource));
}

export function assertCan(p: Principal, permission: string, resource: ResourceScope, message?: string) {
  if (!can(p, permission, resource)) {
    throw forbidden("FORBIDDEN", message ?? t("Action non autorisée sur cette ressource ou hors de votre périmètre."));
  }
}

/** La permission est-elle détenue à un périmètre quelconque ? (contrôle grossier de route) */
export function holds(p: Principal, permission: string): boolean {
  return p.grants.some((g) => g.permissions.has(permission) && (!g.globalOnly.has(permission) || g.scopeType === "global"));
}

export function allPermissions(p: Principal): string[] {
  const s = new Set<string>();
  for (const g of p.grants) for (const perm of g.permissions) if (!g.globalOnly.has(perm) || g.scopeType === "global") s.add(perm);
  return [...s].sort();
}

/** Filtre de lecture : union des périmètres où l'une des permissions est détenue. */
export interface ScopeFilter {
  global: boolean;
  countries: string[];
  agencyIds: string[];
  warehouseIds: string[];
  organizationIds: string[];
  ownUserId: string | null;
}

export function scopeFilter(p: Principal, permissions: string[]): ScopeFilter {
  const f: ScopeFilter = { global: false, countries: [], agencyIds: [], warehouseIds: [], organizationIds: [], ownUserId: null };
  for (const g of p.grants) {
    if (!permissions.some((perm) => g.permissions.has(perm))) continue;
    switch (g.scopeType) {
      case "global": f.global = true; break;
      case "country": if (g.scopeCountry) f.countries.push(g.scopeCountry); break;
      case "agency": if (g.scopeId) f.agencyIds.push(g.scopeId); break;
      case "warehouse": if (g.scopeId) f.warehouseIds.push(g.scopeId); break;
      case "organization": if (g.scopeId) f.organizationIds.push(g.scopeId); break;
      case "own": f.ownUserId = p.userId; break;
    }
  }
  return f;
}

export function isEmptyScope(f: ScopeFilter) {
  return !f.global && !f.countries.length && !f.agencyIds.length && !f.warehouseIds.length && !f.organizationIds.length && !f.ownUserId;
}

/**
 * Construit une clause SQL à partir d'un filtre de périmètre.
 * `cols` indique quelles colonnes de la requête portent chaque dimension.
 * Les valeurs sont TOUJOURS passées en paramètres liés.
 */
export function scopeClause(
  f: ScopeFilter,
  cols: { countries?: string[]; agencies?: string[]; warehouses?: string[]; ownerUser?: string[] },
  params: unknown[],
): string {
  if (f.global) return "true";
  const parts: string[] = [];
  const bind = (v: unknown) => { params.push(v); return `$${params.length}`; };
  if (f.countries.length && cols.countries?.length) {
    const ref = bind(f.countries);
    parts.push(...cols.countries.map((c) => `${c} = any(${ref}::text[])`));
  }
  if (f.agencyIds.length && cols.agencies?.length) {
    const ref = bind(f.agencyIds);
    parts.push(...cols.agencies.map((c) => `${c} = any(${ref}::uuid[])`));
  }
  if (f.warehouseIds.length && cols.warehouses?.length) {
    const ref = bind(f.warehouseIds);
    parts.push(...cols.warehouses.map((c) => `${c} = any(${ref}::uuid[])`));
  }
  if (f.ownUserId && cols.ownerUser?.length) {
    const ref = bind(f.ownUserId);
    parts.push(...cols.ownerUser.map((c) => `${c} = ${ref}::uuid`));
  }
  return parts.length ? `(${parts.join(" or ")})` : "false";
}

/** Charge le principal depuis la base à CHAQUE requête : une révocation prend effet immédiatement. */
export async function loadPrincipal(
  d: Db,
  claims: { sub: string; email?: string | null; session_id?: string | null; aal?: string | null },
): Promise<Principal | null> {
  const profile = await d.query(
    `select p.id, p.first_name, p.last_name, p.account_status, p.preferred_language, u.email,
            upa.access_status
       from identity.profiles p
       join auth.users u on u.id = p.id
       left join access.user_platform_access upa on upa.user_id = p.id and upa.platform_id = 1
      where p.id = $1`,
    [claims.sub],
  );
  const row = profile.rows[0];
  if (!row) return null;

  const aal: "aal1" | "aal2" = claims.aal === "aal2" ? "aal2" : "aal1";
  const enforceMfa = env().AUTH_ENFORCE_MFA;

  const grants = await d.query(
    `select ur.id, ur.scope_type, ur.scope_id, ur.scope_country, r.code, r.requires_mfa,
            coalesce(array_agg(pm.code) filter (where pm.code is not null), '{}') as perms,
            coalesce(array_agg(pm.code) filter (where pm.global_only), '{}') as global_only
       from access.user_roles ur
       join access.roles r on r.id = ur.role_id and r.is_active and r.platform_id = 1
       left join access.role_permissions rp on rp.role_id = r.id
       left join access.permissions pm on pm.id = rp.permission_id and pm.is_active
      where ur.user_id = $1
        and ur.revoked_at is null
        and ur.valid_from <= now()
        and (ur.expires_at is null or ur.expires_at > now())
      group by ur.id, r.code, r.requires_mfa`,
    [claims.sub],
  );

  const active: Grant[] = [];
  for (const g of grants.rows) {
    if (g.requires_mfa && enforceMfa && aal !== "aal2") continue; // rôle sensible ignoré sans MFA
    active.push({
      assignmentId: g.id,
      roleCode: g.code,
      scopeType: g.scope_type,
      scopeId: g.scope_id,
      scopeCountry: g.scope_country,
      permissions: new Set(g.perms),
      globalOnly: new Set(g.global_only),
    });
  }

  return {
    userId: row.id,
    email: row.email ?? claims.email ?? null,
    sessionId: claims.session_id ?? null,
    aal,
    accountStatus: row.account_status,
    preferredLanguage: row.preferred_language === "en" ? "en" : "fr",
    firstName: row.first_name,
    lastName: row.last_name,
    platformAccess: row.access_status ?? null,
    grants: active,
  };
}

/** Liste des rôles ignorés faute de MFA (pour informer l'utilisateur, sans les accorder). */
export async function rolesPendingMfa(d: Db, userId: string): Promise<string[]> {
  const r = await d.query(
    `select distinct r.code from access.user_roles ur join access.roles r on r.id = ur.role_id
      where ur.user_id = $1 and ur.revoked_at is null and r.requires_mfa
        and (ur.expires_at is null or ur.expires_at > now())`,
    [userId],
  );
  return r.rows.map((x) => x.code);
}

import type { Db } from "../../core/db.js";
import { one, withTransaction } from "../../core/db.js";
import { audit } from "../../core/audit.js";
import { sequentialReference } from "../../core/references.js";

const CANADA = 1;

/**
 * Provisionnement idempotent d'un compte client Canada après inscription
 * (Spéc. identité §7.2 étapes 6-7). Rejouable sans doublon : sert aussi de
 * procédure de reprise si l'inscription a été interrompue après Supabase Auth.
 */
export async function ensureCanadaClientProvisioned(
  userId: string,
  input: { firstName: string; lastName: string; country?: string | null; language?: string; email: string | null },
  correlationId?: string,
) {
  return withTransaction(async (tx) => {
    await tx.query(
      `insert into identity.profiles(id, first_name, last_name, country_of_residence, preferred_language)
       values ($1, $2, $3, $4, $5) on conflict (id) do nothing`,
      [userId, input.firstName, input.lastName, input.country ?? null, input.language ?? "fr"],
    );
    await grantCanadaClientAccess(tx, userId, input, correlationId);
  });
}

export async function grantCanadaClientAccess(
  tx: Db,
  userId: string,
  input: { firstName: string; lastName: string; country?: string | null; email: string | null },
  correlationId?: string,
) {
  const access = await tx.query(
    `insert into access.user_platform_access(user_id, platform_id, access_status)
     values ($1, $2, 'active') on conflict (user_id, platform_id) do nothing returning id`,
    [userId, CANADA],
  );
  const role = await one(tx, `select id from access.roles where platform_id = $1 and code = 'canada_client'`, [CANADA]);
  const granted = await tx.query(
    `insert into access.user_roles(user_id, role_id, scope_type, justification)
     select $1, $2, 'own', 'Inscription client'
      where not exists (select 1 from access.user_roles where user_id = $1 and role_id = $2 and revoked_at is null)
     returning id`,
    [userId, role.id],
  );
  const existingClient = await one(tx, `select id from canada.clients where user_id = $1`, [userId]);
  if (!existingClient) {
    const number = await sequentialReference(tx, "CL");
    await tx.query(
      `insert into canada.clients(client_number, user_id, first_name, last_name, email, residence_country, created_by)
       values ($1, $2, $3, $4, $5, $6, $2)`,
      [number, userId, input.firstName, input.lastName, input.email, input.country ?? null],
    );
  }
  if (access.rows[0] || granted.rows[0]) {
    await tx.query(
      `insert into audit.access_changes(actor_user_id, target_user_id, platform_id, role_id, change_type, reason, new_state, correlation_id)
       values (null, $1, $2, $3, 'grant', 'Inscription client (auto-provisionnement)', $4, $5)`,
      [userId, CANADA, role.id, JSON.stringify({ role: "canada_client", scope: "own" }), correlationId ?? null],
    );
  }
}

export async function getMe(d: Db, userId: string) {
  const profile = await one(d,
    `select p.id, u.email, p.first_name, p.last_name, p.display_name, p.country_of_residence,
            p.preferred_language, p.account_status, p.created_at
       from identity.profiles p join auth.users u on u.id = p.id where p.id = $1`, [userId]);
  const platforms = await d.query(
    `select pl.code, upa.access_status from access.user_platform_access upa
       join access.platforms pl on pl.id = upa.platform_id where upa.user_id = $1 order by pl.id`, [userId]);
  const client = await one(d, `select id, client_number from canada.clients where user_id = $1`, [userId]);
  return { profile, platforms: platforms.rows, canada_client: client };
}

export async function updateMe(d: Db, userId: string, patch: Record<string, unknown>, correlationId: string) {
  const fields = ["first_name", "last_name", "display_name", "preferred_language"].filter((f) => patch[f] !== undefined);
  if (!fields.length) return getMe(d, userId);
  return withTransaction(async (tx) => {
    const before = await one(tx, `select ${fields.join(", ")} from identity.profiles where id = $1 for update`, [userId]);
    const sets = fields.map((f, i) => `${f} = $${i + 2}`).join(", ");
    await tx.query(`update identity.profiles set ${sets} where id = $1`, [userId, ...fields.map((f) => patch[f])]);
    await audit(tx, { actorUserId: userId, action: "identity.profile.updated", resourceType: "profile", resourceId: userId,
      previous: before, next: Object.fromEntries(fields.map((f) => [f, patch[f]])), correlationId });
    return getMe(tx, userId);
  });
}

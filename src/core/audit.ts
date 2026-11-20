import type { Request } from "express";
import type { Db } from "./db.js";
import { db } from "./db.js";

export interface AuditEntry {
  actorUserId: string | null;
  actorKind?: "user" | "system" | "integration" | "migration";
  action: string;
  resourceType: string;
  resourceId?: string | null;
  countryCode?: string | null;
  agencyId?: string | null;
  previous?: unknown;
  next?: unknown;
  reason?: string | null;
  correlationId?: string | null;
}

/** Écrit dans audit.audit_events, dans la MÊME transaction que l'opération métier. */
export async function audit(d: Db, e: AuditEntry) {
  await d.query(
    `insert into audit.audit_events(actor_user_id, actor_kind, action, resource_type, resource_id, country_code,
       agency_id, previous_value, new_value, reason, correlation_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [e.actorUserId, e.actorKind ?? "user", e.action, e.resourceType, e.resourceId ?? null, e.countryCode ?? null,
     e.agencyId ?? null, e.previous === undefined ? null : JSON.stringify(e.previous),
     e.next === undefined ? null : JSON.stringify(e.next), e.reason ?? null, e.correlationId ?? null],
  );
}

/** Événement de sécurité (connexion, refus d'accès, révocation…). Ne contient jamais de secret. */
export async function securityEvent(
  eventType: string,
  opts: { userId?: string | null; actorUserId?: string | null; req?: Request; metadata?: Record<string, unknown>; d?: Db },
) {
  const req = opts.req;
  const ip = req ? (req.ip ?? null) : null;
  try {
    await (opts.d ?? db).query(
      `insert into audit.security_events(user_id, platform_id, event_type, actor_user_id, ip_address, user_agent, correlation_id, metadata)
       values ($1, 1, $2, $3, $4::inet, $5, $6, $7)`,
      [opts.userId ?? null, eventType, opts.actorUserId ?? null, ip && /^[0-9a-f.:]+$/i.test(ip) ? ip : null,
       req?.header("user-agent")?.slice(0, 300) ?? null, req?.correlationId ?? null, JSON.stringify(opts.metadata ?? {})],
    );
  } catch (err) {
    // La journalisation ne doit pas masquer l'erreur d'origine, mais son échec est signalé.
    console.error(`[audit] security_event non écrit; type=${eventType}; code=${(err as any)?.code ?? "UNKNOWN"}`);
  }
}

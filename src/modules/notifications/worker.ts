/**
 * Worker : traite l'outbox (au moins une fois, idempotent côté consommateur)
 * puis envoie les e-mails en file. Plusieurs instances peuvent tourner :
 * FOR UPDATE SKIP LOCKED + bail (locked_until) évitent les doubles traitements.
 */
import { db, withTransaction } from "../../core/db.js";
import { env } from "../../config/env.js";
import { sendEmail } from "../../integrations/email.js";
import { handlers, type OutboxRow } from "./handlers.js";

const MAX_OUTBOX_ATTEMPTS = 8;
const MAX_EMAIL_ATTEMPTS = 5;
const backoffMs = (attempt: number) => Math.min(60 * 60_000, 2 ** attempt * 5_000);

export async function processOutboxBatch(limit = 20): Promise<number> {
  const claimed = await db.query<OutboxRow & { attempt_count: number }>(
    `update shared.outbox_events set status = 'processing', locked_until = now() + interval '60 seconds', attempt_count = attempt_count + 1
      where id in (select id from shared.outbox_events
                    where status in ('pending','processing') and next_attempt_at <= now() and (locked_until is null or locked_until < now())
                    order by occurred_at for update skip locked limit $1)
      returning id, event_type, aggregate_id, payload, correlation_id, attempt_count, occurred_at`, [limit]);
  // RETURNING ne garantit aucun ordre : on rétablit l'ordre chronologique des événements.
  const ordered = [...claimed.rows].sort((a: any, b: any) => new Date(a.occurred_at).getTime() - new Date(b.occurred_at).getTime());
  for (const evt of ordered) {
    try {
      await withTransaction(async (tx) => {
        const h = handlers[evt.event_type];
        if (h) await h(tx, evt);
        // Sans gestionnaire : l'événement reste disponible (consommateurs futurs, ex. intégration Market).
        await tx.query(`update shared.outbox_events set status = 'published', published_at = now(), locked_until = null, last_error = null where id = $1`, [evt.id]);
      });
    } catch (err) {
      const final = evt.attempt_count >= MAX_OUTBOX_ATTEMPTS;
      await db.query(
        `update shared.outbox_events set status = $2, locked_until = null, next_attempt_at = now() + make_interval(secs => $3), last_error = $4 where id = $1`,
        [evt.id, final ? "failed" : "pending", backoffMs(evt.attempt_count) / 1000, String((err as any)?.code ?? (err as Error)?.message ?? "ERROR").slice(0, 300)]);
    }
  }
  return claimed.rowCount ?? 0;
}

export async function processEmailBatch(limit = 20): Promise<number> {
  const claimed = await db.query(
    `update shared.notification_deliveries d set attempt_count = attempt_count + 1, next_attempt_at = now() + interval '2 minutes'
      where id in (select id from shared.notification_deliveries where channel = 'email' and status = 'queued' and next_attempt_at <= now()
                    order by created_at for update skip locked limit $1)
      returning d.id, d.destination, d.attempt_count, (select title from shared.notifications n where n.id = d.notification_id) as title,
                (select body from shared.notifications n where n.id = d.notification_id) as body`, [limit]);
  for (const d of claimed.rows) {
    const r = await sendEmail({ to: d.destination, subject: d.title, text: `${d.body}\n\n— Trans Afrique Canada`, idempotencyKey: `delivery:${d.id}` });
    if (r.status === "accepted") {
      await db.query(`update shared.notification_deliveries set status = 'accepted', provider = 'resend', provider_message_id = $2, accepted_at = now(), last_error = null where id = $1`, [d.id, r.providerMessageId]);
    } else if (r.status === "skipped") {
      await db.query(`update shared.notification_deliveries set status = 'skipped', status_reason = $2 where id = $1`, [d.id, r.reason]);
    } else if (r.retryable && d.attempt_count < MAX_EMAIL_ATTEMPTS) {
      await db.query(`update shared.notification_deliveries set next_attempt_at = now() + make_interval(secs => $2), last_error = $3 where id = $1`, [d.id, backoffMs(d.attempt_count) / 1000, r.reason]);
    } else {
      await db.query(`update shared.notification_deliveries set status = 'failed', last_error = $2 where id = $1`, [d.id, r.reason]);
    }
  }
  return claimed.rowCount ?? 0;
}

/** Devis expirés : statut rendu explicite (la vérification à l'acceptation reste la garantie). */
export async function expireQuotes() {
  await db.query(`update canada.quotation_versions set status = 'expired' where status in ('issued','viewed') and valid_until <= now()`);
}

/** Purge bornée des clés d'idempotence expirées (fenêtre de rejeu de 24 h). */
export async function purgeIdempotencyKeys() {
  await db.query(`delete from shared.idempotency_keys where id in (select id from shared.idempotency_keys where expires_at < now() limit 1000)`);
}

export async function runWorkerOnce() {
  let n = 0;
  while ((await processOutboxBatch()) > 0 && n++ < 50) { /* vider la file */ }
  await processEmailBatch();
  await expireQuotes();
  await purgeIdempotencyKeys();
}

let timer: NodeJS.Timeout | null = null;
export function startWorker() {
  if (timer || !env().WORKER_ENABLED) return;
  let running = false;
  timer = setInterval(async () => {
    if (running) return;
    running = true;
    try { await runWorkerOnce(); } catch (err) { console.error(`[worker] cycle en échec; code=${(err as any)?.code ?? "UNKNOWN"}`); }
    finally { running = false; }
  }, env().OUTBOX_POLL_MS);
  timer.unref();
}
export function stopWorker() { if (timer) clearInterval(timer); timer = null; }

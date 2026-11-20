/**
 * Webhook Resend : statut RÉEL de délivrance des e-mails (Cahier §8.7 : une
 * notification n'est pas « délivrée » parce que le fournisseur l'a acceptée).
 * Signature Svix vérifiée (HMAC-SHA256 de `id.timestamp.corps`, fenêtre de 5 min),
 * comme dans le backend existant. Dédoublonnage par shared.inbox_events
 * (Dossier 05 §17.3). Rebonds et plaintes alimentent la liste de suppression.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import express, { type Request, type Response } from "express";
import { env } from "../../config/env.js";
import { withTransaction } from "../../core/db.js";

const TOLERANCE_SECONDS = 300;

export function verifySvixSignature(raw: Buffer, headers: { id?: string; timestamp?: string; signature?: string }, secret: string, now = Date.now()) {
  if (!headers.id || !headers.timestamp || !headers.signature) return false;
  const ts = Number(headers.timestamp);
  if (!Number.isFinite(ts) || Math.abs(now / 1000 - ts) > TOLERANCE_SECONDS) return false;
  const key = Buffer.from(secret.startsWith("whsec_") ? secret.slice(6) : secret, "base64");
  const expected = createHmac("sha256", key).update(`${headers.id}.${headers.timestamp}.${raw.toString("utf8")}`).digest();
  return headers.signature.split(" ").some((part) => {
    const [version, sig] = part.split(",");
    if (version !== "v1" || !sig) return false;
    const given = Buffer.from(sig, "base64");
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

/** UUID déterministe dérivé de l'identifiant Svix (clé d'unicité de l'inbox). */
const eventUuid = (svixId: string) => {
  const h = createHash("sha256").update(`resend:${svixId}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

const STATUS: Record<string, string | null> = {
  "email.delivered": "delivered", "email.bounced": "bounced", "email.complained": "complained", "email.failed": "failed", "email.delivery_delayed": null,
};

export async function resendWebhook(req: Request, res: Response) {
  const secret = env().RESEND_WEBHOOK_SECRET;
  if (!secret) return res.status(503).json({ success: false, error: { code: "WEBHOOK_NOT_CONFIGURED" } });
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from("");
  const h = { id: req.header("svix-id") ?? undefined, timestamp: req.header("svix-timestamp") ?? undefined, signature: req.header("svix-signature") ?? undefined };
  if (!verifySvixSignature(raw, h, secret)) return res.status(400).json({ success: false, error: { code: "INVALID_SIGNATURE" } });
  let event: any;
  try { event = JSON.parse(raw.toString("utf8")); } catch { return res.status(400).json({ success: false, error: { code: "INVALID_JSON" } }); }
  const type = String(event?.type ?? "");
  if (!(type in STATUS)) return res.status(200).json({ success: true, data: { ignored: true } });
  const messageId = String(event?.data?.email_id ?? "");
  const recipient = String(Array.isArray(event?.data?.to) ? event.data.to[0] ?? "" : event?.data?.to ?? "").toLowerCase();

  const outcome = await withTransaction(async (tx) => {
    const inbox = await tx.query(
      `insert into shared.inbox_events(event_id, source_system, event_type, event_version, processing_status)
       values ($1, 'resend', $2, 1, 'received') on conflict (source_system, event_id) do nothing returning id`, [eventUuid(h.id!), type]);
    if (!inbox.rowCount) return { duplicate: true, applied: false };
    const next = STATUS[type];
    const upd = next
      ? await tx.query(
        `update shared.notification_deliveries set status = $2::text,
                delivered_at = case when $2::text = 'delivered' then now() else delivered_at end, last_error = $3
          where provider = 'resend' and provider_message_id = $1 and status not in ('bounced','complained') returning id`,
        [messageId, next, next === "delivered" ? null : type])
      : await tx.query(`update shared.notification_deliveries set last_error = 'DELIVERY_DELAYED' where provider = 'resend' and provider_message_id = $1 returning id`, [messageId]);
    if ((type === "email.bounced" || type === "email.complained") && recipient) {
      await tx.query(`insert into shared.email_suppressions(email_normalized, reason, detail) values ($1, $2, $3) on conflict do nothing`,
        [recipient, type === "email.bounced" ? "bounced" : "complained", String(event?.data?.bounce?.message ?? "").slice(0, 500) || null]);
    }
    await tx.query(`update shared.inbox_events set processing_status = 'processed', processed_at = now() where source_system = 'resend' and event_id = $1`, [eventUuid(h.id!)]);
    return { duplicate: false, applied: (upd.rowCount ?? 0) > 0 };
  });
  return res.status(200).json({ success: true, data: outcome });
}

export const resendWebhookRaw = [express.raw({ type: "*/*", limit: "1mb" }), (req: Request, res: Response, next: express.NextFunction) => {
  resendWebhook(req, res).catch(next);
}];


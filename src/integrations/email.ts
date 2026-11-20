/**
 * Fournisseur e-mail — Resend (déjà retenu par le backend existant).
 * Règle conservée de l'existant : sans configuration, AUCUN e-mail n'est
 * déclaré envoyé ; le résultat est « skipped / EMAIL_NOT_CONFIGURED ».
 * « accepted » signifie accepté par le fournisseur, pas délivré (Cahier §8.7).
 */
import { env } from "../config/env.js";

export type EmailResult =
  | { status: "accepted"; providerMessageId: string }
  | { status: "skipped"; reason: "EMAIL_NOT_CONFIGURED" | "SUPPRESSED" }
  | { status: "failed"; retryable: boolean; reason: string };

export interface EmailMessage { to: string; subject: string; text: string; html?: string; idempotencyKey?: string }

export type EmailTransport = (m: EmailMessage) => Promise<EmailResult>;

const resendTransport: EmailTransport = async (m) => {
  const e = env();
  if (!e.RESEND_API_KEY || !e.RESEND_FROM_EMAIL) return { status: "skipped", reason: "EMAIL_NOT_CONFIGURED" };
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${e.RESEND_API_KEY}`,
        "Content-Type": "application/json",
        ...(m.idempotencyKey ? { "Idempotency-Key": m.idempotencyKey.slice(0, 256) } : {}),
      },
      body: JSON.stringify({ from: e.RESEND_FROM_EMAIL, to: [m.to], subject: m.subject, text: m.text, html: m.html }),
      signal: AbortSignal.timeout(12_000),
    });
    if (r.ok) {
      const body: any = await r.json().catch(() => ({}));
      return body?.id ? { status: "accepted", providerMessageId: String(body.id) } : { status: "failed", retryable: true, reason: "NO_MESSAGE_ID" };
    }
    return { status: "failed", retryable: r.status === 429 || r.status >= 500, reason: `HTTP_${r.status}` };
  } catch (err) {
    return { status: "failed", retryable: true, reason: (err as Error)?.name === "TimeoutError" ? "TIMEOUT" : "NETWORK" };
  }
};

let transport: EmailTransport = resendTransport;

export function sendEmail(m: EmailMessage) { return transport(m); }

/** Uniquement pour les tests : remplace le transport HTTP par un enregistreur. */
export function setEmailTransportForTests(t: EmailTransport | null) { transport = t ?? resendTransport; }

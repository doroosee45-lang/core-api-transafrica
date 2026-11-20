/**
 * Paiements (Spéc. backend §18, Dossier 05 Flux 07 et 15, Dossier 03 §4.6).
 * Confirmation uniquement par source vérifiable :
 *   - encaissement au guichet enregistré par un personnel habilité (payments.verify),
 *     avec référence de reçu obligatoire, unique, auditée ;
 *   - (prévu) webhook signé / interrogation du prestataire — prestataires non retenus.
 * Jamais sur redirection navigateur, capture d'écran ou déclaration du client.
 */
import type { Db } from "../../../core/db.js";
import { one, withTransaction } from "../../../core/db.js";
import { audit } from "../../../core/audit.js";
import { conflict, forbidden, notFound, unprocessable, msg } from "../../../core/errors.js";
import { assertAmountPrecision, D, roundCurrency } from "../../../core/money.js";
import { emit } from "../../../core/outbox.js";
import { sequentialReference } from "../../../core/references.js";
import { assertCan, type Principal, type ResourceScope } from "../../access/authorization.js";
import { loadAgency } from "../common.js";

export async function loadPayment(d: Db, id: string, lock = false) {
  const p = await one(d,
    `select p.*, c.user_id as client_user_id, a.country_code as agency_country
       from canada.payments p join canada.clients c on c.id = p.client_id join canada.agencies a on a.id = p.agency_id
      where p.id = $1 ${lock ? "for update of p" : ""}`, [id]);
  if (!p) throw notFound("PAYMENT_NOT_FOUND", "Paiement introuvable.");
  return p;
}

export const paymentResource = (p: any): ResourceScope => ({ countries: [p.agency_country], agencyIds: [p.agency_id], ownerUserIds: [p.client_user_id] });

export async function createPayment(actor: Principal, input: {
  client_id: string; agency_id: string; amount_due: string; currency: string; purpose: string; due_date?: string | null; quotation_version_id?: string | null;
}, correlationId: string) {
  return withTransaction(async (tx) => {
    assertAmountPrecision(input.amount_due, input.currency, "amount_due");
    const agency = await loadAgency(tx, input.agency_id);
    assertCan(actor, "canada.payments.create", { countries: [agency.country_code], agencyIds: [agency.id] });
    const client = await one(tx, `select id from canada.clients where id = $1 and status = 'active'`, [input.client_id]);
    if (!client) throw unprocessable("CLIENT_INVALID", "Client inconnu ou inactif.");
    if (input.quotation_version_id) {
      const v = await one(tx,
        `select qv.status, qv.total, qv.currency, q.client_id from canada.quotation_versions qv join canada.quotations q on q.id = qv.quotation_id where qv.id = $1`,
        [input.quotation_version_id]);
      if (!v || v.status !== "accepted" || v.client_id !== input.client_id) throw unprocessable("QUOTE_NOT_ACCEPTED", "La version de devis doit être acceptée par ce client.");
      if (v.currency !== input.currency) throw unprocessable("CURRENCY_MISMATCH", "Devise différente du devis.");
      const already = await one(tx, `select coalesce(sum(amount_due), 0) as s from canada.payments where quotation_version_id = $1 and status not in ('cancelled','expired','failed')`, [input.quotation_version_id]);
      if (D(already.s).add(input.amount_due).gt(v.total)) throw unprocessable("AMOUNT_EXCEEDS_QUOTE", "Le montant dépasse le solde du devis accepté.");
    }
    const p = await one(tx,
      `insert into canada.payments(reference, client_id, agency_id, quotation_version_id, purpose, amount_due, currency, status, due_date, created_by)
       values ($1,$2,$3,$4,$5,$6,$7,'pending',$8,$9) returning *`,
      [await sequentialReference(tx, "PAY"), input.client_id, agency.id, input.quotation_version_id ?? null, input.purpose,
       roundCurrency(D(input.amount_due), input.currency), input.currency, input.due_date ?? null, actor.userId]);
    await audit(tx, { actorUserId: actor.userId, action: "canada.payment.created", resourceType: "payment", resourceId: p.id,
      countryCode: agency.country_code, agencyId: agency.id, next: { amount_due: p.amount_due, currency: p.currency }, correlationId });
    return p;
  });
}

/** Encaissement au guichet : enregistré par un personnel habilité, avec référence de reçu. */
export async function recordCounterReceipt(actor: Principal, paymentId: string, input: {
  amount: string; currency: string; method: string; receipt_reference: string; occurred_at?: string | null; note?: string | null;
}, correlationId: string) {
  return withTransaction(async (tx) => {
    const p = await loadPayment(tx, paymentId, true);
    assertCan(actor, "canada.payments.verify", { countries: [p.agency_country], agencyIds: [p.agency_id] });
    if (p.client_user_id && p.client_user_id === actor.userId) throw forbidden("SELF_CONFIRMATION", "Impossible de confirmer son propre paiement.");
    if (!["pending", "created", "processing", "under_review"].includes(p.status)) throw conflict("INVALID_STATE", msg("Paiement au statut {p0}.", { p0: p.status }));
    if (input.currency !== p.currency) throw unprocessable("CURRENCY_MISMATCH", msg("Devise attendue : {p0}.", { p0: p.currency }));
    assertAmountPrecision(input.amount, p.currency);
    // Un reçu déjà saisi est signalé comme tel, avant tout contrôle de montant.
    if (await one(tx, `select 1 from canada.payment_transactions where payment_id = $1 and receipt_reference = $2`, [p.id, input.receipt_reference])) {
      throw conflict("RECEIPT_ALREADY_RECORDED", "Ce reçu est déjà enregistré pour ce paiement.");
    }
    const amount = D(input.amount);
    const remaining = D(p.amount_due).sub(p.amount_paid);
    if (amount.lte(0) || amount.gt(remaining)) throw unprocessable("AMOUNT_INVALID", msg("Montant invalide (solde restant : {p0} {p1}).", { p0: remaining.toFixed(), p1: p.currency }));
    let tx1;
    try {
      tx1 = await one(tx,
        `insert into canada.payment_transactions(payment_id, kind, method, amount, currency, status, source, receipt_reference, evidence, recorded_by, occurred_at)
         values ($1,'charge',$2,$3,$4,'succeeded','counter_receipt',$5,$6,$7,coalesce($8::timestamptz, now())) returning *`,
        [p.id, input.method, roundCurrency(amount, p.currency), p.currency, input.receipt_reference,
         JSON.stringify({ note: input.note ?? null }), actor.userId, input.occurred_at ?? null]);
    } catch (err: any) {
      if (err?.code === "23505") throw conflict("RECEIPT_ALREADY_RECORDED", "Ce reçu est déjà enregistré pour ce paiement.");
      throw err;
    }
    const paid = D(p.amount_paid).add(amount);
    const complete = paid.gte(p.amount_due);
    await tx.query(`update canada.payments set amount_paid = $2, status = $3::text, confirmed_at = case when $3::text = 'succeeded' then now() else confirmed_at end where id = $1`,
      [p.id, roundCurrency(paid, p.currency), complete ? "succeeded" : "pending"]);
    await emit(tx, { type: complete ? "canada.payment.confirmed" : "canada.payment.partially_received", aggregateType: "payment", aggregateId: p.id, correlationId,
      payload: { payment_id: p.id, reference: p.reference, client_id: p.client_id, amount_paid: roundCurrency(paid, p.currency), amount_due: p.amount_due, currency: p.currency } });
    await audit(tx, { actorUserId: actor.userId, action: "canada.payment.counter_receipt_recorded", resourceType: "payment", resourceId: p.id,
      countryCode: p.agency_country, agencyId: p.agency_id, previous: { amount_paid: p.amount_paid, status: p.status },
      next: { amount_paid: roundCurrency(paid, p.currency), status: complete ? "succeeded" : "pending", receipt_reference: input.receipt_reference }, correlationId });
    return { payment_id: p.id, transaction: tx1, amount_paid: roundCurrency(paid, p.currency), balance: roundCurrency(D(p.amount_due).sub(paid), p.currency), status: complete ? "succeeded" : "pending" };
  });
}

export async function cancelPayment(actor: Principal, id: string, reason: string, correlationId: string) {
  return withTransaction(async (tx) => {
    const p = await loadPayment(tx, id, true);
    assertCan(actor, "canada.payments.reconcile", { countries: [p.agency_country], agencyIds: [p.agency_id] });
    if (D(p.amount_paid).gt(0)) throw conflict("PAYMENT_HAS_FUNDS", "Des fonds ont été encaissés : utiliser un remboursement.");
    if (!["created", "pending", "under_review"].includes(p.status)) throw conflict("INVALID_STATE", msg("Paiement au statut {p0}.", { p0: p.status }));
    await tx.query(`update canada.payments set status = 'cancelled', cancelled_at = now(), cancelled_by = $2 where id = $1`, [p.id, actor.userId]);
    await audit(tx, { actorUserId: actor.userId, action: "canada.payment.cancelled", resourceType: "payment", resourceId: p.id, reason, correlationId });
    return { payment_id: p.id, status: "cancelled" };
  });
}

export async function requestRefund(actor: Principal, paymentId: string, input: { amount: string; reason: string }, correlationId: string) {
  return withTransaction(async (tx) => {
    const p = await loadPayment(tx, paymentId, true);
    assertCan(actor, "canada.refunds.request", paymentResource(p));
    assertAmountPrecision(input.amount, p.currency);
    const pending = await one(tx, `select coalesce(sum(amount), 0) as s from canada.refunds where payment_id = $1 and status in ('requested','approved')`, [p.id]);
    const available = D(p.amount_paid).sub(p.amount_refunded).sub(pending.s);
    if (D(input.amount).lte(0) || D(input.amount).gt(available)) throw unprocessable("REFUND_AMOUNT_INVALID", msg("Montant remboursable : {p0} {p1}.", { p0: available.toFixed(), p1: p.currency }));
    const r = await one(tx, `insert into canada.refunds(payment_id, amount, currency, reason, requested_by) values ($1,$2,$3,$4,$5) returning *`,
      [p.id, roundCurrency(D(input.amount), p.currency), p.currency, input.reason, actor.userId]);
    await audit(tx, { actorUserId: actor.userId, action: "canada.refund.requested", resourceType: "refund", resourceId: r.id, reason: input.reason, next: { amount: r.amount }, correlationId });
    return r;
  });
}

export async function decideRefund(actor: Principal, refundId: string, decision: "approve" | "reject", note: string | null, correlationId: string) {
  return withTransaction(async (tx) => {
    const r = await one(tx, `select * from canada.refunds where id = $1 for update`, [refundId]);
    if (!r) throw notFound("REFUND_NOT_FOUND", "Remboursement introuvable.");
    const p = await loadPayment(tx, r.payment_id);
    assertCan(actor, "canada.refunds.approve", { countries: [p.agency_country], agencyIds: [p.agency_id] });
    if (r.requested_by === actor.userId) throw forbidden("SEPARATION_OF_DUTIES", "Le demandeur ne peut pas approuver sa propre demande.");
    if (r.status !== "requested") throw conflict("INVALID_STATE", msg("Remboursement au statut {p0}.", { p0: r.status }));
    const status = decision === "approve" ? "approved" : "rejected";
    await tx.query(`update canada.refunds set status = $2, decided_by = $3, decided_at = now(), decision_note = $4 where id = $1`, [r.id, status, actor.userId, note]);
    await audit(tx, { actorUserId: actor.userId, action: `canada.refund.${status}`, resourceType: "refund", resourceId: r.id, reason: note, correlationId });
    return { refund_id: r.id, status };
  });
}

export async function executeRefund(actor: Principal, refundId: string, input: { method: string; receipt_reference: string }, correlationId: string) {
  return withTransaction(async (tx) => {
    const r = await one(tx, `select * from canada.refunds where id = $1 for update`, [refundId]);
    if (!r) throw notFound("REFUND_NOT_FOUND", "Remboursement introuvable.");
    const p = await loadPayment(tx, r.payment_id, true);
    assertCan(actor, "canada.refunds.execute", { countries: [p.agency_country], agencyIds: [p.agency_id] });
    if (r.status !== "approved") throw conflict("REFUND_NOT_APPROVED", "Le remboursement doit être approuvé avant exécution.");
    const t = await one(tx,
      `insert into canada.payment_transactions(payment_id, kind, method, amount, currency, status, source, receipt_reference, recorded_by)
       values ($1,'refund',$2,$3,$4,'succeeded','counter_receipt',$5,$6) returning id`,
      [p.id, input.method, r.amount, r.currency, input.receipt_reference, actor.userId]);
    const refunded = D(p.amount_refunded).add(r.amount);
    const status = refunded.gte(p.amount_paid) ? "refunded" : "partially_refunded";
    await tx.query(`update canada.payments set amount_refunded = $2, status = $3 where id = $1`, [p.id, roundCurrency(refunded, p.currency), status]);
    await tx.query(`update canada.refunds set status = 'executed', executed_by = $2, executed_at = now(), transaction_id = $3 where id = $1`, [r.id, actor.userId, t.id]);
    await audit(tx, { actorUserId: actor.userId, action: "canada.refund.executed", resourceType: "refund", resourceId: r.id,
      next: { payment_status: status, amount_refunded: roundCurrency(refunded, p.currency) }, correlationId });
    return { refund_id: r.id, status: "executed", payment_status: status };
  });
}

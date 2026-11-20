/**
 * Devis officiels (Spéc. backend §17, Dossier 05 Flux 05-06).
 * - Totaux calculés côté serveur, en décimal, arrondi documenté par devise.
 * - Une version émise est figée (trigger SQL) ; toute modification = nouvelle version.
 * - L'acceptation porte sur UNE version précise et crée l'obligation de paiement.
 */
import type { Decimal } from "decimal.js";
import type { Db } from "../../../core/db.js";
import { one, withTransaction } from "../../../core/db.js";
import { audit } from "../../../core/audit.js";
import { badRequest, conflict, notFound, unprocessable, msg } from "../../../core/errors.js";
import { D, findRate, roundCurrency, type AppliedRate } from "../../../core/money.js";
import { emit } from "../../../core/outbox.js";
import { sequentialReference } from "../../../core/references.js";
import { assertCan, type Principal, type ResourceScope } from "../../access/authorization.js";
import { findActivePricingRule, loadAgency } from "../common.js";

export interface LineInput { category: string; designation: string; quantity: string; unit_price: string; currency: string; parcel_id?: string | null }

/**
 * Un colis ne peut figurer que dans un devis de son expéditeur ou de son destinataire
 * (mêmes clients que la lecture « propriétaire » des colis) et sur la même route.
 */
async function assertParcelForQuote(tx: Db, q: { clientId: string; origin: string; destination: string }, parcelId: string) {
  const p = await one(tx, `select id, reference, client_id, recipient_client_id, origin_country, destination_country, transport_mode, category, billable_weight_kg
                             from canada.parcels where id = $1`, [parcelId]);
  if (!p) throw unprocessable("PARCEL_UNKNOWN", "Colis inconnu.");
  if (p.client_id !== q.clientId && p.recipient_client_id !== q.clientId) throw unprocessable("PARCEL_CLIENT_MISMATCH", "Ce colis n'appartient pas au client du devis.");
  if (p.origin_country !== q.origin || p.destination_country !== q.destination) throw unprocessable("ROUTE_MISMATCH", msg("Route du colis {p0} différente du devis.", { p0: p.reference }));
  return p;
}

async function buildLines(tx: Db, q: { clientId: string; currency: string; origin: string; destination: string }, parcelIds: string[], manual: LineInput[]) {
  const lines: any[] = [];
  const rates: AppliedRate[] = [];
  let pricingRuleId: string | null = null;
  const convert = async (amount: Decimal, from: string) => {
    if (from === q.currency) return amount;
    let r = rates.find((x) => x.base === from && x.quote === q.currency);
    if (!r) { r = await findRate(tx, from, q.currency); rates.push(r); }
    return amount.mul(r.rate);
  };

  for (const pid of parcelIds) {
    const p = await assertParcelForQuote(tx, q, pid);
    if (!p.billable_weight_kg) throw unprocessable("MEASUREMENT_REQUIRED", msg("Le colis {p0} n'est pas encore pesé.", { p0: p.reference }));
    const rule = await findActivePricingRule(tx, { origin: p.origin_country, destination: p.destination_country, mode: p.transport_mode, category: p.category });
    if (!rule) throw unprocessable("PRICING_RULE_MISSING", "Aucun barème actif pour cette route.");
    pricingRuleId = rule.id;
    let base = D(p.billable_weight_kg).mul(rule.rate_per_kg);
    if (base.lt(rule.minimum_charge)) base = D(rule.minimum_charge);
    const amount = await convert(base, rule.currency);
    lines.push({
      category: "transport", designation: `Transport ${p.reference} (${p.billable_weight_kg} kg facturables)`, parcel_id: p.id,
      quantity: p.billable_weight_kg, unit_price: (await convert(D(rule.rate_per_kg), rule.currency)).toDecimalPlaces(4).toString(),
      amount: roundCurrency(amount, q.currency), currency: q.currency,
      calculation_rule: `max(${p.billable_weight_kg} kg × ${rule.rate_per_kg} ${rule.currency}, minimum ${rule.minimum_charge}) — barème ${rule.code} v${rule.version}`,
    });
    if (D(rule.service_fee).gt(0) && !lines.some((l) => l.category === "service" && l.calculation_rule.includes(rule.code))) {
      lines.push({
        category: "service", designation: "Frais de service", parcel_id: null, quantity: "1",
        unit_price: (await convert(D(rule.service_fee), rule.currency)).toDecimalPlaces(4).toString(),
        amount: roundCurrency(await convert(D(rule.service_fee), rule.currency), q.currency), currency: q.currency,
        calculation_rule: `Frais de service fixes — barème ${rule.code} v${rule.version}`,
      });
    }
  }
  for (const m of manual) {
    if (m.parcel_id) await assertParcelForQuote(tx, q, m.parcel_id);
    const unit = await convert(D(m.unit_price), m.currency);
    lines.push({
      category: m.category, designation: m.designation, parcel_id: m.parcel_id ?? null, quantity: m.quantity,
      unit_price: unit.toDecimalPlaces(4).toString(), amount: roundCurrency(unit.mul(m.quantity), q.currency), currency: q.currency,
      calculation_rule: m.currency === q.currency ? "Saisie manuelle" : `Saisie manuelle convertie depuis ${m.currency}`,
    });
  }
  if (!lines.length) throw badRequest("QUOTE_EMPTY", "Un devis doit contenir au moins une ligne.");
  const total = lines.reduce((s, l) => s.add(l.amount), D(0));
  return { lines, rates, pricingRuleId, total: roundCurrency(total, q.currency) };
}

async function writeVersion(tx: Db, quotationId: string, version: number, q: any, built: Awaited<ReturnType<typeof buildLines>>, actor: string) {
  const v = await one(tx,
    `insert into canada.quotation_versions(quotation_id, version, currency, subtotal, total, pricing_rule_id, exchange_rates, conditions, valid_until, created_by)
     values ($1,$2,$3,$4,$4,$5,$6,$7, now() + make_interval(days => $8), $9) returning *`,
    [quotationId, version, q.currency, built.total, built.pricingRuleId, JSON.stringify(built.rates), q.conditions ?? null, q.valid_days ?? 14, actor]);
  let n = 1;
  for (const l of built.lines) {
    await tx.query(
      `insert into canada.quotation_lines(quotation_version_id, line_no, category, designation, parcel_id, quantity, unit_price, amount, currency, calculation_rule)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [v.id, n++, l.category, l.designation, l.parcel_id, l.quantity, l.unit_price, l.amount, l.currency, l.calculation_rule]);
  }
  return v;
}

export async function loadQuote(d: Db, id: string, lock = false) {
  const q = await one(d,
    `select q.*, c.user_id as client_user_id from canada.quotations q join canada.clients c on c.id = q.client_id
      where q.id = $1 ${lock ? "for update of q" : ""}`, [id]);
  if (!q) throw notFound("QUOTE_NOT_FOUND", "Devis introuvable.");
  return q;
}

export const quoteResource = (q: any): ResourceScope => ({
  countries: [q.origin_country, q.destination_country], agencyIds: [q.agency_id], ownerUserIds: [q.client_user_id],
});

export async function createQuote(actor: Principal, input: any, correlationId: string) {
  return withTransaction(async (tx) => {
    const agency = await loadAgency(tx, input.agency_id);
    if (agency.country_code !== input.origin_country && agency.country_code !== input.destination_country) {
      throw unprocessable("AGENCY_ROUTE_MISMATCH", "L'agence doit être dans le pays d'origine ou de destination.");
    }
    assertCan(actor, "canada.quotes.create", { countries: [agency.country_code], agencyIds: [agency.id] });
    const client = await one(tx, `select id, status from canada.clients where id = $1`, [input.client_id]);
    if (!client || client.status !== "active") throw unprocessable("CLIENT_INVALID", "Client inconnu ou inactif.");
    if (input.request_id) {
      const r = await one(tx, `select id, client_id from canada.requests where id = $1`, [input.request_id]);
      if (!r) throw unprocessable("REQUEST_UNKNOWN", "Demande inconnue.");
      // Demande publique anonyme (sans client) : rattachement par le personnel ; sinon, même client obligatoire.
      if (r.client_id && r.client_id !== input.client_id) throw unprocessable("REQUEST_CLIENT_MISMATCH", "Cette demande appartient à un autre client.");
    }
    const built = await buildLines(tx, { clientId: input.client_id, currency: input.currency, origin: input.origin_country, destination: input.destination_country },
      input.parcel_ids ?? [], input.lines ?? []);
    const q = await one(tx,
      `insert into canada.quotations(reference, client_id, request_id, origin_country, destination_country, agency_id, created_by)
       values ($1,$2,$3,$4,$5,$6,$7) returning *`,
      [await sequentialReference(tx, "QT"), input.client_id, input.request_id ?? null, input.origin_country, input.destination_country, agency.id, actor.userId]);
    const v = await writeVersion(tx, q.id, 1, input, built, actor.userId);
    if (input.request_id) await tx.query(`update canada.requests set status = 'quoted', handled_by = $2, handled_at = now() where id = $1`, [input.request_id, actor.userId]);
    await audit(tx, { actorUserId: actor.userId, action: "canada.quote.created", resourceType: "quotation", resourceId: q.id,
      agencyId: agency.id, next: { reference: q.reference, version: 1, total: v.total, currency: v.currency }, correlationId });
    return { ...q, version: v };
  });
}

/** Nouvelle version (brouillon) à partir des lignes fournies ; la précédente reste intacte jusqu'à l'émission. */
export async function reviseQuote(actor: Principal, id: string, input: any, correlationId: string) {
  return withTransaction(async (tx) => {
    const q = await loadQuote(tx, id, true);
    assertCan(actor, "canada.quotes.update_draft", quoteResource(q));
    const cur = await one(tx, `select * from canada.quotation_versions where quotation_id = $1 and version = $2`, [q.id, q.current_version]);
    if (["cancelled"].includes(cur.status)) throw conflict("QUOTE_CANCELLED", "Devis annulé.");
    if (cur.status === "draft") {
      // Un brouillon se remplace : suppression des lignes puis réécriture (aucune version émise n'est touchée).
      await tx.query(`delete from canada.quotation_lines where quotation_version_id = $1`, [cur.id]);
      const built = await buildLines(tx, { clientId: q.client_id, currency: input.currency ?? cur.currency, origin: q.origin_country, destination: q.destination_country }, input.parcel_ids ?? [], input.lines ?? []);
      let n = 1;
      for (const l of built.lines) {
        await tx.query(`insert into canada.quotation_lines(quotation_version_id, line_no, category, designation, parcel_id, quantity, unit_price, amount, currency, calculation_rule)
                        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [cur.id, n++, l.category, l.designation, l.parcel_id, l.quantity, l.unit_price, l.amount, l.currency, l.calculation_rule]);
      }
      await tx.query(`update canada.quotation_versions set currency = $2, subtotal = $3, total = $3, pricing_rule_id = $4, exchange_rates = $5, conditions = coalesce($6, conditions) where id = $1`,
        [cur.id, input.currency ?? cur.currency, built.total, built.pricingRuleId, JSON.stringify(built.rates), input.conditions ?? null]);
      return one(tx, `select * from canada.quotation_versions where id = $1`, [cur.id]);
    }
    const built = await buildLines(tx, { clientId: q.client_id, currency: input.currency ?? cur.currency, origin: q.origin_country, destination: q.destination_country }, input.parcel_ids ?? [], input.lines ?? []);
    const v = await writeVersion(tx, q.id, q.current_version + 1, { ...input, currency: input.currency ?? cur.currency }, built, actor.userId);
    await tx.query(`update canada.quotations set current_version = $2 where id = $1`, [q.id, v.version]);
    await audit(tx, { actorUserId: actor.userId, action: "canada.quote.revised", resourceType: "quotation", resourceId: q.id,
      previous: { version: cur.version, total: cur.total }, next: { version: v.version, total: v.total }, reason: input.reason ?? null, correlationId });
    return v;
  });
}

export async function issueQuote(actor: Principal, id: string, correlationId: string) {
  return withTransaction(async (tx) => {
    const q = await loadQuote(tx, id, true);
    assertCan(actor, "canada.quotes.issue", quoteResource(q));
    const v = await one(tx, `select * from canada.quotation_versions where quotation_id = $1 and version = $2 for update`, [q.id, q.current_version]);
    if (v.status !== "draft") throw conflict("INVALID_STATE", "Seule une version en brouillon peut être émise.");
    // Les versions antérieures non acceptées deviennent caduques.
    await tx.query(`update canada.quotation_versions set status = 'superseded' where quotation_id = $1 and version < $2 and status in ('issued','viewed')`, [q.id, v.version]);
    await tx.query(`update canada.quotation_versions set status = 'issued', issued_at = now(), issued_by = $2 where id = $1`, [v.id, actor.userId]);
    await emit(tx, { type: "canada.quote.issued", aggregateType: "quotation", aggregateId: q.id, correlationId,
      payload: { quotation_id: q.id, reference: q.reference, version: v.version, total: v.total, currency: v.currency, client_id: q.client_id, valid_until: v.valid_until } });
    await audit(tx, { actorUserId: actor.userId, action: "canada.quote.issued", resourceType: "quotation", resourceId: q.id, next: { version: v.version, total: v.total }, correlationId });
    return { quotation_id: q.id, version: v.version, status: "issued", total: v.total, currency: v.currency };
  });
}

export async function cancelQuote(actor: Principal, id: string, reason: string, correlationId: string) {
  return withTransaction(async (tx) => {
    const q = await loadQuote(tx, id, true);
    assertCan(actor, "canada.quotes.cancel", quoteResource(q));
    const v = await one(tx, `select * from canada.quotation_versions where quotation_id = $1 and version = $2 for update`, [q.id, q.current_version]);
    if (v.status === "accepted") {
      const paid = await one(tx, `select 1 from canada.payments where quotation_version_id = $1 and amount_paid > 0`, [v.id]);
      if (paid) throw conflict("QUOTE_PAID", "Devis déjà payé : passer par la procédure d'annulation et de remboursement.");
      await tx.query(`update canada.payments set status = 'cancelled', cancelled_at = now(), cancelled_by = $2 where quotation_version_id = $1 and status in ('created','pending')`, [v.id, actor.userId]);
    }
    if (["cancelled", "rejected", "expired", "superseded"].includes(v.status)) throw conflict("INVALID_STATE", msg("Version déjà {p0}.", { p0: v.status }));
    await tx.query(`update canada.quotation_versions set status = 'cancelled' where id = $1`, [v.id]);
    await audit(tx, { actorUserId: actor.userId, action: "canada.quote.cancelled", resourceType: "quotation", resourceId: q.id, reason, correlationId });
    return { quotation_id: q.id, version: v.version, status: "cancelled" };
  });
}

/** Réponse du client (acceptation explicite ou refus) sur une version précise. */
export async function respondToQuote(actor: Principal, id: string, version: number, decision: "accept" | "reject",
  evidence: { ip: string | null; userAgent: string | null }, reason: string | null, correlationId: string) {
  return withTransaction(async (tx) => {
    const q = await loadQuote(tx, id, true);
    assertCan(actor, "canada.quotes.respond_own", { ownerUserIds: [q.client_user_id] }, "Ce devis ne vous appartient pas.");
    const v = await one(tx, `select * from canada.quotation_versions where quotation_id = $1 and version = $2 for update`, [q.id, version]);
    if (!v) throw notFound("QUOTE_VERSION_NOT_FOUND", "Version introuvable.");
    if (version !== q.current_version) throw conflict("QUOTE_VERSION_OUTDATED", "Une version plus récente existe : consultez-la.");
    if (!["issued", "viewed"].includes(v.status)) throw conflict("INVALID_STATE", msg("Version au statut {p0}.", { p0: v.status }));
    if (v.valid_until && new Date(v.valid_until) <= new Date()) {
      await tx.query(`update canada.quotation_versions set status = 'expired' where id = $1`, [v.id]);
      throw conflict("QUOTE_EXPIRED", "Ce devis a expiré.");
    }
    if (decision === "reject") {
      await tx.query(`update canada.quotation_versions set status = 'rejected', rejected_at = now(), rejected_by = $2, rejection_reason = $3 where id = $1`, [v.id, actor.userId, reason]);
      await audit(tx, { actorUserId: actor.userId, action: "canada.quote.rejected", resourceType: "quotation", resourceId: q.id, next: { version }, reason, correlationId });
      return { quotation_id: q.id, version, status: "rejected" };
    }
    await tx.query(`update canada.quotation_versions set status = 'accepted', accepted_at = now(), accepted_by = $2, acceptance_evidence = $3 where id = $1`,
      [v.id, actor.userId, JSON.stringify({ ip: evidence.ip, user_agent: evidence.userAgent?.slice(0, 300) ?? null, accepted_at: new Date().toISOString(), total: v.total, currency: v.currency })]);
    const payment = await one(tx,
      `insert into canada.payments(reference, client_id, agency_id, quotation_version_id, purpose, amount_due, currency, status, created_by)
       values ($1,$2,$3,$4,'logistics',$5,$6,'pending',$7) returning id, reference, amount_due, currency, status`,
      [await sequentialReference(tx, "PAY"), q.client_id, q.agency_id, v.id, v.total, v.currency, actor.userId]);
    await emit(tx, { type: "canada.quote.accepted", aggregateType: "quotation", aggregateId: q.id, correlationId,
      payload: { quotation_id: q.id, version, payment_id: payment.id, total: v.total, currency: v.currency } });
    await audit(tx, { actorUserId: actor.userId, action: "canada.quote.accepted", resourceType: "quotation", resourceId: q.id,
      next: { version, total: v.total, currency: v.currency, payment_id: payment.id }, correlationId });
    return { quotation_id: q.id, version, status: "accepted", payment };
  });
}

export async function quoteDetail(d: Db, q: any) {
  const versions = (await d.query(`select * from canada.quotation_versions where quotation_id = $1 order by version`, [q.id])).rows;
  const lines = (await d.query(
    `select ql.* from canada.quotation_lines ql join canada.quotation_versions qv on qv.id = ql.quotation_version_id
      where qv.quotation_id = $1 order by qv.version, ql.line_no`, [q.id])).rows;
  return { ...q, client_user_id: undefined, versions: versions.map((v) => ({ ...v, lines: lines.filter((l) => l.quotation_version_id === v.id) })) };
}

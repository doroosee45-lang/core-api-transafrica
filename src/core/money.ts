import { Decimal } from "decimal.js";
import type { Db } from "./db.js";
import { one } from "./db.js";
import { unprocessable, msg } from "./errors.js";

Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

export const D = (v: string | number | Decimal) => new Decimal(v);

const MINOR: Record<string, number> = { USD: 2, EUR: 2, CAD: 2, CNY: 2, XAF: 0, CDF: 2 };

/** Arrondi demi-supérieur aux unités mineures de la devise (règle documentée). */
export function roundCurrency(v: Decimal, currency: string): string {
  const units = MINOR[currency] ?? 2;
  return v.toDecimalPlaces(units, Decimal.ROUND_HALF_UP).toFixed(units);
}

export const minorUnits = (currency: string) => MINOR[currency] ?? 2;

/**
 * Un montant SAISI ne peut pas avoir plus de décimales que la devise n'en admet
 * (ex. XAF : aucune). Refus explicite plutôt qu'un arrondi silencieux qui ferait
 * diverger le montant contrôlé et le montant enregistré.
 */
export function assertAmountPrecision(amount: string, currency: string, field = "amount") {
  const units = minorUnits(currency);
  if (D(amount).decimalPlaces() > units) {
    throw unprocessable("AMOUNT_PRECISION", msg("Le montant {p0} {p1} dépasse la précision de la devise ({p2} décimale(s)).", { p0: amount, p1: currency, p2: units }), [{ path: field }]);
  }
}

export interface AppliedRate { base: string; quote: string; rate: string; effective_at: string; source: string; inverted: boolean }

/** Dernier taux publié (jamais un taux « actuel » appliqué à un document historique). */
export async function findRate(d: Db, from: string, to: string, at = new Date()): Promise<AppliedRate> {
  const direct = await one(d,
    `select base_currency, quote_currency, rate, effective_at, source from canada.exchange_rates
      where base_currency = $1 and quote_currency = $2 and effective_at <= $3 order by effective_at desc limit 1`, [from, to, at]);
  if (direct) return { base: from, quote: to, rate: direct.rate, effective_at: direct.effective_at, source: direct.source, inverted: false };
  const inverse = await one(d,
    `select rate, effective_at, source from canada.exchange_rates
      where base_currency = $1 and quote_currency = $2 and effective_at <= $3 order by effective_at desc limit 1`, [to, from, at]);
  if (inverse) {
    return { base: from, quote: to, rate: D(1).div(inverse.rate).toSignificantDigits(20).toString(), effective_at: inverse.effective_at, source: inverse.source, inverted: true };
  }
  throw unprocessable("EXCHANGE_RATE_MISSING", msg("Aucun taux de change publié {p0} → {p1}.", { p0: from, p1: to }));
}

import { z } from "zod";
import { t } from "./errors.js";

export const Uuid = z.uuid();
export const IdParams = z.object({ id: z.uuid() });
export const CountryCode = z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, t("Code pays ISO 3166-1 alpha-2 attendu"));
export const CurrencyCode = z.enum(["USD", "EUR", "CAD", "CNY", "XAF", "CDF"]);
export const Email = z.string().trim().toLowerCase().pipe(z.email()).refine((v) => v.length <= 254);
export const Password = z.string().min(10, t("10 caractères minimum")).max(128)
  .regex(/[A-Za-z]/, t("Au moins une lettre")).regex(/[0-9]/, t("Au moins un chiffre"));
export const Money = z.union([z.string(), z.number()]).transform((v) => String(v).trim())
  .refine((v) => /^\d{1,14}(\.\d{1,4})?$/.test(v), t("Montant positif attendu (max 4 décimales)"));
/** Taux de change : strictement positif, jusqu'à 10 décimales (colonne numeric(24,10)). */
export const ExchangeRateValue = z.union([z.string(), z.number()]).transform((v) => String(v).trim())
  .refine((v) => /^\d{1,14}(\.\d{1,10})?$/.test(v) && /[1-9]/.test(v), t("Taux strictement positif attendu (max 10 décimales)"));
export const Reason = z.string().trim().min(3).max(1000);
export const IanaTimeZone = z.string().refine((tz) => {
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
}, t("Fuseau horaire IANA invalide"));
export const TransportMode = z.enum(["air", "sea", "road"]);
export const ParcelCategory = z.enum(["document", "clothing", "electronics", "food", "cosmetics", "fragile_item", "other"]);
export const Positive = (max = 100000) => z.coerce.number().positive().max(max);

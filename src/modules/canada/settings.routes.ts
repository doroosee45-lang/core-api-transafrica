/**
 * Paramètres locaux par pays (Cahier §3.3 « paramètres locaux autorisés », §4) et
 * référentiel de libellés bilingues partagé par le web et l'application mobile
 * (cohérence des traductions : une seule source, le backend).
 */
import { Router } from "express";
import { z } from "zod";
import { audit } from "../../core/audit.js";
import { db, one, withTransaction } from "../../core/db.js";
import { notFound, t, unprocessable } from "../../core/errors.js";
import { mount, route } from "../../core/routes.js";
import { CountryCode, IanaTimeZone } from "../../core/schemas.js";
import { DEFAULT_LOCALE, LABELS, SUPPORTED_LOCALES } from "../../i18n/index.js";
import { assertCan } from "../access/authorization.js";

const routes = [
  route({
    method: "get", path: "/i18n", tag: "Référentiels", auth: "public", rateLimit: { windowMs: 60_000, max: 120 },
    summary: "Langues prises en charge, paramètres linguistiques des pays et libellés bilingues des statuts",
    handler: async () => ({
      data: {
        default_locale: DEFAULT_LOCALE,
        supported_locales: SUPPORTED_LOCALES,
        countries: (await db.query(
          `select code, name_fr, name_en, default_locale, supported_locales, default_timezone, default_currency, phone_prefix, is_operating
             from shared.countries where is_active order by is_operating desc, code`)).rows,
        labels: LABELS,
      },
    }),
  }),
  route({
    method: "get", path: "/canada/countries/:code/settings", tag: "Référentiels", auth: "canada", anyPermission: ["canada.settings.read"],
    summary: "Paramètres locaux d'un pays du périmètre", params: z.object({ code: CountryCode }),
    handler: async ({ params, principal }) => {
      assertCan(principal, "canada.settings.read", { countries: [params.code] });
      const c = await one(db, `select code, default_locale, supported_locales, default_timezone, default_currency, phone_prefix from shared.countries where code = $1`, [params.code]);
      if (!c) throw notFound("COUNTRY_NOT_FOUND", "Pays inconnu.");
      return { data: c };
    },
  }),
  route({
    method: "patch", path: "/canada/countries/:code/settings", tag: "Référentiels", auth: "canada", anyPermission: ["canada.settings.manage"],
    summary: "Modifier les paramètres locaux (langues, fuseau par défaut) — administrateur du pays ou global ; la devise reste un réglage financier global",
    params: z.object({ code: CountryCode }),
    body: z.strictObject({
      default_locale: z.enum(["fr", "en"]).optional(),
      supported_locales: z.array(z.enum(["fr", "en"])).min(1).max(2).optional(),
      default_timezone: IanaTimeZone.optional(),
      reason: z.string().trim().min(5).max(1000),
    }),
    handler: async ({ params, body, principal, correlationId }) => {
      assertCan(principal, "canada.settings.manage", { countries: [params.code] });
      return withTransaction(async (tx) => {
        const prev = await one(tx, `select default_locale, supported_locales, default_timezone from shared.countries where code = $1 for update`, [params.code]);
        if (!prev) throw notFound("COUNTRY_NOT_FOUND", "Pays inconnu.");
        const supported = body.supported_locales ?? prev.supported_locales;
        const def = body.default_locale ?? prev.default_locale;
        if (!supported.includes(def)) throw unprocessable("LOCALE_NOT_SUPPORTED", t("Langue non prise en charge pour ce pays."));
        const r = await one(tx,
          `update shared.countries set default_locale = $2, supported_locales = $3, default_timezone = coalesce($4, default_timezone)
            where code = $1 returning code, default_locale, supported_locales, default_timezone, default_currency, phone_prefix`,
          [params.code, def, supported, body.default_timezone ?? null]);
        await audit(tx, { actorUserId: principal.userId, action: "shared.country.settings_updated", resourceType: "country", resourceId: params.code,
          countryCode: params.code, previous: prev, next: { default_locale: def, supported_locales: supported, default_timezone: r.default_timezone }, reason: body.reason, correlationId });
        return { data: r };
      });
    },
  }),
];

export function settingsRouter() {
  const r = Router();
  mount(r, routes);
  return r;
}

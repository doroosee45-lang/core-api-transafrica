/**
 * INTERNATIONALISATION — français (par défaut) et anglais.
 * Décision du 21/11/2026 : français par défaut dans les 5 pays, anglais disponible
 * partout, le choix de l'utilisateur prime toujours.
 *
 * Ordre de résolution de la langue d'une réponse :
 *   1. préférence enregistrée de l'utilisateur authentifié (identity.profiles.preferred_language) ;
 *   2. en-tête Accept-Language (visiteurs non connectés) ;
 *   3. français.
 * Les données (dates ISO 8601 UTC, montants décimaux + code devise) restent neutres
 * dans l'API ; les textes (erreurs, libellés, notifications) sont traduits.
 */
import type { Request } from "express";
import { z } from "zod";
import { render } from "../core/errors.js";
import { DB_RULES, EN } from "./en.js";

export type Locale = "fr" | "en";
export const SUPPORTED_LOCALES: Locale[] = ["fr", "en"];
export const DEFAULT_LOCALE: Locale = "fr";

export const isLocale = (v: unknown): v is Locale => v === "fr" || v === "en";

/** Négociation Accept-Language (RFC 9110) : meilleure langue prise en charge selon q. */
export function negotiate(header: string | undefined | null): Locale | null {
  if (!header) return null;
  const ranked = header.split(",").map((part) => {
    const [tag, ...p] = part.trim().split(";");
    const q = p.find((x) => x.trim().startsWith("q="));
    return { lang: tag.trim().toLowerCase().split("-")[0], q: q ? Number(q.split("=")[1]) : 1 };
  }).filter((x) => x.lang && !Number.isNaN(x.q) && x.q > 0).sort((a, b) => b.q - a.q);
  for (const r of ranked) if (isLocale(r.lang)) return r.lang;
  return null;
}

export function requestLocale(req: Request): Locale {
  const pref = req.principal?.preferredLanguage;
  if (isLocale(pref)) return pref;
  return negotiate(req.header("accept-language")) ?? DEFAULT_LOCALE;
}

/** Traduit un modèle de message (clé = texte français). */
export function translate(template: string, params: Record<string, unknown> | undefined, locale: Locale): string {
  if (template.startsWith("db:")) {
    const rule = DB_RULES[template.slice(3)];
    return rule ? rule[locale] : render(template.slice(3), params);
  }
  if (locale === "fr") return render(template, params);
  return render(EN[template] ?? template, params);
}

/** Table d'erreurs Zod localisée (messages par défaut de la bibliothèque). */
const ZOD_LOCALES = { fr: z.locales.fr(), en: z.locales.en() };
export function zodErrorMap(locale: Locale) {
  return ZOD_LOCALES[locale].localeError;
}

// ---------------------------------------------------------------- Libellés
type Labels = Record<string, { fr: string; en: string }>;

export const LABELS: Record<string, Labels> = {
  parcel_status: {
    expected: { fr: "Attendu", en: "Expected" }, received: { fr: "Réceptionné", en: "Received" },
    inspected: { fr: "Vérifié", en: "Inspected" }, ready_for_shipment: { fr: "Prêt à expédier", en: "Ready for shipment" },
    in_shipment: { fr: "Associé à une expédition", en: "Added to a shipment" }, dispatched: { fr: "Expédié", en: "Dispatched" },
    in_transit: { fr: "En transit", en: "In transit" }, in_customs: { fr: "En douane", en: "In customs" },
    arrived_destination: { fr: "Arrivé dans le pays de destination", en: "Arrived in destination country" },
    received_destination: { fr: "Réceptionné à destination", en: "Received at destination" },
    available: { fr: "Disponible", en: "Available" }, out_for_delivery: { fr: "En cours de livraison", en: "Out for delivery" },
    delivered: { fr: "Livré", en: "Delivered" }, on_hold: { fr: "En attente", en: "On hold" },
    damaged: { fr: "Incident : dommage", en: "Incident: damaged" }, lost: { fr: "Incident : perte", en: "Incident: lost" },
    returned: { fr: "Retourné", en: "Returned" }, cancelled: { fr: "Annulé", en: "Cancelled" },
  },
  shipment_status: {
    planned: { fr: "Planifiée", en: "Planned" }, ready: { fr: "Prête", en: "Ready" }, dispatched: { fr: "Partie", en: "Dispatched" },
    in_transit: { fr: "En transit", en: "In transit" }, arrived: { fr: "Arrivée", en: "Arrived" },
    completed: { fr: "Clôturée", en: "Completed" }, cancelled: { fr: "Annulée", en: "Cancelled" },
  },
  flight_status: {
    DRAFT: { fr: "Brouillon", en: "Draft" }, SCHEDULED: { fr: "Programmé", en: "Scheduled" }, PUBLISHED: { fr: "Publié", en: "Published" },
    BOARDING: { fr: "Embarquement", en: "Boarding" }, DEPARTED: { fr: "Parti", en: "Departed" }, IN_AIR: { fr: "En vol", en: "In the air" },
    DELAYED: { fr: "Retardé", en: "Delayed" }, DIVERTED: { fr: "Dérouté", en: "Diverted" }, LANDED: { fr: "Atterri", en: "Landed" },
    ARRIVED: { fr: "Arrivée confirmée", en: "Arrival confirmed" }, CANCELLED: { fr: "Annulé", en: "Cancelled" },
  },
  quote_status: {
    draft: { fr: "Brouillon", en: "Draft" }, under_review: { fr: "En revue", en: "Under review" }, issued: { fr: "Émis", en: "Issued" },
    viewed: { fr: "Consulté", en: "Viewed" }, accepted: { fr: "Accepté", en: "Accepted" }, rejected: { fr: "Refusé", en: "Rejected" },
    expired: { fr: "Expiré", en: "Expired" }, cancelled: { fr: "Annulé", en: "Cancelled" }, superseded: { fr: "Remplacé", en: "Superseded" },
  },
  payment_status: {
    created: { fr: "Créé", en: "Created" }, pending: { fr: "En attente", en: "Pending" }, processing: { fr: "En traitement", en: "Processing" },
    succeeded: { fr: "Confirmé", en: "Confirmed" }, failed: { fr: "Échoué", en: "Failed" }, cancelled: { fr: "Annulé", en: "Cancelled" },
    expired: { fr: "Expiré", en: "Expired" }, refunded: { fr: "Remboursé", en: "Refunded" },
    partially_refunded: { fr: "Partiellement remboursé", en: "Partially refunded" }, under_review: { fr: "En vérification", en: "Under review" },
  },
  request_status: {
    new: { fr: "Nouvelle", en: "New" }, under_review: { fr: "En cours d'examen", en: "Under review" }, quoted: { fr: "Devis envoyé", en: "Quoted" },
    won: { fr: "Acceptée", en: "Won" }, lost: { fr: "Non concrétisée", en: "Lost" }, cancelled: { fr: "Annulée", en: "Cancelled" },
  },
  support_status: {
    open: { fr: "Ouverte", en: "Open" }, in_progress: { fr: "En cours", en: "In progress" }, waiting_client: { fr: "En attente du client", en: "Waiting for client" },
    resolved: { fr: "Résolue", en: "Resolved" }, closed: { fr: "Clôturée", en: "Closed" },
  },
  support_category: {
    parcel: { fr: "Colis", en: "Parcel" }, delay: { fr: "Retard", en: "Delay" }, delivery: { fr: "Livraison", en: "Delivery" },
    payment: { fr: "Paiement", en: "Payment" }, other: { fr: "Autre", en: "Other" },
  },
  parcel_category: {
    document: { fr: "Document", en: "Document" }, clothing: { fr: "Vêtements", en: "Clothing" }, electronics: { fr: "Électronique", en: "Electronics" },
    food: { fr: "Alimentaire", en: "Food" }, cosmetics: { fr: "Cosmétiques", en: "Cosmetics" }, fragile_item: { fr: "Objet fragile", en: "Fragile item" },
    other: { fr: "Autre", en: "Other" },
  },
  document_kind: {
    parcel_photo: { fr: "Photo du colis", en: "Parcel photo" }, proof_of_receipt: { fr: "Preuve de réception", en: "Proof of receipt" },
    proof_of_delivery: { fr: "Preuve de livraison", en: "Proof of delivery" }, shipment_document: { fr: "Document d'expédition", en: "Shipment document" },
    customs_document: { fr: "Document douanier", en: "Customs document" }, payment_receipt: { fr: "Justificatif de paiement", en: "Payment receipt" },
    support_attachment: { fr: "Pièce jointe", en: "Attachment" }, other: { fr: "Autre", en: "Other" },
  },
};

export function label(domain: keyof typeof LABELS | string, value: string, locale: Locale): string {
  return LABELS[domain]?.[value]?.[locale] ?? value;
}

// ---------------------------------------------------------------- Formats
/** Balise de formatage : langue + pays (ex. fr-CD, en-CA) pour dates et nombres locaux. */
export const formatTag = (locale: Locale, country?: string | null) => (country ? `${locale}-${country}` : locale === "fr" ? "fr-FR" : "en-GB");

/** Date et heure dans le fuseau du lieu concerné, avec décalage explicite. */
export function formatDateTime(instant: string | Date | null | undefined, tz: string, locale: Locale, country?: string | null) {
  if (!instant) return "—";
  const d = new Date(instant);
  const s = new Intl.DateTimeFormat(formatTag(locale, country), { timeZone: tz, dateStyle: "medium", timeStyle: "short" }).format(d);
  const off = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "shortOffset" }).formatToParts(d).find((p) => p.type === "timeZoneName")?.value ?? "";
  return `${s} (${off.replace("GMT", "UTC")}, ${tz})`;
}

/** Montant formaté selon la langue et le pays ; la devise est toujours affichée. */
export function formatMoney(amount: string | number, currency: string, locale: Locale, country?: string | null) {
  return new Intl.NumberFormat(formatTag(locale, country), { style: "currency", currency, currencyDisplay: "code" }).format(Number(amount));
}

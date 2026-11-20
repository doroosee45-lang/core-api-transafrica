/**
 * Traitement des événements métier persistés (outbox) → notifications.
 * Cahier Module 11 : notification opérationnelle aux clients réellement
 * concernés ; annonce générale distincte ; anti-doublon (événement, destinataire).
 * Chaque destinataire reçoit le texte dans SA langue (identity.profiles.preferred_language),
 * heures dans le fuseau de l'aéroport concerné, montants formatés avec leur devise.
 */
import type { Db } from "../../core/db.js";
import { one } from "../../core/db.js";
import { formatDateTime, formatMoney, label, type Locale } from "../../i18n/index.js";

export interface OutboxRow { id: string; event_type: string; aggregate_id: string; payload: any; correlation_id: string | null }

interface Message { category: string; title: string; body: string; data?: Record<string, unknown> }
type Build = (lang: Locale) => Message;

/** Compatibilité : format français historique (utilisé par les tests et les e-mails FR). */
export const formatLocal = (instant: string | Date | null | undefined, tz: string) => formatDateTime(instant, tz, "fr");

const tr = (lang: Locale, fr: string, en: string) => (lang === "en" ? en : fr);

async function notify(tx: Db, evt: OutboxRow, userIds: (string | null)[], build: Build, opts: { campaignId?: string | null; emailRequiresOptIn?: boolean } = {}) {
  const unique = [...new Set(userIds.filter(Boolean) as string[])];
  let created = 0;
  for (const uid of unique) {
    const u = await one(tx,
      `select u.email, p.preferred_language,
              (select enabled from shared.notification_preferences where user_id = $1 and channel = 'email' and category in ($2, '*')
                order by (category = $2) desc limit 1) as email_pref,
              (select enabled from shared.notification_preferences where user_id = $1 and channel = 'push' and category in ($2, '*')
                order by (category = $2) desc limit 1) as push_pref,
              exists (select 1 from shared.email_suppressions s where s.email_normalized = lower(u.email)) as suppressed
         from auth.users u join identity.profiles p on p.id = u.id where u.id = $1`, [uid, build("fr").category]);
    if (!u) continue;
    const m = build(u.preferred_language === "en" ? "en" : "fr");
    const n = await one(tx,
      `insert into shared.notifications(user_id, campaign_id, source_event_id, category, title, body, data)
       values ($1,$2,$3,$4,$5,$6,$7) on conflict (source_event_id, user_id) do nothing returning id`,
      [uid, opts.campaignId ?? null, evt.id, m.category, m.title, m.body, JSON.stringify(m.data ?? {})]);
    if (!n) continue; // déjà notifié pour cet événement
    created++;
    const emailAllowed = opts.emailRequiresOptIn ? u.email_pref === true : u.email_pref !== false;
    if (u.email && emailAllowed) {
      await tx.query(
        `insert into shared.notification_deliveries(notification_id, channel, destination, status, status_reason)
         values ($1,'email',$2,$3,$4) on conflict do nothing`,
        [n.id, u.email, u.suppressed ? "skipped" : "queued", u.suppressed ? "ADDRESS_SUPPRESSED" : null]);
    }
    const pushAllowed = opts.emailRequiresOptIn ? u.push_pref === true : u.push_pref !== false;
    const devices = (await tx.query(`select push_token from shared.user_devices where user_id = $1 and status = 'active' limit 1`, [uid])).rows;
    if (devices.length && pushAllowed) {
      // Fournisseur push non retenu (Cahier §23.8) : la livraison est tracée comme non effectuée, jamais simulée.
      await tx.query(
        `insert into shared.notification_deliveries(notification_id, channel, destination, status, status_reason)
         values ($1,'push',$2,'skipped','PUSH_PROVIDER_NOT_CONFIGURED') on conflict do nothing`, [n.id, devices[0].push_token.slice(0, 40)]);
    }
  }
  return created;
}

const usersOfClients = async (tx: Db, clientIds: (string | null)[]) =>
  (await tx.query(`select user_id from canada.clients where id = any($1::uuid[]) and user_id is not null`, [clientIds.filter(Boolean)])).rows.map((r) => r.user_id);

/**
 * Clients réellement concernés : propriétaires et destinataires des colis des
 * expéditions FIGÉES dans l'événement au moment de la publication / du changement
 * (Cahier §8.4). Un traitement différé ne change donc pas l'audience.
 */
async function audienceOfShipments(tx: Db, shipmentIds: string[]) {
  if (!shipmentIds?.length) return [];
  const r = await tx.query(
    `select distinct c.user_id
       from canada.shipment_parcels sp join canada.parcels p on p.id = sp.parcel_id
       join canada.clients c on c.id in (p.client_id, p.recipient_client_id)
      where sp.removed_at is null and c.user_id is not null and sp.shipment_id = any($1::uuid[])`, [shipmentIds]);
  return r.rows.map((x) => x.user_id);
}

/** Corps conforme au modèle du cahier (§8.3, §8.4), dans la langue du destinataire. */
function flightBody(s: any, lang: Locale, intro: string) {
  const dep = s.departure_country ?? null, arr = s.arrival_country ?? null;
  return [
    intro, "",
    tr(lang, "Informations du vol :", "Flight information:"),
    `• ${tr(lang, "Compagnie", "Airline")} : ${s.airline_name} (${s.airline_iata})`,
    `• ${tr(lang, "Numéro de vol", "Flight number")} : ${s.airline_iata}${s.flight_number}`,
    `• ${tr(lang, "Départ", "Departure")} : ${formatDateTime(s.scheduled_departure, s.departure_timezone, lang, dep)} — ${s.departure_airport_name} (${s.departure_airport})`,
    `• ${tr(lang, "Arrivée prévue", "Scheduled arrival")} : ${formatDateTime(s.scheduled_arrival, s.arrival_timezone, lang, arr)} — ${s.arrival_airport_name} (${s.arrival_airport})`,
    "", tr(lang, "Vous pouvez suivre votre expédition depuis votre application Trans Afrique Canada.",
      "You can track your shipment from your Trans Afrique Canada app."),
  ].join("\n");
}

async function flightSnapshot(tx: Db, flightId: string) {
  return one(tx,
    `select f.*, al.iata_code as airline_iata, al.name as airline_name, da.name as departure_airport_name, aa.name as arrival_airport_name,
            da.country_code as departure_country, aa.country_code as arrival_country
       from canada.flights f join canada.airlines al on al.id = f.airline_id
       join canada.airports da on da.iata_code = f.departure_airport join canada.airports aa on aa.iata_code = f.arrival_airport where f.id = $1`, [flightId]);
}

async function operationalCampaign(tx: Db, evt: OutboxRow, title: string, body: string) {
  const c = await one(tx,
    `insert into shared.notification_campaigns(kind, source_event_id, title, body, audience) values ('operational',$1,$2,$3,$4)
     on conflict (source_event_id) do update set title = excluded.title returning id`,
    [evt.id, title, body, JSON.stringify({ rule: "clients des colis des expéditions associées au vol" })]);
  return c.id as string;
}

const STATUS_TEXT: Record<string, { fr: string; en: string }> = {
  BOARDING: { fr: "L'embarquement du vol a commencé.", en: "Boarding has started." },
  DEPARTED: { fr: "Le vol a décollé.", en: "The flight has departed." },
  DELAYED: { fr: "Le vol est retardé.", en: "The flight is delayed." },
  DIVERTED: { fr: "Le vol a été dérouté.", en: "The flight has been diverted." },
  LANDED: { fr: "Le vol a atterri. La réception de vos colis sera confirmée séparément après traitement.",
    en: "The flight has landed. Receipt of your parcels will be confirmed separately after processing." },
  CANCELLED: { fr: "Le vol a été annulé. Votre expédition va être réaffectée ; vous serez informé(e) du nouveau vol.",
    en: "The flight has been cancelled. Your shipment will be reassigned; you will be informed of the new flight." },
  IN_AIR: { fr: "Le vol est en cours.", en: "The flight is in the air." },
};

export const handlers: Record<string, (tx: Db, evt: OutboxRow) => Promise<void>> = {
  "canada.parcel.status_changed": async (tx, evt) => {
    const p = evt.payload;
    const rec = await one(tx, `select recipient_client_id from canada.parcels where id = $1`, [p.parcel_id]);
    await notify(tx, evt, await usersOfClients(tx, [p.client_id, rec?.recipient_client_id]), (lang) => {
      const l = label("parcel_status", p.to, lang);
      return { category: "parcel_status", title: tr(lang, `Colis ${p.reference} : ${l}`, `Parcel ${p.reference}: ${l}`),
        body: tr(lang, `Votre colis ${p.reference} est désormais au statut « ${l} ».`, `Your parcel ${p.reference} is now "${l}".`),
        data: { parcel_id: p.parcel_id, reference: p.reference, status: p.to } };
    });
  },
  "canada.flight.published": async (tx, evt) => {
    const s = { ...evt.payload.snapshot, ...(await flightCountries(tx, evt.payload.flight_id)) };
    const build: Build = (lang) => ({ category: "flight",
      title: tr(lang, `Vol ${s.airline_iata}${s.flight_number} programmé pour votre expédition`, `Flight ${s.airline_iata}${s.flight_number} scheduled for your shipment`),
      body: flightBody(s, lang, tr(lang, "Nous vous informons que votre expédition est programmée sur un nouveau vol.", "Your shipment has been scheduled on a new flight.")),
      data: { flight_id: evt.payload.flight_id, version: evt.payload.version } });
    const fr = build("fr");
    await notify(tx, evt, await audienceOfShipments(tx, evt.payload.shipment_ids ?? []), build, { campaignId: await operationalCampaign(tx, evt, fr.title, fr.body) });
  },
  "canada.flight.updated": async (tx, evt) => {
    const s = { ...evt.payload.snapshot, ...(await flightCountries(tx, evt.payload.flight_id)) };
    const fields = (evt.payload.changed_fields ?? []).join(", ");
    const build: Build = (lang) => ({ category: "flight",
      title: tr(lang, `Modification du vol ${s.airline_iata}${s.flight_number}`, `Change to flight ${s.airline_iata}${s.flight_number}`),
      body: flightBody(s, lang, tr(lang,
        `Les informations du vol associé à votre expédition ont changé (${fields}). Motif : ${evt.payload.reason ?? "—"}.`,
        `The details of the flight carrying your shipment have changed (${fields}). Reason: ${evt.payload.reason ?? "—"}.`)),
      data: { flight_id: evt.payload.flight_id, version: evt.payload.version } });
    const fr = build("fr");
    await notify(tx, evt, await audienceOfShipments(tx, evt.payload.shipment_ids ?? []), build, { campaignId: await operationalCampaign(tx, evt, fr.title, fr.body) });
  },
  "canada.flight.status_changed": async (tx, evt) => {
    const f = await flightSnapshot(tx, evt.payload.flight_id);
    const build: Build = (lang) => {
      const text = STATUS_TEXT[evt.payload.to]?.[lang] ?? tr(lang, `Nouveau statut du vol : ${evt.payload.to}.`, `New flight status: ${evt.payload.to}.`);
      const est = evt.payload.estimated_arrival
        ? tr(lang, " Arrivée estimée : ", " Estimated arrival: ") + formatDateTime(evt.payload.estimated_arrival, f.arrival_timezone, lang, f.arrival_country) + "." : "";
      return { category: "flight",
        title: tr(lang, `Vol ${f.airline_iata}${f.flight_number} : ${label("flight_status", evt.payload.to, lang)}`,
          `Flight ${f.airline_iata}${f.flight_number}: ${label("flight_status", evt.payload.to, lang)}`),
        body: `${text}${est}${evt.payload.reason ? tr(lang, ` Motif : ${evt.payload.reason}.`, ` Reason: ${evt.payload.reason}.`) : ""}`,
        data: { flight_id: f.id, status: evt.payload.to } };
    };
    const fr = build("fr");
    await notify(tx, evt, await audienceOfShipments(tx, evt.payload.shipment_ids ?? []), build, { campaignId: await operationalCampaign(tx, evt, fr.title, fr.body) });
  },
  "canada.flight.shipment_assigned": async (tx, evt) => {
    const f = await flightSnapshot(tx, evt.payload.flight_id);
    await notify(tx, evt, await audienceOfShipments(tx, [evt.payload.shipment_id]), (lang) => ({ category: "flight",
      title: tr(lang, "Votre expédition est associée à un nouveau vol – Trans Afrique Canada", "Your shipment has been assigned to a new flight – Trans Afrique Canada"),
      body: flightBody(f, lang, tr(lang, "Nous vous informons que votre expédition est programmée sur un nouveau vol.", "Your shipment has been scheduled on a new flight.")),
      data: { flight_id: f.id, shipment_id: evt.payload.shipment_id } }));
  },
  "canada.parcel.weight_discrepancy": async (tx, evt) => {
    const p = evt.payload;
    await notify(tx, evt, await usersOfClients(tx, [p.client_id]), (lang) => ({ category: "parcel_weight",
      title: tr(lang, `Écart de poids constaté — colis ${p.reference}`, `Weight discrepancy — parcel ${p.reference}`),
      body: tr(lang,
        `Le poids facturable de votre colis est passé de ${p.previous_billable_kg} kg à ${p.new_billable_kg} kg. Une régularisation de votre devis vous sera proposée avant toute suite.`,
        `The billable weight of your parcel changed from ${p.previous_billable_kg} kg to ${p.new_billable_kg} kg. A quote adjustment will be proposed before any further step.`),
      data: p }));
  },
  "canada.quote.issued": async (tx, evt) => {
    const q = evt.payload;
    // Échéance affichée dans le fuseau de l'agence émettrice, avec le fuseau explicite (Cahier §8.3).
    const ag = await tx.query(`select a.timezone, a.country_code from canada.quotations qt join canada.agencies a on a.id = qt.agency_id where qt.id = $1`, [q.quotation_id]);
    const tz = ag.rows[0]?.timezone ?? "UTC";
    const country = ag.rows[0]?.country_code ?? null;
    await notify(tx, evt, await usersOfClients(tx, [q.client_id]), (lang) => ({ category: "quote",
      title: tr(lang, `Devis ${q.reference} disponible`, `Quote ${q.reference} available`),
      body: tr(lang,
        `Votre devis ${q.reference} (version ${q.version}) d'un montant de ${formatMoney(q.total, q.currency, lang, country)} est valable jusqu'au ${formatDateTime(q.valid_until, tz, lang, country)}.`,
        `Your quote ${q.reference} (version ${q.version}) for ${formatMoney(q.total, q.currency, lang, country)} is valid until ${formatDateTime(q.valid_until, tz, lang, country)}.`),
      data: { quotation_id: q.quotation_id, version: q.version } }));
  },
  "canada.payment.confirmed": async (tx, evt) => {
    const p = evt.payload;
    await notify(tx, evt, await usersOfClients(tx, [p.client_id]), (lang) => ({ category: "payment",
      title: tr(lang, `Paiement ${p.reference} confirmé`, `Payment ${p.reference} confirmed`),
      body: tr(lang, `Nous confirmons la réception de ${formatMoney(p.amount_paid, p.currency, lang)}.`, `We confirm receipt of ${formatMoney(p.amount_paid, p.currency, lang)}.`),
      data: { payment_id: p.payment_id } }));
  },
  "canada.request.created": async (tx, evt) => {
    const r = evt.payload;
    const staff = (await tx.query(
      `select distinct ur.user_id from access.user_roles ur join access.roles ro on ro.id = ur.role_id and ro.is_active
         join access.role_permissions rp on rp.role_id = ur.role_id
         join access.permissions pm on pm.id = rp.permission_id and pm.code = 'canada.requests.process'
         left join canada.agencies a on ur.scope_type = 'agency' and a.id = ur.scope_id
        where ur.revoked_at is null and (ur.expires_at is null or ur.expires_at > now())
          and (ur.scope_type = 'global' or ur.scope_country = any($1::text[]) or a.country_code = any($1::text[]))`,
      [[r.origin_country, r.destination_country]])).rows.map((x) => x.user_id);
    await notify(tx, evt, staff, (lang) => ({ category: "staff_request",
      title: tr(lang, `Nouvelle demande ${r.reference}`, `New request ${r.reference}`),
      body: tr(lang, `Demande ${r.origin_country} → ${r.destination_country} à traiter.`, `Request ${r.origin_country} → ${r.destination_country} to be processed.`),
      data: { request_id: r.request_id } }));
  },
  "canada.support.message_posted": async (tx, evt) => {
    const s = evt.payload;
    // Réponse du personnel → client ; message du client → agent affecté (s'il existe).
    const users = s.author_side === "staff" ? await usersOfClients(tx, [s.client_id]) : [s.assigned_to];
    await notify(tx, evt, users, (lang) => ({ category: "support",
      title: tr(lang, `Réclamation ${s.reference} : nouveau message`, `Claim ${s.reference}: new message`),
      body: tr(lang, "Un nouveau message a été ajouté à votre réclamation.", "A new message has been added to your claim."),
      data: { ticket_id: s.ticket_id } }));
  },
  "canada.announcement.created": async (tx, evt) => {
    const c = await one(tx, `select * from shared.notification_campaigns where id = $1`, [evt.payload.campaign_id]);
    const countries: string[] | null = evt.payload.countries ?? null;
    const users = (await tx.query(
      `select distinct c.user_id from canada.clients c join access.user_platform_access upa on upa.user_id = c.user_id and upa.platform_id = 1 and upa.access_status = 'active'
        where c.user_id is not null and c.status = 'active' and ($1::text[] is null or c.residence_country = any($1::text[]))`, [countries])).rows.map((r) => r.user_id);
    const t = c.audience?.translations ?? {};
    // Annonce commerciale : e-mail uniquement aux personnes ayant explicitement consenti (opt-in).
    await notify(tx, evt, users, (lang) => ({ category: "announcement",
      title: lang === "en" && t.en?.title ? t.en.title : c.title, body: lang === "en" && t.en?.body ? t.en.body : c.body, data: { campaign_id: c.id } }),
      { campaignId: c.id, emailRequiresOptIn: true });
  },
};

async function flightCountries(tx: Db, flightId: string) {
  return one(tx,
    `select da.country_code as departure_country, aa.country_code as arrival_country from canada.flights f
       join canada.airports da on da.iata_code = f.departure_airport join canada.airports aa on aa.iata_code = f.arrival_airport where f.id = $1`, [flightId]);
}

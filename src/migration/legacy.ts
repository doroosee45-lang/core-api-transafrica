/**
 * REPRISE DES DONNÉES DU BACKEND MERN (MongoDB) VERS LE CORE API (PostgreSQL).
 * Document de migration §7 (bases), §8 (utilisateurs), §14 (réconciliation).
 *
 * Règles appliquées :
 *  - mode « dry_run » par défaut : aucune écriture, rapport des transformations ;
 *  - idempotent : chaque entité source est inscrite dans shared.external_id_mappings,
 *    une seconde exécution ne crée aucun doublon ;
 *  - aucune correspondance inventée : une donnée non transposable est marquée
 *    « needs_review » avec son motif, jamais devinée ;
 *  - mots de passe : le hash bcrypt d'origine est transmis à Supabase Auth, jamais de clair ;
 *  - aucun privilège supplémentaire : un membre du personnel sans agence ne reçoit aucun rôle ;
 *  - la base MongoDB n'est jamais modifiée (lecture seule).
 */
import { randomUUID } from "node:crypto";
import { MongoClient, type Db as MongoDb } from "mongodb";
import { db, one, withTransaction, type Db } from "../core/db.js";
import { sequentialReference } from "../core/references.js";
import { authProvider } from "../modules/identity/authProvider.js";

const SOURCE = "mern_mongodb";
export const COUNTRY_MAP: Record<string, string> = { CANADA: "CA", RDC: "CD", CONGO: "CG" };
const PARCEL_STATUS: Record<string, string> = {
  registered: "received", preparing: "inspected", transit: "in_transit", customs: "in_customs", arrived: "arrived_destination",
  out_for_delivery: "out_for_delivery", delivered: "delivered", returned: "returned", lost: "lost",
};
const PAYMENT_STATUS: Record<string, string> = { pending: "pending", partial: "pending", paid: "succeeded", refunded: "refunded", cancelled: "cancelled" };
const REQUEST_STATUS: Record<string, string> = { new: "new", contacted: "under_review", quoted: "quoted", won: "won", lost: "lost" };
const PAYMENT_METHOD: Record<string, string> = { cash: "cash", bank_transfer: "bank_transfer", mobile_money: "mobile_money", card: "card", cheque: "cheque", other: "legacy" };

/** Collections volontairement non reprises, avec la raison (rapport). */
export const NOT_MIGRATED: Record<string, string> = {
  kilooffers: "Marketplace de kilos : absente des documents de référence — décision métier requise (docs/DECISIONS.md D-07).",
  kiloorders: "Marketplace de kilos : idem.",
  notifications: "Notifications historiques : non reprises (le centre de notifications repart des événements futurs).",
  emaillogs: "Journaux techniques d'envoi : conservés dans MongoDB pendant la période de rétention.",
  flightalertpreferences: "Consentements d'alerte vol : à reprendre après validation du modèle de consentement (D-09).",
  flightcampaigns: "Campagnes historiques : conservées dans MongoDB.",
  flightnotifications: "Livraisons historiques : conservées dans MongoDB.",
  contactmessages: "Messages de contact : module Support non encore implémenté (Cahier Module 14).",
  employees: "Fiches RH (salaire, documents) : hors périmètre des documents ; non reprises.",
  counters: "Compteurs techniques : remplacés par private.business_sequences.",
  emailsuppressions: "Repris dans shared.email_suppressions.",
};

type Status = "migrated" | "needs_review" | "skipped" | "failed";
interface EntityReport { source: number; migrated: number; already: number; needs_review: number; skipped: number; failed: number; issues: { id: string; reason: string }[] }
export interface MigrationReport {
  run_id: string; mode: "dry_run" | "apply"; started_at: string; finished_at?: string;
  entities: Record<string, EntityReport>; not_migrated: Record<string, { documents: number; reason: string }>;
  reconciliation: Record<string, unknown>;
}

const sid = (v: any) => (v == null ? null : String(v));

export async function runLegacyMigration(opts: { mongoUri: string; mongoDbName?: string; apply: boolean; operator: string; log?: (m: string) => void }) {
  const log = opts.log ?? (() => {});
  const mongo = new MongoClient(opts.mongoUri, { readPreference: "secondaryPreferred" });
  await mongo.connect();
  const m = mongo.db(opts.mongoDbName);
  const runId = randomUUID();
  const report: MigrationReport = { run_id: runId, mode: opts.apply ? "apply" : "dry_run", started_at: new Date().toISOString(), entities: {}, not_migrated: {}, reconciliation: {} };
  if (opts.apply) {
    await db.query(`insert into shared.migration_runs(id, source, mode, operator) values ($1, $2, 'apply', $3)`, [runId, SOURCE, opts.operator]);
  }

  const ent = (name: string): EntityReport => (report.entities[name] ??= { source: 0, migrated: 0, already: 0, needs_review: 0, skipped: 0, failed: 0, issues: [] });

  /** Correspondance déjà connue ? */
  const mapped = async (type: string, sourceId: string) =>
    (await one(db, `select target_id, migration_status from shared.external_id_mappings where source_system = $1 and entity_type = $2 and source_id = $3`, [SOURCE, type, sourceId]));
  // Mode à blanc : correspondances simulées en mémoire pour que l'analyse des entités
  // dépendantes (colis → agence, paiement → colis) reflète fidèlement une exécution réelle.
  const dry = new Map<string, { id: string; meta?: Record<string, any> }>();
  const targetOf = async (type: string, sourceId: string | null) => {
    if (!sourceId) return null;
    const sim = dry.get(`${type}:${sourceId}`);
    if (sim) return sim.id;
    return ((await mapped(type, sourceId))?.target_id as string | undefined) ?? null;
  };
  const metaOf = (id: string | null) => [...dry.values()].find((v) => v.id === id)?.meta;
  const record = async (tx: Db, type: string, sourceId: string, targetId: string | null, status: Status, control: string | null) => {
    await tx.query(
      `insert into shared.external_id_mappings(source_system, entity_type, source_id, target_id, migration_status, control_result, migration_run_id)
       values ($1,$2,$3,$4,$5,$6,$7)
       on conflict (source_system, entity_type, source_id) do update set target_id = excluded.target_id, migration_status = excluded.migration_status,
         control_result = excluded.control_result, migration_run_id = excluded.migration_run_id, migrated_at = now()
       where shared.external_id_mappings.migration_status <> 'migrated'`,
      [SOURCE, type, sourceId, targetId, status, control, runId]);
  };

  /** Applique une étape pour un document ; en dry_run, valide seulement. */
  async function each(name: string, docs: any[], fn: (d: any) => Promise<{ status: Status; reason?: string; meta?: Record<string, any>; write?: (tx: Db) => Promise<string | null> }>) {
    const r = ent(name);
    r.source = docs.length;
    for (const d of docs) {
      const id = sid(d._id)!;
      const prev = await mapped(name, id);
      if (prev?.migration_status === "migrated") { r.already++; continue; }
      try {
        const plan = await fn(d);
        if (plan.status !== "migrated") {
          r[plan.status]++;
          r.issues.push({ id, reason: plan.reason ?? plan.status });
          if (opts.apply) await withTransaction((tx) => record(tx, name, id, null, plan.status, plan.reason ?? null));
          continue;
        }
        if (opts.apply && plan.write) {
          await withTransaction(async (tx) => {
            const target = await plan.write!(tx);
            await record(tx, name, id, target, "migrated", plan.reason ?? null);
          });
        }
        if (!opts.apply) dry.set(`${name}:${id}`, { id: `dry-${name}-${id}`, meta: plan.meta });
        r.migrated++;
        if (plan.reason) r.issues.push({ id, reason: plan.reason });
      } catch (err) {
        r.failed++;
        r.issues.push({ id, reason: `ERREUR : ${(err as any)?.code ?? ""} ${(err as Error).message}`.slice(0, 300) });
        if (opts.apply) await withTransaction((tx) => record(tx, name, id, null, "failed", (err as Error).message.slice(0, 300))).catch(() => {});
      }
    }
    log(`${name} : ${r.migrated} repris, ${r.already} déjà repris, ${r.needs_review} à revoir, ${r.skipped} ignorés, ${r.failed} en échec (source ${r.source})`);
  }

  const col = async (n: string) => (await m.listCollections({ name: n }).hasNext()) ? m.collection(n).find({}).toArray() : [];

  // ------------------------------------------------------------------ Agences
  const tzOf = async (country: string) => (await one(db, `select default_timezone from shared.countries where code = $1`, [country]))?.default_timezone;
  await each("agency", await col("agencies"), async (a) => {
    const country = COUNTRY_MAP[a.address?.country];
    if (!country) return { status: "needs_review", reason: `Pays inconnu « ${a.address?.country} »` };
    const tz = await tzOf(country);
    const code = String(a.code ?? `AGC-${sid(a._id)!.slice(-6)}`).toUpperCase().slice(0, 20);
    return {
      status: "migrated", meta: { country },
      // Le fuseau n'existait pas dans l'ancien modèle : fuseau par défaut du pays, signalé.
      reason: country === "CA" ? `Fuseau par défaut ${tz} appliqué (Canada multi-fuseaux) : à vérifier` : undefined,
      write: async (tx) => (await one(tx,
        `insert into canada.agencies(code, name, country_code, city, address, phone, email, timezone, latitude, longitude, status, legacy_ref)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning id`,
        [code, a.name, country, a.address?.city ?? null, a.address?.street ?? null, a.phone ?? null, a.email ?? null, tz,
         a.latitude ?? null, a.longitude ?? null, a.status === "inactif" ? "suspended" : "active", sid(a._id)])).id,
    };
  });

  // -------------------------------------------------------------- Utilisateurs
  const roleId = async (code: string) => (await one(db, `select id from access.roles where platform_id = 1 and code = $1`, [code])).id;
  await each("user", await col("users"), async (u) => {
    const email = String(u.email ?? "").trim().toLowerCase();
    if (!email || !/^\S+@\S+\.\S+$/.test(email)) return { status: "needs_review", reason: "Adresse e-mail absente ou invalide" };
    if (!/^\$2[aby]\$\d{2}\$/.test(String(u.password ?? ""))) return { status: "needs_review", reason: "Hash de mot de passe non bcrypt : réinitialisation requise" };
    if (await one(db, `select 1 from auth.users where lower(email) = $1`, [email])) {
      return { status: "needs_review", reason: "Un compte Supabase existe déjà pour cette adresse : fusion manuelle (aucune liaison automatique par e-mail)" };
    }
    const grants: { role: string; scope_type: string; scope_id?: string | null; scope_country?: string | null }[] = [];
    const notes: string[] = [];
    const agencyOf = async (v: any) => targetOf("agency", sid(v?._id ?? v));
    switch (u.role) {
      case "superadmin": grants.push({ role: "canada_administrator", scope_type: "global" }); notes.push("MFA obligatoire à l'activation"); break;
      case "admin": {
        for (const c of u.countries ?? []) if (COUNTRY_MAP[c]) grants.push({ role: "canada_administrator", scope_type: "country", scope_country: COUNTRY_MAP[c] });
        for (const a of u.agencies ?? []) {
          const ag = await agencyOf(a);
          // Administrateur limité à une agence : rôle cible le plus proche, sans élargissement.
          if (ag) { grants.push({ role: "canada_agency_manager", scope_type: "agency", scope_id: ag }); notes.push("admin d'agence → responsable d'agence"); }
        }
        if (!grants.length) notes.push("Administrateur sans pays ni agence : aucun rôle attribué");
        break;
      }
      case "manager": case "agent": case "driver": {
        const ag = await agencyOf(u.agency ?? u.agencies?.[0]);
        if (!ag) { notes.push(`${u.role} sans agence reprise : aucun rôle attribué`); break; }
        grants.push({ role: u.role === "manager" ? "canada_agency_manager" : "canada_agent", scope_type: "agency", scope_id: ag });
        if (u.role === "driver") notes.push("chauffeur → agent (aucun rôle chauffeur dans les documents)");
        break;
      }
      case "client": grants.push({ role: "canada_client", scope_type: "own" }); break;
      default: notes.push(`Rôle inconnu « ${u.role} » : aucun rôle attribué`);
    }
    return {
      status: "migrated",
      reason: [notes.join(" ; "), u.emailVerified ? null : "E-mail non vérifié : confirmation requise avant connexion"].filter(Boolean).join(" ; ") || undefined,
      write: async (tx) => {
        const userId = await authProvider.adminCreateUserWithHash({
          email, passwordHash: u.password, emailConfirmed: Boolean(u.emailVerified),
          metadata: { first_name: u.firstName, last_name: u.lastName, legacy_id: sid(u._id) },
        });
        await tx.query(`insert into identity.profiles(id, first_name, last_name, account_status, created_at) values ($1,$2,$3,$4,coalesce($5, now()))`,
          [userId, u.firstName || "—", u.lastName || "—", u.isActive === false ? "suspended" : u.emailVerified ? "active" : "pending_verification", u.createdAt ?? null]);
        await tx.query(`insert into access.user_platform_access(user_id, platform_id, access_status) values ($1, 1, 'active')`, [userId]);
        for (const g of grants) {
          await tx.query(`insert into access.user_roles(user_id, role_id, scope_type, scope_id, scope_country, justification) values ($1,$2,$3,$4,$5,$6)`,
            [userId, await roleId(g.role), g.scope_type, g.scope_id ?? null, g.scope_country ?? null, `Reprise MongoDB (rôle d'origine : ${u.role})`]);
          await tx.query(`insert into audit.access_changes(target_user_id, platform_id, change_type, reason, new_state) values ($1, 1, 'grant', 'Reprise des données', $2)`,
            [userId, JSON.stringify({ ...g, legacy_role: u.role })]);
        }
        if (u.phone) await tx.query(`insert into identity.contact_methods(user_id, contact_type, contact_value, normalized_value) values ($1,'phone',$2,$3)`,
          [userId, u.phone, String(u.phone).replace(/[^\d+]/g, "")]);
        for (const t of u.pushTokens ?? []) {
          if (t?.token) await tx.query(`insert into shared.user_devices(user_id, push_token, platform) values ($1,$2,$3) on conflict (push_token) do nothing`,
            [userId, t.token, t.platform === "ios" ? "ios" : "android"]);
        }
        return userId;
      },
    };
  });

  // ------------------------------------------------------------------- Clients
  await each("client", await col("clients"), async (c) => {
    const country = c.country ? COUNTRY_MAP[c.country] : null;
    if (c.country && !country) return { status: "needs_review", reason: `Pays inconnu « ${c.country} »` };
    const userId = await targetOf("user", sid(c.user));
    const agencyId = await targetOf("agency", sid(c.agency));
    const reasons = [c.user && !userId ? "Compte lié non repris : fiche reprise sans lien" : null, c.agency && !agencyId ? "Agence non reprise" : null].filter(Boolean);
    return {
      status: "migrated", reason: reasons.join(" ; ") || undefined,
      write: async (tx) => (await one(tx,
        `insert into canada.clients(client_number, user_id, first_name, last_name, email, phone, residence_country, home_agency_id, status, notes, legacy_ref, created_at, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,coalesce($12, now()),$13) returning id`,
        [await sequentialReference(tx, "CL"), userId, c.firstName, c.lastName, c.email ?? null, c.phone ?? null, country, agencyId,
         c.isActive === false ? "inactive" : "active", c.notes ?? null, sid(c._id), c.createdAt ?? null, await targetOf("user", sid(c.createdBy))])).id,
    };
  });

  // --------------------------------------------------------------------- Colis
  await each("parcel", await col("packages"), async (p) => {
    const origin = COUNTRY_MAP[p.origin], dest = COUNTRY_MAP[p.destination];
    if (!origin || !dest) return { status: "needs_review", reason: `Route inconnue ${p.origin} → ${p.destination}` };
    if (origin === dest) return { status: "needs_review", reason: "Origine et destination identiques" };
    const status = PARCEL_STATUS[p.status];
    if (!status) return { status: "needs_review", reason: `Statut inconnu « ${p.status} »` };
    const clientId = await targetOf("client", sid(p.sender));
    if (!clientId) return { status: "needs_review", reason: "Expéditeur non repris" };
    const agencyId = await targetOf("agency", sid(p.agency));
    if (!agencyId) return { status: "needs_review", reason: "Colis sans agence responsable reprise (agence d'origine obligatoire)" };
    const agencyCountry = metaOf(agencyId)?.country ?? (await one(db, `select country_code from canada.agencies where id = $1`, [agencyId]))?.country_code;
    const recipientId = await targetOf("client", sid(p.receiver));
    const reference = String(p.trackingNumber ?? "").toUpperCase();
    if (!/^[A-Z]{2,3}-[A-Z0-9]{6,20}$/.test(reference)) return { status: "needs_review", reason: `Numéro de suivi inexploitable « ${reference} »` };
    const notes = [
      agencyCountry && agencyCountry !== origin ? `Agence (${agencyCountry}) hors du pays d'origine (${origin}) : agence d'origine conservée telle quelle, à vérifier` : null,
      p.receiver && !recipientId ? "Destinataire non repris" : null,
      "Poids facturable historique = poids réel (aucun diviseur volumétrique dans l'ancien système)",
    ].filter(Boolean);
    return {
      status: "migrated", reason: notes.join(" ; "), meta: { agencyId },
      write: async (tx) => {
        const weight = Number(p.weight) > 0 ? Number(p.weight).toFixed(3) : null;
        const parcel = await one(tx,
          `insert into canada.parcels(reference, client_id, recipient_client_id, origin_country, destination_country, origin_agency_id, category, description,
             item_count, declared_value, declared_value_currency, fragile, status, actual_weight_kg, length_cm, width_cm, height_cm, billable_weight_kg,
             measured_at, estimated_delivery_at, delivered_at, legacy_ref, created_by, created_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$14,$18,$19,$20,$21,$22,coalesce($23, now())) returning id, reference, client_id`,
          [reference, clientId, recipientId, origin, dest, agencyId, p.packageType ?? "other", [p.description, p.specialInstructions, p.notes].filter(Boolean).join(" — ") || null,
           Math.max(1, Number(p.numberOfItems) || 1), Number(p.declaredValue) > 0 ? p.declaredValue : null, Number(p.declaredValue) > 0 ? p.currency ?? null : null,
           Boolean(p.fragile), status, weight, Number(p.length) > 0 ? p.length : null, Number(p.width) > 0 ? p.width : null, Number(p.height) > 0 ? p.height : null,
           weight ? p.createdAt ?? new Date() : null, p.estimatedDelivery ?? null, p.deliveredAt ?? null, sid(p._id), await targetOf("user", sid(p.createdBy)), p.createdAt ?? null]);
        if (weight) {
          const dims = Number(p.length) > 0 && Number(p.width) > 0 && Number(p.height) > 0;
          await tx.query(
            `insert into canada.parcel_measurements(parcel_id, actual_weight_kg, length_cm, width_cm, height_cm, billable_weight_kg, measured_at, source, reason)
             values ($1,$2,$3,$4,$5,$2,coalesce($6, now()),'legacy_migration','Reprise MongoDB')`,
            [parcel.id, weight, dims ? p.length : null, dims ? p.width : null, dims ? p.height : null, p.createdAt ?? null]);
        }
        let prev: string | null = null;
        for (const e of [...(p.trackingHistory ?? [])].sort((a: any, b: any) => new Date(a.date ?? a.timestamp ?? 0).getTime() - new Date(b.date ?? b.timestamp ?? 0).getTime())) {
          const to = PARCEL_STATUS[e.status] ?? null;
          await tx.query(
            `insert into canada.parcel_events(parcel_id, event_type, from_status, to_status, occurred_at, actor_user_id, location_text, source, comment)
             values ($1,$2,$3,$4,coalesce($5, now()),$6,$7,'legacy_migration',$8)`,
            [parcel.id, `legacy.${e.status}`, prev, to, e.date ?? e.timestamp ?? null, await targetOf("user", sid(e.updatedBy)),
             e.location ? COUNTRY_MAP[e.location] ?? String(e.location).slice(0, 200) : null,
             [e.description, to ? null : `Statut d'origine non transposable : ${e.status}`].filter(Boolean).join(" — ") || null]);
          if (to) prev = to;
        }
        // Tarification historique conservée telle quelle (preuve), sans la requalifier en devis.
        await tx.query(
          `insert into audit.audit_events(actor_kind, action, resource_type, resource_id, country_code, agency_id, new_value, reason)
           values ('migration', 'legacy.parcel.pricing_snapshot', 'parcel', $1, $2, $3, $4, 'Reprise MongoDB : tarification d''origine')`,
          [parcel.id, origin, agencyId, JSON.stringify({ pricePerKg: p.pricePerKg, extraFees: p.extraFees, insurance: p.insurance, insuranceFee: p.insuranceFee,
            totalPrice: p.totalPrice, currency: p.currency, isPaid: p.isPaid, paymentMethod: p.paymentMethod })]);
        return parcel.id;
      },
    };
  });

  // ----------------------------------------------------------------- Paiements
  await each("payment", await col("payments"), async (pay) => {
    const status = PAYMENT_STATUS[pay.status];
    if (!status) return { status: "needs_review", reason: `Statut inconnu « ${pay.status} »` };
    const clientId = await targetOf("client", sid(pay.client));
    if (!clientId) return { status: "needs_review", reason: "Client non repris" };
    const parcelSourceIds = [...new Set([pay.package, ...(pay.packages ?? [])].filter(Boolean).map(sid))] as string[];
    const parcelIds = (await Promise.all(parcelSourceIds.map((x) => targetOf("parcel", x)))).filter(Boolean) as string[];
    let agencyId = await targetOf("agency", sid(pay.agency));
    if (!agencyId && parcelIds.length) {
      agencyId = metaOf(parcelIds[0])?.agencyId ?? (await one(db, `select origin_agency_id from canada.parcels where id = $1`, [parcelIds[0]]))?.origin_agency_id ?? null;
    }
    if (!agencyId) return { status: "needs_review", reason: "Paiement sans agence déterminable" };
    if (!(Number(pay.amount) > 0)) return { status: "needs_review", reason: "Montant nul ou invalide" };
    if (!pay.currency) return { status: "needs_review", reason: "Devise absente : aucune conversion supposée" };
    const paid = Math.min(Number(pay.amountPaid) || (pay.status === "paid" ? Number(pay.amount) : 0), Number(pay.amount));
    return {
      status: "migrated",
      reason: [paid > 0 ? "Encaissement historique déclaré manuellement : source non vérifiable, à réconcilier" : null,
        parcelSourceIds.length !== parcelIds.length ? "Certains colis liés non repris" : null].filter(Boolean).join(" ; ") || undefined,
      write: async (tx) => {
        const created = await one(tx,
          `insert into canada.payments(reference, legacy_invoice_number, client_id, agency_id, purpose, amount_due, amount_paid, amount_refunded, currency, status,
             due_date, confirmed_at, legacy_ref, created_by, created_at)
           values ($1,$2,$3,$4,'logistics',$5,$6,$7,$8,$9,$10,$11,$12,$13,coalesce($14, now())) returning id`,
          [pay.invoiceNumber ?? (await sequentialReference(tx, "PAY")), pay.invoiceNumber ?? null, clientId, agencyId, Number(pay.amount).toFixed(2), paid.toFixed(2),
           status === "refunded" ? paid.toFixed(2) : "0.00", pay.currency, status, pay.dueDate ?? null, status === "succeeded" ? pay.paidAt ?? pay.updatedAt ?? null : null,
           sid(pay._id), await targetOf("user", sid(pay.createdBy)), pay.createdAt ?? null]);
        if (paid > 0) {
          await tx.query(
            `insert into canada.payment_transactions(payment_id, kind, method, amount, currency, status, source, receipt_reference, evidence, occurred_at)
             values ($1,'charge',$2,$3,$4,'succeeded','legacy_migration',$5,$6,coalesce($7, now()))`,
            [created.id, PAYMENT_METHOD[pay.method] ?? "legacy", paid.toFixed(2), pay.currency, `LEGACY-${pay.invoiceNumber ?? sid(pay._id)}`,
             JSON.stringify({ legacy: true, verifiable_source: false, note: "Déclaré dans l'ancien système" }), pay.paidAt ?? null]);
        }
        for (const pid of parcelIds) await tx.query(`insert into canada.payment_parcels(payment_id, parcel_id) values ($1,$2) on conflict do nothing`, [created.id, pid]);
        return created.id;
      },
    };
  });

  // ---------------------------------------------------- Demandes de devis
  await each("request", await col("quoterequests"), async (q) => {
    const o = COUNTRY_MAP[q.originCountry], d = COUNTRY_MAP[q.destinationCountry];
    if (!o || !d) return { status: "needs_review", reason: "Pays inconnus" };
    return {
      status: "migrated",
      write: async (tx) => (await one(tx,
        `insert into canada.requests(reference, source, requester_user_id, full_name, company, email, phone, origin_country, destination_country,
           preferred_agency_id, shipment_type, estimated_weight_kg, estimated_volume_m3, message, status, handled_by, handled_at, legacy_ref, created_at)
         values ($1,'legacy_migration',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,coalesce($18, now())) returning id`,
        [q.reference ?? `REQ-LEG-${sid(q._id)!.slice(-8).toUpperCase()}`, await targetOf("user", sid(q.clientUser)), q.fullName, q.company ?? null, q.email, q.phone ?? null,
         o, d, await targetOf("agency", sid(q.preferredAgency)), q.shipmentType ?? "parcel", q.weight ?? null, q.volume ?? null, q.message ?? null,
         REQUEST_STATUS[q.status] ?? "new", await targetOf("user", sid(q.handledBy)), q.handledAt ?? null, sid(q._id), q.createdAt ?? null])).id,
    };
  });

  // --------------------------------------------- Vols : jamais devinés
  await each("flight", await col("flights"), async (f) => ({
    status: "needs_review",
    reason: `Vol ${f.flightNumber} (${f.origin} → ${f.destination}) : compagnie et codes IATA absents de l'ancien modèle ; à ressaisir via le module Vols`,
  }));

  // ------------------------------------------ Suppressions d'e-mail
  await each("email_suppression", await col("emailsuppressions"), async (s) => ({
    status: "migrated",
    write: async (tx) => {
      await tx.query(`insert into shared.email_suppressions(email_normalized, reason, detail) values (lower($1), $2, $3) on conflict do nothing`, [s.email, s.reason, s.detail ?? null]);
      return null;
    },
  }));

  // -------------------------------------------- Journal d'activité historique
  await each("activity", await col("activities"), async (a) => ({
    status: "migrated",
    write: async (tx) => {
      await tx.query(
        `insert into audit.audit_events(actor_user_id, actor_kind, action, resource_type, resource_id, new_value, reason, occurred_at)
         values ($1, 'migration', $2, $3, $4, $5, 'Reprise du journal d''activité MongoDB', coalesce($6, now()))`,
        [await targetOf("user", sid(a.actor?.id)), `legacy.${a.type}`, String(a.ref?.model ?? "legacy").toLowerCase().slice(0, 80), sid(a.ref?.id),
         JSON.stringify({ title: a.title, description: a.description, meta: a.meta ?? null, actor: a.actor ? { name: a.actor.name, role: a.actor.role } : null }), a.createdAt ?? null]);
      return null;
    },
  }));

  for (const [name, reason] of Object.entries(NOT_MIGRATED)) {
    if (name === "emailsuppressions") continue;
    const n = (await m.listCollections({ name }).hasNext()) ? await m.collection(name).countDocuments() : 0;
    if (n) report.not_migrated[name] = { documents: n, reason };
  }

  report.reconciliation = await reconcile(m);
  report.finished_at = new Date().toISOString();
  if (opts.apply) await db.query(`update shared.migration_runs set finished_at = now(), report = $2 where id = $1`, [runId, JSON.stringify(report)]);
  await mongo.close();
  return report;
}

/** Contrôles croisés source ↔ cible (Document de migration §14). */
async function reconcile(m: MongoDb) {
  const count = async (sql: string, p: unknown[] = []) => (await one(db, sql, p)).n as number;
  const has = async (n: string) => m.listCollections({ name: n }).hasNext();
  const srcPaid = (await has("payments")) ? await m.collection("payments").aggregate([{ $group: { _id: "$currency", due: { $sum: "$amount" } } }]).toArray() : [];
  const tgtPaid = (await db.query(`select currency, sum(amount_due)::text as due from canada.payments where legacy_ref is not null group by currency`)).rows;
  const srcEvents = (await has("packages"))
    ? (await m.collection("packages").aggregate([{ $project: { n: { $size: { $ifNull: ["$trackingHistory", []] } } } }, { $group: { _id: null, n: { $sum: "$n" } } }]).toArray())[0]?.n ?? 0
    : 0;
  return {
    parcels_without_events: await count(`select count(*)::int n from canada.parcels p where legacy_ref is not null and not exists (select 1 from canada.parcel_events e where e.parcel_id = p.id)`),
    parcel_events: { source_tracking_entries: srcEvents, migrated: await count(`select count(*)::int n from canada.parcel_events where source = 'legacy_migration'`) },
    parcels_with_unknown_owner: await count(`select count(*)::int n from canada.parcels p where legacy_ref is not null and not exists (select 1 from canada.clients c where c.id = p.client_id)`),
    payments_amount_due_by_currency: { source: srcPaid.map((r) => ({ currency: r._id, due: Number(r.due).toFixed(2) })), target: tgtPaid },
    legacy_unverified_receipts: await count(`select count(*)::int n from canada.payment_transactions where source = 'legacy_migration'`),
    staff_without_role: await count(`select count(*)::int n from shared.external_id_mappings m where m.entity_type = 'user' and m.migration_status = 'migrated'
      and not exists (select 1 from access.user_roles ur where ur.user_id = m.target_id)`),
  };
}

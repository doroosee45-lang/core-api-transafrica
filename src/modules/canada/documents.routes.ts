/**
 * Documents et preuves (Cahier §13.7, Spéc. backend §20, Dossier 04 §12.1).
 * Les fichiers ne transitent pas par le backend : téléversement direct vers Supabase
 * Storage par URL signée, puis CONFIRMATION serveur (l'objet stocké doit correspondre
 * à la taille et au type déclarés). Téléchargement : lien temporaire après contrôle d'accès.
 * La permission exigée découle de la nature du document (aucune permission nouvelle).
 */
import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { env } from "../../config/env.js";
import { audit } from "../../core/audit.js";
import { db, one, type Db, withTransaction } from "../../core/db.js";
import { conflict, forbidden, notFound, t, unprocessable } from "../../core/errors.js";
import { mount, route } from "../../core/routes.js";
import { IdParams } from "../../core/schemas.js";
import { storage } from "../../integrations/storage.js";
import { can, type Principal, type ResourceScope } from "../access/authorization.js";
import { destinationResource, loadParcel, originResource, parcelResource } from "./common.js";
import { loadPayment } from "./finance/payment.service.js";
import { loadShipment, shipmentResource } from "./shipments/shipment.service.js";

const ALLOWED_MIME = ["image/jpeg", "image/png", "image/webp", "application/pdf"];
const CLIENT_VISIBLE = ["parcel_photo", "proof_of_receipt", "proof_of_delivery", "payment_receipt", "support_attachment"];
const KINDS: Record<string, string[]> = {
  parcel: ["parcel_photo", "proof_of_receipt", "proof_of_delivery", "customs_document", "other"],
  shipment: ["shipment_document", "customs_document", "other"],
  payment: ["payment_receipt"],
  support_ticket: ["support_attachment"],
};

interface Target { countries: string[]; agencyIds: string[]; ownerUserIds: string[]; uploadPermission: string; uploadResource: ResourceScope; readPermissions: string[] }

/** Résout l'objet métier, le périmètre figé du document et la permission requise. */
async function resolveTarget(d: Db, entityType: string, entityId: string, kind: string): Promise<Target> {
  if (!KINDS[entityType]?.includes(kind)) throw unprocessable("DOCUMENT_KIND_MISMATCH", t("Ce type de document ne correspond pas à l'objet concerné."));
  switch (entityType) {
    case "parcel": {
      const p = await loadParcel(d, entityId);
      const owners = [p.owner_user_id, p.recipient_user_id].filter(Boolean) as string[];
      const base = { countries: [p.origin_country, p.destination_country], agencyIds: [p.origin_agency_id, p.destination_agency_id].filter(Boolean) as string[],
        ownerUserIds: owners, readPermissions: ["canada.parcels.read_scoped"] };
      if (kind === "proof_of_receipt") return { ...base, uploadPermission: "canada.parcels.receive", uploadResource: parcelResource(p) };
      if (kind === "proof_of_delivery") return { ...base, uploadPermission: "canada.parcels.release", uploadResource: destinationResource(p) };
      if (kind === "parcel_photo") return { ...base, uploadPermission: "canada.tracking.update", uploadResource: parcelResource(p) };
      return { ...base, uploadPermission: "canada.tracking.update", uploadResource: kind === "customs_document" ? destinationResource(p) : originResource(p) };
    }
    case "shipment": {
      const s = await loadShipment(d, entityId);
      return { countries: [s.origin_country, s.destination_country], agencyIds: [s.origin_agency_id, s.destination_agency_id].filter(Boolean),
        ownerUserIds: [], uploadPermission: "canada.shipments.plan", uploadResource: shipmentResource(s), readPermissions: ["canada.shipments.read_scoped"] };
    }
    case "payment": {
      const p = await loadPayment(d, entityId);
      return { countries: [p.agency_country], agencyIds: [p.agency_id], ownerUserIds: [p.client_user_id].filter(Boolean),
        uploadPermission: "canada.payments.verify", uploadResource: { countries: [p.agency_country], agencyIds: [p.agency_id] }, readPermissions: ["canada.payments.read_scoped"] };
    }
    case "support_ticket": {
      const tk = await one(d, `select s.*, c.user_id as client_user_id from canada.support_tickets s join canada.clients c on c.id = s.client_id where s.id = $1`, [entityId]);
      if (!tk) throw notFound("TICKET_NOT_FOUND", t("Réclamation introuvable."));
      return { countries: [tk.country_code], agencyIds: [tk.agency_id].filter(Boolean), ownerUserIds: [tk.client_user_id],
        uploadPermission: "canada.support.reply", uploadResource: { countries: [tk.country_code], agencyIds: [tk.agency_id] }, readPermissions: ["canada.support.read_scoped"] };
    }
  }
  throw notFound("DOCUMENT_NOT_FOUND", t("Document introuvable."));
}

/** Le client propriétaire peut joindre une pièce à SA réclamation. */
function canUpload(p: Principal, tg: Target, entityType: string) {
  if (can(p, tg.uploadPermission, tg.uploadResource)) return true;
  return entityType === "support_ticket" && can(p, "canada.support.create_own", { ownerUserIds: tg.ownerUserIds });
}

function canRead(p: Principal, doc: any) {
  const scope: ResourceScope = { countries: doc.country_codes, agencyIds: doc.agency_ids };
  const perms = { parcel: "canada.parcels.read_scoped", shipment: "canada.shipments.read_scoped", payment: "canada.payments.read_scoped",
    support_ticket: "canada.support.read_scoped" } as Record<string, string>;
  if (can(p, perms[doc.entity_type], scope)) return true;
  return doc.visibility === "client" && doc.owner_user_ids.includes(p.userId);
}

/** Signatures binaires (« magic bytes ») des seuls types acceptés. */
export function matchesSignature(mime: string, head: Buffer): boolean {
  const starts = (sig: number[], at = 0) => sig.every((b, i) => head[at + i] === b);
  switch (mime) {
    case "application/pdf": return starts([0x25, 0x50, 0x44, 0x46, 0x2d]); // %PDF-
    case "image/jpeg": return starts([0xff, 0xd8, 0xff]);
    case "image/png": return starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case "image/webp": return starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8); // RIFF....WEBP
    default: return false;
  }
}

const routes = [
  route({
    method: "post", path: "/canada/documents", tag: "Documents", auth: "canada", idempotent: true,
    summary: "Déclarer un document et obtenir une URL de téléversement signée (bucket privé)",
    body: z.object({
      entity_type: z.enum(["parcel", "shipment", "payment", "support_ticket"]), entity_id: z.uuid(),
      kind: z.enum(["parcel_photo", "proof_of_receipt", "proof_of_delivery", "shipment_document", "customs_document", "payment_receipt", "support_attachment", "other"]),
      original_name: z.string().trim().min(1).max(255), mime_type: z.string().trim().max(120), size_bytes: z.number().int().positive(),
    }),
    handler: async ({ body, principal, correlationId }) => {
      if (!ALLOWED_MIME.includes(body.mime_type)) throw unprocessable("FILE_TYPE_NOT_ALLOWED", t("Type de fichier non autorisé."), ALLOWED_MIME);
      if (body.size_bytes > env().DOCUMENT_MAX_BYTES) throw unprocessable("FILE_TOO_LARGE", t("Fichier trop volumineux."), [{ max_bytes: env().DOCUMENT_MAX_BYTES }]);
      const tg = await resolveTarget(db, body.entity_type, body.entity_id, body.kind);
      if (!canUpload(principal, tg, body.entity_type)) throw forbidden("FORBIDDEN", "Action non autorisée.");
      const id = randomUUID();
      const ext = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "application/pdf": "pdf" }[body.mime_type];
      const path = `${body.entity_type}/${body.entity_id}/${id}.${ext}`;
      const signed = await storage.signedUpload(path);
      const doc = await withTransaction(async (tx) => {
        const r = await one(tx,
          `insert into canada.documents(id, entity_type, entity_id, kind, country_codes, agency_ids, owner_user_ids, visibility, storage_bucket,
             storage_path, original_name, mime_type, declared_size, uploaded_by)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning id, entity_type, entity_id, kind, visibility, status, created_at`,
          [id, body.entity_type, body.entity_id, body.kind, [...new Set(tg.countries)], [...new Set(tg.agencyIds)], tg.ownerUserIds,
           CLIENT_VISIBLE.includes(body.kind) ? "client" : "internal", env().STORAGE_BUCKET, path, body.original_name, body.mime_type, body.size_bytes, principal.userId]);
        await audit(tx, { actorUserId: principal.userId, action: "canada.document.declared", resourceType: "document", resourceId: id,
          next: { entity_type: body.entity_type, entity_id: body.entity_id, kind: body.kind, size: body.size_bytes }, correlationId });
        return r;
      });
      return { status: 201, data: { ...doc, upload: signed } };
    },
  }),
  route({
    method: "post", path: "/canada/documents/:id/complete", tag: "Documents", auth: "canada",
    summary: "Confirmer le téléversement : vérification serveur de l'objet stocké (taille, type)", params: IdParams,
    handler: async ({ params, principal, correlationId }) => {
      const doc = await one(db, `select * from canada.documents where id = $1`, [params.id]);
      if (!doc || doc.uploaded_by !== principal.userId) throw notFound("DOCUMENT_NOT_FOUND", t("Document introuvable."));
      if (doc.status !== "pending_upload") throw conflict("DOCUMENT_ALREADY_CONFIRMED", "Statut non modifiable.");
      const info = await storage.info(doc.storage_path);
      if (!info) throw conflict("DOCUMENT_NOT_UPLOADED", t("Le fichier n'a pas été téléversé."));
      const declaredOk = info.size === Number(doc.declared_size) && (!info.contentType || info.contentType === doc.mime_type);
      // Contenu réel : la signature binaire doit correspondre au type déclaré (un exécutable renommé en .pdf est rejeté).
      const signatureOk = declaredOk && matchesSignature(doc.mime_type, await storage.head(doc.storage_path));
      const matches = declaredOk && signatureOk;
      const reason = !declaredOk ? "SIZE_OR_TYPE_MISMATCH" : !signatureOk ? "CONTENT_SIGNATURE_MISMATCH" : null;
      const r = await one(db,
        `update canada.documents set status = $2, stored_size = $3, confirmed_at = now(), rejection_reason = $4 where id = $1 and status = 'pending_upload'
         returning id, status, stored_size, confirmed_at`,
        [doc.id, matches ? "uploaded" : "rejected", info.size, reason]);
      await audit(db, { actorUserId: principal.userId, action: matches ? "canada.document.uploaded" : "canada.document.rejected",
        resourceType: "document", resourceId: doc.id, next: { stored_size: info.size, content_type: info.contentType, rejection_reason: reason }, correlationId });
      if (!matches) throw unprocessable("DOCUMENT_MISMATCH", t("Le fichier téléversé ne correspond pas à la déclaration."));
      return { data: r };
    },
  }),
  route({
    method: "get", path: "/canada/documents", tag: "Documents", auth: "canada",
    summary: "Documents d'un objet métier visibles par l'appelant",
    query: z.object({ entity_type: z.enum(["parcel", "shipment", "payment", "support_ticket"]), entity_id: z.uuid() }),
    handler: async ({ query, principal }) => {
      const rows = (await db.query(
        `select id, entity_type, entity_id, kind, visibility, original_name, mime_type, stored_size, status, created_at, confirmed_at,
                country_codes, agency_ids, owner_user_ids
           from canada.documents where entity_type = $1 and entity_id = $2 and status = 'uploaded' order by created_at`, [query.entity_type, query.entity_id])).rows;
      return { data: rows.filter((d) => canRead(principal, d)).map(({ country_codes, agency_ids, owner_user_ids, ...d }) => d) };
    },
  }),
  route({
    method: "get", path: "/canada/documents/:id/download", tag: "Documents", auth: "canada",
    summary: "Lien de téléchargement temporaire (5 minutes) après contrôle d'accès", params: IdParams,
    handler: async ({ params, principal, correlationId }) => {
      const doc = await one(db, `select * from canada.documents where id = $1`, [params.id]);
      // Même réponse que « introuvable » pour ne pas révéler l'existence d'un document hors périmètre.
      if (!doc || !canRead(principal, doc)) throw notFound("DOCUMENT_NOT_FOUND", t("Document introuvable."));
      if (doc.status !== "uploaded") throw conflict("DOCUMENT_NOT_AVAILABLE", t("Document non disponible."));
      const url = await storage.signedDownload(doc.storage_path, 300, doc.original_name);
      await audit(db, { actorUserId: principal.userId, action: "canada.document.downloaded", resourceType: "document", resourceId: doc.id, correlationId });
      return { data: { url, expires_in: 300 } };
    },
  }),
];

export function documentsRouter() {
  const r = Router();
  mount(r, routes);
  return r;
}

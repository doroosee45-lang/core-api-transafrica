/**
 * Stockage objet — Supabase Storage (décision du 21/11/2026), bucket PRIVÉ.
 * Seul point du code qui parle au stockage (Spéc. backend §29). Clé service_role
 * côté serveur uniquement ; les clients reçoivent des URL signées à durée limitée.
 */
import { createClient } from "@supabase/supabase-js";
import { env } from "../config/env.js";
import { AppError, t } from "../core/errors.js";

function bucket() {
  const e = env();
  if (!e.SUPABASE_SERVICE_ROLE_KEY) throw new AppError(503, "STORAGE_NOT_CONFIGURED", t("Stockage de documents indisponible."));
  return createClient(e.SUPABASE_URL, e.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
    .storage.from(e.STORAGE_BUCKET);
}

const unavailable = () => new AppError(502, "STORAGE_UNAVAILABLE", t("Stockage de documents indisponible."));

export const storage = {
  /** URL de téléversement direct à usage unique (validité fixée par Supabase, 2 h). */
  async signedUpload(path: string) {
    const { data, error } = await bucket().createSignedUploadUrl(path);
    if (error || !data) throw unavailable();
    return { upload_url: data.signedUrl, token: data.token };
  },
  /** Métadonnées de l'objet réellement stocké ; null s'il n'existe pas. */
  async info(path: string): Promise<{ size: number; contentType: string | null } | null> {
    const { data, error } = await bucket().info(path);
    if (error) {
      const status = (error as any).status ?? (error as any).statusCode;
      if (status === 404 || status === "404" || (error as any).code === "NoSuchKey") return null;
      throw unavailable();
    }
    const d: any = data;
    return { size: Number(d.size ?? d.metadata?.size), contentType: d.contentType ?? d.metadata?.mimetype ?? null };
  },
  /**
   * Premiers octets de l'objet réellement stocké (lien signé de 60 s + requête Range) :
   * permet de contrôler la signature binaire du fichier sans le télécharger entièrement.
   */
  async head(path: string, bytes = 16): Promise<Buffer> {
    const { data, error } = await bucket().createSignedUrl(path, 60);
    if (error || !data) throw unavailable();
    const r = await fetch(data.signedUrl, { headers: { Range: `bytes=0-${bytes - 1}` } }).catch(() => null);
    if (!r || (r.status !== 200 && r.status !== 206)) throw unavailable();
    return Buffer.from(await r.arrayBuffer()).subarray(0, bytes);
  },
  /** Lien de téléchargement temporaire. */
  async signedDownload(path: string, expiresInSeconds: number, filename: string) {
    const { data, error } = await bucket().createSignedUrl(path, expiresInSeconds, { download: filename });
    if (error || !data) throw unavailable();
    return data.signedUrl;
  },
};

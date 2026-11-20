/**
 * Erreurs applicatives à code stable (Spéc. backend §24.3) et messages traduisibles.
 * Le texte français du message sert de clé de traduction ; les parties variables
 * sont des paramètres nommés ({p0}, {p1}…). La traduction anglaise est résolue
 * au moment de la réponse selon la langue de l'utilisateur (src/i18n).
 */
export interface Msg { text: string; params?: Record<string, unknown> }

export const msg = (text: string, params?: Record<string, unknown>): Msg => ({ text, params });

/** Marqueur de texte traduisible (identité à l'exécution, repéré par l'extraction i18n). */
export const t = (text: string) => text;

export function render(template: string, params?: Record<string, unknown>) {
  return params ? template.replace(/\{(\w+)\}/g, (_, k) => (params[k] === undefined || params[k] === null ? "" : String(params[k]))) : template;
}

export class AppError extends Error {
  public readonly template: string;
  public readonly params?: Record<string, unknown>;
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string | Msg,
    public readonly details: unknown[] = [],
  ) {
    const m = typeof message === "string" ? { text: message } : message;
    super(render(m.text, m.params));
    this.template = m.text;
    this.params = m.params;
  }
}

type M = string | Msg;
export const badRequest = (code: string, message: M, details: unknown[] = []) => new AppError(400, code, message, details);
export const unauthorized = (code = "UNAUTHENTICATED", message: M = "Authentification requise.") => new AppError(401, code, message);
export const forbidden = (code = "FORBIDDEN", message: M = "Action non autorisée.") => new AppError(403, code, message);
export const notFound = (code = "NOT_FOUND", message: M = "Ressource introuvable.") => new AppError(404, code, message);
export const conflict = (code: string, message: M, details: unknown[] = []) => new AppError(409, code, message, details);
export const unprocessable = (code: string, message: M, details: unknown[] = []) => new AppError(422, code, message, details);

/**
 * Erreurs PostgreSQL connues → erreurs métier. Les messages bruts du driver ne sont
 * jamais renvoyés : pour les règles levées par les triggers (« CODE: texte »), seul le
 * code est conservé et le message vient du catalogue (DB_RULE_MESSAGES, src/i18n).
 */
export function fromPgError(err: any): AppError | null {
  if (!err || typeof err.code !== "string") return null;
  const tagged = /^([A-Z_]{4,}):/.exec(err.message ?? "");
  const rule = (fallback: string) => tagged?.[1] ?? fallback;
  switch (err.code) {
    case "23505":
      return conflict("DUPLICATE", "Cette ressource existe déjà.", [{ constraint: err.constraint }]);
    case "23503":
      return unprocessable("REFERENCE_INVALID", "Une référence fournie est inconnue.", [{ constraint: err.constraint }]);
    case "23514":
      return tagged ? unprocessable(rule(""), { text: `db:${rule("")}` }) : unprocessable("CONSTRAINT_VIOLATION", "Règle d'intégrité non respectée.", [{ constraint: err.constraint }]);
    case "42501":
      return tagged ? conflict(rule(""), { text: `db:${rule("")}` }) : conflict("OPERATION_NOT_ALLOWED", "Opération interdite sur cette donnée.");
    case "22P02":
      return badRequest("INVALID_INPUT", "Format de donnée invalide.");
    case "40001":
    case "40P01":
      return conflict("CONCURRENT_UPDATE", "Conflit de mise à jour concurrente, réessayez.");
    default:
      return null;
  }
}

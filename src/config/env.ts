import { z } from "zod";

const bool = (def: boolean) =>
  z.preprocess((v) => (v === undefined || v === "" ? def : String(v).toLowerCase() === "true"), z.boolean());

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(5100),
  TRUST_PROXY: bool(false),

  // Connexion PostgreSQL du projet Supabase (rôle serveur, jamais exposé au frontend).
  DATABASE_URL: z.string().min(1),
  DATABASE_SSL: bool(false),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),

  // Supabase Auth
  SUPABASE_URL: z.string().url(),
  SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  // Projets « legacy » signés en HS256. Si absent : vérification via JWKS (clés asymétriques).
  SUPABASE_JWT_SECRET: z.string().optional(),
  SUPABASE_JWT_ISSUER: z.string().optional(),
  // Rôles sensibles (requires_mfa) pris en compte uniquement en session AAL2.
  AUTH_ENFORCE_MFA: bool(true),
  // Verrouillage temporaire après N échecs sur un même compte (valeurs d'exploitation, à confirmer : D-18).
  AUTH_MAX_FAILED_ATTEMPTS: z.coerce.number().int().min(3).max(100).default(10),
  AUTH_LOCKOUT_MINUTES: z.coerce.number().int().min(1).max(1440).default(15),

  CORS_ORIGINS: z.string().default("http://localhost:3000"),
  APP_PUBLIC_URL: z.string().default("http://localhost:3000"),

  // E-mail (Resend). Sans clé : livraisons « skipped / EMAIL_NOT_CONFIGURED », jamais « envoyé ».
  RESEND_API_KEY: z.string().optional(),
  RESEND_FROM_EMAIL: z.string().optional(),
  // Secret « whsec_… » du webhook Resend (statuts de délivrance réels, rebonds, plaintes).
  RESEND_WEBHOOK_SECRET: z.string().optional(),

  // Documents (Supabase Storage, bucket privé à créer dans le projet)
  STORAGE_BUCKET: z.string().regex(/^[a-z0-9][a-z0-9_-]{2,62}$/).default("canada-documents"),
  DOCUMENT_MAX_BYTES: z.coerce.number().int().positive().max(50 * 1024 * 1024).default(10 * 1024 * 1024),

  OUTBOX_POLL_MS: z.coerce.number().int().positive().default(2000),
  WORKER_ENABLED: bool(true),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | null = null;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`Configuration invalide ou incomplète : ${fields}`);
  }
  if (parsed.data.NODE_ENV === "production" && !parsed.data.AUTH_ENFORCE_MFA) {
    throw new Error("AUTH_ENFORCE_MFA=false est interdit en production (Cahier §16 : MFA administratif).");
  }
  cached = parsed.data;
  return cached;
}

export function env(): Env {
  if (!cached) return loadEnv();
  return cached;
}

/** Tests : la configuration passe par le même schéma (valeurs par défaut comprises) qu'en production. */
export function setEnvForTests(e: Partial<Env>) {
  cached = null;
  loadEnv(Object.fromEntries(Object.entries(e).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])) as NodeJS.ProcessEnv);
}

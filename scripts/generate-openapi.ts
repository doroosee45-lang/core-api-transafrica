/**
 * Génère docs/openapi.json à partir du registre de routes (source unique).
 * Usage : npm run openapi
 */
import { mkdir, writeFile } from "node:fs/promises";
import { z } from "zod";
import { setEnvForTests } from "../src/config/env.js";

setEnvForTests({
  NODE_ENV: "development", TRUST_PROXY: false, DATABASE_URL: "postgres://unused", DATABASE_SSL: false, DATABASE_POOL_MAX: 1,
  SUPABASE_URL: "https://example.supabase.co", SUPABASE_ANON_KEY: "unused", AUTH_ENFORCE_MFA: true, CORS_ORIGINS: "", APP_PUBLIC_URL: "",
  OUTBOX_POLL_MS: 1000, WORKER_ENABLED: false,
} as any);

const { createApp } = await import("../src/app.js");
const { registry } = await import("../src/core/routes.js");
createApp();

const schema = (s: any) => (s ? z.toJSONSchema(s, { io: "input", unrepresentable: "any" }) : undefined);
const paths: Record<string, any> = {};
/** operationId stable et unique (génération de clients web / mobile) : post /canada/parcels/:id → postCanadaParcelsById. */
const opId = (method: string, p: string) => method + p.split("/").filter(Boolean)
  .map((seg) => seg.startsWith(":") ? `By${seg[1].toUpperCase()}${seg.slice(2)}` : seg.split(/[-_]/).map((w) => w[0].toUpperCase() + w.slice(1)).join(""))
  .join("");
const opIds = new Set<string>();
for (const r of registry) {
  const p = `/api/v1${r.path.replace(/:([A-Za-z]+)/g, "{$1}")}`;
  const params = schema(r.params) as any;
  const query = schema(r.query) as any;
  paths[p] ??= {};
  const operationId = opId(r.method, r.path);
  if (opIds.has(operationId)) throw new Error(`operationId en double : ${operationId}`);
  opIds.add(operationId);
  paths[p][r.method] = {
    operationId,
    tags: [r.tag],
    summary: r.summary,
    description: [
      r.description,
      r.anyPermission?.length ? `**Permission (au moins une, puis contrôle de périmètre)** : ${r.anyPermission.map((x) => `\`${x}\``).join(", ")}` : null,
      r.idempotent ? "**Idempotence** : en-tête `Idempotency-Key` obligatoire ; une répétition renvoie la réponse initiale." : null,
      r.auth === "canada" ? "Exige un accès actif à la plateforme Canada." : null,
    ].filter(Boolean).join("\n\n"),
    security: r.auth === "public" ? [] : [{ bearerAuth: [] }],
    parameters: [
      ...Object.keys(params?.properties ?? {}).map((name) => ({ name, in: "path", required: true, schema: params.properties[name] })),
      ...Object.keys(query?.properties ?? {}).map((name) => ({ name, in: "query", required: (query.required ?? []).includes(name), schema: query.properties[name] })),
      ...(r.idempotent ? [{ name: "Idempotency-Key", in: "header", required: true, schema: { type: "string", minLength: 8, maxLength: 200 } }] : []),
    ],
    ...(r.body ? { requestBody: { required: true, content: { "application/json": { schema: schema(r.body) } } } } : {}),
    responses: {
      "2XX": { description: "Succès (200, 201 création, 202 accepté)", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
      "4XX": { description: "Erreur (code stable)", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
      "5XX": { description: "Erreur serveur ou fournisseur (message générique, sans détail interne)", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
    },
  };
}
// Webhook monté hors registre (corps brut nécessaire à la vérification de signature).
paths["/api/v1/webhooks/resend"] = { post: {
  operationId: "postWebhooksResend", tags: ["Webhooks"], security: [],
  summary: "Événements de délivrance Resend (signature Svix obligatoire)",
  description: "Réservé à Resend. En-têtes `svix-id`, `svix-timestamp` (fenêtre de 5 minutes) et `svix-signature` (HMAC du corps brut avec `RESEND_WEBHOOK_SECRET`). Événement déjà reçu : ignoré (dédoublonnage `shared.inbox_events`).",
  requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } },
  responses: { "200": { description: "Reçu ou déjà traité" }, "400": { description: "Signature absente, invalide ou expirée (INVALID_SIGNATURE), ou JSON invalide" }, "503": { description: "Secret non configuré" } },
} };

const doc = {
  openapi: "3.1.0",
  info: { title: "Trans Afrique Core API — Canada", version: "1.0.0",
    description: "Contrat généré depuis le registre de routes. Authentification : JWT Supabase (Bearer). Toutes les réponses portent `meta.correlation_id` et `meta.locale`. Langue : préférence du profil, sinon en-tête `Accept-Language` (fr, en), sinon fr ; en-tête de réponse `Content-Language`. Voir docs/I18N.md." },
  servers: [{ url: "/" }],
  components: {
    securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT (Supabase Auth)" } },
    schemas: {
      Success: { type: "object", properties: { success: { const: true }, data: {}, meta: { type: "object", properties: { correlation_id: { type: "string", format: "uuid" }, pagination: { type: "object" } } } } },
      Error: { type: "object", properties: { success: { const: false }, error: { type: "object", properties: { code: { type: "string" }, message: { type: "string" }, details: { type: "array" } } }, meta: { type: "object" } } },
    },
  },
  paths,
};
await mkdir("docs", { recursive: true });
await writeFile("docs/openapi.json", JSON.stringify(doc, null, 2));
console.log(`OpenAPI : ${registry.length + 1} opérations, ${Object.keys(paths).length} chemins -> docs/openapi.json`);
process.exit(0);

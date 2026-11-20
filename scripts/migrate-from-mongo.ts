/**
 * Reprise MongoDB (backend MERN) → PostgreSQL (Core API).
 *
 *   npm run migrate:mongo -- --mongo-uri mongodb://127.0.0.1:27017/colis              # analyse à blanc (défaut)
 *   npm run migrate:mongo -- --mongo-uri ... --apply --operator "Nom de l'exécutant"  # exécution réelle
 *
 * Prérequis de l'exécution réelle (Document de migration §16) : sauvegarde des
 * deux bases vérifiée, migrations appliquées, SUPABASE_SERVICE_ROLE_KEY défini,
 * environnement de préproduction validé AVANT toute production.
 */
import "dotenv/config";
import { writeFile } from "node:fs/promises";
import { loadEnv } from "../src/config/env.js";
import { closePool } from "../src/core/db.js";
import { runLegacyMigration } from "../src/migration/legacy.js";

const args = process.argv.slice(2);
const arg = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const apply = args.includes("--apply");
const mongoUri = arg("--mongo-uri") ?? process.env.LEGACY_MONGO_URI;
const operator = arg("--operator") ?? process.env.USERNAME ?? process.env.USER ?? "inconnu";

if (!mongoUri) {
  console.error("Indiquer --mongo-uri ou LEGACY_MONGO_URI.");
  process.exit(2);
}
const e = loadEnv();
if (apply && e.NODE_ENV === "production" && !args.includes("--confirm-production")) {
  console.error("Exécution en production refusée sans --confirm-production (validation explicite exigée, Migration §18.4).");
  process.exit(2);
}

const report = await runLegacyMigration({ mongoUri, apply, operator, log: (m) => console.log(m) });
const out = arg("--out") ?? `migration-report-${report.mode}-${report.started_at.replace(/[:.]/g, "-")}.json`;
await writeFile(out, JSON.stringify(report, null, 2));
console.log(`\nMode : ${report.mode}. Rapport : ${out}`);
console.log(JSON.stringify(report.reconciliation, null, 2));
await closePool();

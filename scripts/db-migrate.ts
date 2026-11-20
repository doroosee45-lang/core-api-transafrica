/**
 * Applique supabase/migrations puis supabase/seed sur DATABASE_URL.
 * Sur un projet Supabase, préférer `supabase db push` + exécution du seed.
 * Le shim de test (supabase/tests) n'est JAMAIS appliqué ici.
 */
import "dotenv/config";
import { loadEnv } from "../src/config/env.js";
import { runMigrations } from "../src/core/migrator.js";

const e = loadEnv();
await runMigrations(e.DATABASE_URL, { dir: "supabase/migrations", seedDir: "supabase/seed", log: (m) => console.log(m) });
console.log("Migrations et seed à jour.");

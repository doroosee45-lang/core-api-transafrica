/**
 * Extraction statique des messages traduisibles du code source.
 * Utilisée par le test de complétude des traductions (tests/i18n.test.ts) :
 * tout message utilisé dans le code DOIT avoir sa traduction anglaise.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

function walk(dir: string, out: string[] = []) {
  for (const f of readdirSync(dir)) {
    const p = path.join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

const STR = String.raw`"((?:[^"\\]|\\.)*)"`;
const PATTERNS = [
  // badRequest("CODE", "texte"), forbidden(...), new AppError(400, "CODE", "texte")
  new RegExp(String.raw`(?:badRequest|forbidden|notFound|conflict|unprocessable|unauthorized)\(\s*"[A-Z_]+"\s*,\s*${STR}`, "g"),
  new RegExp(String.raw`new AppError\(\s*\d+\s*,\s*"[A-Z_]+"\s*,\s*${STR}`, "g"),
  // msg("modèle {p0}", ...)
  new RegExp(String.raw`\bmsg\(\s*${STR}`, "g"),
  // assertCan(principal, "perm", ressource, "message")
  new RegExp(String.raw`assertCan\([^;]*?,\s*${STR}\s*\)`, "g"),
  // messages par défaut et textes i18n déclarés explicitement : t("…")
  new RegExp(String.raw`\bt\(\s*${STR}`, "g"),
  new RegExp(String.raw`message: (?:M|string) = ${STR}`, "g"),
];

export function extractMessages(srcDir: string): Set<string> {
  const found = new Set<string>();
  for (const file of walk(srcDir)) {
    if (file.includes(`${path.sep}i18n${path.sep}`)) continue;
    const s = readFileSync(file, "utf8");
    for (const re of PATTERNS) {
      for (const m of s.matchAll(re)) {
        const text = JSON.parse(`"${m[1]}"`);
        // assertCan : seul le dernier argument chaîne est un message (pas la permission).
        if (/^canada\.[a-z_]+\.[a-z_]+$/.test(text)) continue;
        if (/^[A-Z_]+$/.test(text)) continue;
        found.add(text);
      }
    }
  }
  return found;
}

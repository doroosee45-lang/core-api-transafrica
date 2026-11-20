import { randomInt } from "node:crypto";
import type { Db } from "./db.js";

// Alphabet sans caractères ambigus (0/O, 1/I/L) : lisible au scan comme au téléphone.
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

/** Référence publique non devinable (≈ 10 caractères ≈ 49 bits d'entropie). */
export function randomReference(prefix: string, length = 10): string {
  let s = "";
  for (let i = 0; i < length; i++) s += ALPHABET[randomInt(ALPHABET.length)];
  return `${prefix}-${s}`;
}

/** Référence séquentielle annuelle (devis, paiements) : jamais réutilisée. */
export async function sequentialReference(d: Db, prefix: string, pad = 6): Promise<string> {
  const year = new Date().getUTCFullYear();
  const r = await d.query(`select private.next_sequence($1) as v`, [`${prefix}-${year}`]);
  return `${prefix}-${year}-${String(r.rows[0].v).padStart(pad, "0")}`;
}

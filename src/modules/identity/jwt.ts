import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { env } from "../../config/env.js";

export interface SupabaseClaims extends JWTPayload {
  sub: string;
  email?: string;
  role?: string;
  aal?: string;
  session_id?: string;
}

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

/**
 * Vérifie cryptographiquement un JWT Supabase (signature, expiration, audience, émetteur).
 * - Projets à clés asymétriques : JWKS publié par Supabase Auth.
 * - Projets « legacy » HS256 : secret partagé SUPABASE_JWT_SECRET (serveur uniquement).
 */
export async function verifySupabaseJwt(token: string): Promise<SupabaseClaims> {
  const e = env();
  const issuer = e.SUPABASE_JWT_ISSUER ?? `${e.SUPABASE_URL.replace(/\/$/, "")}/auth/v1`;
  const options = { audience: "authenticated", issuer, clockTolerance: 5 };
  let payload: JWTPayload;
  if (e.SUPABASE_JWT_SECRET) {
    ({ payload } = await jwtVerify(token, new TextEncoder().encode(e.SUPABASE_JWT_SECRET), { ...options, algorithms: ["HS256"] }));
  } else {
    jwks ??= createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));
    ({ payload } = await jwtVerify(token, jwks, { ...options, algorithms: ["ES256", "RS256"] }));
  }
  if (typeof payload.sub !== "string" || payload.role !== "authenticated") {
    throw new Error("JWT_INVALID_SUBJECT");
  }
  return payload as SupabaseClaims;
}

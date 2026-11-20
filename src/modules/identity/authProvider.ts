/**
 * Intégration Supabase Auth (Spéc. identité §7). Le backend ne gère jamais
 * lui-même les mots de passe : il délègue à Supabase Auth (GoTrue).
 * Cette couche est le SEUL endroit qui parle à Supabase Auth (Spéc. backend §29).
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { env } from "../../config/env.js";
import { AppError, badRequest, unauthorized } from "../../core/errors.js";

export interface AuthSession {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  expires_at: number | null;
  token_type: string;
}

function anonClient(accessToken?: string): SupabaseClient {
  const e = env();
  return createClient(e.SUPABASE_URL, e.SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: accessToken ? { headers: { Authorization: `Bearer ${accessToken}` } } : undefined,
  });
}

function adminClient(): SupabaseClient {
  const e = env();
  if (!e.SUPABASE_SERVICE_ROLE_KEY) {
    throw new AppError(500, "SERVICE_ROLE_NOT_CONFIGURED", "Opération d'administration Auth indisponible.");
  }
  return createClient(e.SUPABASE_URL, e.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

const toSession = (s: any): AuthSession => ({
  access_token: s.access_token,
  refresh_token: s.refresh_token,
  expires_in: s.expires_in,
  expires_at: s.expires_at ?? null,
  token_type: s.token_type ?? "bearer",
});

function mapAuthError(err: any): AppError {
  const code = String(err?.code ?? err?.error_code ?? "");
  if (code === "email_not_confirmed") return new AppError(403, "EMAIL_NOT_VERIFIED", "Adresse e-mail non vérifiée.");
  if (code === "weak_password") return badRequest("WEAK_PASSWORD", "Mot de passe trop faible.");
  if (code === "over_request_rate_limit" || err?.status === 429) return new AppError(429, "RATE_LIMITED", "Trop de tentatives.");
  if (err?.status === 400 || err?.status === 401 || code === "invalid_credentials") {
    // Message volontairement générique (anti-énumération de comptes).
    return unauthorized("INVALID_CREDENTIALS", "Identifiants invalides.");
  }
  return new AppError(502, "AUTH_PROVIDER_ERROR", "Service d'authentification indisponible.");
}

export const authProvider = {
  async signUp(email: string, password: string, metadata: Record<string, unknown>, redirectTo: string) {
    const { data, error } = await anonClient().auth.signUp({ email, password, options: { data: metadata, emailRedirectTo: redirectTo } });
    if (error) throw mapAuthError(error);
    return { userId: data.user?.id ?? null, session: data.session ? toSession(data.session) : null, identities: data.user?.identities?.length ?? 0 };
  },

  async signIn(email: string, password: string): Promise<AuthSession> {
    const { data, error } = await anonClient().auth.signInWithPassword({ email, password });
    if (error || !data.session) throw mapAuthError(error ?? { status: 401 });
    return toSession(data.session);
  },

  async refresh(refreshToken: string): Promise<AuthSession> {
    const { data, error } = await anonClient().auth.refreshSession({ refresh_token: refreshToken });
    if (error || !data.session) throw unauthorized("REFRESH_INVALID", "Session expirée : reconnectez-vous.");
    return toSession(data.session);
  },

  /**
   * Vérification d'un lien e-mail Supabase (modèle d'e-mail configuré avec
   * {{ .TokenHash }} : voir docs/MIGRATION-PLAN.md). Retourne la session ouverte.
   */
  async verifyEmailToken(tokenHash: string, type: "signup" | "email" | "recovery"): Promise<AuthSession> {
    const { data, error } = await anonClient().auth.verifyOtp({ token_hash: tokenHash, type });
    if (error || !data.session) throw badRequest("TOKEN_INVALID_OR_EXPIRED", "Lien invalide ou expiré.");
    return toSession(data.session);
  },

  async resendSignupConfirmation(email: string, redirectTo: string) {
    const { error } = await anonClient().auth.resend({ type: "signup", email, options: { emailRedirectTo: redirectTo } });
    // Réponse identique que le compte existe ou non ; seules les pannes du fournisseur remontent.
    if (error && error.status && error.status >= 500) throw mapAuthError(error);
  },

  async signOut(accessToken: string, scope: "local" | "global" = "local") {
    const e = env();
    // Appel REST direct : supabase-js ne permet pas de cibler un jeton arbitraire côté serveur sans service_role.
    const r = await fetch(`${e.SUPABASE_URL.replace(/\/$/, "")}/auth/v1/logout?scope=${scope}`, {
      method: "POST",
      headers: { apikey: e.SUPABASE_ANON_KEY, Authorization: `Bearer ${accessToken}` },
    });
    if (!r.ok && r.status !== 401 && r.status !== 404) throw new AppError(502, "AUTH_PROVIDER_ERROR", "Déconnexion impossible.");
  },

  async recover(email: string, redirectTo: string) {
    const { error } = await anonClient().auth.resetPasswordForEmail(email, { redirectTo });
    // Aucune information sur l'existence du compte n'est renvoyée.
    if (error && error.status && error.status >= 500) throw mapAuthError(error);
  },

  async updatePassword(accessToken: string, newPassword: string) {
    const e = env();
    const r = await fetch(`${e.SUPABASE_URL.replace(/\/$/, "")}/auth/v1/user`, {
      method: "PUT",
      headers: { apikey: e.SUPABASE_ANON_KEY, Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ password: newPassword }),
    });
    if (!r.ok) throw mapAuthError({ status: r.status, ...(await r.json().catch(() => ({}))) });
  },

  /**
   * Migration des comptes existants (Migration §8.2) : le hash bcrypt d'origine est
   * transmis tel quel à Supabase Auth (compatible bcrypt). Aucun mot de passe en clair.
   */
  async adminCreateUserWithHash(input: { email: string; passwordHash: string; emailConfirmed: boolean; metadata: Record<string, unknown> }) {
    const { data, error } = await adminClient().auth.admin.createUser({
      email: input.email,
      password_hash: input.passwordHash,
      email_confirm: input.emailConfirmed,
      user_metadata: input.metadata,
    } as any);
    if (error || !data.user) throw new AppError(502, "AUTH_ADMIN_CREATE_FAILED", "Création refusée par Supabase Auth.");
    return data.user.id;
  },
};

# Plan de migration, recette et retour arrière

## 1. Niveaux de preuve (à ne pas confondre)

| Niveau | État au 21/11/2026 |
|---|---|
| Compilation TypeScript stricte + build de production | ✅ |
| Tests automatisés API + **PostgreSQL 18 réel** (embarqué) — doublure GoTrue/Storage pour Supabase | ✅ 153 tests, 0 échec (20/11/2026) |
| Reprise MongoDB → PostgreSQL sur un **vrai mongod** (données de synthèse au format des modèles) | ✅ |
| Essai du **serveur compilé** (`db:migrate` puis `node dist/src/server.js`) | ✅ health, i18n, refus 401, erreur traduite |
| Qualification locale reproductible (`npm run qualify:local`) : base vierge, `db:migrate` ×2, serveur compilé | ✅ 10/10 contrôles |
| Privilèges PostgreSQL et RLS sur la base migrée | ✅ `rls.test.ts` |
| Recette sur un **projet Supabase réel** (Auth, JWKS, vérification d'e-mail, réinitialisation, révocation, MFA TOTP, `password_hash`, bucket privé) | ❌ script prêt : `npm run recette:supabase` (RECETTE_ENV=preproduction) — non exécuté faute d'accès |
| Recette **Resend réelle** (envoi, webhook signé) | ❌ à faire |
| Reprise sur une **copie des données de production** | ❌ à faire (à blanc puis application en préproduction) |
| Tests navigateur avec backend réel | ❌ le frontend appelle encore `/api/*` (MERN) |
| Validation mobile native | ❌ |

## 2. Étapes

1. **Préproduction Supabase** : créer le projet, ne PAS exposer les schémas métier à la Data API, appliquer `supabase db push` (fichiers `supabase/migrations`), puis `psql -f supabase/seed/001_rbac_catalog.sql`. Ne jamais appliquer `supabase/tests/supabase_shim.sql`.
2. **Configurer Auth et Storage** : confirmation e-mail activée, SMTP de production, MFA TOTP activée, durée des sessions ; créer le bucket **privé** `canada-documents` (aucune politique publique) ; modèles d'e-mail Supabase « Confirm signup » et « Reset password » pointant vers le frontend avec `token_hash={{ .TokenHash }}&type=…` (le frontend transmet ce jeton à `POST /auth/verify-email` ou `/auth/reset-password`) ; créer le webhook Resend (`/api/v1/webhooks/resend`, événements `email.*`) et renseigner `RESEND_WEBHOOK_SECRET`.
3. **Recette Auth réelle** : `npm run recette:supabase` (voir l'en-tête de `scripts/recette-supabase.ts` pour les variables). Le script crée des comptes `recette+…@<domaine de test>` marqués `recette: true`, obtient les vrais jetons d'e-mail par l'API d'administration (`generateLink`), enrôle un vrai facteur TOTP, et vérifie aussi la connexion avec un hash bcrypt hérité et le caractère privé du bucket. Tout ÉCHEC bloque la mise en production.
4. **Premier administrateur** : créé par procédure contrôlée (SQL manuel tracé : `access.user_roles` global + justification), jamais par seed.
5. **Référentiels** : compagnies, aéroports, barèmes, taux validés par la direction (décisions §23).
6. **Reprise à blanc** sur une copie de la base MongoDB : `npm run migrate:mongo -- --mongo-uri <copie>` → analyser le rapport (`needs_review`, réconciliation par devise).
7. **Corrections source** puis reprise réelle en préproduction (`--apply`), rapport archivé dans `shared.migration_runs`.
8. **Pilote** : une agence, comptes internes ; frontend pilote branché sur `/api/v1`.
9. **Gel des écritures MongoDB** (fenêtre annoncée) → reprise incrémentale (le script ignore ce qui est déjà repris) → bascule.

## 3. Retour arrière

| Moment | Procédure |
|---|---|
| Avant bascule des écritures | Rien à faire : le backend MERN et MongoDB n'ont jamais été modifiés. |
| Après bascule | Ne PAS remettre l'ancien backend en service sans rejouer vers MongoDB les écritures faites dans PostgreSQL (aucune réplication inverse n'existe). Décision de la direction technique. |
| Migrations SQL | Toutes additives ; restauration par sauvegarde Supabase (PITR) testée avant la production. |

## 4. Exécution locale

```bash
cp .env.example .env     # renseigner DATABASE_URL, SUPABASE_*
npm run db:migrate       # migrations + seed (environnement sans CLI Supabase)
npm run dev              # API sur /api/v1, worker inclus
npm test                 # PostgreSQL embarqué + mongod local requis pour la reprise
npm run openapi          # régénère docs/openapi.json
npm run typecheck        # compilation stricte des sources ET des tests
npm run qualify:local    # après build : base vierge, db:migrate ×2, serveur compilé (dev uniquement)
```

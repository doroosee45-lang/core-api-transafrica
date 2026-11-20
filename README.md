# Trans Afrique Core API — domaine Canada

Backend cible (Node.js, Express 5, TypeScript, Supabase PostgreSQL, Supabase Auth) qui remplace progressivement le backend MERN de `../backend`, lequel **reste en service et n'a pas été modifié**.

| Document | Contenu |
|---|---|
| [docs/STATUS.md](docs/STATUS.md) | Fonctionnalités terminées / partielles / non réalisées, avec preuves |
| [docs/CONFORMITE.md](docs/CONFORMITE.md) | Conformité exigence par exigence, niveaux de preuve (PostgreSQL réel / doublure / réel) |
| [docs/PLAN-CORRECTION.md](docs/PLAN-CORRECTION.md) | Écarts par criticité, plan ordonné, recettes réelles, tests manquants |
| [docs/ARBITRAGES.md](docs/ARBITRAGES.md) | Analyse des arbitrages G-1 à G-17 (recommandations, non décisionnelles) |
| [docs/ROUTES.md](docs/ROUTES.md) | Inventaire des 145 routes : fichier, permission, tests |
| [docs/AUDIT.md](docs/AUDIT.md) | Audit de l'existant MERN et audit du Core API (écarts, preuves, corrections) |
| [docs/DECISIONS.md](docs/DECISIONS.md) | Décisions validées, décisions à valider, contradictions entre documents |
| [docs/RBAC.md](docs/RBAC.md) | Matrice rôles × permissions générée depuis le catalogue appliqué |
| [docs/I18N.md](docs/I18N.md) | Contrat d'internationalisation FR/EN pour le web et le mobile |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Architecture, sécurité, fiabilité, modules |
| [docs/MIGRATION-PLAN.md](docs/MIGRATION-PLAN.md) | Niveaux de preuve, étapes, recette Supabase, retour arrière |
| [docs/openapi.json](docs/openapi.json) | Contrat généré depuis le registre des routes (`npm run openapi`), 146 opérations |

Structure : `supabase/migrations` (schéma versionné, 10 migrations additives), `supabase/seed` (catalogue RBAC), `src/modules` (identity, access, canada/*, notifications), `src/i18n`, `src/integrations` (Supabase Auth/Storage, Resend), `src/migration/legacy.ts` (reprise MongoDB), `tests/` (intégration sur PostgreSQL réel).

## Démarrage

```bash
npm install
cp .env.example .env          # renseigner DATABASE_URL et SUPABASE_*
npm run db:migrate            # migrations + catalogue RBAC (hors CLI Supabase)
npm run dev                   # API sur /api/v1 + worker
npm test                      # 153 tests ; requiert le binaire mongod local pour la reprise (MONGOD_BINARY)
npm run build && npm start    # production
npm run typecheck             # sources + tests
npm run qualify:local         # qualification locale (base vierge, migrations, serveur compilé)
npm run recette:supabase      # recette RÉELLE en préproduction (RECETTE_ENV=preproduction)
```

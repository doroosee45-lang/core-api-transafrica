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

## Runtime de référence

Node.js **22.23.5** est la version de référence du projet (`.nvmrc`, `package.json` et `package-lock.json`). Elle a été utilisée pour exécuter la suite complète de tests et la qualification locale. Utiliser cette version exacte ; les versions Node 20 ne sont pas compatibles avec les versions verrouillées de Supabase JS et Vitest.

Avec `nvm` :

```bash
nvm install
nvm use
node --version  # doit afficher v22.23.5
```

Sur Windows, installer/sélectionner Node.js 22.23.5 avec un gestionnaire compatible (par exemple nvm-windows), puis vérifier `node --version`.

## Tests locaux et qualification

```bash
npm ci
npm run typecheck
npm run build
npm test
npm run qualify:local
```

La suite de tests télécharge à la première exécution (puis réutilise le cache local) le binaire **MongoDB 8.2.6** via `mongodb-memory-server`. Une connexion au serveur de téléchargement MongoDB est donc nécessaire si le binaire n'est pas déjà en cache. Les tests de reprise ne sont jamais ignorés : si le binaire ne peut pas être obtenu, la suite échoue avec un message explicite. Le provisionnement CI utilise le même téléchargement versionné ; le dépôt ne contenait pas de workflow CI avant l'ajout de `.github/workflows/ci.yml`.

`npm run qualify:local` démarre un PostgreSQL temporaire et isolé, applique les migrations deux fois, puis teste le serveur compilé. Ce script ne contacte pas Supabase/Resend et ne prouve pas l'intégration réelle.

## Démarrage de l'API

Après configuration d'une base locale/de développement dans `.env` (ne jamais utiliser la base de production pour les commandes locales) :

```bash
cp .env.example .env          # renseigner DATABASE_URL et SUPABASE_*
npm run db:migrate            # applique migrations + catalogue RBAC à DATABASE_URL
npm run dev                   # API sur /api/v1 + worker
npm start                     # serveur compilé (après npm run build)
npm run recette:supabase      # recette RÉELLE en préproduction (RECETTE_ENV=preproduction)
```

`npm run db:migrate` écrit sur la base ciblée par `DATABASE_URL`. Vérifier explicitement la cible avant de l'utiliser ; la qualification locale ne nécessite pas d'exécuter cette commande sur une base distante.

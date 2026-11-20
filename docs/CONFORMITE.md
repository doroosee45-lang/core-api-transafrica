# Conformité du Core API au cahier des charges v2.0 — rapport détaillé

Vérifié le 20/11/2026 sur le **code et les tests** (et non sur la documentation). Inventaire route par route : `docs/ROUTES.md`.
**Le Core API n'est PAS déclaré conforme** : voir la section 9 (bilan) et `docs/PLAN-CORRECTION.md`.

## 0. Niveaux de preuve (à ne jamais confondre)

| Code | Signification | Ce que cela prouve | Ce que cela NE prouve PAS |
|---|---|---|---|
| **PG** | Test automatisé HTTP → Core API → **PostgreSQL 18 réel** (schéma migré, triggers, RLS) | règles métier, autorisations, intégrité, transactions | comportement des services externes |
| **DBL** | Idem, mais un service externe est une **doublure de test** (`tests/support/gotrue-stub.ts` : Supabase Auth et Storage ; transport e-mail remplacé ; webhook signé localement) | que notre code d'intégration envoie et interprète correctement les appels **tels que la doublure les imite** | que le vrai Supabase / Resend se comporte ainsi |
| **QUAL** | `npm run qualify:local` : base vierge, `db:migrate` ×2, **serveur compilé** démarré et interrogé | déploiement des migrations, démarrage de production | intégrations externes |
| **RÉEL** | Recette sur service réel (préproduction) | l'intégration réelle | — |
| **NON** | Non développé | — | — |
| **BLOQ** | Bloqué par une décision ouverte | — | — |

**Aucune exigence n'est aujourd'hui prouvée au niveau RÉEL** : `npm run recette:supabase` est prêt mais n'a pas été exécuté (pas d'accès à un projet de préproduction).

Mesures du 20/11/2026 : `npm run typecheck` ✅ · `npm test` **14 fichiers, 153 tests, 0 échec** (deux exécutions identiques) · couverture 92,9 % des lignes, 85,7 % des instructions, 70,8 % des branches · **145/145 routes exercées** par au moins un test (garde-fou `route-inventory.test.ts`) · `qualify:local` 10/10.

## 1. Gouvernance et rôles (Cahier §3, Modules 1-3, §19.1)

| Exigence | Fichiers / fonctions | Routes | Permissions / RLS | Tests | Non couvert | Preuve | Correction nécessaire |
|---|---|---|---|---|---|---|---|
| Super Admin : vue des 5 pays | `authorization.ts` `scopeFilter`, `loadPrincipal` | listes `/canada/*`, `/canada/reports/overview` | `canada_administrator` @global | `rbac`, `structure`, `routes-coverage` | — | PG | — |
| Super Admin sans opération financière (V-02) | seed `001_rbac_catalog.sql` ; `governance.routes.ts` (garde d'escalade) | `/canada/payments/:id/counter-receipts`, `/canada/refunds/*`, `/canada/payments/:id/cancel` | jamais `payments.verify`, `refunds.*`, `payments.reconcile` | `features`, `rbac-audit`, `routes-coverage` | — | PG | — |
| Administrateur pays : son pays et toutes ses agences | `scopeClause` (pays → agences du pays) | toutes les listes | `canada_administrator` @country | `rbac`, `structure`, `routes-coverage` | écriture d'une fiche client par un pays « de passage » (G-7) | PG | selon G-7 |
| Activer / désactiver un pays : global seulement | `structure.routes.ts` PATCH `/canada/countries/:code` | idem | `countries.manage` @global | `routes-coverage` | — | PG | — |
| Manager limité à son agence, sans gouvernance (V-01) | seed (périmètre `agency`), `flight.service.ts` | `/canada/flights*` | `canada_agency_manager` @agency ; `flights.assign_shipments` seul | `features`, `routes-coverage` | — | PG | — |
| Agent : opérations, ni tarifs, ni permissions, ni paiements | seed, `parcel.service.ts` | `/canada/parcels*` | `canada_agent` @agency/@warehouse | `rbac`, `routes-coverage` | — | PG | — |
| Client : ses données uniquement | `client.routes.ts`, `client.self.routes.ts` (`myClientIds`, `ownerUserIds`) | `/me/*` | `*_own` ; RLS « propriétaire » | `rbac`, `rls`, `routes-coverage` | — | PG | — |
| Rôles complémentaires configurables (§3.7) | `governance.routes.ts` | `/access/roles` | `roles.manage` @global ; anti-escalade à la modification | `features`, `rbac-audit` | — | PG | — |
| Anti-escalade, révocation immédiate, rôle exceptionnel | `access.service.ts` `assertGrantAuthority`, `revokeRole` ; trigger `user_roles_revoke_only` | `/access/user-roles*`, `/access/invitations*` | `users.manage_access` | `rbac`, `rbac-audit`, `routes-coverage` | — | PG | — |
| Nomination du personnel financier | idem | `/access/user-roles` | D-15 | `rbac-audit` (existant) | conditions de l'option 1 non encore appliquées | PG (existant) | **attend la validation de D-15** (`ARBITRAGES.md`) |
| Suspension de compte / d'accès plateforme | `access.service.ts` `setAccountStatus`, `setPlatformAccess` | `/access/users/:id/*` | global seulement | `structure` | suspension par un administrateur pays (G-5) | PG | selon G-5 |
| Historique des connexions, sessions | `governance.routes.ts` | `/identity/me/sessions`, `/identity/me/security-events`, `/access/users/:id/security-events` | `users.read` (périmètre) | `features`, `routes-coverage` | — | PG | — |
| Modification du profil d'autrui par un administrateur ; « réinitialisation des accès » par un administrateur (Module 3) | — | — | — | — | non développé | NON | spécification des champs et de la procédure (G-16) |

## 2. Authentification (Spéc. identité §7-§8, §14 ; Cahier §16)

| Exigence | Fichiers / fonctions | Routes | Tests | Non couvert | Preuve | Correction |
|---|---|---|---|---|---|---|
| Inscription commune, anti-énumération, reprise de provisionnement | `identity.routes.ts`, `identity.service.ts` | `/auth/register` | `identity`, `auth-money` | Supabase réel | DBL | recette réelle |
| Vérification JWT (signature, `aud`, `iss`, `exp`), HS256 ou JWKS | `jwt.ts` | toutes | `identity` | JWKS asymétrique réel (le test utilise HS256) | DBL | recette réelle (contrôle JWKS) |
| Session révocable, compte banni, e-mail non vérifié | `authenticate.ts` (`auth.sessions`) | toutes | `identity`, `auth-money` | — | DBL | recette réelle |
| Connexion, refresh, déconnexion locale/globale | `authProvider.ts` | `/auth/login`, `/auth/refresh`, `/auth/logout` | `identity` | — | DBL | recette réelle |
| Vérification d'e-mail, renvoi, réinitialisation, changement de mot de passe | `authProvider.verifyEmailToken`, `resendSignupConfirmation`, `updatePassword` | `/auth/verify-email`, `/auth/resend-verification`, `/auth/forgot-password`, `/auth/reset-password`, `/auth/change-password` | `auth-money` | modèles d'e-mail Supabase (`{{ .TokenHash }}`) non configurés | DBL | configuration + recette réelle |
| Limitation des tentatives (IP + compte) | `security.ts` | `/auth/*` | `auth-money` | compteurs en mémoire : non partagés entre instances | PG | stockage partagé si plusieurs instances (G-6 / exploitation) |
| MFA administrateurs (AAL2) | `authorization.ts` (`requires_mfa`) | toutes | `rbac`, `rbac-audit` | facteur TOTP réel | DBL | recette réelle (TOTP prévu dans le script) |
| Reprise des mots de passe bcrypt hérités | `authProvider.adminCreateUserWithHash`, `migration/legacy.ts` | — | `legacy-migration` (mongod réel, doublure Auth) | `password_hash` sur Supabase réel | DBL | recette réelle |

## 3. Multi-pays, agences, entrepôts (Cahier §4, Module 5)

| Exigence | Fichiers | Routes | Tests | Non couvert | Preuve | Correction |
|---|---|---|---|---|---|---|
| 5 pays, devise, fuseau, indicatif, langues | migration `foundation`, `locales_documents_support` ; `settings.routes.ts` | `/canada/countries*`, `/i18n` | `auth-money`, `structure`, `i18n`, QUAL | — | PG | — |
| Distinctions géographiques (résidence, origine, destination, agence, aéroports) | schéma `canada.*` | — | `logistics` | — | PG | — |
| Agences et entrepôts : création, modification, suspension | `structure.routes.ts`, `logistics.extra.routes.ts` | `/canada/agencies*`, `/canada/warehouses/:id` | `structure`, `features` | — | PG | — |
| Horaires d'agence, capacités, inventaire | — | — | — | non modélisés | NON | spécification (G-15) |
| Isolation (backend + RLS + privilèges) | `authorization.ts`, migration `rls_policies` | toutes | `rbac`, `rls`, `routes-coverage` | — | PG | — |

## 4. Logistique (Modules 4, 6, 7, 10 ; §17)

| Exigence | Fichiers | Routes | Tests | Non couvert | Preuve | Correction |
|---|---|---|---|---|---|---|
| Fiche client, adresses, préférences | `structure.routes.ts`, `client.self.routes.ts` | `/canada/clients*`, `/me/client`, `/me/addresses*` | `structure`, `features`, `routes-coverage` | — | PG | — |
| Colis : référence unique, machine à états, poids réel/volumétrique/facturable, historique en ajout seul | `parcel.service.ts`, `parcel.rules.ts` | `/canada/parcels*` | `logistics`, `features`, `routes-coverage` | — | PG | — |
| QR / code-barres | — (la référence est fournie) | — | — | image | — | côté web/mobile |
| Photos et documents (stockage privé, signature binaire) | `documents.routes.ts` (`matchesSignature`), `storage.ts` | `/canada/documents*` | `features` | Storage réel (Range, privé) | DBL | recette réelle (prévue dans le script) |
| Expéditions : regroupement, retrait, départ, arrivée, clôture, annulation, responsables | `shipment.service.ts` | `/canada/shipments*` | `logistics`, `features`, `routes-coverage` | — | PG | — |
| Transporteurs, documents d'expédition générés | — | — | — | non modélisés | NON | spécification (G-14, G-13) |
| Coordination origine/destination (§17) | `originResource`, `shipmentDestination` | transitions, arrivée | `logistics`, `rbac` | — | PG | — |
| Suivi client : étapes, dernière position confirmée (scan), vol publié associé | `client.routes.ts` `clientTracking`, `lastConfirmedPosition` | `/me/parcels/:id/tracking`, `/me/shipments`, `/public/tracking/:reference` | `features`, `routes-coverage`, `logistics` | carte, GPS | PG / BLOQ (GPS) | décisions §23.2, §23.4 |

## 5. Vols et suivi aérien (Modules 8, 9 ; §19.3-19.4)

| Exigence | Fichiers | Routes | Tests | Non couvert | Preuve | Correction |
|---|---|---|---|---|---|---|
| Création, validation, publication versionnée, statuts du Cahier, annulation | `flight.service.ts` | `/canada/flights*` | `logistics`, `features`, `routes-coverage` | — | PG | — |
| Association / désassociation d'expéditions (historique) | `assignShipment`, `unassignShipment` | `/canada/flights/:id/shipments*` | `logistics`, `routes-coverage` | — | PG | — |
| Arrivée du vol ≠ réception des colis | `changeOperationalStatus` | `/canada/flights/:id/status` | `logistics` | — | PG | — |
| Recherche compagnie + numéro + date, dernière information confirmée, aucune position inventée | `flight.routes.ts` `flightTracking` | `/canada/flights`, `/canada/flights/:id/tracking` | `logistics`, `routes-coverage` | positions réelles | PG / BLOQ | fournisseur aéronautique (§23.1) |

## 6. Notifications (Module 11 ; §19.6)

| Exigence | Fichiers | Routes | Tests | Non couvert | Preuve | Correction |
|---|---|---|---|---|---|---|
| Outbox, anti-doublon, ordre, destinataires figés | `outbox.ts`, `worker.ts`, `handlers.ts` | (asynchrone) | `logistics` | — | PG | — |
| Annonce générale distincte et autorisée | `operations.routes.ts` | `/canada/notifications/announcements` | `logistics` | — | PG | — |
| Langue et fuseau du destinataire | `handlers.ts`, `i18n` | — | `i18n`, `auth-money` | — | PG | — |
| Centre de notifications, préférences, appareils | `client.routes.ts` | `/me/notifications*`, `/me/notification-preferences`, `/me/devices` | `routes-coverage` | — | PG | — |
| E-mail : accepté ≠ délivré, rebonds, suppressions | `email.ts`, `webhooks.ts` | `/webhooks/resend` | `webhooks` | Resend réel | DBL | recette Resend (`PLAN-CORRECTION.md` §4) |
| Push mobile | — (appareils enregistrés seulement) | — | — | envoi | BLOQ | fournisseur (§23.8) |

## 7. Finances (Modules 12, 13)

| Exigence | Fichiers | Routes | Tests | Non couvert | Preuve | Correction |
|---|---|---|---|---|---|---|
| Barèmes versionnés et immuables, diviseur configurable | `finance.routes.ts`, trigger `pricing_rule_immutable` | `/canada/pricing-rules*` | `logistics`, `auth-money` | — | PG | — |
| Taux datés et historisés (10 décimales, > 0, ajout seul) | `money.ts` `findRate` | `/canada/exchange-rates` | `logistics`, `auth-money` | — | PG | — |
| Devis versionnés, multi-devises, taux figé, propriétaire du colis contrôlé | `quote.service.ts` | `/canada/quotes*`, `/me/quotes*` | `logistics`, `auth-money`, `routes-coverage` | — | PG | — |
| Précision des montants par devise, cohérence des devises en base | `money.ts` `assertAmountPrecision` ; migration `currency_integrity` | paiements, remboursements, barèmes | `auth-money` | — | PG | — |
| Paiements : obligation, encaissement vérifié, idempotence, remboursements à double validation, annulation | `payment.service.ts` | `/canada/payments*`, `/canada/refunds*`, `/me/payments` | `logistics`, `routes-coverage` | — | PG | — |
| Prestataires en ligne, réconciliation prestataire | — | — | — | — | BLOQ | §23.9 |
| Factures, reçus | — | — | — | — | NON / BLOQ | G-13 |
| Rapports financiers, export CSV par périmètre | `operations.routes.ts`, `exports.routes.ts` | `/canada/reports/overview`, `/canada/financial-reports/payments/export` | `structure`, `routes-coverage` | revenus consolidés multi-devises | PG / BLOQ | G-10 |

## 8. Support, tableaux de bord, plateforme (Modules 14-15 ; §13, §15, §16)

| Exigence | Fichiers | Routes | Tests | Non couvert | Preuve | Correction |
|---|---|---|---|---|---|---|
| Tickets, réclamations, affectation, réponses, notes internes, clôture | `support.routes.ts` | `/me/support-tickets*`, `/canada/support-tickets*` | `features`, `routes-coverage` | — | PG | — |
| Tableaux de bord par périmètre (statuts, clients, agences, personnel, réclamations, devis en attente, paiements par devise, échecs de notifications, outbox) | `operations.routes.ts` | `/canada/reports/overview` | `structure`, `routes-coverage` | performance des agences, revenus consolidés, tâches des agents | PG / BLOQ | G-10, G-11 |
| API versionnée, OpenAPI (146 opérations, `operationId`) | `routes.ts`, `generate-openapi.ts` | — | `npm run openapi` | — | QUAL | — |
| Idempotence (clés abandonnées, purge) | `routes.ts`, `worker.ts` | opérations sensibles | `logistics`, `auth-money` | — | PG | — |
| Audit en ajout seul, refus 403 journalisés | `audit.ts`, `http.ts`, triggers | `/canada/audit-events*` | `rbac-audit`, `structure` | — | PG | — |
| Temps réel (WebSocket/SSE) | — | — | — | — | BLOQ | D-13 (G-17) |
| Sauvegardes, restauration (PITR) | infrastructure Supabase | — | — | — | — | recette préproduction |

## 9. Bilan

| Catégorie | Contenu |
|---|---|
| **Réellement terminé (preuve PG, sans dépendance externe)** | RBAC complet (5 rôles + rôles configurables, anti-escalade, révocation), isolation pays/agence/entrepôt/propriétaire, RLS et privilèges PostgreSQL, colis, expéditions, vols (hors positions), devis, paiements au guichet, remboursements, devises et taux, support, centre de notifications, documents (logique), audit, idempotence, internationalisation FR/EN |
| **Partiellement terminé** | tableaux de bord (§12 : sans performance des agences, revenus consolidés, tâches), réconciliation (sans prestataire), notifications (e-mail sans recette réelle, pas de push) |
| **Bloqué par décision** | D-15 (conditions de l'option 1), G-5 à G-17 (`ARBITRAGES.md`), positions aériennes, GPS/cartographie, push, paiement en ligne, factures, temps réel |
| **Non réalisé (spécification manquante)** | horaires/capacités/inventaire, transporteurs, manifestes PDF, modification du profil d'autrui par un administrateur |
| **Testé avec doublure uniquement** | Supabase Auth (inscription, JWT, sessions, MFA, e-mails), Supabase Storage (URL signées, Range, bucket privé), Resend (envoi, webhook) |
| **Testé avec service réel** | **aucun** (seul PostgreSQL 18 est réel) |
| **Restant à développer** | voir `PLAN-CORRECTION.md` §3 |

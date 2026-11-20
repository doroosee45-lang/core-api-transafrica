# Plan de fermeture des écarts — Core API

20/11/2026. Complète `CONFORMITE.md` (exigence par exigence), `ARBITRAGES.md` (G-1 à G-17) et `ROUTES.md` (inventaire).

## 1. Écarts classés par criticité

| Criticité | Écart | Nature | Débloqué par |
|---|---|---|---|
| **Critique** | Aucune intégration externe prouvée au niveau RÉEL (Supabase Auth, MFA, Storage, Resend) | recette | accès préproduction + `npm run recette:supabase` + procédure Resend (§4) |
| **Critique** | Nomination du personnel financier : conditions de l'option 1 non appliquées (justification, éventuelle échéance, amorçage journalisé, séparation) | décision | validation formelle de D-15 + G-1 … G-4 |
| **Élevé** | Écriture d'une fiche client par un pays « de passage » (statut, e-mail) | décision d'autorisation | G-7 |
| **Élevé** | Paiement en ligne absent ; seul l'encaissement au guichet est possible | décision + intégration | Cahier §23.9 |
| **Élevé** | Factures et reçus absents (Module 13) | décision légale + développement | G-13 |
| **Élevé** | Compteurs de verrouillage et de débit en mémoire (non partagés si plusieurs instances) | exploitation | mode d'hébergement (une ou plusieurs instances) |
| **Moyen** | Push mobile absent (appareils enregistrés) | décision + intégration | §23.8 |
| **Moyen** | Positions aériennes, GPS, carte | décision + intégration | §23.1, §23.2, §23.4 |
| **Moyen** | Tableaux de bord : performance des agences, revenus consolidés, anomalies | spécification | G-10, G-11, G-12 |
| **Moyen** | Temps réel (WebSocket/SSE) | spécification | G-17 |
| **Moyen** | Déconnexion de tous les appareils après réinitialisation | décision | G-6 (D-19) |
| **Faible** | Horaires, capacités, inventaire ; transporteurs ; manifestes PDF ; modification du profil d'autrui | spécification | G-14, G-15, G-16 |
| **Faible** | QR / code-barres (image) | côté applications | — |

## 2. Analyse des fonctionnalités manquantes (mission §5)

| Fonctionnalité | Exigence source | Ce qui manque | Catégorie |
|---|---|---|---|
| Horaires des agences | Cahier §4.3 | format (jours, plages, fuseau, jours fériés) | **spécification** (G-15) puis développement simple |
| Capacités des agences | Module 5, Spéc. backend §9 | unité, seuils, effet d'un dépassement | **décision métier** + spécification (G-15) |
| Inventaire des entrepôts | Module 5 | procédure (fréquence, écarts, validation) ; la localisation des colis par entrepôt existe déjà (`current_warehouse_id`, scans) | **spécification** (G-15) |
| Transporteurs et attribution | Module 7, §14.3 | modèle de données et règles | **spécification** (G-14) |
| Manifestes et documents PDF | Module 7 « génération des documents » | contenu, format, exigences douanières | **spécification** + développement |
| Factures et reçus | Module 13 | règles légales et comptables par pays | **décision métier/légale** (G-13) |
| Tableaux de bord détaillés | Cahier §12 | comptages : **faits** ; performance, consolidation, anomalies : définitions | **spécification** (G-10 … G-12) |
| WebSocket / SSE | §13.6, Spéc. backend §28 | canaux, événements, authentification | **spécification** (G-17) puis développement |
| Signatures binaires des fichiers | §16 | — | **FAIT** le 20/11/2026 (doublure) ; recette Storage réelle à faire |
| Intégration aéronautique | Module 9, §23.1 | choix du fournisseur, contrat, coût | **intégration externe** + décision |
| Notifications push | Module 11, §23.8 | choix du fournisseur (Expo, FCM/APNs) | **intégration externe** + décision |
| Prestataires de paiement | Module 13, §23.9 | prestataires par pays, webhooks signés | **intégration externe** + décision |

## 3. Plan de correction ordonné (avec dépendances)

| Étape | Travail | Dépend de | Fichiers concernés |
|---|---|---|---|
| 1 | Recette Supabase réelle (Auth, JWKS, e-mails, MFA TOTP, bcrypt hérité, Storage privé + Range) | projet de préproduction, modèles d'e-mail `{{ .TokenHash }}` | `scripts/recette-supabase.ts` |
| 2 | Recette Resend réelle (§4) | domaine d'envoi vérifié, URL publique de préproduction | `src/integrations/email.ts`, `src/modules/notifications/webhooks.ts` |
| 3 | Appliquer D-15 (option 1) selon G-1 … G-4 | validation formelle D-15 | `src/modules/access/access.service.ts`, nouvelle migration additive (fonction d'amorçage, `access.invitations.justification`), `supabase/seed/001_rbac_catalog.sql` (si G-3 = b), `tests/rbac-audit.test.ts`, `tests/rls.test.ts`, `docs/RBAC.md` |
| 4 | Appliquer G-7 (périmètre d'écriture client), G-5, G-6 | décisions | `structure.routes.ts`, `access.service.ts`, `identity.routes.ts` |
| 5 | Stockage partagé des compteurs (si plusieurs instances) | mode d'hébergement | `src/core/security.ts` |
| 6 | Tableaux de bord restants | G-10 … G-12 | `operations.routes.ts` |
| 7 | Temps réel | G-17 | nouveau module `src/modules/realtime` |
| 8 | Factures/reçus, manifestes, transporteurs, horaires/capacités/inventaire | G-13 … G-16 | nouvelles migrations additives + modules |
| 9 | Intégrations externes (paiement, push, aéronautique) | choix des fournisseurs | `src/integrations/*` |
| 10 | Migration du frontend et du mobile vers `/api/v1` (hors périmètre de ce lot) | étapes 1-3 | autres projets |

## 4. Recettes réelles à exécuter (aucune n'a été exécutée)

| Service | Vérifications | Moyen | Prérequis |
|---|---|---|---|
| Supabase Auth | JWKS, inscription, e-mail non vérifié refusé, vérification par jeton réel, connexion, message générique, refresh, déconnexion → session refusée, réinitialisation (anti-énumération, ancien mot de passe refusé) | `npm run recette:supabase` | projet de préproduction ; confirmation d'e-mail activée ; SMTP ; modèles d'e-mail |
| MFA | enrôlement TOTP réel, session AAL2 reconnue par le Core API | idem | MFA TOTP activée dans Auth |
| Reprise des comptes | `admin.createUser({ password_hash })` bcrypt, connexion avec l'ancien mot de passe | idem | clé `service_role` |
| Storage | bucket privé, téléversement signé, lecture `Range` (dont dépend le contrôle de signature), objet inaccessible sans lien signé | idem | bucket `canada-documents` privé |
| Resend | envoi accepté puis **délivré** (webhook `email.delivered`), rebond → adresse supprimée, signature Svix invalide → 400, rejeu ignoré | procédure manuelle : déclencher une invitation vers `delivered@resend.dev` puis `bounced@resend.dev` (adresses de test Resend) ; vérifier `shared.notification_deliveries`, `shared.email_suppressions` | domaine vérifié, `RESEND_*`, webhook configuré vers l'URL publique |
| Sauvegardes | restauration PITR sur un projet de test | console Supabase | plan Supabase avec PITR |
| Paiements en ligne | — | **impossible** : non développé | choix des prestataires |
| Suivi aéronautique | — | **impossible** : non développé | choix du fournisseur |
| Push | — | **impossible** : non développé | choix du fournisseur |

## 5. Tests encore manquants

| Sujet | Test à écrire | Bloqué par |
|---|---|---|
| D-15 option 1 | justification obligatoire, échéance (si G-1 = b), amorçage journalisé, exception d'anti-escalade bornée (si G-3 = b) | validation D-15 |
| G-7 | écriture de la fiche client par le seul pays de rattachement | G-7 |
| Concurrence | deux associations simultanées d'un même colis à deux expéditions | — (réalisable sans décision, à faire) |
| Charge | latence et débit des routes principales | objectifs §19.7 non fixés |
| Plusieurs instances | verrouillage/débit partagés | mode d'hébergement |

## 6. Corrections réalisées le 20/11/2026 sans décision supplémentaire

Toutes vérifiées compatibles avec V-01 à V-04 ; aucune ne touche D-15.

| Correction | Fichiers | Preuve |
|---|---|---|
| 37 routes (25 %) n'étaient appelées par aucun test : toutes couvertes, avec un cas autorisé et un cas refusé | `tests/routes-coverage.test.ts` | 24 tests ; inventaire 145/145 |
| Garde-fou : une route sans test fait échouer la suite (vérifié par mutation : retirer le fichier de couverture le fait échouer) | `tests/route-inventory.test.ts` | — |
| Droits du client vérifiés (suivi de ses colis et du vol publié de son expédition ; aucune action opérationnelle ; aucun accès aux autres clients) | `tests/routes-coverage.test.ts` « Droits du client » | 3 tests |
| Contrôle de la signature binaire des fichiers (un exécutable déclaré en image est rejeté) | `documents.routes.ts` `matchesSignature`, `storage.ts` `head` | `features.test.ts` (2 tests) |
| Tableaux de bord : clients, agences, personnel par rôle, réclamations, filtrés par périmètre (Cahier §12) | `operations.routes.ts` | `routes-coverage.test.ts` |
| Concurrence : deux encaissements simultanés du solde → un seul aboutit, aucun trop-perçu | `tests/auth-money.test.ts` | 1 test |
| Recette réelle étendue au stockage (téléversement signé, Range, objet privé) | `scripts/recette-supabase.ts` | non exécutée |
| Inventaire route par route | `docs/ROUTES.md` | — |

## 7. Clarification demandée : droits du client (§3 / §10 du rapport précédent)

Vérification (tests « Droits du client ») : le client **consulte** le suivi de ses colis, le vol **publié** associé à son expédition (désignation, horaires, statut, dernière information confirmée, jamais de position inventée) et ses expéditions ; il **ne peut pas** changer un statut, créer/publier/annuler un vol, déclarer un statut de vol, lire la liste interne des vols ou des expéditions, ni désassocier une expédition ; un autre client reçoit 403 ou une liste vide.

- La formulation de l'ancien rapport (« jamais un statut logistique ni un vol ») était ambiguë : elle signifiait **ne jamais modifier**, pas ne jamais consulter.
- Formulation du cahier nécessitant clarification : Cahier §7.1 « Cette fonctionnalité est destinée à l'expérience client mobile » et Doc. de référence §8.1 / critère AC-10 « Accessible selon les rôles et uniquement dans le périmètre mobile prévu », face à la Migration §10.1 qui prévoit le « Tracking » dans l'espace client web → **question G-8**. Aucune fonctionnalité de suivi n'a été retirée.

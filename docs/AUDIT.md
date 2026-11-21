# Rapport d'audit — backend MERN existant (`migration/backend`)

Date : 20 novembre 2026 · Référentiel : Cahier des charges v2.0, Spécifications backend Canada, Document de migration, Dossiers techniques 02 à 05, Spécifications identité.
Méthode : lecture complète des modèles, middlewares, utilitaires de périmètre, routes et des contrôleurs clés (colis, paiements, vols). Le backend existant n'a **pas** été modifié.

## 1. Inventaire

| Élément | Constat |
|---|---|
| Pile | Node.js, Express 5, **JavaScript (CommonJS)**, Mongoose 9 / **MongoDB**, JWT maison (bcryptjs), Socket.IO, Multer (disque local), Resend |
| Taille | ~9 300 lignes ; 18 modèles, 24 fichiers de routes, 21 contrôleurs |
| API | `/api/*` non versionnée, réponses `{ success, message, data }`, identifiants Mongo `_id` |
| Tests | 12 scripts maison (`test-*.js`) sur `mongodb-memory-server`, sans framework |
| Pays | **3** (`CANADA`, `RDC`, `CONGO`) — la cible en exige **5** (+ Chine, Cameroun) |
| Devises | CAD, CDF, XAF (+ USD/EUR en lecture) — la cible exige aussi CNY |

## 2. Classification des fonctionnalités (Migration §5.3)

| Fonction existante | Statut | Justification / cible |
|---|---|---|
| Authentification JWT + bcrypt maison | **REPLACE** | Documents : Supabase Auth, compte unique Canada/Market. Hash bcrypt **repris tel quel** (compatible). |
| Rôles `superadmin/admin/manager/agent/driver/client` en champ texte | **REPLACE** | RBAC en tables (rôles, permissions, attributions à périmètre, historique). Correspondance §4 de `DECISIONS.md`. |
| Périmètre pays/agence (`utils/scope.js`, `X-Scope-*`) | **REFACTOR** | Principe conservé (le serveur calcule, l'en-tête ne fait que restreindre) → moteur `authorization.ts` à périmètres explicites. |
| Agences | **UPDATE** | Conservées ; ajout fuseau horaire, entrepôts (absents). |
| Clients (`Client.user` posé par un admin) | **KEEP (règle)** / migré | Règle saine conservée : aucun rattachement déduit d'un e-mail. |
| Colis (`Package` + `trackingHistory` embarqué) | **REFACTOR** | Historique en table append-only, poids réel/volumétrique/facturable, machine à états, origine ≠ destination. |
| Expéditions / regroupement | **MISSING** | Développé (`canada.shipments`, `shipment_parcels` historisé). |
| Vols (`Flight` draft/published/cancelled + outbox embarquée) | **REFACTOR** | Bonne idée (outbox) conservée ; ajout compagnie, IATA, statuts du cahier, versions, association expéditions. |
| Paiements (`Payment`, statut posé par le personnel) | **REPLACE** | Confirmation uniquement par source vérifiable + transactions, remboursements à double validation. |
| Devis public (`QuoteRequest`) | **UPDATE** | → `canada.requests` ; devis officiels versionnés **MISSING** → développés. |
| Marketplace de kilos (`KiloOffer/KiloOrder`) | **DEPRECATE (à valider)** | Absente des documents ; données conservées dans MongoDB, non reprises (D-07). |
| E-mails Resend, journal, suppressions | **KEEP (principes)** | « Non configuré = skipped, jamais envoyé », idempotence : principes repris. |
| Notifications push (Expo) | **UPDATE** | Fournisseur non validé (Cahier §23.8) : livraisons tracées `skipped`, jamais simulées. |
| Assistant IA (`/api/chat`) | **DEPRECATE (à valider)** | Hors documents ; historique non authentifié (voir A-07). |
| Employés (salaire, documents RH) | **À valider** | Hors périmètre des documents ; non repris. |
| Uploads sur disque local | **REPLACE** | Stockage objet privé exigé ; module Documents non encore développé. |
| Support / réclamations | **MISSING** | Non développé (Cahier Module 14). |
| Market (catalogue, vidéos, fournisseurs) | **MISSING** | Aucun code existant ; non développé dans ce lot. |

## 3. Anomalies (preuve · risque · priorité · test de correction)

| ID | Anomalie et preuve | Risque | Prio. | Correction et test dans le Core API |
|---|---|---|---|---|
| A-01 | `GET /api/packages/:id/tracking` sans contrôle de périmètre (`packageController.getPackageTracking`) : tout compte connecté lit l'historique de n'importe quel colis | Critique (fuite inter-clients) | P0 | Lecture conditionnée au périmètre ou au propriétaire — `rbac.test.ts` « client A ne lit pas les données du client B » |
| A-02 | Socket.IO `join_room(roomId)` sans contrôle (`server.js`) : un socket anonyme peut rejoindre `dashboard_admin` ou `tracking_<id>` | Élevé | P0 | Temps réel non repris tant que les canaux autorisés ne sont pas définis |
| A-03 | Suppression physique des colis et des paiements (`findByIdAndDelete`) : historique et piste comptable perdus | Critique | P0 | Triggers `forbid_mutation` — `rbac.test.ts` « pas de suppression physique » |
| A-04 | Statut colis libre (`updatePackageStatus` accepte toute valeur, y compris `delivered` sans preuve) | Élevé | P0 | Machine à états + preuve — `logistics.test.ts` |
| A-05 | Paiement marqué `paid` par tout personnel, sans source vérifiable (`Payment` pre-save force `amountPaid = amount`) | Critique (financier) | P0 | Encaissement avec reçu unique + permission `payments.verify` — scénario B/C |
| A-06 | Prix au kilo saisi par l'agent dans le corps de la requête colis | Élevé | P1 | Barèmes versionnés, calcul serveur |
| A-07 | `GET/DELETE /api/chat/history/:sessionId` sans authentification | Moyen | P1 | Non repris (à valider) |
| A-08 | Recherche par `new RegExp(search)` (saisie utilisateur) : ReDoS | Moyen | P1 | `ILIKE` paramétré, motifs échappés |
| A-09 | Suivi public renvoie noms expéditeur/destinataire et agence | Moyen (données personnelles) | P1 | Suivi public sans donnée personnelle — `logistics.test.ts` |
| A-10 | 3 pays au lieu de 5 ; pas d'aéroport/compagnie ; vol identifié par numéro seul | Fonctionnel | P1 | Référentiels + unicité compagnie/numéro/date |
| A-11 | Arrivée du vol non distinguée de la réception des colis | Fonctionnel | P1 | Testé : `ARRIVED` laisse les colis à `dispatched` |
| A-12 | Pas de MFA administrateur | Élevé | P1 | Rôles `requires_mfa` ignorés hors AAL2 — testé |
| A-13 | `X-Forwarded-For` lu directement par le limiteur de débit (usurpable) | Moyen | P2 | `req.ip` + `TRUST_PROXY` explicite |
| A-14 | Montants en `Number` flottant | Moyen | P2 | `NUMERIC` + `decimal.js`, arrondi par devise |
| A-15 | Frontend : appels vers des routes inexistantes (`/shipping-finance/*`, `/contact/messages`, `/marketplace/products`) | Fonctionnel | P2 | À traiter lors de la migration du frontend |

## 4. Points forts conservés
Calcul serveur du périmètre (jamais confiance au client), révocation de session (`tokenVersion` → ici `auth.sessions`), refus explicite et journalisé, montants ventilés par devise, outbox durable des vols, honnêteté des envois d'e-mail, numérotation atomique des factures.

---

# Audit du Core API lui-même (21/11/2026)

Vérification de ce qui avait été annoncé à la livraison précédente, par preuves (extraction du code, tests, essai du serveur compilé).

| ID | Écart constaté | Preuve | Correction | Test |
|---|---|---|---|---|
| B-01 | 23 permissions du catalogue sans aucune route (rôles configurables, paramètres, coordonnées client, affectation entrepôt, responsables d'étape, exports…) | extraction `grep` du catalogue vs `src/` | Routes ajoutées ; reliquat justifié : `payments.initiate_own` (prestataire), `tracking.manage_devices` / `read_location_history` (GPS), `quotes.approve_exception` (règles tarifaires), `clients.read_sensitive`, `permissions.manage` (catalogue défini par migration), `organizations.*` (Market) | `features.test.ts`, `structure.test.ts` |
| B-02 | Aucune internationalisation (130 codes d'erreur, notifications et libellés en français seulement) | extraction | Module `src/i18n`, 200+ messages traduits, notifications par destinataire | `i18n.test.ts` |
| B-03 | Agent attribuable au périmètre « pays » ; manager « pays » contraire à V-01 | seed | Périmètres corrigés ; rôle désactivé | `features.test.ts` |
| B-04 | Destinataires d'un vol calculés au traitement asynchrone (annonce perdue si annulation entre-temps) | scénario E | Audience figée dans l'événement | `logistics.test.ts` |
| B-05 | Ordre de traitement de l'outbox non garanti (`UPDATE … RETURNING`) | scénario E | Tri chronologique explicite | `logistics.test.ts` |
| B-06 | Paramètres SQL de types incohérents (`42P08`) : transitions colis, vols, paiements, accès, taux, webhook | erreurs 500 en test | Casts uniformes ; détecteur statique ajouté au processus | toutes les suites |
| B-07 | « Dernière position confirmée » toujours vide | lecture du code | Dernier scan physique (`kind: "scan"`), jamais de GPS inventé | `features.test.ts` |
| B-08 | Statut « délivré » jamais atteint (aucun webhook) | lecture du code | Webhook Resend signé, inbox de dédoublonnage, suppressions | `webhooks.test.ts` |
| B-09 | Modules Documents et Support absents (Cahier §13.7, Module 14) | inventaire | Implémentés (V-04 pour le stockage) | `features.test.ts` |
| B-10 | Routes de structure jamais exercées par l'API (référentiels créés en SQL dans les tests) | couverture 15 % | Test dédié aux 5 pays par l'API | `structure.test.ts` (couverture totale 81,8 %) |
| B-11 | Point d'entrée de production jamais démarré | — | Essai : build → `db:migrate` → `node dist/src/server.js` | essai consigné dans `docs/STATUS.md` |
| B-12 | Pas de route pour finaliser une réinitialisation de mot de passe ni pour vérifier l'e-mail / renvoyer le lien (Spéc. identité §8, §13) | lecture de `identity.routes.ts` | `POST /auth/reset-password`, `/auth/verify-email`, `/auth/resend-verification` (Supabase `verifyOtp` / `resend`) | `auth-money.test.ts` |
| B-13 | Limitation des connexions uniquement par IP : contournable en changeant d'adresse (Cahier §16) | lecture de `security.ts` | Verrouillage temporaire par compte (D-18), réponse identique pour un compte inconnu | `auth-money.test.ts` |
| B-14 | `change-password` ouvrait une session de contrôle jamais fermée | lecture du code | Session de contrôle fermée aussitôt | `auth-money.test.ts` |
| B-15 | Montants arrondis silencieusement à la devise : un encaissement de 100,5 XAF sur 101 dus affichait « 101 payés » mais statut « en attente » | test de reproduction | Refus `AMOUNT_PRECISION` (paiements, encaissements, remboursements, frais de barème) | `auth-money.test.ts` |
| B-16 | Taux de change limités à 4 décimales par l'API (colonne : 10) et taux nul accepté par la validation | lecture de `schemas.ts` + migration | Schéma `ExchangeRateValue` : > 0, 10 décimales | `auth-money.test.ts` |
| B-17 | Configuration de test injectée sans le schéma (valeurs par défaut absentes, divergence avec la production) | échec de test | `setEnvForTests` passe par `loadEnv` | toute la suite |
| B-18 | Escalade : ajout de `payments.verify` / `refunds.*` à un rôle personnalisé déjà attribué, ou réactivation d'un tel rôle, par un acteur ne les détenant pas (contournement de V-02) | test de reproduction (200 au lieu de 403) | Permissions ajoutées ou réactivées détenues par l'acteur au périmètre global | `rbac-audit.test.ts` |
| B-19 | Devis : colis d'un autre client facturable (sa référence devenait visible au client du devis) ; demande d'un autre client rattachable | lecture de `quote.service.ts` | `PARCEL_CLIENT_MISMATCH`, `REQUEST_CLIENT_MISMATCH` | `auth-money.test.ts` |
| B-20 | Cohérence des devises garantie seulement par le service | lecture des migrations | Triggers `CURRENCY_MISMATCH` (transactions, remboursements, lignes de devis, paiement ↔ devis) | `auth-money.test.ts` |
| B-21 | Idempotence : clé bloquée à vie après un arrêt du processus ; clés expirées jamais purgées ; réponse 5xx renvoyée sans libérer la clé | lecture de `routes.ts` | Reprise après 5 min, purge par le worker, libération sur 5xx | `auth-money.test.ts` |
| B-22 | Dates brutes ISO/UTC dans l'avis de devis et l'e-mail d'invitation (V-03) | lecture de `handlers.ts` | Date localisée avec fuseau explicite | `auth-money.test.ts` |
| B-23 | Aucun test des privilèges PostgreSQL ni de la RLS (une table future pouvait être ouverte sans alerte) | inventaire des tests | `rls.test.ts` : RLS partout, aucun droit `anon`, liste blanche `authenticated` (colonnes), aucune fonction exposée, comportement « propriétaire » | `rls.test.ts` |
| B-24 | Tests non vérifiés par le compilateur ; OpenAPI sans `operationId` ni webhook | `tsconfig.json`, `openapi.json` | `tsconfig.test.json` dans `npm run typecheck` ; `operationId` uniques, webhook documenté | `npm run typecheck`, `npm run openapi` |
| B-25 | `/i18n` public sans limitation de débit | scan des routes | 120 requêtes/minute/IP | — |
| B-26 | 37 routes sur 145 (25 %) appelées par AUCUN test, dont des routes client (paiements, notifications, expéditions, refus de devis) présentées comme prouvées | inventaire automatique registre ↔ tests | `routes-coverage.test.ts` + garde-fou `route-inventory.test.ts` (vérifié par mutation) | 145/145 |
| B-27 | Type de fichier contrôlé sur la seule déclaration (un exécutable déclaré « image/jpeg » était accepté) | lecture de `documents.routes.ts` | signature binaire lue par requête Range sur l'objet stocké | `features.test.ts` |
| B-28 | Indicateurs du Cahier §12 absents (clients, agences, personnel, réclamations) | lecture de `operations.routes.ts` | comptages filtrés par périmètre | `routes-coverage.test.ts` |
| B-29 | Écriture d'une fiche client permise depuis tout pays/agence figurant dans son périmètre de rattachement ou dans l'origine/destination d'un de ses colis | `structure.routes.ts` (`clientResource`, PATCH et link-account) ; test exploratoire local : un administrateur d'origine avec permission peut écrire, un pays sans lien est refusé sans modifier `notes` | **non corrigé — décision G-7 requise**. `routes-coverage.test.ts` couvre seulement le refus depuis un pays sans lien et le refus d'un manager sans permission ; il ne décide pas si un pays d'origine/destination doit pouvoir modifier la fiche entière. | Ne pas restreindre/élargir avant validation de G-7 ; ajouter ensuite les tests autorisé, hors périmètre et absence d'effet de bord. |

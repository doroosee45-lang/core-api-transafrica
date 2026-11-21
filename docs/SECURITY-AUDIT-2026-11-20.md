# Audit sécurité et qualification locale — Core API

**Date de clôture des vérifications locales : 20 novembre 2026**  
**Périmètre :** dépôt backend `transafricacanada` uniquement, clone `/home/user/core-api-review`, branche `main`, base initiale `3ad04f74d7e833544adfcb20ee5263b539d908df`.  
**Hors périmètre exécuté :** frontend, Supabase distant/préproduction/production, transfert de données historiques, commit et push.

## 1. Synthèse exécutive

La reproductibilité locale est maintenant validée sous Node **22.23.5**, avec MongoDB **8.2.6** identifié et validé par `MONGOD_BINARY`. Typecheck, build, suite entière (153 tests) et qualification locale (migrations 10/10 + rejeu) ont réussi sur l’état du code audité. Les diagnostics « binaire absent » et « chemin invalide » ont aussi été vérifiés : les tests de migration échouent explicitement, sans saut silencieux.

L’audit n’autorise **pas** une conclusion « backend conforme ». Trois sujets concrets restent à résoudre/valider avant mise en production :

1. **Important — incohérence métier/outbox et idempotence :** une demande client est enregistrée avant l’écriture outbox, hors transaction commune. Une panne outbox produit HTTP 500 mais conserve la demande ; la nouvelle tentative avec la même clé crée une seconde demande.
2. **Important — périmètre d’entrepôt incomplet :** la pesée accepte le `warehouse_id` envoyé sans vérifier son existence, son pays, son agence ni son périmètre. La transition vérifie le pays de l’entrepôt mais pas l’agence. Une sonde locale a confirmé l’usage d’un entrepôt d’une autre agence du même pays par un acteur de l’agence d’origine.
3. **À arbitrer — B-29 :** un administrateur ayant permission et scope du pays d’origine d’un colis lié peut modifier toute la fiche client. Un pays sans lien est refusé sans mutation. Ceci confirme le comportement actuel, pas le droit métier attendu ; G-7 reste à décider.

La configuration effective du rôle PostgreSQL utilisé par l’API, la recette Supabase, les intégrations réelles et la reprise des données de l’ancien schéma `public` restent non prouvées.

## 2. État initial et changements locaux

### État initial vérifié

- Clone GitHub du backend ; branche `main`, commit `3ad04f7` (SHA complet ci-dessus), arbre initial propre.
- Node exécuté : **v22.23.5**.
- Aucun changement du frontend, appel Supabase distant, `db push`, import/transfert/suppression distante, commit ou push n’a été effectué.

### Changements locaux présents

- `.nvmrc`, `package.json`, `package-lock.json` : runtime Node fixé à `22.23.5`.
- `.github/workflows/ci.yml` : CI de typecheck, build, tests et qualification ; provisionne le binaire MongoDB 8.2.6 et définit `MONGOD_BINARY`.
- `tests/legacy-migration.test.ts` : exige `MONGOD_BINARY`, contrôle son caractère exécutable et sa version 8.2.6 puis utilise ce chemin. L’absence ou l’invalidité produit une erreur explicite ; aucun test n’est ignoré.
- `README.md` : commandes/runtime et précautions locales documentés.
- `docs/AUDIT.md` : conclusion B-29 reformulée pour distinguer résultat d’essai et arbitrage G-7.

`git diff --check` a réussi. Aucun code métier, schéma ou migration SQL n’a été modifié pour corriger les constats : les anomalies sont rapportées pour validation distincte.

## 3. Commandes et résultats reproductibles

Toutes les commandes ci-dessous ont été exécutées sur l’arbre local final, avec `PATH` contenant Node 22.23.5 et, pour les validations positives, `MONGOD_BINARY=/home/user/.cache/mongodb-binaries/mongod-x64-debian-8.2.6`.

| Commande / contrôle | Résultat observé | Détail |
|---|---:|---|
| `node --version` | code 0 | `v22.23.5` |
| `npm ci` | code 0 (qualification antérieure sur le même arbre de reproductibilité) | 233 paquets installés, 0 vulnérabilité signalée par npm |
| `npm run typecheck` | code 0 | TypeScript sources et tests |
| `npm run build` | code 0 | Build de production |
| `npm test` | code 0 | **14 fichiers, 153/153 tests** ; inclut RLS, négatifs de scope, finance, migration legacy |
| `npm run qualify:local` | code 0 | 10/10 migrations, rejeu idempotent, référentiels, serveur compilé/health 200 et contrôles HTTP tous OK |
| Sonde entrepôts (temporaire) | code 0 | 1 test passé ; le cas d’un entrepôt d’une autre agence du même pays a été accepté dans pesée/transition selon le scénario de sonde |
| Sonde atomicité outbox (temporaire) | code 0 | 1 test passé ; détail et preuve en §4 |
| Test migration sans `MONGOD_BINARY` | échec attendu, code 1 | erreur `MONGOD_BINARY is required…`, 1 fichier en échec ; preuve du diagnostic, pas une qualification positive |
| Test migration avec `MONGOD_BINARY=/no/such/mongod` | échec attendu, code 1 | erreur `MONGOD_BINARY is missing, not executable, invalid, or not MongoDB 8.2.6…` |

Les deux sondes d’audit ont été supprimées après exécution ; aucun test temporaire n’est conservé. La qualification a émis un avertissement Embedded Postgres de terminaison synchrone sur stderr, sans échec.

Le workflow GitHub est ajouté mais **n’a pas été exécuté sur GitHub**. Les validations ci-dessus sont locales.

## 4. Matrice des opérations sensibles examinées

| Opération / contrôle | Code principal (lignes) | Observations et couverture locale |
|---|---|---|
| Authentification API, contrôle permission grossier, idempotence | `src/core/routes.ts:74-120,124-164`; `src/modules/identity/authenticate.ts`; `src/modules/identity/jwt.ts` | Authentification/contrôle de permission avant handler ; l’idempotence persiste les réponses <500 et libère la clé en erreur. `auth-money`, `identity`, `routes-coverage` et qualification locale. Le défaut d’atomicité décrit ci-dessous reste. |
| RBAC, scopes et accès utilisateur | `src/modules/access/authorization.ts`; `src/modules/access/access.service.ts:79-127,132-190,194-227`; `src/modules/access/access.routes.ts` | Attribution/refus anti-escalade et révocation conservée en transaction ; suspension de plateforme / compte journalisée. Couverture existante RBAC et audit. |
| Défense PostgreSQL `anon`/`authenticated` | `supabase/migrations/20261119000700_rls_policies.sql`; `tests/rls.test.ts:1-108` | Tests locaux vérifient RLS sur tables, privilèges et politiques propriétaire sous `authenticated`. Cela ne prouve pas le rôle/configuration effective du pool API ni la configuration Supabase distante. |
| Fiche client / B-29 | `src/modules/canada/structure.routes.ts:227-265` (`PATCH`, rattachement) et `clientResource` | Test exploratoire : administrateur CN relié par l’origine d’un colis écrit ; admin CM sans lien reçoit 403 et les notes restent inchangées. G-7 en suspens. |
| Création, pesée et transitions de colis | `src/modules/canada/parcels/parcel.service.ts:55-111,114-159,162-215`; `parcel.routes.ts:108-129`; `common.ts:23-37` | Création impose agence d’origine et entrepôt de la même agence (service:73-80). Transition et pesée confirment une divergence de validation de l’entrepôt fourni (constat #2). Tests négatifs de scope et sonde locale. |
| Expéditions, départ/arrivée/annulation | `src/modules/canada/shipments/shipment.service.ts:1-218` | Verrous/transactions, vérifications d’état, scope origine/destination, événements/audit et outbox dans la transaction pour départ ; couvert par scénarios logistiques. |
| Vols, publication, affectations et annulation | `src/modules/canada/flights/flight.service.ts:1-329` | Scope pays de départ/arrivée, transitions, verrou, version publiée, annulation et libération des expéditions ; tests logistiques. Aucun test de recette fournisseur réel. |
| Encaissement, annulation de paiement et remboursement | `src/modules/canada/finance/payment.service.ts:30-110,113-162` | Transactions, scope agence, interdiction auto-confirmation, reçu, bornes de solde, séparation demande/approbation/exécution ; tests `logistics` et `rbac-audit`. Prestataire externe non retenu/non testé. |
| Documents / stockage privé | `src/modules/canada/documents.routes.ts`; `src/integrations/storage.ts` | Auth, scope, validation contenu et URL temporaire examinés. La confidentialité du bucket réel et les permissions Supabase restent à recette réelle. |
| Événements / notifications | `src/core/outbox.ts`; `src/modules/notifications/worker.ts`; migrations `20261119000600_shared_events_notifications.sql` et `20261119000700_rls_policies.sql` | Outbox écrite dans la transaction métier pour plusieurs services, mais la création de demande client est une exception non atomique (#1). Test local par trigger de panne ci-dessous. |
| Demande client et idempotence en échec | `src/modules/canada/client.routes.ts:137-153`; `src/core/routes.ts:105-120` | Sonde locale injectant un trigger qui fait échouer `shared.outbox_events` pour `canada.request.created`. Deux POST avec même utilisateur/clé retournent 500 ; les demandes passent de `n` à `n+1`, puis `n+2`. Démonstration de doublons possibles sur retries. |

## 5. Anomalies, preuves et suites attendues

### SEC-01 — Demande persistée malgré l’échec de l’outbox, puis doublonnée au retry — important

**Faits vérifiés.** `POST /me/requests` insère dans `canada.requests` avec `db`, puis appelle `emit(db, …)` séparément (`src/modules/canada/client.routes.ts:144-151`). Le handler n’enveloppe pas ces deux écritures dans une même transaction. L’idempotence supprime la clé sur exception / réponse 5xx (`src/core/routes.ts:105-120`), ce qui permet une nouvelle exécution. Une sonde locale a installé un trigger temporaire qui lève `P0001` lors de l’insertion `canada.request.created`. Premier appel : 500 et une demande reste créée ; second appel, même clé : 500 et une seconde demande est créée. Les deux lignes et l’effet ont été observés dans la base de test isolée.

**Risque.** Le client croit à un échec et réessaie ; les demandes opérationnelles se multiplient, tandis que les notifications associées ne sont pas émises. Même classe de risque pour toute autre route combinant écriture métier hors transaction et effet secondaire susceptible d’échouer.

**Correction à autoriser séparément.** Envelopper écriture métier, événement outbox et audit pertinent dans une transaction commune ; définir le traitement idempotent des erreurs après commit et empêcher le retry de créer une nouvelle ressource.

**Tests d’acceptation.** Injecter l’échec outbox et vérifier que la demande n’est pas partiellement persistée ; réessayer avec la même clé et obtenir une seule ressource ; vérifier le replay après succès et l’absence de double événement.

### SEC-02 — `warehouse_id` fourni non lié à l’agence autorisée — important, validation métier à confirmer

**Faits vérifiés.** La création d’un colis vérifie bien que l’entrepôt est actif et appartient à l’agence d’origine (`parcel.service.ts:77-80`). En revanche, `measureParcel` prend `input.warehouse_id` et l’insère directement comme `parcel_measurements.warehouse_id` sans recherche ni assertion d’agence/pays sur l’entrepôt (`parcel.service.ts:184-197`). Pour une transition, la vérification compare seulement le pays attendu et l’entrepôt actif ; le scope est calculé avant le changement sur le colis et son entrepôt courant (`parcel.service.ts:127-143`). Une sonde locale a confirmé l’acceptation d’un entrepôt d’une autre agence du même pays pour l’agent du scénario d’origine.

**Risque.** Attribution erronée des événements/mesures à un site hors de l’agence responsable ; contournement des limites de séparation opérationnelle si l’agence d’entrepôt est un contrôle d’accès voulu. La mesure peut accepter un identifiant d’entrepôt sans toute vérification applicative ; les seules contraintes SQL effectives n’ont pas été démontrées comme remplaçant ce contrôle.

**Correction à autoriser séparément.** Pour chaque `warehouse_id` cible, charger l’entrepôt actif et appliquer les mêmes règles agence/pays/scope que l’opération demande ; décider si le scope d’entrepôt doit être égal à l’agence d’origine ou seulement au pays. Revalider les ressources dans la transaction.

**Tests d’acceptation.** Entrepôt autorisé accepté ; entrepôt inactif/inconnu, d’un autre pays et d’une autre agence interdite selon la règle validée ; les cas refusés ne changent ni colis, mesure ni historique/audit. Ajouter des tests par profil agent/manager/admin et par pesée/transition.

### B-29 — Écriture de la fiche client via le lien indirect d’un colis — arbitrage G-7

**Faits vérifiés.** `clientResource` inclut les pays/agences du client ainsi que les origines/destinations des colis associés. Le `PATCH /canada/clients/:id` vérifie `canada.clients.manage` sur cette ressource complète avant d’appliquer n’importe quel champ (`structure.routes.ts:227-248`). La sonde : admin du pays sans lien → HTTP 403 et `notes` inchangées ; admin du pays d’origine d’un colis du client → HTTP 200 et `notes` changées.

**Ce qui n’est pas établi.** Aucun document/essai ne tranche si un administrateur d’origine ou destination doit pouvoir modifier toute la fiche client, notamment résidence, statut, coordonnées ou notes. L’existence d’un lien logistique ne vaut pas décision d’autorisation.

**Statut.** Non corrigé. `docs/AUDIT.md` l’indique comme arbitrage G-7 ; ne pas restreindre ou élargir avant décision explicite.

**Tests d’acceptation après décision.** Isoler les champs autorisés par rôle/scope ; tester autorisé, hors périmètre, chaque champ sensible et refus sans effet de bord. Si le partage d’une fiche entière est autorisé, valider explicitement les conséquences sur statut, rattachement et données personnelles.

### SEC-04 — Le rôle PostgreSQL effectif de l’API reste à prouver avant préproduction

**Faits vérifiés.** `src/core/db.ts` crée le pool sur `DATABASE_URL` sans contrôle explicite au démarrage de `current_user`, `rolsuper` ou `rolbypassrls`. `tests/rls.test.ts` vérifie l’isolement pour `anon`/`authenticated` et les privilèges de ces rôles sur la base locale migrée. La politique SQL décrit le rôle serveur comme point de passage backend.

**Limite.** Ces éléments ne démontrent pas l’identité/privilèges du rôle utilisé par le pool API en préproduction ou production, ni l’état actuel du projet Supabase. Pas d’accès distant utilisé dans cette mission.

**Blocage de recette.** Sur le projet de préproduction, relever sans secret le nom/attributs du rôle API (`rolsuper`, `rolbypassrls`), ses droits sur schémas/tables/séquences/fonctions, les schémas exposés à la Data API et les résultats effectifs des tests d’accès propriétaire/hors-propriétaire. Ne jamais communiquer la chaîne de connexion.

## 6. Conclusion B-29

**Résultat comportemental :** la règle implémentée accorde `clients.manage` au scope de ressource composite client + colis, donc un admin du pays d’origine d’un colis peut modifier la fiche entière. Hors-lien, refus 403 sans mutation.

**Conclusion métier :** indéterminée. G-7 doit être validé par le propriétaire fonctionnel/sécurité. L’audit ne transforme pas l’essai réussi en approbation, et aucun correctif métier n’a été fait.

## 7. Reprise PostgreSQL historique `public` → nouveaux schémas

Aucun transfert, copie, `db push`, import ou suppression n’a été exécuté. Les tests de migration existants portent sur une source MongoDB de synthèse et ne prouvent ni ne définissent un transfert de données historiques PostgreSQL du schéma `public`.

### Données indispensables avant conception du mapping

Ne pas supposer les tables, volumes, relations, clés, doublons, formats ou correspondances. Demander, depuis une copie/export **expurgé** et en lecture seule :

1. DDL/structure des objets `public` concernés (tables, vues, séquences, contraintes, index, triggers, fonctions), sans données personnelles ni secrets.
2. Comptages agrégés par table, plages de dates et volumes de pièces jointes/objets Storage.
3. Inventaire anonymisé des relations/valeurs distinctes utiles (statuts, pays/devise, rôle, valeurs nulles/orphelines), avec exemples pseudonymisés uniquement si indispensables.
4. Version applicative/schema historique, règles de production et intégrations qui écrivent encore dans `public`, politiques RLS/grants et contraintes légales de conservation.
5. Identifiants de correspondance entre ancien et nouveau modèle, conflits attendus, propriétaire fonctionnel de chaque table et décision pour chaque catégorie inconnue.

### Plan requis avant toute exécution

- Construire une matrice source → cible validée et une stratégie d’identifiants stables/rejouables.
- Exécuter d’abord une analyse à blanc sur copie restaurée isolée ; produire rapport d’orphelins, collisions, conversions/rejets et comptages de rapprochement.
- Définir invariants/comptages pré et post transfert, essais de répétition idempotente, rapprochement financier et vérification d’historiques/fichiers.
- Obtenir sauvegarde/restauration testée, fenêtre de gel ou stratégie delta, plan de bascule et rollback documenté ; valider qui autorise l’application.
- Ne pas supprimer/modifier `public` tant que transfert, rapprochement, validation métier, restauration testée et rétention ne sont pas signés.

## 8. Vérifications Supabase de préproduction restantes

Les contrôles ci-dessous sont **à exécuter en préproduction**, et non des faits établis dans cet audit :

- Créer/identifier un projet distinct de la production ; vérifier backups/PITR et capacité de restauration.
- Examiner les migrations datées et leurs dépendances ; confirmer que `public` reste intact. Appliquer seulement après revue et autorisation, jamais dans cette mission.
- Vérifier schémas exposés Data API, RLS, droits `anon`/`authenticated` et rôle effectif `DATABASE_URL` côté API.
- Configurer Auth réel : confirmation d’email, liens, réinitialisation, JWKS/issuer/audience, MFA/TOTP, sessions et révocation ; exécuter `npm run recette:supabase` avec variables conservées hors logs/rapport.
- Vérifier le bucket `canada-documents` privé, les politiques Storage, URLs signées et cas refusés.
- Tester délivrance/révocation effective d’accès, rôles expirés, invitation, MFA et absence d’accès après révocation sur la vraie intégration.
- Tester Resend réel et webhook signé/rejoué ; vérifier retries/échec d’outbox et alertes/monitoring.
- Exécuter la qualification d’abord sur copie préproduction vide puis les essais de reprise sur copie de données anonymisées ; comparer données, relations, compteurs et effets.
- Contrôler logs sans secrets, alertes, sauvegardes, fenêtre de bascule/retour arrière et feu vert métier/sécurité.

## 9. État Git final

- Branche : `main` ; HEAD inchangé au commit initial `3ad04f74d7e833544adfcb20ee5263b539d908df`.
- Changés : `README.md`, `docs/AUDIT.md`, `package-lock.json`, `package.json`, `tests/legacy-migration.test.ts`.
- Non suivis : `.github/workflows/ci.yml`, `.nvmrc`.
- `git diff --check` : code 0.
- Aucun commit ni push. Le rapport présent est un nouveau fichier non suivi jusqu’à ajout Git ; aucun fichier de sonde temporaire ne subsiste.

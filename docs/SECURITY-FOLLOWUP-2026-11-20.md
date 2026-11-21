# Suivi d’audit local — SEC-01 / SEC-02

**Date : 20 novembre 2026** · **Portée : corrections backend locales autorisées, sans changement de schéma ni accès distant.**  
Ce suivi complète `docs/SECURITY-AUDIT-2026-11-20.md`, qui conserve l’état et les preuves avant correction. Le fichier `docs/B29-MATRIX-TO-ARBITRATE.md` prépare G-7 sans le décider.

## 1. Décision et résultat

- **SEC-01 : corrigé localement** sur les créations de demandes client et public ; l’idempotence atomique est activée uniquement pour `POST /me/requests`, sans réécrire le wrapper global.
- **SEC-02 : corrigé localement dans les contrôles fournis par les routes pesée/transition.** Les droits sur la cible sont vérifiés indépendamment du colis et le mouvement inter-agences n’est pas implicite dans un statut.
- **Tests de non-régression permanents ajoutés :** `tests/idempotency-atomicity.test.ts` (9), `tests/parcel-warehouse-scope.test.ts` (7), `tests/audit-atomicity.test.ts` (4). Total final **173 tests / 17 fichiers**.
- **B-29 reste ouvert :** matrice préparée, aucune règle métier modifiée.
- **Préproduction :** aucun accès distant, migration, transfert, rôle ou grant modifié. Le rôle PostgreSQL effectif est à établir en préproduction avec les diagnostics de `docs/PREPROD-DB-ROLE-DIAGNOSTICS.sql`.

## 2. SEC-01 — transaction commune et idempotence durable, limitée à la route

### Mise en œuvre

- `src/modules/canada/request.service.ts` centralise la création de demandes client/public et l’écriture correspondante de l’événement outbox sur **le Db fourni par l’appelant**.
- `src/modules/canada/client.routes.ts` :
  - `POST /me/requests` déclare `atomicIdempotency: true` et utilise obligatoirement la transaction partagée.
  - `POST /public/requests` enveloppe création + outbox dans `withTransaction`.
- `src/core/routes.ts` : le nouveau chemin atomique, activé seulement par cette route, écrit dans une seule transaction PostgreSQL :
  1. réservation unique de la clé (`UNIQUE(principal_id,idempotency_key)` existant) ;
  2. demande métier et événement outbox ;
  3. réponse/id du résultat marqué `completed`.
- Le résultat et la demande ne sont donc visibles qu’ensemble. Sur échec avant commit, la réservation et les deux écritures sont rollbackées. Si la réponse de commit est incertaine, une nouvelle tentative rencontre soit le résultat completed et le rejoue, soit aucune réservation et peut refaire l’opération ; le résultat métier n’est pas créé deux fois.
- Les appels concurrents identiques attendent la contrainte unique, puis rejouent la réponse commitée. Même clé avec empreinte différente → conflit explicite `IDEMPOTENCY_KEY_REUSED`. Une ligne `in_progress` legacy/ambiguë n’est pas silencieusement réexécutée par ce chemin ; elle renvoie un conflit à réconcilier.
- **Clé globale :** la contrainte existante est `UNIQUE(principal_id,idempotency_key)`, sans partition route/méthode. Réutiliser la même clé par le même principal sur une autre méthode ou route rencontre donc la même ligne et renvoie un conflit, jamais le résultat d’une route différente. Les tests injectent des réservations simulant `PUT` sur le même chemin et `POST` sur un autre chemin.
- **Empreinte :** SHA-256 de `routeKey | params | body`; `routeKey` contient `req.method` et `req.baseUrl + req.route.path`. `stableStringify` trie récursivement les clés des objets JSON et conserve l’ordre des tableaux. Les paramètres de query et les headers ne font pas partie de l’empreinte ; pour `POST /me/requests`, ils ne déterminent pas le résultat métier. La comparaison se fait sur le JSON brut reçu, après validation réussie du schéma ; omettre un défaut Zod et l’envoyer explicitement peut donc produire deux empreintes distinctes même si la valeur métier par défaut coïncide.
- **Autorisation avant rejeu :** dans `mount`, authentification, accès Canada et `anyPermission` sont des middleware précédant le handler qui appelle `withIdempotency`. La validation Zod précède également le rejeu. Test : après création, l’accès plateforme est suspendu ; le même POST/key renvoie 403 sans `Idempotent-Replayed`; après réactivation, il rejoue la ressource commitée.
- **Conservation/expiration :** la table donne par défaut `expires_at = now() + 24 hours`. Le chemin atomique conserve le résultat completed jusque-là ; il efface une ligne completed expirée avant de permettre une nouvelle exécution. Le worker purge aussi les clés expirées. Les lignes `in_progress` anciennes/ambiguës ne sont pas récupérées par ce handler via son ancien délai de 5 minutes : elles renvoient un conflit ; une purge globale après leur expiry peut les supprimer. Le test vérifie la conservation avant expiry et le comportement explicite au-delà : le même key peut alors créer une nouvelle demande. **La fenêtre de non-duplication garantie est donc 24 h, pas une déduplication perpétuelle.**
- Les mécanismes existants pour les autres routes idempotentes n’ont pas été réécrits. `tests/support/harness.ts` expose l’application pour simuler un client TCP qui coupe le corps de réponse après le commit.

### Tests permanents

`tests/idempotency-atomicity.test.ts` (**9 tests**) vérifie :

1. échec outbox injecté → aucune demande/outbox/clé partielle ; retry après retrait du trigger → une demande et un événement ;
2. replay réussi → même ressource, pas de nouvel événement ;
3. appels simultanés avec même clé → une seule demande, réponses identiques ;
4. même clé avec un autre payload → 422 et aucune nouvelle écriture ;
5. déconnexion TCP après démarrage de la réponse 201 (commit effectué) → retry rejoue la ressource, sans second insert ;
6. ordre différent des clés d’un objet JSON → même empreinte/replay ;
7. collision d’une clé du même principal avec autre méthode ou autre route → 422, aucune exécution de la seconde action ;
8. suspension de l’accès Canada entre premier appel et replay → 403 avant accès au résultat ; réactivation → replay ;
9. ligne completed et réponse conservées avant expiry ; après expiry forcée à des fins de test, la clé peut être réutilisée et une nouvelle demande est créée, ce qui borne explicitement la garantie à 24 h.

La simulation post-commit détruit la réponse après les en-têtes réseau, puis refait réellement le POST ; ce n’est pas seulement une seconde lecture de la réponse gardée en mémoire.

### Audit des autres handlers à écritures successives

| Handler / chemin | État à la fin de ce lot |
|---|---|
| `POST /me/requests` : demande puis outbox | Corrigé : service applicatif et transaction commune outbox + clé idempotente + réponse |
| `POST /public/requests` : demande, relecture d’id, puis outbox | Corrigé : insert avec `RETURNING id`, demande + outbox transactionnelles. La route publique n’exige pas de clé idempotente ; des soumissions volontairement répétées restent des soumissions distinctes. Aucun contrat de clé publique n’a été ajouté. |
| `POST /canada/countries`, `/airlines`, `/airports`, création d’entrepôt : mutation puis audit | Corrigé : mutation + audit dans `withTransaction` (`src/modules/canada/structure.routes.ts`). Test injectant l’échec d’audit d’un catalogue : aucune compagnie partiellement créée (`tests/audit-atomicity.test.ts`). |
| `POST /canada/requests/:id/status` : update puis audit | Corrigé : lecture `FOR UPDATE`, update et audit même transaction. Couvert par les tests de parcours structurels ; aucun trigger d’échec spécifique ajouté ici. |
| `POST /access/invitations/:id/revoke` : update puis `audit.access_changes` | Corrigé : verrou, mutation et audit même transaction ; aucun audit de révocation n’est créé si aucune invitation pending n’a été modifiée. **Test dédié** : trigger d’audit échoue, invitation reste pending et l’audit absent ; retry après retrait du trigger révoque et trace. |
| Confirmation/rejet d’upload document : update puis audit, puis éventuellement 422 | Corrigé : update conditionnel + audit même transaction ; le statut « rejected » et sa trace sont commités avant la réponse métier 422, comme voulu. Lecture Supabase Storage externe reste hors transaction DB. **Test dédié** : trigger d’audit échoue, le document reste `pending_upload`/sans `stored_size` ; retry réussit. |
| Préférences de notifications : série d’upserts dans une boucle | Corrigé : tous les upserts et la lecture de résultat partagent une transaction, évitant un sous-ensemble appliqué. **Test dédié** : échec injecté au second upsert laisse zéro préférence du lot ; retry écrit les deux. |
| Exports d’audit/financiers, téléchargement document : lecture ou URL signée puis audit de consultation | Conservé : aucune mutation métier à rollbacker ; l’audit de lecture reste une écriture distincte. Les pannes de service d’audit peuvent rendre l’appel en erreur après la lecture ou la génération d’URL, mais ne créent pas d’écriture métier partielle. |
| Paiements, remboursements, devis, colis, expéditions, vols, support, annonces | Audit des appels `emit()` : aucun `emit(db, …)`/écriture outbox indépendante restant repéré ; les événements métier listés sont écrits avec `tx`. |
| Appareil client (enregistrement/révocation) et adresse client (suppression) | Mutation ponctuelle sans événement outbox/audit associé repéré ; non modifiée ici. À réexaminer si la politique d’audit exige une trace de sécurité spécifique. |

La route publique reste non idempotente : l’outbox est atomique avec sa demande, mais si un demandeur public renvoie volontairement le formulaire une seconde fois, il crée une nouvelle demande car aucune clé de requête n’est dans son contrat. C’est distinct du défaut SEC-01 et reste à décision produit si une déduplication publique est souhaitée.

## 3. SEC-02 — autorisation des entrepôts cibles

### Règles implémentées sans élargissement

`src/modules/canada/parcels/parcel.service.ts` ajoute `loadWarehouseTarget` : la cible doit exister, être active, être géographiquement cohérente et l’acteur doit détenir la permission au scope **pays/agence/entrepôt cible**. La ligne est lue `FOR SHARE` dans la transaction ; le colis est déjà verrouillé pour l’opération, et l’entrepôt courant est également verrouillé lors du contrôle de mouvement.

- **Pesée :** le périmètre du colis continue d’être vérifié ; le site de pesée est vérifié en plus. Un agent à plusieurs agences peut enregistrer une mesure dans un entrepôt où il détient réellement l’accès. Une mesure ne change pas `parcels.current_warehouse_id` ; le site enregistré est la localisation de la pesée.
- **Phase origine :** entrepôt dans le pays d’origine et agence d’origine ; pas de changement d’agence par transition d’origine.
- **Phase destination :** entrepôt dans le pays de destination et, lorsqu’elle existe, agence de destination déclarée. La réception physique à destination par un agent destination est testée et reste autorisée ; la transition de destination constitue le changement de phase explicite.
- **Phase `any`/exception :** l’entrepôt reste dans le pays du colis ; la transition ne peut pas déplacer l’objet vers une autre agence. S’il n’y a pas d’entrepôt courant, la première cible doit appartenir à une agence d’origine ou de destination.
- Il n’existe pas de route dédiée de transfert inter-agences dans le module colis. Une cible qui impliquerait un tel mouvement est refusée avec `WAREHOUSE_TRANSFER_REQUIRED` plutôt que d’en faire un effet implicite de pesée ou de statut. Un vrai transfert inter-agences reste à spécifier avant ajout.

### Tableau opérationnel des entrepôts

| Opération / transition | Pays accepté pour la cible | Relation d’agence exigée | Permission sur le colis et la cible | Effet sur `current_warehouse_id` |
|---|---|---|---|---|
| Création de colis | Origine | Entrepôt actif de l’agence d’origine | Permission création/réception appliquée au scope d’origine | Initialise la localisation à l’entrepôt fourni |
| Pesée `received` / `inspected` | Origine | Aucune égalité d’agence imposée pour la **localisation de pesée** ; l’acteur doit avoir `parcels.weigh` sur l’agence/entrepôt de pesée | Scope d’origine du colis **et** scope de l’entrepôt cible ; `parcels.measure` au site si dimensions présentes | Inchangé ; le site est enregistré dans mesure/événement |
| Pesée `received_destination` | Destination | Localisation dans le pays de destination ; cible doit être dans le scope réel de l’acteur | Scope destination du colis **et** scope de l’entrepôt cible | Inchangé |
| Pesée `on_hold` / `damaged` | Pays d’origine ou destination du colis | Localisation de pesée avec autorisation sur la cible ; aucune affectation de stock n’est modifiée | Scope de ressource du colis **et** scope de l’entrepôt cible | Inchangé |
| Transition `phase=origin` (p. ex. réception/inspection/prêt) | Origine | Agence d’origine déclarée ; si un entrepôt courant existe, l’agence ne change pas par cette transition | Permission de la transition sur le scope origine **et** permission de cette transition sur la cible | Peut conserver ou initialiser la cible ; un transfert inter-agence est refusé |
| Transition `phase=destination` (dont `arrived_destination → received_destination`) | Destination | Agence de destination déclarée si renseignée ; l’étape explicite de destination autorise la prise en charge par cette agence | Permission de la transition sur le scope destination **et** permission de cette transition sur la cible | Met à jour la localisation à la destination |
| Transition `phase=any` (exception) | Origine ou destination | Agence de l’entrepôt courant ; si aucune localisation n’existe, une agence d’origine ou de destination | Permission exception sur la ressource complète **et** permission sur la cible | Ne permet pas de déplacer le colis entre agences |

Une cible omise réutilise la localisation courante et, si elle existe, la revalide (active, pays/scope). Le colis est chargé `FOR UPDATE`, la cible `FOR SHARE` dans la transaction. **Il n’existe pas d’opération de transfert inter-agences dans le module colis** : les changements inter-agences hors étape de destination sont refusés `WAREHOUSE_TRANSFER_REQUIRED`, à arbitrer avant toute route explicite de transfert.

### Tests permanents

`tests/parcel-warehouse-scope.test.ts` (**7 tests**) : cible autorisée, cible inconnue, suspendue, mauvais pays, hors périmètre, absence d’effets métier en cas de refus, transition inter-agence refusée, mesure par acteur explicitement multi-scope et réception destination légitime. Les snapshots vérifient statut, entrepôt courant, version colis, mesures et événements. Les journaux d’erreur de test qui correspondent aux triggers injectés sont attendus ; un refus d’accès peut, à l’avenir, recevoir un événement de sécurité sans mutation métier.

## 4. B-29 et rôle PostgreSQL

- `docs/B29-MATRIX-TO-ARBITRATE.md` distingue nom/prénom, coordonnées, résidence, agence, statut, notes et rattachement compte ; il liste propriétaire fonctionnel, rôle, périmètre et conséquences à décider. Toutes les propositions restent **non approuvées**. Aucun changement B-29 n’a été fait.
- `docs/PREPROD-DB-ROLE-DIAGNOSTICS.sql` prépare uniquement des requêtes SELECT sur l’utilisateur effectif, attributs de rôle, privilèges, exposition PostgREST, RLS et fonctions. Elles n’ont pas été exécutées. Aucun rôle/grant n’a été modifié.

## 5. Validation finale locale

Exécution de la chaîne après les dernières modifications, avec Node `v22.23.5` et `MONGOD_BINARY=/home/user/.cache/mongodb-binaries/mongod-x64-debian-8.2.6` :

| Commande | Code de sortie | Résultat |
|---|---:|---|
| `npm run typecheck` | 0 | sources et tests |
| `npm run build` | 0 | production build |
| `npm test` | 0 | **17 fichiers, 173/173 tests** |
| `npm run qualify:local` | 0 | migrations 10/10, rejeu idempotent, référentiels, serveur compilé health 200, contrôles HTTP OK |

Dans `npm test`, deux traces `P0001` sont intentionnelles : triggers des tests vérifiant rollback sur panne outbox et audit. Le processus a aussi émis l’avertissement Embedded Postgres connu de terminaison synchrone, sans modifier le code de sortie 0.

Les échecs du run immédiatement précédent étaient le garde-fou i18n qui exige les traductions des nouveaux messages. Les neuf messages anglais ont été ajoutés à `src/i18n/en.ts` ; le run final complet après cette correction a réussi. L’ancien décompte 153/14 figurant dans les documents initiaux reste un état de mesure antérieur, non le total final.

**Qualification indépendante du livrable :** patch appliqué dans `/home/user/core-api-review-clean`, clone jetable détaché exactement au commit de base, après `npm ci` sous Node `v22.23.5` ; la chaîne complète ci-dessus a été relancée dans cette copie et a réussi : typecheck, build, **173/173 tests**, puis `qualify:local` (migrations 10/10, serveur health 200 et contrôles HTTP OK). Résultat observé le 20 novembre 2026. `npm ci` a installé 233 paquets, audit npm : 0 vulnérabilité. Les triggers `P0001` et l’avertissement Embedded Postgres sont attendus et n’ont pas changé le code de sortie 0.

Non exécuté : workflow GitHub, Supabase préproduction, migration réelle, tests Resend/Storage réels.

## 6. Diff, Git et limites restantes

- Aucun schéma/migration SQL modifié ; aucun secret ajouté.
- Aucun frontend, accès distant, transfert, `db push`, commit ou push.
- Branch `main`; HEAD inchangé `3ad04f74d7e833544adfcb20ee5263b539d908df`.
- Les deux anomalies SEC-01/SEC-02 sont testées et corrigées localement ; la règle métier B-29 et les privilèges Supabase effectifs restent non approuvés/non vérifiés.
- Le patch complet du diff final est `LOCAL-SECURITY-FOLLOWUP.patch`. L’état Git inclut explicitement rapports, matrice, diagnostics et nouveaux tests non suivis.
- `DELIVERY-MANIFEST.tsv` énumère tous les fichiers source/documentation du livrable hors manifeste et patch, avec statut et SHA-256. Vérification faite par comparaison de l’inventaire Git (modifiés **et non suivis**) aux chemins `diff --git` du patch : **aucun fichier manquant ni inattendu**.
- **Reconstruction reproductible :** depuis le clone du dépôt, `git checkout --detach 3ad04f74d7e833544adfcb20ee5263b539d908df`; puis `git apply --check /chemin/LOCAL-SECURITY-FOLLOWUP.patch` et `git apply /chemin/LOCAL-SECURITY-FOLLOWUP.patch`. Vérifier ensuite les hashes du manifeste (il exclut son propre hash et celui du conteneur patch). C’est la procédure utilisée dans le clone propre `/home/user/core-api-review-clean`; le patch est appliqué sans dépendre de l’arbre initial.
- La qualification indépendante a utilisé Node `v22.23.5`, `MONGOD_BINARY=/home/user/.cache/mongodb-binaries/mongod-x64-debian-8.2.6`, `npm ci`, puis `npm run typecheck && npm run build && npm test && npm run qualify:local` ; toutes étapes code 0. Aucun changement à B-29, aucun transfert inter-agences, accès distant, commit ou push.

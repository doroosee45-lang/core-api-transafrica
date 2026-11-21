# B-29 — matrice de champs et décision à arbitrer

**Statut : document de préparation uniquement. Aucune règle d’accès métier n’est approuvée ou modifiée ici.** Le comportement actuel du `PATCH /canada/clients/:id` prend le scope composite du client et des colis liés. La sonde locale a montré qu’un admin du pays d’origine d’un colis lié peut écrire la fiche entière ; un admin hors lien est refusé.

## 1. Champs concernés et propriétaire à confirmer

| Champ / opération | Donnée actuellement enregistrée | Propriétaire fonctionnel proposé (à confirmer) | Rôles envisageables (à décider) | Périmètre à décider | Risque d’un droit large |
|---|---|---|---|---|---|
| `first_name`, `last_name` | `canada.clients` ; nom aussi recopié dans certaines opérations | Identité commune ou fiche client Canada : **à confirmer** (définir la source de vérité) | Client lui-même ; équipe de service habilitée ; admin global, selon politique | Propriétaire du compte / agence de rattachement ? pays lié au colis ? | Changement d’identité affichée dans plusieurs flux ; incohérence avec profil Auth et justificatifs |
| `email`, `phone` | `canada.clients` | Coordonnées de contact client ; propriété identité/Canada à confirmer | Client lui-même ; personnel habilité à corriger avec preuve ; admin selon besoin | `own`, agence d’attache ou pays de service ; lien colis seul insuffisant sauf décision expresse | Détournement de contact, notifications envoyées à la mauvaise personne, risque de prise de contrôle/support |
| `residence_country` | `canada.clients` | Attribut personnel / conformité ; propriétaire exact à confirmer | Client ; rôle de vérification dédié ; administration habilitée | Pays de résidence et pays d’exploitation doivent être distingués ; pays d’origine/destination d’un colis ne devrait pas implicitement suffire | Mauvaise classification, rapport ou contrôle réglementaire ; effet multi-pays |
| `home_agency_id` | `canada.clients` | Référentiel opérationnel Canada | Opérations désignées / admin ; éventuelle approbation de transfert | Agence source et agence cible ; arbitrage explicite si transfert inter-agence | Réaffectation du propriétaire opérationnel et changement des accès indirects |
| `status` (`active`, `inactive`, `blocked`) | `canada.clients` | Gouvernance de compte client / opérations | Rôle dédié, motif requis et éventuellement seconde validation | Global client vs agence/pays ; blocage doit-il s’appliquer partout ? | Blocage ou réactivation globale par une équipe ne gérant qu’un colis |
| `notes` | `canada.clients` | Notes opérationnelles internes ; classification/confidentialité à confirmer | Personnel autorisé ; potentiellement par dossier/colis plutôt que fiche globale | Agence/pays du dossier ; contenu et visibilité client à définir | Exposition inter-pays, notes sensibles, altération du contexte d’autres équipes |
| `user_id` via `POST /:id/link-account` | Relation compte ↔ fiche | Identité / rapprochement manuel | Personnel habilité avec justification ; séparation des tâches éventuelle | Autorité sur la fiche **et** le compte cible, vérification d’identité, absence de doublon | Rattachement du compte d’un tiers, accès aux opérations et informations client |

Les propriétaires ci-dessus sont des **propositions de cadrage**, pas des faits établis par le schéma. Les propriétés de données et responsabilités organisationnelles doivent être validées par le propriétaire métier et le responsable sécurité/confidentialité.

## 2. Questions pour la décision G-7

1. Le client est-il une fiche commune à toute la plateforme ou une fiche opérationnelle Canada ? Quelle table/champ est la source de vérité du nom et des coordonnées ?
2. Un pays/agence peut-il consulter un client parce qu’un colis y transite sans obtenir aucun droit d’écriture sur sa fiche ?
3. Pour chaque champ, quel rôle peut lire, modifier, bloquer, réactiver ou rattacher un compte ? Un motif et/ou une validation secondaire sont-ils requis ?
4. Le scope d’un pays lié s’applique-t-il aux deux extrémités du colis, aux colis actifs seulement, ou aussi à l’historique ?
5. Une modification d’agence/résidence/statut affecte-t-elle les autres pays ou colis déjà ouverts ? Qui arbitre un conflit ?
6. Les notes sont-elles internes, visibles au client, limitées à une équipe, ou doivent-elles déménager au niveau d’un dossier/colis ?
7. Un rattachement de compte exige-t-il un contrôle d’identité ou une notification/confirmation du compte cible ?

## 3. Options de décision (à choisir et préciser)

- **Option A — séparation stricte :** droit d’édition lié au compte client et à l’agence propriétaire ; les pays des colis ont accès lecture opérationnelle limitée. Les champs globaux sont réservés à une autorité désignée.
- **Option B — édition partagée par champ :** équipe logistique liée au colis peut modifier uniquement les champs opérationnels explicitement listés ; identité, coordonnées, résidence, statut global et rattachement ont des contrôles plus étroits.
- **Option C — accès partagé large :** pays/agences d’origine et destination peuvent modifier tous les champs ; les risques, motifs, notification inter-pays, concurrence et piste d’audit doivent être acceptés explicitement.

Aucune option n’est recommandée comme décision finale dans ce document. La préférence de sécurité provisoire est de ne pas déduire un droit d’édition complet d’un simple lien logistique, mais cela reste soumis à approbation officielle.

## 4. Cas de recette après décision

- Propriétaire du client : lecture/écriture autorisées selon matrice approuvée.
- Agence d’attache, pays d’origine et pays de destination d’un colis lié : tester **chaque champ séparément** et distinguer lecture de modification.
- Autre pays/agence sans lien : refus sans mutation métier.
- Client avec plusieurs colis, colis annulé/terminé, plusieurs pays/agences : confirmer si le droit persiste et sur quels champs.
- Rattachement du compte : acteur non habilité, compte cible déjà lié, doublon, justification absente et tentative d’auto-rattachement.
- Refus : données métier inchangées ; journaliser un événement de sécurité si la politique le prévoit, sans enregistrer de secret.
- Vérifier que la réponse n’expose aucune donnée hors du scope et que toute modification est auditée.

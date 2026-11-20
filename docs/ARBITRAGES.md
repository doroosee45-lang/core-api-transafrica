# Arbitrages demandés au propriétaire — G-1 à G-17

Rédigé le 20/11/2026. **Les recommandations ci-dessous sont des propositions techniques ; aucune n'est appliquée ni ne vaut décision.** Toute règle dépendant de D-15 reste inchangée jusqu'à validation formelle.

## Contexte commun à G-1 … G-4 (D-15, option 1 sélectionnée)

Faits vérifiés par `tests/rbac-audit.test.ts` (comportement actuel) :
- le Super Admin (`canada_administrator` @global) ne peut nommer aucun rôle portant `payments.verify` ou `refunds.*` (anti-escalade : l'acteur doit détenir chaque permission attribuée) ;
- l'administrateur exceptionnel (`canada_super_administrator`, `requires_mfa`) peut les nommer **uniquement en session AAL2** ; son rôle expire au plus tard 7 jours après attribution ; l'échéance est immuable en base ;
- toute attribution/révocation par l'API est écrite dans `audit.access_changes` (ajout seul) ;
- la révocation d'un rôle financier est possible par le Super Admin.

---

## G-1 — Portée de la limite de 7 jours

**Question.** La limite de 7 jours s'applique-t-elle seulement au rôle de l'administrateur exceptionnel (état actuel), ou aussi aux rôles financiers qu'il attribue ?

| | (a) 7 jours pour l'administrateur exceptionnel seulement | (b) 7 jours aussi pour chaque rôle financier |
|---|---|---|
| Conséquence | caissiers et agents financiers nommés sans échéance (ou avec une échéance libre) ; révocables à tout moment | chaque caissier doit être renommé chaque semaine par un administrateur exceptionnel (lui-même renouvelé chaque semaine) |
| Avantages | continuité des guichets ; charge opérationnelle faible | revue hebdomadaire forcée des accès financiers |
| Risques | un accès financier oublié reste actif (atténué par une revue périodique) | interruption d'encaissement si le renouvellement est oublié ; banalisation du rôle exceptionnel, contraire au Dossier 03 §12 (« interdiction d'utiliser ces rôles pour les opérations quotidiennes ») |
| Impact technique | aucune modification de l'échéance | `assertGrantAuthority` : échéance ≤ 7 jours obligatoire pour un rôle financier ; alerte d'expiration ; tests |

**Recommandation technique : (a)**, complétée par une revue périodique des accès financiers (rapport des attributions financières actives, déjà possible via `audit.access_changes`). Motif : (b) transforme le rôle d'exception en outil quotidien, ce que le Dossier 03 §12 interdit.

## G-2 — Amorçage du rôle exceptionnel

**Question.** Le rôle exceptionnel ne peut être attribué que par un autre administrateur exceptionnel actif. Chaque attribution expirant en 7 jours au plus, il arrivera qu'aucun ne soit actif. Qui l'amorce, et comment ?

| Option | Description | Avantages | Risques |
|---|---|---|---|
| (a) Procédure SQL manuelle documentée (état actuel, non outillé) | un DBA insère l'attribution | aucun code | journalisation non garantie (une insertion directe n'écrit pas `audit.access_changes`) ; contrôles 7 jours/justification non appliqués |
| (b) Fonction SQL d'amorçage contrôlée | `private.grant_exceptional_administrator(target, justification, expires_at, operator)` : vérifie 7 jours et justification, écrit `audit.access_changes` + `audit.security_events`, exécutable uniquement par le rôle propriétaire de la base | contrôles et journal non contournables par cette voie ; migration additive | reste une voie « hors API » réservée au DBA |
| (c) Comme (b) + double validation (deux opérateurs nommés) | la fonction exige deux identités distinctes | séparation des responsabilités (Dossier 03 §11 « second approbateur pour les rôles sensibles ») | procédure plus lourde ; désignation de deux personnes nécessaire |

**Recommandation technique : (b), ou (c) si la direction veut appliquer le Dossier 03 §11 au rôle exceptionnel.** Décisions nécessaires : qui détient l'accès DBA en production, et faut-il deux personnes.

## G-3 — L'administrateur exceptionnel peut-il exercer les opérations financières ?

**Question.** Pendant sa fenêtre de 7 jours, il détient tout le catalogue, donc `payments.verify` et `refunds.execute`. Doit-il pouvoir encaisser et rembourser, ou seulement nommer ?

| | (a) Exercer et nommer (état actuel) | (b) Nommer sans exercer |
|---|---|---|
| Conséquence | aucune modification | exception explicite à l'anti-escalade : l'administrateur exceptionnel peut attribuer des permissions financières qu'il ne peut pas exercer |
| Avantages | règle d'attribution simple et uniforme | séparation des responsabilités stricte (V-02 étendu au rôle exceptionnel) |
| Risques | une même personne peut nommer un caissier ET encaisser pendant 7 jours | complexité de la règle ; doit être limitée au seul rôle exceptionnel et testée (sinon brèche d'escalade) |
| Impact technique | — | retirer `payments.verify`, `payments.reconcile`, `refunds.approve`, `refunds.execute` du rôle exceptionnel (seed) ; dans `assertGrantAuthority`, accepter ces permissions manquantes UNIQUEMENT pour un acteur exceptionnel et un rôle financier (G-4) ; tests négatifs |

**Recommandation technique : (b)**, conforme à l'esprit de V-02 et du Dossier 03 §12, à condition que l'exception soit strictement bornée (acteur exceptionnel + rôle financier défini en G-4) et testée. Contradiction documentaire associée : C-09.

## G-4 — Définition technique d'un « rôle financier »

**Question.** Quels rôles tombent sous la procédure exceptionnelle, y compris les rôles personnalisés ?

Proposition : **est financier tout rôle (système ou personnalisé) contenant au moins une des permissions** `canada.payments.verify`, `canada.payments.reconcile`, `canada.refunds.request`, `canada.refunds.approve`, `canada.refunds.execute`.

| Point | Analyse |
|---|---|
| Avantage | définition calculée depuis le catalogue (pas de liste de noms à maintenir) ; couvre « caissier ou équivalent » automatiquement |
| `refunds.request` inclus ? | Inclure : demander un remboursement engage des fonds. Exclure : un agent de support pourrait initier une demande sans procédure exceptionnelle. **À trancher.** |
| `payments.create` inclus ? | Non proposé : créer une obligation ne déplace pas de fonds (le Super Admin la détient déjà, V-02). |
| Rôles personnalisés | la définition s'applique aussi à la **modification** d'un rôle (déjà protégée : B-1) et à la réactivation |
| Impact technique | fonction `isFinancialRole(perms)` ; utilisée par `assertGrantAuthority`, les invitations et la revue des accès ; tests sur rôle système et rôle personnalisé |

**Recommandation technique :** la liste ci-dessus, `refunds.request` inclus par prudence.

## G-5 — Suspension d'un compte par l'administrateur pays

**État actuel.** Suspension du compte (effet sur Canada ET Market) et de l'accès plateforme : administration globale seulement. L'administrateur pays retire les rôles de son pays.

| | (a) Statu quo | (b) L'administrateur pays suspend l'accès **Canada** d'un utilisateur dont tous les rôles sont dans son pays | (c) L'administrateur pays suspend le **compte** |
|---|---|---|---|
| Avantage | simple ; aucune action d'un pays n'affecte un autre pays ou Market | réactivité locale (Cahier §3.3 « gérer les utilisateurs locaux ») | réactivité maximale |
| Risque | lenteur si l'administration globale est indisponible | un utilisateur multi-pays doit être exclu de la règle | un pays bloquerait l'accès Market et les autres pays : contraire à l'isolation |
| Impact | — | contrôle « tous les rôles actifs dans le pays » + tests | — |

**Recommandation technique : (a), ou (b) si la réactivité locale est requise.** (c) déconseillé.

## G-6 — Verrouillage (D-18) et déconnexion après réinitialisation (D-19)

| Point | Options | Recommandation technique |
|---|---|---|
| Seuils de verrouillage | 10 échecs / 15 min (actuel, réglable par variables d'environnement) ; plus strict : 5 / 30 min | conserver 10 / 15 min au démarrage, ajuster après mesure. Limite connue : compteurs **en mémoire** (non partagés entre instances) ; si plusieurs instances, stockage partagé à prévoir (D-13 / exploitation) |
| Après réinitialisation du mot de passe | (a) fermer seulement la session de récupération (actuel) ; (b) déconnecter **tous** les appareils | **(b)** : une réinitialisation suit souvent une compromission ; coût : reconnexion sur chaque appareil. Impact technique : `signOut(scope: "global")` dans `/auth/reset-password` + test |

## Nouvelles questions G-7 et suivantes

| ID | Question | Pourquoi elle se pose (preuve) | Recommandation technique |
|---|---|---|---|
| G-7 | Périmètre d'**écriture** d'une fiche client : aujourd'hui identique à la lecture (pays/agence de rattachement **et** pays d'origine/destination de ses colis). Un administrateur chinois peut donc modifier le statut ou l'e-mail d'un client résidant en RDC qui a expédié depuis la Chine. | `structure.routes.ts` `clientResource` ; constaté par `routes-coverage.test.ts` | écriture (statut, coordonnées, rattachement) réservée au pays/agence de rattachement ; lecture inchangée |
| G-8 | « Live Tracking … uniquement dans le périmètre mobile » (Doc. de référence §8.1, critère AC-10 ; Cahier §7.1 « destinée à l'expérience client mobile ») alors que la Migration §10.1 prévoit le « Tracking » dans l'espace client **web**. | le backend ne peut pas distinguer de façon fiable un client web d'un client mobile | ne pas restreindre côté backend (aucune garantie possible) ; si besoin, restriction d'affichage côté applications |
| G-9 | « Personnes autorisées du processus de passage ou de réception » / « agents de passage » (Doc. de référence §8.1, §8.3) : quel rôle ? | absent du catalogue ; l'ancien rôle « chauffeur » est repris comme `canada_agent` (D-10) | rôle complémentaire configurable (`canada_custom_*`, périmètre agence) plutôt qu'un nouveau rôle système |
| G-10 | « Revenus consolidés » (Cahier §12.1) : devise de référence et règle de taux (date de l'opération ou date du rapport) ? | aujourd'hui : montants par devise, jamais convertis | conversion à la date de chaque encaissement, taux historisé, devise de référence choisie par la direction |
| G-11 | « Performance des agences » (Cahier §12.1) : quels indicateurs ? | aucune définition | à définir (délais de traitement, volumes, anomalies) |
| G-12 | « Colis en anomalie » : quels statuts ? | `on_hold`, `damaged`, `lost`, `returned` existent ; aucun regroupement défini | `on_hold`, `damaged`, `lost` |
| G-13 | Factures et reçus : obligations légales par pays (numérotation, mentions, taxes), format | aucune spécification | décision juridique/comptable préalable |
| G-14 | Transporteurs : modèle (compagnie aérienne, transitaire, livreur ?), attributs, lien avec les expéditions | Cahier Module 7, §14.3 « carriers » ; non modélisé | spécification avant développement |
| G-15 | Horaires et capacités d'agence, inventaire d'entrepôt : format, unités (kg, m³, colis), comportement en cas de dépassement (blocage ou alerte), fréquence d'inventaire | Spéc. backend §9 : « règles à ajouter lorsque les besoins seront validés » | spécification avant développement |
| G-16 | Module 3 : quels champs un administrateur peut-il modifier sur le profil d'un autre utilisateur ; « réinitialisation des accès » = envoi d'un lien de réinitialisation ? | non spécifié | lien de réinitialisation déclenché par l'administrateur (sans voir le mot de passe), journalisé |
| G-17 | Temps réel (D-13) : quels écrans, quels événements, WebSocket ou SSE ? | Cahier §13.6, Spéc. backend §28 | SSE authentifié pour le suivi client et le centre de notifications (plus simple, compatible mobile) |

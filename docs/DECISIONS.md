# Registre des décisions — Core API (domaine Canada)

Mis à jour le 20/11/2026. Règle (Note explicative §5) : une proposition n'est jamais traitée comme une décision validée. Toutes les migrations sont additives ; le backend MERN reste en service.

Catégories : **A** approuvées et correctement appliquées · **B** approuvées mais mal appliquées (et correction) · **C** sélection du propriétaire en attente de validation formelle · **D** choix provisoires appliqués, à confirmer · **E** décisions ouvertes (aucune hypothèse codée) · **F** contradictions documentaires · **G** questions d'arbitrage.

## A. Approuvées par le propriétaire et correctement appliquées

| ID | Décision | Mise en œuvre et preuve |
|---|---|---|
| V-01 | Managers limités à leur agence. Vols créés, publiés, annulés par l'Administrateur pays et le Super Admin ; les managers associent leurs expéditions aux vols. | Rôle `canada_operations_manager` désactivé (conservé pour l'historique, n'accorde rien) ; `canada_agency_manager` au seul périmètre agence ; `canada_agent` agence/entrepôt. `features.test.ts` « Décisions RBAC du 21/11/2026 ». |
| V-02 | Super Admin : visibilité et contrôle globaux SAUF opérations financières (encaissement, approbation et exécution des remboursements). | `canada_administrator` : barèmes, taux, exports, audit ; jamais `payments.verify` / `refunds.*`. `features.test.ts`, `rbac-audit.test.ts` « V-02 — aucun chemin indirect ». Voir B-1. |
| V-03 | Français par défaut dans les 5 pays ; anglais partout ; le choix de l'utilisateur prime toujours. | `default_locale = 'fr'`, `supported_locales = {fr,en}` ; préférence du profil > `Accept-Language` > fr. `i18n.test.ts`. Voir B-2. |
| V-04 | Documents dans Supabase Storage (bucket privé, liens temporaires signés). | `src/integrations/storage.ts`, `canada.documents`. `features.test.ts` (doublure). Recette réelle : `npm run recette:supabase` (contrôle « bucket PRIVÉ »). |

## B. Approuvées mais incomplètement appliquées — corrigées le 20/11/2026

| ID | Écart | Correction | Preuve |
|---|---|---|---|
| B-1 (V-02) | Contournement possible : le Super Admin pouvait ajouter `payments.verify` / `refunds.*` à un rôle personnalisé **déjà attribué** (ou réactiver un tel rôle), donnant ces permissions à ses titulaires. | `PATCH /access/roles/:code` : toute permission ajoutée (ou rendue par réactivation) doit être détenue par l'acteur au périmètre global, sinon `PRIVILEGE_ESCALATION`. | `rbac-audit.test.ts` |
| B-2 (V-03) | Avis « devis émis » et e-mail d'invitation : date brute ISO en UTC (ni localisée, ni dans le bon fuseau). | Date localisée FR/EN avec fuseau explicite (agence émettrice ; UTC explicite pour l'invitation). | `auth-money.test.ts` |

## C. D-15 — Nomination du personnel financier : OPTION 1 SÉLECTIONNÉE, EN ATTENTE DE VALIDATION FORMELLE

**Instruction du propriétaire (20/11/2026)** : conserver exclusivement la procédure de nomination exceptionnelle par `canada_super_administrator`, avec MFA réellement vérifiée et obligatoire, justification écrite pour chaque attribution, attribution temporaire de 7 jours maximum, journalisation complète et non contournable, expiration et révocation effectives, anti-escalade et séparation des responsabilités. Rôles concernés : `canada_finance_agent`, `canada_finance_manager` et tout rôle de caissier ou équivalent. Le Super Admin ordinaire ne reçoit jamais de permission permanente `payments.verify` ou `refunds.*`.

**Statut : aucune règle d'attribution n'a été modifiée.** L'analyse ci-dessous décrit l'existant (prouvé par `rbac-audit.test.ts`), les écarts avec les conditions demandées et les modifications prêtes à appliquer après validation.

### C.1 Conditions déjà satisfaites par le code actuel

| Condition | État actuel | Preuve |
|---|---|---|
| Seul l'administrateur exceptionnel peut nommer (agent financier, responsable financier, caissier personnalisé) | ✅ par l'anti-escalade : l'acteur doit détenir chaque permission du rôle ; le Super Admin ne détient pas `payments.verify` / `refunds.*` | test « le Super Admin ne peut nommer ni agent financier… » |
| MFA réellement vérifiée | ✅ le rôle exceptionnel (`requires_mfa`) est ignoré hors session AAL2 ; en AAL1 l'attribution est refusée | test « …ne peut nommer qu'en session MFA (AAL2) » ; recette réelle MFA TOTP dans `scripts/recette-supabase.ts` |
| Attribution du rôle exceptionnel : 7 jours maximum + justification | ✅ `EXPIRY_REQUIRED`, `JUSTIFICATION_REQUIRED` | test « …pour 7 jours au plus » |
| Journalisation non contournable | ✅ `audit.access_changes` en ajout seul (trigger) ; toute attribution/révocation par l'API y est écrite dans la même transaction | test « …l'attribution est journalisée » |
| Expiration effective | ✅ échéance immuable en base (`ROLE_ASSIGNMENT_IMMUTABLE`) ; droits rechargés à chaque requête : perte immédiate à l'échéance | test « à expiration… » |
| Révocation effective | ✅ immédiate ; le Super Admin peut révoquer un rôle financier (révoquer n'exige pas la permission révoquée) | test « le Super Admin peut RÉVOQUER… » |
| Pas de permission financière permanente pour le Super Admin | ✅ y compris par rôle personnalisé (B-1) | tests V-02 |

### C.2 Écarts entre l'existant et les conditions demandées

1. **Justification de chaque nomination financière** : aujourd'hui exigée seulement pour attribuer le rôle exceptionnel lui-même, **pas** pour l'attribution d'un rôle financier par l'administrateur exceptionnel (le champ est facultatif).
2. **« Attribution temporaire de 7 jours maximum » — ambiguïté** (voir G-1) : s'applique-t-elle au rôle de l'administrateur exceptionnel (déjà le cas) ou **aussi aux rôles financiers attribués** (un caissier devrait alors être renommé tous les 7 jours) ?
3. **Amorçage du rôle exceptionnel** : il ne peut être attribué que par un autre administrateur exceptionnel actif. Comme chaque attribution expire après 7 jours, en l'absence de titulaire actif **la seule voie est une procédure SQL manuelle** (aujourd'hui décrite mais non outillée, et non journalisée automatiquement dans `audit.access_changes`). Voir G-2.
4. **Séparation des responsabilités pendant la fenêtre exceptionnelle** : l'administrateur exceptionnel détient tout le catalogue, donc aussi `payments.verify` et `refunds.execute` pendant 7 jours. L'anti-escalade *exige* qu'il les détienne pour pouvoir les attribuer. Interdire qu'il les exerce supposerait une exception à l'anti-escalade. Voir G-3.
5. **Définition de « rôle financier »** pour les rôles personnalisés : aucune n'existe dans le code. Voir G-4.

### C.3 Modifications techniques prêtes, à appliquer APRÈS validation formelle

| Zone | Modification | Migration | RLS |
|---|---|---|---|
| `access.service.ts` `assertGrantAuthority` | Rôle financier (définition G-4) : justification obligatoire (≥ 10 caractères) ; si G-1 = oui, échéance ≤ 7 jours obligatoire ; refus explicite `FINANCE_ROLE_EXCEPTIONAL_ONLY` si l'acteur n'est pas l'administrateur exceptionnel (message plus clair que `PRIVILEGE_ESCALATION`) | — | aucune |
| Invitations (`createInvitation`, `acceptInvitation`) | Même règle pour un rôle financier proposé par invitation (justification portée par l'invitation) | colonne `justification` sur `access.invitations` (additive) | aucune (table non exposée) |
| Amorçage (G-2) | Fonction `private.grant_exceptional_administrator(target, justification, expires_at, operator)` : contrôles 7 jours / justification et écriture dans `audit.access_changes` + `audit.security_events`, exécutable uniquement par le rôle propriétaire de la base | migration additive | `revoke all … from public, anon, authenticated` |
| Tests | justification manquante → refus ; échéance > 7 jours (si G-1) → refus ; invitation financière ; fonction d'amorçage journalisée ; non-régression `rbac-audit.test.ts` | — | `rls.test.ts` (fonction non exécutable par anon/authenticated) |
| Documentation | `RBAC.md` (règle de nomination), `MIGRATION-PLAN.md` (procédure d'amorçage) | — | — |

## D. Choix provisoires appliqués, à confirmer

| ID | Sujet | Choix actuel |
|---|---|---|
| D-01 | Permissions **[complément]** (dont `canada.support.*`, exigées par le Cahier Module 14) | Voir `docs/RBAC.md` |
| D-02 | Rôles sensibles (MFA, auditeur) attribuables au seul périmètre global | Appliqué |
| D-03 | Poids facturable = max(réel, volumétrique), diviseur du barème | Appliqué |
| D-04 | Pesée refusée sans barème actif | Appliqué |
| D-05 | Confirmation de paiement : encaissement au guichet uniquement ; webhooks prestataires non implémentés | Prestataires non choisis |
| D-06 | E-mail d'annonce : opt-in explicite ; notifications opérationnelles : e-mail sauf refus | Appliqué |
| D-07 | Marketplace de kilos non reprise | Décision métier |
| D-08 | Comptes migrés non vérifiés : confirmation de l'e-mail exigée | Appliqué |
| D-09 | Consentements d'alerte vol non repris | Modèle à valider |
| D-10 | Ancien admin d'agence → responsable d'agence ; chauffeur → agent | Appliqué dans la reprise |
| D-11 | Fuseau des agences reprises = fuseau du pays (Canada signalé) | Appliqué |
| D-12 | Vols historiques non repris | Ressaisie |
| D-13 | Temps réel (WebSocket) non repris | Canaux à définir |
| D-14 | Réclamation sur un colis : DESTINATION pour « livraison » et « retard », ORIGINE sinon ; sans colis, pays de résidence | Appliqué, à valider |
| D-16 | Le client modifie son e-mail de CONTACT, jamais son e-mail de connexion | Appliqué |
| D-17 | Seuls les scans physiques sont publiés comme « dernière position confirmée » ; aucun GPS (Cahier §23.4) | Appliqué |
| D-18 | Verrouillage d'un compte après 10 échecs en 15 minutes (en plus de la limite par IP) ; réglable | Appliqué, valeurs à confirmer |
| D-19 | Après réinitialisation du mot de passe, seule la session de récupération est fermée | Appliqué, à valider (option : déconnexion de tous les appareils) |
| D-20 | Montant saisi avec plus de décimales que la devise → refus `AMOUNT_PRECISION` (ISO 4217) | Appliqué |
| D-21 | Devise et fuseau par défaut des 5 pays (CA→CAD, CD→CDF, CG/CM→XAF, CN→CNY) : référentiel ISO, modifiable | Appliqué |
| D-22 | Un colis ne figure que dans un devis de son expéditeur ou de son destinataire ; une demande rattachée à un client ne sert qu'à un devis de ce client | Appliqué (même règle que la lecture « propriétaire ») |
| D-23 | Suspension d'un COMPTE (effet sur les deux plateformes) réservée à l'administration globale ; l'administrateur pays retire des rôles dans son pays | Appliqué, à confirmer (G-5) |

## E. Décisions ouvertes (Cahier §23, Spéc. backend §35) — aucune hypothèse codée
Fournisseur aéronautique, cartographie, compagnies et routes exploitées, collecte GPS, prestataire push, prestataires de paiement par pays, tarifs et règles de transport, conservation des données, volumes, correspondances et changements de vols, règles de confirmation de livraison, factures et reçus (format, numérotation légale par pays). Les fonctions concernées répondent « non configuré » ou ne sont pas exposées.

## F. Contradictions entre documents (choix provisoires, inchangés)

| ID | Contradiction | Choix provisoire |
|---|---|---|
| C-01 | « Migration progressive » (Migration) vs « développées à partir de zéro » (Spéc. identité §1) | Core API à côté de l'existant + reprise idempotente |
| C-02 | Deux backends (Doc. de référence §3.1) vs monolithe modulaire (Dossier 04) | Monolithe modulaire, schémas séparés |
| C-03 | Statuts de vol du Cahier §8.3 vs Dossier 05 §14.3 | Liste du Cahier |
| C-04 | Super Admin / Admin pays (Cahier) vs catalogue du Dossier 03 | `canada_administrator` @ global ou @ pays ; `canada_super_administrator` = bris de glace |
| C-05 | Rôles spécialisés du Cahier §3.7 absents du Dossier 03 | Résolu : rôles complémentaires configurables |
| C-06 | `access.organizations` vs `organizations.organizations` | Dossier 02 |
| C-07 | Fournisseur = utilisateur vs organisation | Hors périmètre (Market) |
| C-08 | Cahier §3.4 « le manager participe à la gestion des vols » vs V-01 | V-01 prime (décision du propriétaire) : le manager associe ses expéditions, ne crée ni ne publie |
| C-09 | Dossier 03 §12 « interdiction d'utiliser le rôle exceptionnel pour les opérations quotidiennes » vs anti-escalade (il doit détenir les permissions qu'il attribue) | Voir G-3 |

## G. Questions nécessitant votre arbitrage

Analyse détaillée (conséquences, risques, avantages, recommandation technique non décisionnelle) : **`docs/ARBITRAGES.md`**, qui ajoute G-7 à G-17 (périmètre d'écriture d'une fiche client, suivi « mobile uniquement », agents de passage, revenus consolidés, performance des agences, anomalies, factures, transporteurs, horaires/capacités/inventaire, profil d'autrui, temps réel).

| ID | Question | Conséquence de chaque réponse |
|---|---|---|
| G-1 (D-15) | La limite de 7 jours s'applique-t-elle aussi aux **rôles financiers** attribués (caissier, agent, responsable financier) ? | Oui : renouvellement hebdomadaire par un administrateur exceptionnel (charge et risque d'interruption des guichets). Non : seule la fenêtre de l'administrateur exceptionnel est limitée ; les rôles financiers peuvent être permanents ou avoir une échéance libre. |
| G-2 (D-15) | Qui exécute l'**amorçage** du rôle exceptionnel lorsqu'aucun n'est actif (procédure SQL journalisée), et faut-il deux personnes ? | Sans procédure désignée, aucune nomination financière n'est possible après expiration du dernier administrateur exceptionnel. |
| G-3 (D-15) | Pendant ses 7 jours, l'administrateur exceptionnel peut-il **exercer** l'encaissement et les remboursements, ou seulement nommer ? | Exercer : aucune modification (journalisation renforcée). Seulement nommer : exception explicite à l'anti-escalade pour les rôles financiers, limitée au rôle exceptionnel (modification de règle approuvée nécessaire). |
| G-4 (D-15) | Définition d'un « rôle financier » : tout rôle contenant au moins une permission parmi `payments.verify`, `payments.reconcile`, `refunds.request`, `refunds.approve`, `refunds.execute` ? | Détermine quels rôles personnalisés tombent sous la procédure exceptionnelle. |
| G-5 | Un administrateur pays doit-il pouvoir **suspendre un compte** de son pays (aujourd'hui : uniquement retirer ses rôles) ? | La suspension de compte agit aussi sur Market : la confier aux pays supposerait une suspension limitée à la plateforme Canada (déjà disponible au niveau global). |
| G-6 | D-18 (seuils de verrouillage) et D-19 (déconnexion de tous les appareils après réinitialisation) | Valeurs d'exploitation ; aucune autre conséquence technique. |

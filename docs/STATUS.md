# État des fonctionnalités — Core API (domaine Canada), 21/11/2026

Légende : ✅ terminé et prouvé par test automatisé (API + PostgreSQL réel) · 🟡 partiel / dépend d'une décision ou d'une recette externe · ❌ non réalisé.
Preuves (20/11/2026) : `npm run typecheck` (sources + tests) ✅ ; `npm test` → **14 fichiers, 153 tests, 0 échec** ; **145/145 routes exercées** (garde-fou `route-inventory.test.ts`) ; couverture 92,9 % des lignes, 85,7 % des instructions, 70,8 % des branches ; `npm run qualify:local` → migrations sur base vierge (10/10), rejeu idempotent, serveur compilé démarré et interrogé : 10/10 contrôles OK. Rapport détaillé : `docs/CONFORMITE.md` ; écarts et plan : `docs/PLAN-CORRECTION.md` ; arbitrages : `docs/ARBITRAGES.md` ; inventaire : `docs/ROUTES.md`. Intégration Supabase/Resend RÉELLE non encore prouvée : `npm run recette:supabase` en préproduction.

## Gouvernance, identité, accès (Cahier §3, Modules 1 et 3)

| Fonction | État | Preuve |
|---|---|---|
| 5 pays configurés (devise, fuseau, indicatif, langues) | ✅ | `structure.test.ts` |
| Super Admin global / Admin pays / Manager d'agence / Agent / Client | ✅ | `rbac.test.ts`, `features.test.ts`, `structure.test.ts` |
| Isolation pays, agence, entrepôt, propriétaire (lectures, écritures, filtres, agrégats) | ✅ | `rbac.test.ts`, `structure.test.ts` |
| Anti-escalade (auto-attribution, sous-ensemble de permissions, rôles sensibles globaux, rôle exceptionnel) | ✅ | `rbac.test.ts` |
| MFA (rôles sensibles ignorés hors AAL2) | ✅ | `rbac.test.ts` |
| Révocation immédiate, invitations à jeton haché, suspension plateforme / globale | ✅ | `rbac.test.ts`, `structure.test.ts` |
| Rôles complémentaires configurables (caissier, douane, support…) | ✅ | `features.test.ts` |
| Historique des connexions, sessions actives | ✅ | `features.test.ts` |
| Inscription commune, connexion, refresh, déconnexion, changement de mot de passe | ✅ (doublure GoTrue) / 🟡 recette Supabase réelle | `identity.test.ts`, `auth-money.test.ts` |
| Vérification d'e-mail par lien, renvoi du lien, réinitialisation du mot de passe (lien à usage unique) | ✅ (doublure GoTrue) / 🟡 modèles d'e-mail Supabase à configurer | `auth-money.test.ts` |
| Limitation des tentatives : par IP et par compte (verrouillage temporaire, D-18) | ✅ | `auth-money.test.ts` |
| Nomination du personnel financier | 🟡 voir D-15 | `features.test.ts` (refus prouvé) |

## Logistique (Modules 4 à 8, Cahier §17)

| Fonction | État | Preuve |
|---|---|---|
| Agences, entrepôts (création, modification, suspension) | ✅ | `structure.test.ts`, `features.test.ts` |
| Clients (guichet, recherche, rattachement de compte), fiche et adresses côté client | ✅ | `structure.test.ts`, `features.test.ts` |
| Colis : référence unique, machine à états, origine/destination, poids réel/volumétrique/facturable, re-pesée motivée | ✅ | `logistics.test.ts` |
| Classement, affectation à un entrepôt, scan, dernière position confirmée | ✅ | `features.test.ts` |
| Expéditions : regroupement, retrait, départ, arrivée, clôture, responsables d'étape | ✅ | `logistics.test.ts`, `features.test.ts` |
| Vols : brouillon → validé → publié, versions, notifications correctives, statuts, annulation et libération | ✅ | `logistics.test.ts` |
| Arrivée du vol ≠ réception des colis | ✅ | `logistics.test.ts` |
| QR code / code-barres | 🟡 la référence unique est fournie ; l'image est générée par le frontend/mobile | — |
| Transferts entre pays | 🟡 couverts par les expéditions internationales ; pas de module « transfert » distinct | — |
| Suivi aérien en direct (positions) | ❌ fournisseur non choisi ; seules les informations confirmées sont affichées | `logistics.test.ts` (`position: null`) |
| GPS agents / chauffeurs | ❌ décision Cahier §23.4 | — |

## Finances (Modules 12, 13)

| Fonction | État | Preuve |
|---|---|---|
| Barèmes versionnés, taux historisés, devis versionnés multi-devises | ✅ | `logistics.test.ts`, `structure.test.ts` |
| Paiements : obligations, encaissement vérifié au guichet, idempotence | ✅ | `logistics.test.ts` |
| Remboursements à double validation | ✅ | `logistics.test.ts` |
| Précision des montants par devise (refus au lieu d'arrondi silencieux), taux jusqu'à 10 décimales, jamais nuls | ✅ | `auth-money.test.ts` |
| Paiement en ligne (webhooks prestataires) | ❌ prestataires par pays non choisis | — |
| Factures / reçus PDF | ❌ non développé | — |

## Communication, support, documents, rapports

| Fonction | État | Preuve |
|---|---|---|
| Notifications opérationnelles (outbox, anti-doublon, destinataires figés à la publication) | ✅ | `logistics.test.ts` |
| Notifications dans la langue de chaque destinataire | ✅ | `i18n.test.ts` |
| E-mail Resend + statut réel de délivrance (webhook signé), rebonds → suppression | ✅ (doublure) / 🟡 recette Resend réelle | `webhooks.test.ts` |
| Push mobile | ❌ fournisseur non choisi (livraisons tracées « skipped ») | `logistics.test.ts` |
| Annonce générale distincte, opt-in, version EN facultative | ✅ | `logistics.test.ts` |
| Support et réclamations | ✅ | `features.test.ts` |
| Documents (Supabase Storage, URL signées, vérification serveur) | ✅ (doublure) / 🟡 recette Storage réelle | `features.test.ts` |
| Tableaux de bord par périmètre, audit, exports CSV | ✅ (indicateurs de base) / 🟡 tableaux détaillés du Cahier §12 | `structure.test.ts`, `features.test.ts` |

## Internationalisation

| Fonction | État | Preuve |
|---|---|---|
| FR/EN : erreurs, validations, libellés, notifications, préférences, formats, fuseaux | ✅ | `i18n.test.ts` (complétude statique + API) |
| Paramètres linguistiques par pays | ✅ | `i18n.test.ts` |
| Cohérence web / mobile | 🟡 contrat publié (`docs/I18N.md`, `GET /api/v1/i18n`) ; intégration côté applications à faire | — |

## Données et migration

| Fonction | État | Preuve |
|---|---|---|
| Schéma PostgreSQL (10 migrations), RLS, triggers d'intégrité | ✅ | toutes les suites |
| Reprise MongoDB → PostgreSQL (à blanc, idempotente, réconciliation) | ✅ (données de synthèse) / 🟡 copie réelle à analyser | `legacy-migration.test.ts` |

## Hors périmètre de ce lot
Plateforme Market et intégration Market ↔ Canada ; temps réel (WebSocket) ; migration du frontend web et de l'application mobile vers `/api/v1`.

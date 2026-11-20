# Architecture — Trans Afrique Core API (domaine Canada)

## 1. Vue d'ensemble

```
Web / Mobile ──HTTPS──▶ Core API (Express 5 + TypeScript, /api/v1)
                          │  correlation-id → en-têtes sécurité → JSON
                          │  route() : validation Zod → JWT Supabase → accès plateforme
                          │           → permission (grossière) → idempotence → service
                          │  service : périmètre précis + règles métier + audit + outbox (1 transaction)
                          ▼
                 Supabase PostgreSQL ─ schémas identity · access · organizations · shared · canada · audit · private
                          ▲
            Worker (même processus ou instance dédiée) : outbox → notifications → e-mail (Resend)
Supabase Auth : mots de passe, sessions, MFA ; le backend vérifie les JWT et charge les droits à chaque requête.
```

Monolithe modulaire (Dossier 04) : `src/modules/{identity, access, canada/*, notifications}`. Market n'est pas implémenté ; son schéma n'est pas créé (aucune table vide « pour plus tard »).

## 2. Sécurité

| Exigence | Mise en œuvre |
|---|---|
| Authentification | JWT Supabase vérifié (HS256 legacy ou JWKS asymétrique), audience, émetteur, expiration ; session vérifiée dans `auth.sessions` (déconnexion immédiate) ; e-mail vérifié obligatoire ; compte banni/suspendu refusé |
| Autorisation | `access.user_roles` avec périmètre `global/country/agency/warehouse/own` ; permissions chargées **à chaque requête** (révocation immédiate) ; refus par défaut ; permissions `global_only` |
| Origine / destination | Étapes d'origine contrôlées sur le périmètre du pays d'origine, étapes de destination sur celui de destination (Cahier §17) |
| MFA | Rôles `requires_mfa` ignorés hors session AAL2 ; désactivation interdite en production |
| Anti-escalade | Pas d'auto-attribution ; sous-ensemble de permissions ; rôles sensibles au périmètre global ; rôle exceptionnel limité à 7 jours et justifié |
| Idempotence | En-tête `Idempotency-Key` obligatoire sur les opérations sensibles ; rejeu = réponse d'origine ; clé réutilisée avec un autre corps = 422 |
| Intégrité | Historiques et journaux en ajout seul (triggers) ; pas de suppression physique des colis, expéditions, vols, paiements ; versions de devis figées |
| Défense en profondeur | RLS activée sur toutes les tables ; `anon`/`authenticated` sans droits sauf lectures « propriétaire » |
| Journalisation | `audit.audit_events` (métier), `audit.access_changes` (droits), `audit.security_events` (connexions, refus 403) ; aucun secret ni jeton journalisé |

## 3. Flux principaux implémentés
Inscription → fiche client · colis (enregistrement, pesée, transitions) · expédition (regroupement, retrait, départ, arrivée, clôture) · vol (brouillon, validation, publication versionnée, statuts opérationnels, annulation avec libération) · devis (calcul barème + taux, émission, version, acceptation) · paiement (obligation, encaissement vérifié, remboursement à double validation) · notifications (opérationnelles, correctives, annonces) · suivi client et public · rapports par périmètre · audit.

## 4. Fiabilité
- Outbox transactionnelle `shared.outbox_events` ; worker `FOR UPDATE SKIP LOCKED`, bail, reprise exponentielle, statut `failed` après 8 tentatives, traitement dans l'ordre chronologique d'un lot.
- Destinataires d'un événement de vol **figés au moment de l'événement** (`shipment_ids`), pas au traitement.
- Anti-doublon : `unique(source_event_id, user_id)` sur les notifications, `unique(notification_id, channel)` sur les livraisons.
- E-mail : « accepté par le fournisseur » ≠ « délivré » ; sans configuration → `skipped / EMAIL_NOT_CONFIGURED`.

## 5. Modules ajoutés le 21/11/2026

- **Internationalisation** (`src/i18n`) : voir `docs/I18N.md`.
- **Documents** (`canada.documents`, `src/integrations/storage.ts`) : déclaration → URL de téléversement signée (Supabase Storage, bucket privé) → confirmation serveur (taille et type réellement stockés) → lien de téléchargement de 5 minutes. Périmètre figé à la création ; refus « introuvable » hors périmètre.
- **Support** (`canada.support_tickets`, `support_messages`) : cycle de vie contrôlé, notes internes invisibles du client, affectation limitée aux agents habilités du périmètre.
- **Webhook Resend** (`POST /api/v1/webhooks/resend`, corps brut, signature Svix, fenêtre de 5 minutes, dédoublonnage `shared.inbox_events`).
- **Gouvernance** : rôles complémentaires configurables, historique des connexions, sessions.
- **Exports CSV** bornés, filtrés par périmètre, audités, neutralisation des formules.

## 6. Ce qui n'est PAS implémenté (honnêtement)
Market et intégration Market↔Canada · paiements en ligne (prestataires non choisis) · fournisseur aéronautique (positions) · GPS · push réel (fournisseur non choisi) · factures/reçus PDF · temps réel (WebSocket) · migration du frontend et du mobile vers `/api/v1`. Détail : `docs/STATUS.md`.

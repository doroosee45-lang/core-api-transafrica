# Inventaire des routes — fichier, autorisation, preuves de test

Régénéré le 20/11/2026 depuis le code (registre `route()`, 145 routes) et `tests/*.test.ts`. Le garde-fou `tests/route-inventory.test.ts` échoue si une route n'est appelée par aucun test (présence d'appel). La **pertinence** (cas refusés) est évaluée dans `VERIFICATIONS-TECHNIQUES.md` §2.

Niveau de preuve : tests exécutés contre **PostgreSQL 18 réel** ; Supabase Auth/Storage et Resend y sont des **doublures** (voir `CONFORMITE.md` §0).

| Méthode | Route (`/api/v1`) | Fichier | Auth | Permission (au moins une) | Tests qui l'appellent |
|---|---|---|---|---|---|
| GET | `/access/roles` | `src/modules/access/access.routes.ts` | canada | ["canada.roles.read"] | structure |
| GET | `/access/permissions` | `src/modules/access/access.routes.ts` | canada | ["canada.permissions.read"] | routes-coverage |
| GET | `/access/users` | `src/modules/access/access.routes.ts` | canada | ["canada.users.read"] | negative-scope, structure |
| POST | `/access/user-roles` | `src/modules/access/access.routes.ts` | canada | ["canada.users.manage_access"] | features, rbac, rbac-audit |
| POST | `/access/user-roles/:id/revoke` | `src/modules/access/access.routes.ts` | canada | ["canada.users.manage_access"] | negative-scope, rbac, rbac-audit |
| POST | `/access/invitations` | `src/modules/access/access.routes.ts` | canada | ["canada.users.manage_access"] | negative-scope, rbac, routes-coverage |
| POST | `/access/invitations/accept` | `src/modules/access/access.routes.ts` | user | ["canada.users.manage_access"] | rbac, routes-coverage |
| POST | `/access/invitations/:id/revoke` | `src/modules/access/access.routes.ts` | canada | ["canada.users.manage_access"] | routes-coverage |
| POST | `/access/users/:id/platform-access` | `src/modules/access/access.routes.ts` | canada | ["canada.users.manage_access"] | structure |
| POST | `/access/users/:id/account-status` | `src/modules/access/access.routes.ts` | canada | ["canada.users.manage_access"] | structure |
| POST | `/access/roles` | `src/modules/access/governance.routes.ts` | canada | ["canada.roles.manage"] | features, rbac-audit |
| PATCH | `/access/roles/:code` | `src/modules/access/governance.routes.ts` | canada | ["canada.roles.manage"] | features, rbac-audit |
| GET | `/access/users/:id/security-events` | `src/modules/access/governance.routes.ts` | canada | ["canada.users.read"] | features |
| GET | `/identity/me/sessions` | `src/modules/access/governance.routes.ts` | user | - | features |
| GET | `/identity/me/security-events` | `src/modules/access/governance.routes.ts` | user | - | routes-coverage |
| GET | `/me/parcels` | `src/modules/canada/client.routes.ts` | canada | ["canada.parcels.read_own"] | identity, legacy-migration |
| GET | `/me/parcels/:id/tracking` | `src/modules/canada/client.routes.ts` | canada | ["canada.tracking.read_own"] | features, i18n, logistics, rbac, routes-coverage |
| GET | `/me/quotes` | `src/modules/canada/client.routes.ts` | canada | ["canada.quotes.read_own"] | routes-coverage |
| GET | `/me/quotes/:id` | `src/modules/canada/client.routes.ts` | canada | ["canada.quotes.read_own"] | logistics |
| POST | `/me/quotes/:id/versions/:version/accept` | `src/modules/canada/client.routes.ts` | canada | ["canada.quotes.respond_own"] | logistics, routes-coverage |
| POST | `/me/quotes/:id/versions/:version/reject` | `src/modules/canada/client.routes.ts` | canada | ["canada.quotes.respond_own"] | routes-coverage |
| GET | `/me/payments` | `src/modules/canada/client.routes.ts` | canada | ["canada.payments.read_own"] | routes-coverage |
| GET | `/me/requests` | `src/modules/canada/client.routes.ts` | canada | ["canada.requests.read_own"] | routes-coverage |
| POST | `/me/requests` | `src/modules/canada/client.routes.ts` | canada | ["canada.requests.create_own"] | features, routes-coverage |
| GET | `/me/notifications` | `src/modules/canada/client.routes.ts` | user | - | routes-coverage |
| POST | `/me/notifications/:id/read` | `src/modules/canada/client.routes.ts` | user | - | routes-coverage |
| PUT | `/me/notification-preferences` | `src/modules/canada/client.routes.ts` | user | - | routes-coverage |
| POST | `/me/devices` | `src/modules/canada/client.routes.ts` | user | - | routes-coverage |
| DELETE | `/me/devices` | `src/modules/canada/client.routes.ts` | user | - | routes-coverage |
| GET | `/public/tracking/:reference` | `src/modules/canada/client.routes.ts` | public | - | i18n, legacy-migration, logistics |
| POST | `/public/requests` | `src/modules/canada/client.routes.ts` | public | - | routes-coverage |
| GET | `/me/client` | `src/modules/canada/client.self.routes.ts` | canada | ["canada.clients.read_own"] | features |
| PATCH | `/me/client` | `src/modules/canada/client.self.routes.ts` | canada | ["canada.clients.update_own"] | features |
| GET | `/me/addresses` | `src/modules/canada/client.self.routes.ts` | canada | ["canada.clients.read_own"] | features |
| POST | `/me/addresses` | `src/modules/canada/client.self.routes.ts` | canada | ["canada.clients.update_own"] | features, routes-coverage |
| PUT | `/me/addresses/:id` | `src/modules/canada/client.self.routes.ts` | canada | ["canada.clients.update_own"] | features |
| DELETE | `/me/addresses/:id` | `src/modules/canada/client.self.routes.ts` | canada | ["canada.clients.update_own"] | routes-coverage |
| PATCH | `/me/requests/:id` | `src/modules/canada/client.self.routes.ts` | canada | ["canada.requests.update_own"] | features |
| GET | `/me/shipments` | `src/modules/canada/client.self.routes.ts` | canada | ["canada.shipments.read_own"] | routes-coverage |
| POST | `/canada/documents` | `src/modules/canada/documents.routes.ts` | canada | - | features |
| POST | `/canada/documents/:id/complete` | `src/modules/canada/documents.routes.ts` | canada | - | features |
| GET | `/canada/documents` | `src/modules/canada/documents.routes.ts` | canada | - | features |
| GET | `/canada/documents/:id/download` | `src/modules/canada/documents.routes.ts` | canada | - | features |
| GET | `/canada/audit-events/export` | `src/modules/canada/exports.routes.ts` | canada | ["canada.audit.export"] | features |
| GET | `/canada/financial-reports/payments/export` | `src/modules/canada/exports.routes.ts` | canada | ["canada.financial_reports.export"] | routes-coverage |
| GET | `/canada/exchange-rates` | `src/modules/canada/finance/finance.routes.ts` | canada | ["canada.pricing.read", "canada.exchange_rates.manage"] | features, negative-scope |
| POST | `/canada/exchange-rates` | `src/modules/canada/finance/finance.routes.ts` | canada | ["canada.exchange_rates.manage"] | auth-money, features, negative-scope |
| GET | `/canada/pricing-rules` | `src/modules/canada/finance/finance.routes.ts` | canada | ["canada.pricing.read"] | negative-scope, structure |
| POST | `/canada/pricing-rules` | `src/modules/canada/finance/finance.routes.ts` | canada | ["canada.pricing.manage"] | auth-money, negative-scope, structure |
| POST | `/canada/pricing-rules/:id/activate` | `src/modules/canada/finance/finance.routes.ts` | canada | ["canada.pricing.manage"] | negative-scope, structure |
| GET | `/canada/quotes` | `src/modules/canada/finance/finance.routes.ts` | canada | ["canada.quotes.read_scoped"] | routes-coverage |
| POST | `/canada/quotes` | `src/modules/canada/finance/finance.routes.ts` | canada | ["canada.quotes.create"] | auth-money, logistics, negative-scope, routes-coverage |
| GET | `/canada/quotes/:id` | `src/modules/canada/finance/finance.routes.ts` | canada | ["canada.quotes.read_scoped"] | routes-coverage |
| POST | `/canada/quotes/:id/revisions` | `src/modules/canada/finance/finance.routes.ts` | canada | ["canada.quotes.update_draft"] | logistics, negative-scope |
| POST | `/canada/quotes/:id/issue` | `src/modules/canada/finance/finance.routes.ts` | canada | ["canada.quotes.issue"] | auth-money, logistics, routes-coverage |
| POST | `/canada/quotes/:id/cancel` | `src/modules/canada/finance/finance.routes.ts` | canada | ["canada.quotes.cancel"] | routes-coverage |
| GET | `/canada/payments` | `src/modules/canada/finance/finance.routes.ts` | canada | ["canada.payments.read_scoped"] | routes-coverage |
| POST | `/canada/payments` | `src/modules/canada/finance/finance.routes.ts` | canada | ["canada.payments.create"] | auth-money, features, negative-scope, routes-coverage |
| GET | `/canada/payments/:id` | `src/modules/canada/finance/finance.routes.ts` | canada | ["canada.payments.read_scoped"] | features, negative-scope |
| POST | `/canada/payments/:id/counter-receipts` | `src/modules/canada/finance/finance.routes.ts` | canada | ["canada.payments.verify"] | auth-money, features, logistics |
| POST | `/canada/payments/:id/cancel` | `src/modules/canada/finance/finance.routes.ts` | canada | ["canada.payments.reconcile"] | routes-coverage |
| POST | `/canada/payments/:id/refunds` | `src/modules/canada/finance/finance.routes.ts` | canada | ["canada.refunds.request"] | logistics |
| POST | `/canada/refunds/:id/decision` | `src/modules/canada/finance/finance.routes.ts` | canada | ["canada.refunds.approve"] | logistics |
| POST | `/canada/refunds/:id/execute` | `src/modules/canada/finance/finance.routes.ts` | canada | ["canada.refunds.execute"] | logistics |
| GET | `/canada/flights` | `src/modules/canada/flights/flight.routes.ts` | canada | ["canada.flights.read"] | features, routes-coverage |
| POST | `/canada/flights` | `src/modules/canada/flights/flight.routes.ts` | canada | ["canada.flights.create"] | features, logistics, negative-scope, routes-coverage |
| GET | `/canada/flights/:id` | `src/modules/canada/flights/flight.routes.ts` | canada | ["canada.flights.read"] | logistics, negative-scope |
| PATCH | `/canada/flights/:id` | `src/modules/canada/flights/flight.routes.ts` | canada | ["canada.flights.update"] | logistics |
| POST | `/canada/flights/:id/schedule` | `src/modules/canada/flights/flight.routes.ts` | canada | ["canada.flights.update"] | logistics, negative-scope, routes-coverage |
| POST | `/canada/flights/:id/publish` | `src/modules/canada/flights/flight.routes.ts` | canada | ["canada.flights.publish"] | logistics, routes-coverage |
| POST | `/canada/flights/:id/status` | `src/modules/canada/flights/flight.routes.ts` | canada | ["canada.flights.update_operational_status"] | logistics, routes-coverage |
| POST | `/canada/flights/:id/cancel` | `src/modules/canada/flights/flight.routes.ts` | canada | ["canada.flights.cancel"] | logistics, routes-coverage |
| POST | `/canada/flights/:id/shipments` | `src/modules/canada/flights/flight.routes.ts` | canada | ["canada.flights.assign_shipments"] | logistics, negative-scope, routes-coverage |
| POST | `/canada/flights/:id/shipments/:shipmentId/unassign` | `src/modules/canada/flights/flight.routes.ts` | canada | ["canada.flights.assign_shipments"] | routes-coverage |
| GET | `/canada/flights/:id/tracking` | `src/modules/canada/flights/flight.routes.ts` | canada | ["canada.flights.read"] | logistics, negative-scope |
| POST | `/canada/parcels/:id/warehouse` | `src/modules/canada/logistics.extra.routes.ts` | canada | ["canada.parcels.assign"] | features |
| PATCH | `/canada/parcels/:id/classification` | `src/modules/canada/logistics.extra.routes.ts` | canada | ["canada.parcels.classify"] | features, negative-scope |
| POST | `/canada/parcels/:id/scans` | `src/modules/canada/logistics.extra.routes.ts` | canada | ["canada.tracking.update"] | features |
| GET | `/canada/parcels/:id/tracking` | `src/modules/canada/logistics.extra.routes.ts` | canada | ["canada.tracking.read_scoped"] | features, negative-scope |
| POST | `/canada/shipments/:id/responsibles` | `src/modules/canada/logistics.extra.routes.ts` | canada | ["canada.shipments.assign"] | features |
| PATCH | `/canada/warehouses/:id` | `src/modules/canada/logistics.extra.routes.ts` | canada | ["canada.warehouses.manage"] | features |
| POST | `/canada/notifications/announcements` | `src/modules/canada/operations.routes.ts` | canada | ["canada.notifications.announce"] | logistics |
| GET | `/canada/reports/overview` | `src/modules/canada/operations.routes.ts` | canada | ["canada.reports.read", "canada.financial_reports.read"] | negative-scope, routes-coverage, structure |
| GET | `/canada/audit-events` | `src/modules/canada/operations.routes.ts` | canada | ["canada.audit.read"] | negative-scope, structure |
| GET | `/canada/parcels` | `src/modules/canada/parcels/parcel.routes.ts` | canada | READ | rbac |
| POST | `/canada/parcels` | `src/modules/canada/parcels/parcel.routes.ts` | canada | ["canada.parcels.create"] | auth-money, features, i18n, logistics, negative-scope, rbac, routes-coverage, webhooks |
| GET | `/canada/parcels/by-reference/:reference` | `src/modules/canada/parcels/parcel.routes.ts` | canada | READ | routes-coverage |
| GET | `/canada/parcels/:id` | `src/modules/canada/parcels/parcel.routes.ts` | canada | READ | rbac |
| POST | `/canada/parcels/:id/transitions` | `src/modules/canada/parcels/parcel.routes.ts` | canada | ["canada.parcels.receive", "canada.parcels.update_status", "canada.parcels.release", "canada.parcels.report_damage", "canada.parcels.manage_exception"] | logistics, negative-scope, rbac, routes-coverage |
| POST | `/canada/parcels/:id/measurements` | `src/modules/canada/parcels/parcel.routes.ts` | canada | ["canada.parcels.weigh"] | auth-money, logistics, negative-scope, routes-coverage |
| POST | `/canada/parcels/:id/events/:eventId/corrections` | `src/modules/canada/parcels/parcel.routes.ts` | canada | ["canada.parcels.manage_exception"] | routes-coverage |
| GET | `/i18n` | `src/modules/canada/settings.routes.ts` | public | - | i18n |
| GET | `/canada/countries/:code/settings` | `src/modules/canada/settings.routes.ts` | canada | ["canada.settings.read"] | routes-coverage |
| PATCH | `/canada/countries/:code/settings` | `src/modules/canada/settings.routes.ts` | canada | ["canada.settings.manage"] | i18n, negative-scope |
| GET | `/canada/shipments` | `src/modules/canada/shipments/shipment.routes.ts` | canada | READ | routes-coverage |
| POST | `/canada/shipments` | `src/modules/canada/shipments/shipment.routes.ts` | canada | ["canada.shipments.create"] | features, logistics, negative-scope, routes-coverage |
| GET | `/canada/shipments/:id` | `src/modules/canada/shipments/shipment.routes.ts` | canada | READ | routes-coverage |
| POST | `/canada/shipments/:id/parcels` | `src/modules/canada/shipments/shipment.routes.ts` | canada | ["canada.shipments.consolidate"] | logistics, negative-scope, routes-coverage |
| POST | `/canada/shipments/:id/parcels/:parcelId/remove` | `src/modules/canada/shipments/shipment.routes.ts` | canada | ["canada.shipments.split"] | logistics, negative-scope |
| POST | `/canada/shipments/:id/ready` | `src/modules/canada/shipments/shipment.routes.ts` | canada | ["canada.shipments.plan"] | logistics, routes-coverage |
| POST | `/canada/shipments/:id/dispatch` | `src/modules/canada/shipments/shipment.routes.ts` | canada | ["canada.shipments.dispatch"] | logistics |
| POST | `/canada/shipments/:id/arrive` | `src/modules/canada/shipments/shipment.routes.ts` | canada | ["canada.shipments.receive"] | logistics |
| POST | `/canada/shipments/:id/complete` | `src/modules/canada/shipments/shipment.routes.ts` | canada | ["canada.shipments.close"] | logistics |
| POST | `/canada/shipments/:id/cancel` | `src/modules/canada/shipments/shipment.routes.ts` | canada | ["canada.shipments.cancel"] | routes-coverage |
| GET | `/canada/countries` | `src/modules/canada/structure.routes.ts` | canada | ["canada.countries.manage"] | structure |
| PATCH | `/canada/countries/:code` | `src/modules/canada/structure.routes.ts` | canada | ["canada.countries.manage"] | routes-coverage |
| POST | `/canada/countries` | `src/modules/canada/structure.routes.ts` | canada | ["canada.countries.manage"] | structure |
| GET | `/canada/currencies` | `src/modules/canada/structure.routes.ts` | canada | ["canada.flights.read"] | routes-coverage |
| GET | `/canada/airlines` | `src/modules/canada/structure.routes.ts` | canada | ["canada.flights.read"] | routes-coverage |
| POST | `/canada/airlines` | `src/modules/canada/structure.routes.ts` | canada | ["canada.airlines.manage"] | structure |
| GET | `/canada/airports` | `src/modules/canada/structure.routes.ts` | canada | ["canada.flights.read"] | routes-coverage |
| POST | `/canada/airports` | `src/modules/canada/structure.routes.ts` | canada | ["canada.airports.manage"] | structure |
| GET | `/canada/agencies` | `src/modules/canada/structure.routes.ts` | canada | ["canada.agencies.read_scoped"] | rbac, structure |
| POST | `/canada/agencies` | `src/modules/canada/structure.routes.ts` | canada | ["canada.agencies.manage"] | structure |
| PATCH | `/canada/agencies/:id` | `src/modules/canada/structure.routes.ts` | canada | ["canada.agencies.manage"] | structure |
| GET | `/canada/agencies/:id/warehouses` | `src/modules/canada/structure.routes.ts` | canada | ["canada.warehouses.read_scoped"] | structure |
| POST | `/canada/agencies/:id/warehouses` | `src/modules/canada/structure.routes.ts` | canada | ["canada.warehouses.manage"] | negative-scope, structure |
| GET | `/canada/clients` | `src/modules/canada/structure.routes.ts` | canada | ["canada.clients.read_scoped"] | negative-scope, structure |
| POST | `/canada/clients` | `src/modules/canada/structure.routes.ts` | canada | ["canada.clients.create"] | structure |
| GET | `/canada/clients/:id` | `src/modules/canada/structure.routes.ts` | canada | ["canada.clients.read_scoped"] | structure |
| PATCH | `/canada/clients/:id` | `src/modules/canada/structure.routes.ts` | canada | ["canada.clients.manage"] | routes-coverage |
| POST | `/canada/clients/:id/link-account` | `src/modules/canada/structure.routes.ts` | canada | ["canada.clients.manage"] | structure |
| GET | `/canada/requests` | `src/modules/canada/structure.routes.ts` | canada | ["canada.requests.read_scoped"] | routes-coverage |
| POST | `/canada/requests/:id/status` | `src/modules/canada/structure.routes.ts` | canada | ["canada.requests.process"] | features |
| POST | `/me/support-tickets` | `src/modules/canada/support.routes.ts` | canada | ["canada.support.create_own"] | features, negative-scope, routes-coverage |
| GET | `/me/support-tickets` | `src/modules/canada/support.routes.ts` | canada | ["canada.support.read_own"] | routes-coverage |
| GET | `/me/support-tickets/:id` | `src/modules/canada/support.routes.ts` | canada | ["canada.support.read_own"] | features, negative-scope |
| POST | `/me/support-tickets/:id/messages` | `src/modules/canada/support.routes.ts` | canada | ["canada.support.create_own"] | features |
| GET | `/canada/support-tickets` | `src/modules/canada/support.routes.ts` | canada | ["canada.support.read_scoped"] | routes-coverage |
| GET | `/canada/support-tickets/:id` | `src/modules/canada/support.routes.ts` | canada | ["canada.support.read_scoped"] | features |
| POST | `/canada/support-tickets/:id/messages` | `src/modules/canada/support.routes.ts` | canada | ["canada.support.reply"] | features, negative-scope |
| POST | `/canada/support-tickets/:id/assign` | `src/modules/canada/support.routes.ts` | canada | ["canada.support.assign"] | features |
| POST | `/canada/support-tickets/:id/status` | `src/modules/canada/support.routes.ts` | canada | ["canada.support.reply"] | features |
| POST | `/auth/register` | `src/modules/identity/identity.routes.ts` | public | - | auth-money, i18n, identity |
| POST | `/auth/login` | `src/modules/identity/identity.routes.ts` | public | - | auth-money, features, i18n, identity, legacy-migration, routes-coverage |
| POST | `/auth/refresh` | `src/modules/identity/identity.routes.ts` | public | - | identity |
| POST | `/auth/logout` | `src/modules/identity/identity.routes.ts` | user | - | identity, negative-scope |
| POST | `/auth/forgot-password` | `src/modules/identity/identity.routes.ts` | public | - | auth-money |
| POST | `/auth/reset-password` | `src/modules/identity/identity.routes.ts` | public | - | auth-money |
| POST | `/auth/verify-email` | `src/modules/identity/identity.routes.ts` | public | - | auth-money |
| POST | `/auth/resend-verification` | `src/modules/identity/identity.routes.ts` | public | - | auth-money |
| POST | `/auth/change-password` | `src/modules/identity/identity.routes.ts` | user | - | auth-money, identity |
| GET | `/identity/me` | `src/modules/identity/identity.routes.ts` | user | - | auth-money, identity, rbac, rbac-audit, structure |
| PATCH | `/identity/me` | `src/modules/identity/identity.routes.ts` | user | - | i18n, identity |
| POST | `/identity/me/platforms/canada/activate` | `src/modules/identity/identity.routes.ts` | user | - | routes-coverage |

Webhook hors registre : `POST /webhooks/resend` (`src/modules/notifications/webhooks.ts`) — testé par `webhooks.test.ts` (signature locale, doublure).

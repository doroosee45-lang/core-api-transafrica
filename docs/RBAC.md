# Matrice RBAC — Trans Afrique Canada

Générée depuis `supabase/seed/001_rbac_catalog.sql` (source appliquée en base). Décisions du 21/11/2026 intégrées.

Lecture : un rôle n'agit que sur le **périmètre** de son attribution (global, pays, agence, entrepôt, propriétaire).
Super Admin = `canada_administrator` @ global ; Administrateur pays = `canada_administrator` @ pays ; Manager = `canada_agency_manager` @ agence.

## Règles d'attribution (vérifiées par `rbac.test.ts`, `rbac-audit.test.ts`)

- Pas d'auto-attribution ; l'acteur doit détenir **chaque** permission du rôle sur le périmètre visé.
- Rôles sensibles (`requires_mfa`, auditeur) : attribution au seul périmètre global, en session MFA (AAL2).
- Rôle exceptionnel : attribué uniquement par un autre administrateur exceptionnel, 7 jours maximum, justification obligatoire.
- Rôles personnalisés (`canada_custom_*`) : ajouter une permission à un rôle, ou réactiver un rôle, exige de détenir ces permissions au périmètre global (un rôle déjà attribué ne peut pas devenir un vecteur d'escalade).
- Conséquence de V-02 : le personnel financier n'est nommé que par l'administrateur exceptionnel (D-15, option 1 sélectionnée, validation formelle attendue : `DECISIONS.md` §C).
- Révocation : immédiate ; ne requiert pas de détenir les permissions révoquées.


| Rôle | Libellé | MFA | Périmètres autorisés | Actif | Nb permissions |
|---|---|---|---|---|---|
| `canada_client` | Client | non | own | oui | 14 |
| `canada_agent` | Agent opérationnel | non | agency,warehouse | oui | 24 |
| `canada_warehouse_agent` | Agent d'entrepôt | non | warehouse,agency | oui | 15 |
| `canada_agency_manager` | Responsable d'agence | non | agency | oui | 44 |
| `canada_operations_manager` | Responsable des opérations (désactivé) | non | country,global | **désactivé** | 0 |
| `canada_finance_agent` | Agent financier | non | agency,country,global | oui | 10 |
| `canada_finance_manager` | Responsable financier | oui | country,global | oui | 17 |
| `canada_administrator` | Administrateur | oui | country,global | oui | 74 |
| `canada_security_auditor` | Auditeur sécurité | non | country,global | oui | 7 |
| `canada_super_administrator` | Administrateur exceptionnel | oui | global | oui | 95 |

## Permissions par rôle

CLI client · AGT agent · ENT agent d'entrepôt · MGR responsable d'agence · FIN agent financier · DFI responsable financier · ADM administrateur (pays ou global) · AUD auditeur. Le rôle exceptionnel détient tout le catalogue. « (G) » = permission effective au seul périmètre global.

| Permission | CLI | AGT | ENT | MGR | FIN | DFI | ADM | AUD | Description |
|---|---|---|---|---|---|---|---|---|---|
| `canada.clients.read_own` | ✔ |  |  |  |  |  |  |  | Consulter son propre profil client |
| `canada.clients.update_own` | ✔ |  |  |  |  |  |  |  | Modifier ses propres coordonnées |
| `canada.clients.read_scoped` |  | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |  | Consulter les clients de son périmètre |
| `canada.clients.create` |  | ✔ |  | ✔ |  |  | ✔ |  | [complément] Créer une fiche client au guichet |
| `canada.clients.read_sensitive` |  |  |  |  |  |  | ✔ |  | Consulter les données sensibles |
| `canada.clients.manage` |  |  |  |  |  |  | ✔ |  | Gérer les fiches clients (lien compte, statut) |
| `canada.requests.create_own` | ✔ |  |  |  |  |  |  |  | Créer ses propres demandes |
| `canada.requests.read_own` | ✔ |  |  |  |  |  |  |  | Consulter ses demandes |
| `canada.requests.read_scoped` |  | ✔ |  | ✔ |  |  | ✔ |  | Consulter les demandes du périmètre |
| `canada.requests.update_own` | ✔ |  |  |  |  |  |  |  | Modifier ses demandes non traitées |
| `canada.requests.process` |  | ✔ |  | ✔ |  |  | ✔ |  | Traiter les demandes |
| `canada.quotes.create` |  | ✔ |  | ✔ |  |  | ✔ |  | Préparer un devis |
| `canada.quotes.read_own` | ✔ |  |  |  |  |  |  |  | Consulter ses devis |
| `canada.quotes.read_scoped` |  | ✔ |  | ✔ | ✔ | ✔ | ✔ |  | Consulter les devis du périmètre |
| `canada.quotes.update_draft` |  | ✔ |  | ✔ |  |  | ✔ |  | Modifier un devis en brouillon |
| `canada.quotes.issue` |  |  |  | ✔ |  |  | ✔ |  | Émettre officiellement un devis |
| `canada.quotes.cancel` |  |  |  | ✔ |  |  | ✔ |  | Annuler un devis |
| `canada.quotes.approve_exception` |  |  |  |  |  | ✔ | ✔ |  | Approuver une exception tarifaire |
| `canada.quotes.respond_own` | ✔ |  |  |  |  |  |  |  | [complément] Accepter ou refuser son propre devis |
| `canada.parcels.create` |  | ✔ |  | ✔ |  |  | ✔ |  | Enregistrer un colis |
| `canada.parcels.read_own` | ✔ |  |  |  |  |  |  |  | Consulter ses colis |
| `canada.parcels.read_scoped` |  | ✔ | ✔ | ✔ |  |  | ✔ |  | Consulter les colis du périmètre |
| `canada.parcels.receive` |  | ✔ | ✔ | ✔ |  |  | ✔ |  | Confirmer la réception physique |
| `canada.parcels.weigh` |  | ✔ | ✔ | ✔ |  |  | ✔ |  | Peser un colis |
| `canada.parcels.measure` |  | ✔ | ✔ | ✔ |  |  | ✔ |  | Mesurer un colis |
| `canada.parcels.classify` |  | ✔ | ✔ | ✔ |  |  | ✔ |  | Classer un colis |
| `canada.parcels.assign` |  |  |  | ✔ |  |  | ✔ |  | Affecter un colis à un entrepôt |
| `canada.parcels.update_status` |  | ✔ | ✔ | ✔ |  |  | ✔ |  | Faire avancer le statut logistique |
| `canada.parcels.release` |  |  |  | ✔ |  |  | ✔ |  | Libérer / remettre un colis |
| `canada.parcels.report_damage` |  | ✔ | ✔ | ✔ |  |  | ✔ |  | Déclarer un dommage |
| `canada.parcels.manage_exception` |  |  |  | ✔ |  |  | ✔ |  | Traiter les exceptions (perte, retour, blocage) |
| `canada.shipments.create` |  |  |  | ✔ |  |  | ✔ |  | Créer une expédition |
| `canada.shipments.read_own` | ✔ |  |  |  |  |  |  |  | Consulter ses expéditions |
| `canada.shipments.read_scoped` |  | ✔ | ✔ | ✔ |  |  | ✔ |  | Consulter les expéditions du périmètre |
| `canada.shipments.plan` |  |  |  | ✔ |  |  | ✔ |  | Planifier une expédition |
| `canada.shipments.assign` |  |  |  | ✔ |  |  | ✔ |  | Affecter les responsables |
| `canada.shipments.consolidate` |  |  |  | ✔ |  |  | ✔ |  | Regrouper des colis |
| `canada.shipments.split` |  |  |  | ✔ |  |  | ✔ |  | Retirer / séparer des colis |
| `canada.shipments.dispatch` |  |  |  | ✔ |  |  | ✔ |  | Confirmer le départ |
| `canada.shipments.receive` |  |  |  | ✔ |  |  | ✔ |  | Confirmer l'arrivée à destination |
| `canada.shipments.close` |  |  |  | ✔ |  |  | ✔ |  | Clôturer |
| `canada.shipments.cancel` |  |  |  | ✔ |  |  | ✔ |  | Annuler |
| `canada.flights.create` |  |  |  |  |  |  | ✔ |  | Créer un vol |
| `canada.flights.read` |  | ✔ | ✔ | ✔ |  |  | ✔ |  | Consulter les vols |
| `canada.flights.update` |  |  |  |  |  |  | ✔ |  | Modifier un vol |
| `canada.flights.publish` |  |  |  |  |  |  | ✔ |  | Publier un vol |
| `canada.flights.cancel` |  |  |  |  |  |  | ✔ |  | Annuler un vol |
| `canada.flights.assign_shipments` |  |  |  | ✔ |  |  | ✔ |  | Associer des expéditions à un vol |
| `canada.flights.update_operational_status` |  |  |  |  |  |  | ✔ |  | Mettre à jour le statut opérationnel |
| `canada.airlines.manage` (G) |  |  |  |  |  |  | ✔ |  | [complément] Référentiel des compagnies |
| `canada.airports.manage` (G) |  |  |  |  |  |  | ✔ |  | [complément] Référentiel des aéroports |
| `canada.payments.read_own` | ✔ |  |  |  |  |  |  |  | Consulter ses paiements |
| `canada.payments.read_scoped` |  | ✔ |  | ✔ | ✔ | ✔ | ✔ |  | Consulter les paiements du périmètre |
| `canada.payments.initiate_own` | ✔ |  |  |  |  |  |  |  | Initier son propre paiement |
| `canada.payments.create` |  |  |  |  | ✔ | ✔ | ✔ |  | [complément] Créer une demande de paiement |
| `canada.payments.verify` |  |  |  |  | ✔ | ✔ |  |  | Vérifier / enregistrer un encaissement |
| `canada.payments.reconcile` |  |  |  |  |  | ✔ |  |  | Rapprocher |
| `canada.refunds.request` |  |  |  |  | ✔ | ✔ |  |  | Demander un remboursement |
| `canada.refunds.approve` |  |  |  |  |  | ✔ |  |  | Approuver un remboursement |
| `canada.refunds.execute` |  |  |  |  |  | ✔ |  |  | Exécuter un remboursement |
| `canada.financial_reports.read` |  |  |  |  | ✔ | ✔ | ✔ |  | Rapports financiers |
| `canada.financial_reports.export` |  |  |  |  |  | ✔ | ✔ |  | Export financier |
| `canada.pricing.read` |  | ✔ |  | ✔ | ✔ | ✔ | ✔ |  | [complément] Consulter les barèmes |
| `canada.pricing.manage` (G) |  |  |  |  |  | ✔ | ✔ |  | [complément] Gérer les barèmes |
| `canada.exchange_rates.manage` (G) |  |  |  |  |  | ✔ | ✔ |  | [complément] Publier des taux de change |
| `canada.countries.read` |  | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | [complément] Consulter les pays |
| `canada.countries.manage` (G) |  |  |  |  |  |  | ✔ |  | [complément] Activer / désactiver un pays |
| `canada.agencies.read_scoped` |  | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |  | Consulter les agences |
| `canada.agencies.manage` |  |  |  |  |  |  | ✔ |  | Gérer les agences |
| `canada.warehouses.read_scoped` |  | ✔ | ✔ | ✔ |  |  | ✔ |  | Consulter les entrepôts |
| `canada.warehouses.manage` |  |  |  |  |  |  | ✔ |  | Gérer les entrepôts |
| `canada.organizations.manage_members` |  |  |  |  |  |  | ✔ |  | Gérer les membres |
| `canada.organizations.assign_members` |  |  |  |  |  |  | ✔ |  | Affecter des membres |
| `canada.tracking.read_own` | ✔ |  |  |  |  |  |  |  | Suivre ses colis |
| `canada.tracking.read_scoped` |  | ✔ | ✔ | ✔ |  |  | ✔ |  | Suivre les colis du périmètre |
| `canada.tracking.update` |  | ✔ | ✔ | ✔ |  |  | ✔ |  | Enregistrer un événement de suivi |
| `canada.tracking.manage_devices` |  |  |  |  |  |  |  |  | Gérer les appareils GPS |
| `canada.tracking.read_location_history` |  |  |  |  |  |  | ✔ |  | Historique de positions |
| `canada.support.create_own` | ✔ |  |  |  |  |  |  |  | [Cahier Module 14] Ouvrir une réclamation sur ses opérations |
| `canada.support.read_own` | ✔ |  |  |  |  |  |  |  | [Cahier Module 14] Consulter ses réclamations |
| `canada.support.read_scoped` |  |  |  | ✔ |  |  | ✔ |  | [Cahier Module 14] Consulter les réclamations du périmètre |
| `canada.support.reply` |  |  |  | ✔ |  |  | ✔ |  | [Cahier Module 14] Répondre et faire avancer une réclamation |
| `canada.support.assign` |  |  |  | ✔ |  |  | ✔ |  | [Cahier Module 14] Affecter une réclamation |
| `canada.notifications.announce` |  |  |  |  |  |  | ✔ |  | [complément] Annonce générale (distincte de la publication) |
| `canada.reports.read` |  |  |  | ✔ |  |  | ✔ |  | [complément] Tableaux de bord opérationnels |
| `canada.users.read` |  |  |  | ✔ |  |  | ✔ | ✔ | Consulter les utilisateurs |
| `canada.users.manage_access` |  |  |  |  |  |  | ✔ |  | Attribuer / révoquer des accès |
| `canada.roles.read` |  |  |  |  |  |  | ✔ | ✔ | Consulter les rôles |
| `canada.roles.manage` (G) |  |  |  |  |  |  | ✔ |  | Gérer les rôles |
| `canada.permissions.read` |  |  |  |  |  |  | ✔ | ✔ | Consulter les permissions |
| `canada.permissions.manage` (G) |  |  |  |  |  |  |  |  | Gérer les permissions |
| `canada.settings.read` |  |  |  |  |  |  | ✔ | ✔ | Consulter les paramètres |
| `canada.settings.manage` |  |  |  |  |  |  | ✔ |  | Gérer les paramètres |
| `canada.audit.read` |  |  |  |  |  |  | ✔ | ✔ | Consulter le journal d'audit |
| `canada.audit.export` |  |  |  |  |  |  | ✔ | ✔ | Exporter le journal d'audit |

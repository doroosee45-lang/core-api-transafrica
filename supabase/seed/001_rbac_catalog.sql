-- ============================================================================
-- 001_rbac_catalog.sql — catalogue RBAC Trans Afrique Canada (idempotent)
--
-- Source : Dossier 03 §3.1 (rôles) et §4 (permissions). Les permissions
-- marquées [complément] ne figurent pas textuellement dans le dossier 03 mais
-- sont exigées par le cahier des charges (gestion des pays, aéroports, tarifs,
-- annonces générales, rapports). Elles sont listées dans docs/DECISIONS.md
-- pour validation. Aucun compte n'est créé ici (Dossier 02 §13).
--
-- Correspondance avec la hiérarchie du cahier des charges (§3) :
--   Super Admin global   = canada_administrator   @ périmètre global
--   Administrateur pays  = canada_administrator   @ périmètre country
--   Manager              = canada_agency_manager @ agency (décision du 21/11/2026 :
--                          managers limités à leur agence ; vols gérés par l'admin pays / Super Admin)
--   Agent                = canada_agent @ agency, canada_warehouse_agent @ warehouse
--   Client               = canada_client @ own
--   canada_super_administrator = accès exceptionnel (MFA, durée limitée, justification)
-- ============================================================================

with perms(code, module, action, global_only, description) as (values
  -- Clients
  ('canada.clients.read_own',       'clients', 'read_own', false, 'Consulter son propre profil client'),
  ('canada.clients.update_own',     'clients', 'update_own', false, 'Modifier ses propres coordonnées'),
  ('canada.clients.read_scoped',    'clients', 'read_scoped', false, 'Consulter les clients de son périmètre'),
  ('canada.clients.create',         'clients', 'create', false, '[complément] Créer une fiche client au guichet'),
  ('canada.clients.read_sensitive', 'clients', 'read_sensitive', false, 'Consulter les données sensibles'),
  ('canada.clients.manage',         'clients', 'manage', false, 'Gérer les fiches clients (lien compte, statut)'),
  -- Demandes et devis
  ('canada.requests.create_own',    'requests', 'create_own', false, 'Créer ses propres demandes'),
  ('canada.requests.read_own',      'requests', 'read_own', false, 'Consulter ses demandes'),
  ('canada.requests.read_scoped',   'requests', 'read_scoped', false, 'Consulter les demandes du périmètre'),
  ('canada.requests.update_own',    'requests', 'update_own', false, 'Modifier ses demandes non traitées'),
  ('canada.requests.process',       'requests', 'process', false, 'Traiter les demandes'),
  ('canada.quotes.create',          'quotes', 'create', false, 'Préparer un devis'),
  ('canada.quotes.read_own',        'quotes', 'read_own', false, 'Consulter ses devis'),
  ('canada.quotes.read_scoped',     'quotes', 'read_scoped', false, 'Consulter les devis du périmètre'),
  ('canada.quotes.update_draft',    'quotes', 'update_draft', false, 'Modifier un devis en brouillon'),
  ('canada.quotes.issue',           'quotes', 'issue', false, 'Émettre officiellement un devis'),
  ('canada.quotes.cancel',          'quotes', 'cancel', false, 'Annuler un devis'),
  ('canada.quotes.approve_exception','quotes', 'approve_exception', false, 'Approuver une exception tarifaire'),
  ('canada.quotes.respond_own',     'quotes', 'respond_own', false, '[complément] Accepter ou refuser son propre devis'),
  -- Colis
  ('canada.parcels.create',         'parcels', 'create', false, 'Enregistrer un colis'),
  ('canada.parcels.read_own',       'parcels', 'read_own', false, 'Consulter ses colis'),
  ('canada.parcels.read_scoped',    'parcels', 'read_scoped', false, 'Consulter les colis du périmètre'),
  ('canada.parcels.receive',        'parcels', 'receive', false, 'Confirmer la réception physique'),
  ('canada.parcels.weigh',          'parcels', 'weigh', false, 'Peser un colis'),
  ('canada.parcels.measure',        'parcels', 'measure', false, 'Mesurer un colis'),
  ('canada.parcels.classify',       'parcels', 'classify', false, 'Classer un colis'),
  ('canada.parcels.assign',         'parcels', 'assign', false, 'Affecter un colis à un entrepôt'),
  ('canada.parcels.update_status',  'parcels', 'update_status', false, 'Faire avancer le statut logistique'),
  ('canada.parcels.release',        'parcels', 'release', false, 'Libérer / remettre un colis'),
  ('canada.parcels.report_damage',  'parcels', 'report_damage', false, 'Déclarer un dommage'),
  ('canada.parcels.manage_exception','parcels', 'manage_exception', false, 'Traiter les exceptions (perte, retour, blocage)'),
  -- Expéditions
  ('canada.shipments.create',       'shipments', 'create', false, 'Créer une expédition'),
  ('canada.shipments.read_own',     'shipments', 'read_own', false, 'Consulter ses expéditions'),
  ('canada.shipments.read_scoped',  'shipments', 'read_scoped', false, 'Consulter les expéditions du périmètre'),
  ('canada.shipments.plan',         'shipments', 'plan', false, 'Planifier une expédition'),
  ('canada.shipments.assign',       'shipments', 'assign', false, 'Affecter les responsables'),
  ('canada.shipments.consolidate',  'shipments', 'consolidate', false, 'Regrouper des colis'),
  ('canada.shipments.split',        'shipments', 'split', false, 'Retirer / séparer des colis'),
  ('canada.shipments.dispatch',     'shipments', 'dispatch', false, 'Confirmer le départ'),
  ('canada.shipments.receive',      'shipments', 'receive', false, 'Confirmer l''arrivée à destination'),
  ('canada.shipments.close',        'shipments', 'close', false, 'Clôturer'),
  ('canada.shipments.cancel',       'shipments', 'cancel', false, 'Annuler'),
  -- Vols
  ('canada.flights.create',         'flights', 'create', false, 'Créer un vol'),
  ('canada.flights.read',           'flights', 'read', false, 'Consulter les vols'),
  ('canada.flights.update',         'flights', 'update', false, 'Modifier un vol'),
  ('canada.flights.publish',        'flights', 'publish', false, 'Publier un vol'),
  ('canada.flights.cancel',         'flights', 'cancel', false, 'Annuler un vol'),
  ('canada.flights.assign_shipments','flights', 'assign_shipments', false, 'Associer des expéditions à un vol'),
  ('canada.flights.update_operational_status','flights', 'update_operational_status', false, 'Mettre à jour le statut opérationnel'),
  ('canada.airlines.manage',        'airlines', 'manage', true, '[complément] Référentiel des compagnies'),
  ('canada.airports.manage',        'airports', 'manage', true, '[complément] Référentiel des aéroports'),
  -- Paiements
  ('canada.payments.read_own',      'payments', 'read_own', false, 'Consulter ses paiements'),
  ('canada.payments.read_scoped',   'payments', 'read_scoped', false, 'Consulter les paiements du périmètre'),
  ('canada.payments.initiate_own',  'payments', 'initiate_own', false, 'Initier son propre paiement'),
  ('canada.payments.create',        'payments', 'create', false, '[complément] Créer une demande de paiement'),
  ('canada.payments.verify',        'payments', 'verify', false, 'Vérifier / enregistrer un encaissement'),
  ('canada.payments.reconcile',     'payments', 'reconcile', false, 'Rapprocher'),
  ('canada.refunds.request',        'refunds', 'request', false, 'Demander un remboursement'),
  ('canada.refunds.approve',        'refunds', 'approve', false, 'Approuver un remboursement'),
  ('canada.refunds.execute',        'refunds', 'execute', false, 'Exécuter un remboursement'),
  ('canada.financial_reports.read', 'financial_reports', 'read', false, 'Rapports financiers'),
  ('canada.financial_reports.export','financial_reports', 'export', false, 'Export financier'),
  ('canada.pricing.read',           'pricing', 'read', false, '[complément] Consulter les barèmes'),
  ('canada.pricing.manage',         'pricing', 'manage', true, '[complément] Gérer les barèmes'),
  ('canada.exchange_rates.manage',  'exchange_rates', 'manage', true, '[complément] Publier des taux de change'),
  -- Structure
  ('canada.countries.read',         'countries', 'read', false, '[complément] Consulter les pays'),
  ('canada.countries.manage',       'countries', 'manage', true, '[complément] Activer / désactiver un pays'),
  ('canada.agencies.read_scoped',   'agencies', 'read_scoped', false, 'Consulter les agences'),
  ('canada.agencies.manage',        'agencies', 'manage', false, 'Gérer les agences'),
  ('canada.warehouses.read_scoped', 'warehouses', 'read_scoped', false, 'Consulter les entrepôts'),
  ('canada.warehouses.manage',      'warehouses', 'manage', false, 'Gérer les entrepôts'),
  ('canada.organizations.manage_members','organizations', 'manage_members', false, 'Gérer les membres'),
  ('canada.organizations.assign_members','organizations', 'assign_members', false, 'Affecter des membres'),
  -- Suivi
  ('canada.tracking.read_own',      'tracking', 'read_own', false, 'Suivre ses colis'),
  ('canada.tracking.read_scoped',   'tracking', 'read_scoped', false, 'Suivre les colis du périmètre'),
  ('canada.tracking.update',        'tracking', 'update', false, 'Enregistrer un événement de suivi'),
  ('canada.tracking.manage_devices','tracking', 'manage_devices', false, 'Gérer les appareils GPS'),
  ('canada.tracking.read_location_history','tracking', 'read_location_history', false, 'Historique de positions'),
  -- Communication et rapports
  -- Support et réclamations (Cahier Module 14 ; « Support client » configurable, §3.7)
  ('canada.support.create_own',     'support', 'create_own', false, '[Cahier Module 14] Ouvrir une réclamation sur ses opérations'),
  ('canada.support.read_own',       'support', 'read_own', false, '[Cahier Module 14] Consulter ses réclamations'),
  ('canada.support.read_scoped',    'support', 'read_scoped', false, '[Cahier Module 14] Consulter les réclamations du périmètre'),
  ('canada.support.reply',          'support', 'reply', false, '[Cahier Module 14] Répondre et faire avancer une réclamation'),
  ('canada.support.assign',         'support', 'assign', false, '[Cahier Module 14] Affecter une réclamation'),
  ('canada.notifications.announce', 'notifications', 'announce', false, '[complément] Annonce générale (distincte de la publication)'),
  ('canada.reports.read',           'reports', 'read', false, '[complément] Tableaux de bord opérationnels'),
  -- Administration et audit
  ('canada.users.read',             'users', 'read', false, 'Consulter les utilisateurs'),
  ('canada.users.manage_access',    'users', 'manage_access', false, 'Attribuer / révoquer des accès'),
  ('canada.roles.read',             'roles', 'read', false, 'Consulter les rôles'),
  ('canada.roles.manage',           'roles', 'manage', true, 'Gérer les rôles'),
  ('canada.permissions.read',       'permissions', 'read', false, 'Consulter les permissions'),
  ('canada.permissions.manage',     'permissions', 'manage', true, 'Gérer les permissions'),
  ('canada.settings.read',          'settings', 'read', false, 'Consulter les paramètres'),
  ('canada.settings.manage',        'settings', 'manage', false, 'Gérer les paramètres'),
  ('canada.audit.read',             'audit', 'read', false, 'Consulter le journal d''audit'),
  ('canada.audit.export',           'audit', 'export', false, 'Exporter le journal d''audit')
)
insert into access.permissions(platform_id, code, module, action, global_only, description)
select 1, code, module, action, global_only, description from perms
on conflict (platform_id, code) do update
  set module = excluded.module, action = excluded.action,
      global_only = excluded.global_only, description = excluded.description;

with roles(code, name, description, requires_mfa, is_exceptional, allowed_scopes, is_active) as (values
  ('canada_client', 'Client', 'Consulte ses demandes, devis, paiements et colis', false, false, array['own'], true),
  ('canada_agent', 'Agent opérationnel', 'Traite les opérations autorisées de son agence', false, false, array['agency','warehouse'], true),
  ('canada_warehouse_agent', 'Agent d''entrepôt', 'Réceptionne, pèse et traite les colis', false, false, array['warehouse','agency'], true),
  ('canada_agency_manager', 'Responsable d''agence', 'Supervise une agence', false, false, array['agency'], true),
  -- Désactivé (décision du 21/11/2026) : conservé pour l'historique, n'accorde plus aucun droit.
  ('canada_operations_manager', 'Responsable des opérations (désactivé)', 'Rôle retiré : managers limités à leur agence', false, false, array['country','global'], false),
  ('canada_finance_agent', 'Agent financier', 'Traite les opérations financières autorisées', false, false, array['agency','country','global'], true),
  ('canada_finance_manager', 'Responsable financier', 'Supervise les opérations financières', true, false, array['country','global'], true),
  ('canada_administrator', 'Administrateur', 'Administrateur pays (country) ou Super Admin global (global)', true, false, array['country','global'], true),
  ('canada_security_auditor', 'Auditeur sécurité', 'Consulte les journaux et contrôles autorisés', false, false, array['country','global'], true),
  ('canada_super_administrator', 'Administrateur exceptionnel', 'Accès exceptionnel soumis à des contrôles renforcés', true, true, array['global'], true)
)
insert into access.roles(platform_id, code, name, description, is_system_role, requires_mfa, is_exceptional, allowed_scopes, is_active)
select 1, code, name, description, true, requires_mfa, is_exceptional, allowed_scopes, is_active from roles
on conflict (platform_id, code) do update
  set name = excluded.name, description = excluded.description, requires_mfa = excluded.requires_mfa,
      is_exceptional = excluded.is_exceptional, allowed_scopes = excluded.allowed_scopes, is_active = excluded.is_active;

-- Matrice rôle -> permissions (remplace intégralement l'association des rôles système).
delete from access.role_permissions rp using access.roles r
 where rp.role_id = r.id and r.platform_id = 1 and r.is_system_role;

with matrix(role_code, perm_codes) as (values
  ('canada_client', array[
    'canada.clients.read_own','canada.clients.update_own','canada.requests.create_own','canada.requests.read_own',
    'canada.requests.update_own','canada.quotes.read_own','canada.quotes.respond_own','canada.parcels.read_own',
    'canada.shipments.read_own','canada.payments.read_own','canada.payments.initiate_own','canada.tracking.read_own',
    'canada.support.create_own','canada.support.read_own']),
  ('canada_warehouse_agent', array[
    'canada.clients.read_scoped','canada.parcels.read_scoped','canada.parcels.receive','canada.parcels.weigh',
    'canada.parcels.measure','canada.parcels.classify','canada.parcels.update_status','canada.parcels.report_damage',
    'canada.shipments.read_scoped','canada.tracking.read_scoped','canada.tracking.update','canada.warehouses.read_scoped',
    'canada.agencies.read_scoped','canada.flights.read','canada.countries.read']),
  ('canada_agent', array[
    'canada.clients.read_scoped','canada.clients.create','canada.requests.read_scoped','canada.requests.process',
    'canada.quotes.create','canada.quotes.read_scoped','canada.quotes.update_draft','canada.parcels.create',
    'canada.parcels.read_scoped','canada.parcels.receive','canada.parcels.weigh','canada.parcels.measure',
    'canada.parcels.classify','canada.parcels.update_status','canada.parcels.report_damage','canada.shipments.read_scoped',
    'canada.tracking.read_scoped','canada.tracking.update','canada.flights.read','canada.agencies.read_scoped',
    'canada.warehouses.read_scoped','canada.pricing.read','canada.countries.read','canada.payments.read_scoped']),
  ('canada_agency_manager', array[
    'canada.clients.read_scoped','canada.clients.create','canada.requests.read_scoped','canada.requests.process',
    'canada.quotes.create','canada.quotes.read_scoped','canada.quotes.update_draft','canada.quotes.issue','canada.quotes.cancel',
    'canada.parcels.create','canada.parcels.read_scoped','canada.parcels.receive','canada.parcels.weigh','canada.parcels.measure',
    'canada.parcels.classify','canada.parcels.assign','canada.parcels.update_status','canada.parcels.release',
    'canada.parcels.report_damage','canada.parcels.manage_exception','canada.shipments.create','canada.shipments.read_scoped',
    'canada.shipments.plan','canada.shipments.assign','canada.shipments.consolidate','canada.shipments.split',
    'canada.shipments.dispatch','canada.shipments.receive','canada.shipments.close','canada.shipments.cancel',
    'canada.flights.read','canada.flights.assign_shipments','canada.tracking.read_scoped','canada.tracking.update',
    'canada.agencies.read_scoped','canada.warehouses.read_scoped','canada.pricing.read','canada.countries.read',
    'canada.payments.read_scoped','canada.reports.read','canada.users.read',
    'canada.support.read_scoped','canada.support.reply','canada.support.assign']),
  ('canada_finance_agent', array[
    'canada.clients.read_scoped','canada.quotes.read_scoped','canada.payments.read_scoped','canada.payments.create',
    'canada.payments.verify','canada.refunds.request','canada.financial_reports.read','canada.pricing.read',
    'canada.agencies.read_scoped','canada.countries.read']),
  ('canada_finance_manager', array[
    'canada.clients.read_scoped','canada.quotes.read_scoped','canada.quotes.approve_exception','canada.payments.read_scoped',
    'canada.payments.create','canada.payments.verify','canada.payments.reconcile','canada.refunds.request','canada.refunds.approve',
    'canada.refunds.execute','canada.financial_reports.read','canada.financial_reports.export','canada.pricing.read',
    'canada.pricing.manage','canada.exchange_rates.manage','canada.agencies.read_scoped','canada.countries.read']),
  ('canada_administrator', array[
    'canada.clients.read_scoped','canada.clients.create','canada.clients.read_sensitive','canada.clients.manage',
    'canada.requests.read_scoped','canada.requests.process','canada.quotes.create','canada.quotes.read_scoped',
    'canada.quotes.update_draft','canada.quotes.issue','canada.quotes.cancel','canada.quotes.approve_exception',
    'canada.parcels.create','canada.parcels.read_scoped','canada.parcels.receive','canada.parcels.weigh','canada.parcels.measure',
    'canada.parcels.classify','canada.parcels.assign','canada.parcels.update_status','canada.parcels.release',
    'canada.parcels.report_damage','canada.parcels.manage_exception','canada.shipments.create','canada.shipments.read_scoped',
    'canada.shipments.plan','canada.shipments.assign','canada.shipments.consolidate','canada.shipments.split',
    'canada.shipments.dispatch','canada.shipments.receive','canada.shipments.close','canada.shipments.cancel',
    'canada.flights.create','canada.flights.read','canada.flights.update','canada.flights.publish','canada.flights.cancel',
    'canada.flights.assign_shipments','canada.flights.update_operational_status','canada.airlines.manage','canada.airports.manage',
    -- Gouvernance financière sans opération d'encaissement ni de remboursement (décision du 21/11/2026).
    'canada.payments.read_scoped','canada.payments.create','canada.financial_reports.read','canada.financial_reports.export',
    'canada.pricing.read','canada.pricing.manage','canada.exchange_rates.manage','canada.audit.export',
    'canada.support.read_scoped','canada.support.reply','canada.support.assign',
    'canada.countries.read','canada.countries.manage','canada.agencies.read_scoped','canada.agencies.manage',
    'canada.warehouses.read_scoped','canada.warehouses.manage','canada.organizations.manage_members',
    'canada.organizations.assign_members','canada.tracking.read_scoped','canada.tracking.update',
    'canada.tracking.read_location_history','canada.notifications.announce','canada.reports.read','canada.users.read',
    'canada.users.manage_access','canada.roles.read','canada.roles.manage','canada.permissions.read','canada.settings.read',
    'canada.settings.manage','canada.audit.read']),
  ('canada_security_auditor', array[
    'canada.audit.read','canada.audit.export','canada.users.read','canada.roles.read','canada.permissions.read',
    'canada.settings.read','canada.countries.read'])
)
insert into access.role_permissions(role_id, permission_id)
select r.id, p.id
  from matrix m
  join access.roles r on r.platform_id = 1 and r.code = m.role_code
  join lateral unnest(m.perm_codes) as pc(code) on true
  join access.permissions p on p.platform_id = 1 and p.code = pc.code
on conflict do nothing;

-- L'administrateur exceptionnel reçoit l'ensemble du catalogue Canada.
insert into access.role_permissions(role_id, permission_id)
select r.id, p.id from access.roles r cross join access.permissions p
 where r.platform_id = 1 and r.code = 'canada_super_administrator' and p.platform_id = 1
on conflict do nothing;

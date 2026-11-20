-- ============================================================================
-- 20261119000300_canada_logistics.sql
-- Structure opérationnelle et logistique de Trans Afrique Canada :
-- agences, entrepôts, clients, colis, mesures, événements, expéditions.
--
-- Références : Cahier §4, Modules 4 à 7 ; Spéc. backend §7 à §11 ; Dossier 05 Flux 09-13.
-- Règles clés :
--   * chaque notion géographique a son propre champ (Spéc. backend §4.2) ;
--   * poids réel / volumétrique / facturable distincts, diviseur conservé ;
--   * historiques en ajout seul ; aucune suppression physique d'un colis ;
--   * un colis appartient à au plus UNE expédition active, l'historique est conservé.
-- ============================================================================

create table canada.agencies (
  id           uuid primary key default gen_random_uuid(),
  code         varchar(20) not null unique,
  name         varchar(160) not null,
  country_code char(2) not null references shared.countries(code),
  city         varchar(120),
  address      text,
  phone        varchar(40),
  email        varchar(160),
  timezone     varchar(64) not null,
  latitude     numeric(9,6),
  longitude    numeric(9,6),
  status       varchar(20) not null default 'active' check (status in ('active','suspended','closed')),
  legacy_ref   text unique,
  created_by   uuid references identity.profiles(id),
  updated_by   uuid references identity.profiles(id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index idx_agencies_country on canada.agencies(country_code, status);
create trigger trg_agencies_updated before update on canada.agencies
  for each row execute function private.set_updated_at();

create table canada.warehouses (
  id            uuid primary key default gen_random_uuid(),
  agency_id     uuid not null references canada.agencies(id),
  country_code  char(2) not null references shared.countries(code),
  code          varchar(20) not null unique,
  name          varchar(160) not null,
  address       text,
  capacity_m3   numeric(12,3) check (capacity_m3 is null or capacity_m3 > 0),
  status        varchar(20) not null default 'active' check (status in ('active','suspended','closed')),
  created_by    uuid references identity.profiles(id),
  updated_by    uuid references identity.profiles(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index idx_warehouses_agency on canada.warehouses(agency_id);
create trigger trg_warehouses_updated before update on canada.warehouses
  for each row execute function private.set_updated_at();

-- L'entrepôt est dans le pays de son agence.
create or replace function private.check_warehouse_country()
returns trigger language plpgsql as $$
begin
  if new.country_code is distinct from (select country_code from canada.agencies where id = new.agency_id) then
    raise exception 'WAREHOUSE_COUNTRY_MISMATCH: l''entrepôt doit être dans le pays de son agence' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger trg_warehouses_country before insert or update on canada.warehouses
  for each row execute function private.check_warehouse_country();

-- ---------------------------------------------------------------------------
-- Clients (Module 4). Le lien fiche ↔ compte (user_id) est posé par un
-- personnel habilité ou à l'inscription — jamais déduit d'une adresse e-mail.
-- ---------------------------------------------------------------------------
create table canada.clients (
  id                uuid primary key default gen_random_uuid(),
  client_number     varchar(30) not null unique,
  user_id           uuid unique references identity.profiles(id),
  first_name        varchar(100) not null,
  last_name         varchar(100) not null,
  email             varchar(254),
  phone             varchar(40),
  residence_country char(2) references shared.countries(code),
  home_agency_id    uuid references canada.agencies(id),
  status            varchar(20) not null default 'active' check (status in ('active','inactive','blocked')),
  notes             text,
  legacy_ref        text unique,
  created_by        uuid references identity.profiles(id),
  updated_by        uuid references identity.profiles(id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index idx_clients_agency on canada.clients(home_agency_id);
create index idx_clients_residence on canada.clients(residence_country);
create index idx_clients_name on canada.clients(lower(last_name), lower(first_name));
create index idx_clients_email on canada.clients(lower(email));
create trigger trg_clients_updated before update on canada.clients
  for each row execute function private.set_updated_at();

create table canada.client_addresses (
  id           uuid primary key default gen_random_uuid(),
  client_id    uuid not null references canada.clients(id),
  label        varchar(60),
  country_code char(2) not null references shared.countries(code),
  city         varchar(120) not null,
  line1        text not null,
  line2        text,
  postal_code  varchar(20),
  phone        varchar(40),
  is_default   boolean not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create unique index uq_client_default_address on canada.client_addresses(client_id) where is_default;
create trigger trg_client_addresses_updated before update on canada.client_addresses
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------------
-- Colis (Module 6, Spéc. backend §10)
-- ---------------------------------------------------------------------------
create table canada.parcels (
  id                     uuid primary key default gen_random_uuid(),
  reference              varchar(30) not null unique,            -- référence publique / QR / code-barres
  client_id              uuid not null references canada.clients(id),  -- propriétaire (expéditeur)
  recipient_client_id    uuid references canada.clients(id),
  recipient_name         varchar(200),
  recipient_phone        varchar(40),
  origin_country         char(2) not null references shared.countries(code),
  destination_country    char(2) not null references shared.countries(code),
  origin_agency_id       uuid not null references canada.agencies(id),  -- agence responsable
  destination_agency_id  uuid references canada.agencies(id),
  current_warehouse_id   uuid references canada.warehouses(id),
  transport_mode         varchar(10) not null default 'air' check (transport_mode in ('air','sea','road')),
  category               varchar(30) not null default 'other' check (category in
    ('document','clothing','electronics','food','cosmetics','fragile_item','other')),
  description            text,
  item_count             integer not null default 1 check (item_count > 0),
  declared_value         numeric(18,2) check (declared_value is null or declared_value >= 0),
  declared_value_currency char(3) references shared.currencies(code),
  fragile                boolean not null default false,
  status                 varchar(30) not null default 'expected' check (status in (
    'expected','received','inspected','ready_for_shipment','in_shipment','dispatched','in_transit',
    'in_customs','arrived_destination','received_destination','available','out_for_delivery',
    'delivered','on_hold','damaged','lost','returned','cancelled')),
  -- Dernière mesure validée (dénormalisée ; l'historique est dans parcel_measurements)
  actual_weight_kg       numeric(10,3) check (actual_weight_kg is null or actual_weight_kg > 0),
  length_cm              numeric(10,2) check (length_cm is null or length_cm > 0),
  width_cm               numeric(10,2) check (width_cm is null or width_cm > 0),
  height_cm              numeric(10,2) check (height_cm is null or height_cm > 0),
  volumetric_divisor     integer check (volumetric_divisor is null or volumetric_divisor > 0),
  volumetric_weight_kg   numeric(10,3),
  billable_weight_kg     numeric(10,3),
  measured_at            timestamptz,
  estimated_delivery_at  timestamptz,
  delivered_at           timestamptz,
  row_version            integer not null default 1,
  legacy_ref             text unique,
  created_by             uuid references identity.profiles(id),
  updated_by             uuid references identity.profiles(id),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint ck_parcels_route check (origin_country <> destination_country),
  constraint ck_parcels_declared_currency check (declared_value is null or declared_value_currency is not null)
);
create index idx_parcels_client on canada.parcels(client_id);
create index idx_parcels_recipient on canada.parcels(recipient_client_id);
create index idx_parcels_origin_agency on canada.parcels(origin_agency_id, status);
create index idx_parcels_destination_agency on canada.parcels(destination_agency_id, status);
create index idx_parcels_route on canada.parcels(origin_country, destination_country, status);
create index idx_parcels_created on canada.parcels(created_at desc);
create trigger trg_parcels_updated before update on canada.parcels
  for each row execute function private.set_updated_at();
create trigger trg_parcels_no_delete before delete on canada.parcels
  for each row execute function private.forbid_mutation();

create table canada.parcel_measurements (
  id                   uuid primary key default gen_random_uuid(),
  parcel_id            uuid not null references canada.parcels(id),
  actual_weight_kg     numeric(10,3) not null check (actual_weight_kg > 0),
  length_cm            numeric(10,2) check (length_cm > 0),
  width_cm             numeric(10,2) check (width_cm > 0),
  height_cm            numeric(10,2) check (height_cm > 0),
  volumetric_divisor   integer not null check (volumetric_divisor > 0),
  volumetric_weight_kg numeric(10,3) not null,
  billable_weight_kg   numeric(10,3) not null,
  warehouse_id         uuid references canada.warehouses(id),
  measured_by          uuid references identity.profiles(id),
  measured_at          timestamptz not null default now(),
  reason               text,      -- obligatoire pour une re-mesure (contrôlé par le service)
  source               varchar(30) not null default 'operator' check (source in ('operator','legacy_migration')),
  constraint ck_measure_dims check (
    (length_cm is null and width_cm is null and height_cm is null) or
    (length_cm is not null and width_cm is not null and height_cm is not null))
);
create index idx_parcel_measurements_parcel on canada.parcel_measurements(parcel_id, measured_at desc);
create trigger trg_parcel_measurements_append_only before update or delete on canada.parcel_measurements
  for each row execute function private.forbid_mutation();

create table canada.parcel_events (
  id                    uuid primary key default gen_random_uuid(),
  parcel_id             uuid not null references canada.parcels(id),
  event_type            varchar(60) not null,
  from_status           varchar(30),
  to_status             varchar(30),
  occurred_at           timestamptz not null default now(),
  recorded_at           timestamptz not null default now(),
  actor_user_id         uuid references identity.profiles(id),
  agency_id             uuid references canada.agencies(id),
  warehouse_id          uuid references canada.warehouses(id),
  shipment_id           uuid,
  location_text         varchar(200),
  -- Nature de la donnée : un scan, une saisie, un événement système n'ont pas la même valeur.
  source                varchar(30) not null default 'manual' check (source in
    ('scan','manual','system','legacy_migration','integration')),
  visibility            varchar(10) not null default 'client' check (visibility in ('client','internal')),
  comment               text,
  proof_reference       text,
  corrects_event_id     uuid references canada.parcel_events(id),
  correlation_id        uuid
);
create index idx_parcel_events_parcel on canada.parcel_events(parcel_id, occurred_at);
create trigger trg_parcel_events_append_only before update or delete on canada.parcel_events
  for each row execute function private.forbid_mutation();

-- ---------------------------------------------------------------------------
-- Expéditions (Module 7, Spéc. backend §11)
-- ---------------------------------------------------------------------------
create table canada.shipments (
  id                    uuid primary key default gen_random_uuid(),
  reference             varchar(30) not null unique,
  origin_country        char(2) not null references shared.countries(code),
  destination_country   char(2) not null references shared.countries(code),
  origin_agency_id      uuid not null references canada.agencies(id),
  destination_agency_id uuid references canada.agencies(id),
  transport_mode        varchar(10) not null default 'air' check (transport_mode in ('air','sea','road')),
  carrier_name          varchar(160),
  status                varchar(20) not null default 'planned' check (status in
    ('planned','ready','dispatched','in_transit','arrived','completed','cancelled')),
  origin_responsible_id      uuid references identity.profiles(id),
  destination_responsible_id uuid references identity.profiles(id),
  notes                 text,
  dispatched_at         timestamptz,
  arrived_at            timestamptz,
  completed_at          timestamptz,
  cancelled_at          timestamptz,
  row_version           integer not null default 1,
  created_by            uuid references identity.profiles(id),
  updated_by            uuid references identity.profiles(id),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint ck_shipments_route check (origin_country <> destination_country)
);
create index idx_shipments_origin on canada.shipments(origin_agency_id, status);
create index idx_shipments_destination on canada.shipments(destination_agency_id, status);
create index idx_shipments_route on canada.shipments(origin_country, destination_country, status);
create trigger trg_shipments_updated before update on canada.shipments
  for each row execute function private.set_updated_at();
create trigger trg_shipments_no_delete before delete on canada.shipments
  for each row execute function private.forbid_mutation();

-- Association colis ↔ expédition avec historique (ajout / retrait).
create table canada.shipment_parcels (
  id             uuid primary key default gen_random_uuid(),
  shipment_id    uuid not null references canada.shipments(id),
  parcel_id      uuid not null references canada.parcels(id),
  added_at       timestamptz not null default now(),
  added_by       uuid references identity.profiles(id),
  removed_at     timestamptz,
  removed_by     uuid references identity.profiles(id),
  removal_reason text
);
-- Un colis ne peut appartenir qu'à une seule expédition active à la fois.
create unique index uq_shipment_parcels_active on canada.shipment_parcels(parcel_id) where removed_at is null;
create index idx_shipment_parcels_shipment on canada.shipment_parcels(shipment_id) where removed_at is null;
create trigger trg_shipment_parcels_no_delete before delete on canada.shipment_parcels
  for each row execute function private.forbid_mutation();

alter table canada.parcel_events
  add constraint fk_parcel_events_shipment foreign key (shipment_id) references canada.shipments(id);

create table canada.shipment_events (
  id             uuid primary key default gen_random_uuid(),
  shipment_id    uuid not null references canada.shipments(id),
  event_type     varchar(60) not null,
  from_status    varchar(20),
  to_status      varchar(20),
  occurred_at    timestamptz not null default now(),
  actor_user_id  uuid references identity.profiles(id),
  country_code   char(2) references shared.countries(code),
  comment        text,
  metadata       jsonb not null default '{}'::jsonb,
  correlation_id uuid
);
create index idx_shipment_events_shipment on canada.shipment_events(shipment_id, occurred_at);
create trigger trg_shipment_events_append_only before update or delete on canada.shipment_events
  for each row execute function private.forbid_mutation();

-- ---------------------------------------------------------------------------
-- Demandes (devis publics, application client, Market) — Dossier 03 §4.2
-- ---------------------------------------------------------------------------
create table canada.requests (
  id                  uuid primary key default gen_random_uuid(),
  reference           varchar(30) not null unique,
  source              varchar(20) not null check (source in ('public_form','client_app','staff','market','legacy_migration')),
  client_id           uuid references canada.clients(id),
  requester_user_id   uuid references identity.profiles(id),
  full_name           varchar(160) not null,
  company             varchar(160),
  email               varchar(254) not null,
  phone               varchar(40),
  origin_country      char(2) not null references shared.countries(code),
  destination_country char(2) not null references shared.countries(code),
  preferred_agency_id uuid references canada.agencies(id),
  shipment_type       varchar(20) not null default 'parcel' check (shipment_type in ('parcel','kilogram','pallet','documents','other')),
  estimated_weight_kg numeric(10,3) check (estimated_weight_kg is null or estimated_weight_kg >= 0),
  estimated_volume_m3 numeric(10,3) check (estimated_volume_m3 is null or estimated_volume_m3 >= 0),
  message             text,
  status              varchar(20) not null default 'new' check (status in ('new','under_review','quoted','won','lost','cancelled')),
  handled_by          uuid references identity.profiles(id),
  handled_at          timestamptz,
  market_request_id   uuid unique,     -- correspondance Market (Dossier 05 §3.2)
  correlation_id      uuid,
  legacy_ref          text unique,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index idx_requests_status on canada.requests(status, created_at desc);
create index idx_requests_requester on canada.requests(requester_user_id);
create trigger trg_requests_updated before update on canada.requests
  for each row execute function private.set_updated_at();

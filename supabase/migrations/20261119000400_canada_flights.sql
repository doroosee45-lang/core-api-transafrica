-- ============================================================================
-- 20261119000400_canada_flights.sql
-- Vols internationaux, versions publiées, association expéditions ↔ vols.
--
-- Références : Cahier Module 8 (§8.2 à §8.6), Spéc. backend §12, Dossier 05 Flux 11.
-- Identification fonctionnelle : compagnie + numéro + date (unicité).
-- Le statut ARRIVED du vol ne modifie JAMAIS le statut des colis (règle §8.3).
-- Aucune position aérienne n'est stockée tant qu'aucun fournisseur n'est retenu.
-- ============================================================================

create table canada.airlines (
  id         uuid primary key default gen_random_uuid(),
  iata_code  char(2) not null unique check (iata_code ~ '^[A-Z0-9]{2}$'),
  icao_code  char(3) unique check (icao_code is null or icao_code ~ '^[A-Z]{3}$'),
  name       varchar(160) not null,
  is_active  boolean not null default true,
  created_by uuid references identity.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger trg_airlines_updated before update on canada.airlines
  for each row execute function private.set_updated_at();

create table canada.airports (
  iata_code    char(3) primary key check (iata_code ~ '^[A-Z]{3}$'),
  icao_code    char(4) unique,
  name         varchar(200) not null,
  city         varchar(120) not null,
  country_code char(2) not null references shared.countries(code),
  timezone     varchar(64) not null,   -- IANA, validé côté backend
  is_active    boolean not null default true,
  created_by   uuid references identity.profiles(id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create trigger trg_airports_updated before update on canada.airports
  for each row execute function private.set_updated_at();

create table canada.flights (
  id                    uuid primary key default gen_random_uuid(),
  airline_id            uuid not null references canada.airlines(id),
  flight_number         varchar(6) not null check (flight_number ~ '^[0-9]{1,4}[A-Z]?$'),
  flight_date           date not null,                    -- date locale de départ
  departure_airport     char(3) not null references canada.airports(iata_code),
  arrival_airport       char(3) not null references canada.airports(iata_code),
  scheduled_departure   timestamptz not null,
  scheduled_arrival     timestamptz not null,
  departure_timezone    varchar(64) not null,
  arrival_timezone      varchar(64) not null,
  departure_terminal    varchar(20),
  arrival_terminal      varchar(20),
  operating_reference   varchar(80),
  notes                 text,
  status                varchar(20) not null default 'DRAFT' check (status in (
    'DRAFT','SCHEDULED','PUBLISHED','BOARDING','DEPARTED','IN_AIR','DELAYED','DIVERTED','LANDED','ARRIVED','CANCELLED')),
  estimated_departure   timestamptz,
  estimated_arrival     timestamptz,
  actual_departure      timestamptz,
  actual_arrival        timestamptz,
  diverted_to_airport   char(3) references canada.airports(iata_code),
  current_version       integer not null default 0,     -- 0 = jamais publié
  published_at          timestamptz,
  published_by          uuid references identity.profiles(id),
  cancelled_at          timestamptz,
  cancelled_by          uuid references identity.profiles(id),
  cancellation_reason   text,
  row_version           integer not null default 1,
  created_by            uuid references identity.profiles(id),
  updated_by            uuid references identity.profiles(id),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint uq_flight_identity unique (airline_id, flight_number, flight_date),
  constraint ck_flight_airports check (departure_airport <> arrival_airport),
  constraint ck_flight_times check (scheduled_arrival > scheduled_departure)
);
create index idx_flights_status_date on canada.flights(status, flight_date);
create index idx_flights_departure on canada.flights(departure_airport, flight_date);
create index idx_flights_arrival on canada.flights(arrival_airport, flight_date);
create trigger trg_flights_updated before update on canada.flights
  for each row execute function private.set_updated_at();
create trigger trg_flights_no_delete before delete on canada.flights
  for each row execute function private.forbid_mutation();

-- Versions publiées : instantané complet + champs modifiés + motif (Cahier §8.5).
create table canada.flight_versions (
  id             uuid primary key default gen_random_uuid(),
  flight_id      uuid not null references canada.flights(id),
  version        integer not null check (version > 0),
  snapshot       jsonb not null,
  changed_fields text[] not null default '{}',
  previous_values jsonb,
  change_reason  text,
  is_significant boolean not null default false,
  created_by     uuid references identity.profiles(id),
  created_at     timestamptz not null default now(),
  unique (flight_id, version)
);
create trigger trg_flight_versions_append_only before update or delete on canada.flight_versions
  for each row execute function private.forbid_mutation();

-- Une expédition peut changer de vol (correspondance, annulation) : historique conservé.
create table canada.flight_shipment_assignments (
  id                uuid primary key default gen_random_uuid(),
  flight_id         uuid not null references canada.flights(id),
  shipment_id       uuid not null references canada.shipments(id),
  leg_sequence      smallint not null default 1 check (leg_sequence > 0),
  assigned_at       timestamptz not null default now(),
  assigned_by       uuid references identity.profiles(id),
  unassigned_at     timestamptz,
  unassigned_by     uuid references identity.profiles(id),
  unassign_reason   text
);
create unique index uq_flight_shipment_active on canada.flight_shipment_assignments(shipment_id, leg_sequence)
  where unassigned_at is null;
create index idx_fsa_flight on canada.flight_shipment_assignments(flight_id) where unassigned_at is null;
create trigger trg_fsa_no_delete before delete on canada.flight_shipment_assignments
  for each row execute function private.forbid_mutation();

create table canada.flight_events (
  id             uuid primary key default gen_random_uuid(),
  flight_id      uuid not null references canada.flights(id),
  event_type     varchar(60) not null,
  from_status    varchar(20),
  to_status      varchar(20),
  -- operator = saisie d'un personnel habilité ; provider = fournisseur aéronautique (non encore retenu)
  source         varchar(20) not null default 'operator' check (source in ('operator','provider','system')),
  occurred_at    timestamptz not null default now(),
  recorded_at    timestamptz not null default now(),
  actor_user_id  uuid references identity.profiles(id),
  details        jsonb not null default '{}'::jsonb,
  correlation_id uuid
);
create index idx_flight_events_flight on canada.flight_events(flight_id, occurred_at);
create trigger trg_flight_events_append_only before update or delete on canada.flight_events
  for each row execute function private.forbid_mutation();

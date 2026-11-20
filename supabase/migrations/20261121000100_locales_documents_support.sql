-- ============================================================================
-- 20261121000100_locales_documents_support.sql  (additive, non destructive)
--
-- 1. Paramètres linguistiques par pays (décision du 21/11/2026 : français par
--    défaut dans les 5 pays, anglais disponible partout, le choix de
--    l'utilisateur prime).
-- 2. Documents et preuves (Cahier §13.7, Spéc. backend §20) — décision du
--    21/11/2026 : Supabase Storage, bucket privé, liens temporaires signés.
-- 3. Support et réclamations (Cahier Module 14, Spéc. backend §21).
-- ============================================================================

-- ---------------------------------------------------------------- 1. Langues
alter table shared.countries
  add column default_locale char(2) not null default 'fr' check (default_locale in ('fr','en')),
  add column supported_locales text[] not null default array['fr','en']::text[]
    check (supported_locales <@ array['fr','en']::text[] and cardinality(supported_locales) > 0);
alter table shared.countries
  add constraint ck_countries_default_locale_supported check (default_locale = any(supported_locales));

-- ------------------------------------------------------------- 2. Documents
create table canada.documents (
  id             uuid primary key default gen_random_uuid(),
  entity_type    varchar(20) not null check (entity_type in ('parcel','shipment','payment','support_ticket')),
  entity_id      uuid not null,
  kind           varchar(30) not null check (kind in
    ('parcel_photo','proof_of_receipt','proof_of_delivery','shipment_document','customs_document','payment_receipt','support_attachment','other')),
  -- Périmètre figé à la création : la visibilité ne dépend pas d'une donnée modifiable ensuite.
  country_codes  char(2)[] not null,
  agency_ids     uuid[] not null default '{}',
  owner_user_ids uuid[] not null default '{}',
  visibility     varchar(10) not null default 'internal' check (visibility in ('client','internal')),
  storage_bucket varchar(63) not null,
  storage_path   text not null unique,
  original_name  varchar(255) not null,
  mime_type      varchar(120) not null,
  declared_size  bigint not null check (declared_size > 0),
  stored_size    bigint,
  status         varchar(20) not null default 'pending_upload' check (status in ('pending_upload','uploaded','rejected')),
  rejection_reason text,
  uploaded_by    uuid not null references identity.profiles(id),
  created_at     timestamptz not null default now(),
  confirmed_at   timestamptz
);
create index idx_documents_entity on canada.documents(entity_type, entity_id);
create trigger trg_documents_no_delete before delete on canada.documents
  for each row execute function private.forbid_mutation();

-- --------------------------------------------------------------- 3. Support
create table canada.support_tickets (
  id              uuid primary key default gen_random_uuid(),
  reference       varchar(30) not null unique,
  client_id       uuid not null references canada.clients(id),
  opened_by       uuid not null references identity.profiles(id),
  category        varchar(20) not null check (category in ('parcel','delay','delivery','payment','other')),
  parcel_id       uuid references canada.parcels(id),
  subject         varchar(200) not null,
  -- Périmètre de traitement : pays/agence du colis concerné, sinon pays de résidence du client.
  country_code    char(2) not null references shared.countries(code),
  agency_id       uuid references canada.agencies(id),
  status          varchar(20) not null default 'open' check (status in ('open','in_progress','waiting_client','resolved','closed')),
  assigned_to     uuid references identity.profiles(id),
  closed_at       timestamptz,
  closure_note    text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index idx_support_tickets_scope on canada.support_tickets(country_code, agency_id, status);
create index idx_support_tickets_client on canada.support_tickets(client_id);
create trigger trg_support_tickets_updated before update on canada.support_tickets
  for each row execute function private.set_updated_at();
create trigger trg_support_tickets_no_delete before delete on canada.support_tickets
  for each row execute function private.forbid_mutation();

create table canada.support_messages (
  id            uuid primary key default gen_random_uuid(),
  ticket_id     uuid not null references canada.support_tickets(id),
  author_id     uuid not null references identity.profiles(id),
  author_side   varchar(10) not null check (author_side in ('client','staff')),
  body          text not null check (length(trim(body)) > 0),
  internal_note boolean not null default false,
  created_at    timestamptz not null default now(),
  constraint ck_internal_note_staff check (not internal_note or author_side = 'staff')
);
create index idx_support_messages_ticket on canada.support_messages(ticket_id, created_at);
create trigger trg_support_messages_append_only before update or delete on canada.support_messages
  for each row execute function private.forbid_mutation();

-- RLS : refus par défaut (aucun accès direct client).
alter table canada.documents enable row level security;
alter table canada.support_tickets enable row level security;
alter table canada.support_messages enable row level security;
revoke all on canada.documents, canada.support_tickets, canada.support_messages from anon, authenticated;

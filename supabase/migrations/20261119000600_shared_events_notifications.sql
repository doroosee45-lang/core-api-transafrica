-- ============================================================================
-- 20261119000600_shared_events_notifications.sql
-- Outbox transactionnelle, inbox, idempotence, correspondances d'identifiants
-- (migration et intégration), notifications et livraisons par canal.
--
-- Références : Dossier 04 §8.2-8.3, Dossier 05 §17.3, Migration §7.5,
-- Cahier Module 11 (§8.7 fiabilité des notifications).
-- ============================================================================

create table shared.outbox_events (
  id              uuid primary key default gen_random_uuid(),
  event_type      varchar(120) not null,
  event_version   integer not null default 1,
  aggregate_type  varchar(60) not null,
  aggregate_id    uuid not null,
  payload         jsonb not null,
  correlation_id  uuid,
  occurred_at     timestamptz not null default now(),
  status          varchar(20) not null default 'pending' check (status in ('pending','processing','published','failed')),
  attempt_count   integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  locked_until    timestamptz,
  published_at    timestamptz,
  last_error      text
);
create index idx_outbox_due on shared.outbox_events(next_attempt_at) where status in ('pending','processing');
create index idx_outbox_aggregate on shared.outbox_events(aggregate_type, aggregate_id, occurred_at);

create table shared.inbox_events (
  id                uuid primary key default gen_random_uuid(),
  event_id          uuid not null,
  source_system     varchar(60) not null,
  event_type        varchar(120) not null,
  event_version     integer not null,
  correlation_id    uuid,
  received_at       timestamptz not null default now(),
  processed_at      timestamptz,
  processing_status varchar(20) not null default 'received' check (processing_status in ('received','processed','failed')),
  attempt_count     integer not null default 0,
  last_error        text,
  unique (source_system, event_id)
);

create table shared.idempotency_keys (
  id              uuid primary key default gen_random_uuid(),
  principal_id    uuid not null,
  idempotency_key varchar(200) not null,
  method          varchar(10) not null,
  route           varchar(300) not null,
  request_hash    char(64) not null,
  status          varchar(20) not null default 'in_progress' check (status in ('in_progress','completed')),
  response_status integer,
  response_body   jsonb,
  created_at      timestamptz not null default now(),
  expires_at      timestamptz not null default now() + interval '24 hours',
  unique (principal_id, idempotency_key)
);
create index idx_idempotency_expiry on shared.idempotency_keys(expires_at);

-- Migration §7.5 : correspondance source -> cible, jamais d'identifiant inventé.
create table shared.external_id_mappings (
  id               uuid primary key default gen_random_uuid(),
  source_system    varchar(40) not null,
  entity_type      varchar(60) not null,
  source_id        text not null,
  target_id        uuid,
  migrated_at      timestamptz not null default now(),
  migration_status varchar(20) not null check (migration_status in ('migrated','needs_review','skipped','failed')),
  control_result   text,
  migration_run_id uuid,
  unique (source_system, entity_type, source_id)
);
create index idx_external_mapping_target on shared.external_id_mappings(entity_type, target_id);

create table shared.migration_runs (
  id          uuid primary key default gen_random_uuid(),
  source      varchar(40) not null,
  mode        varchar(10) not null check (mode in ('dry_run','apply')),
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  operator    text,
  report      jsonb
);

-- ---------------------------------------------------------------------------
-- Notifications (Module 11) : opérationnelles vs annonces générales
-- ---------------------------------------------------------------------------
create table shared.notification_campaigns (
  id              uuid primary key default gen_random_uuid(),
  platform_id     smallint not null default 1 references access.platforms(id),
  kind            varchar(20) not null check (kind in ('operational','announcement')),
  source_event_id uuid,
  title           varchar(200) not null,
  body            text not null,
  audience        jsonb not null default '{}'::jsonb,
  created_by      uuid references identity.profiles(id),
  created_at      timestamptz not null default now(),
  -- Un même événement métier ne produit qu'une seule campagne opérationnelle.
  unique (source_event_id)
);

create table shared.notifications (
  id              uuid primary key default gen_random_uuid(),
  platform_id     smallint not null default 1 references access.platforms(id),
  user_id         uuid not null references identity.profiles(id),
  campaign_id     uuid references shared.notification_campaigns(id),
  source_event_id uuid,
  category        varchar(60) not null,
  title           varchar(200) not null,
  body            text not null,
  data            jsonb not null default '{}'::jsonb,
  read_at         timestamptz,
  created_at      timestamptz not null default now(),
  -- Anti-doublon : un événement => une notification par destinataire.
  unique (source_event_id, user_id)
);
create index idx_notifications_user on shared.notifications(user_id, created_at desc);

create table shared.notification_deliveries (
  id                  uuid primary key default gen_random_uuid(),
  notification_id     uuid not null references shared.notifications(id),
  channel             varchar(10) not null check (channel in ('email','push')),
  destination         text not null,
  status              varchar(20) not null default 'queued' check (status in
    ('queued','accepted','delivered','bounced','complained','failed','skipped')),
  status_reason       varchar(120),
  provider            varchar(40),
  provider_message_id varchar(200),
  attempt_count       integer not null default 0,
  next_attempt_at     timestamptz not null default now(),
  last_error          text,
  accepted_at         timestamptz,
  delivered_at        timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (notification_id, channel)
);
create index idx_deliveries_due on shared.notification_deliveries(next_attempt_at) where status = 'queued';
create trigger trg_deliveries_updated before update on shared.notification_deliveries
  for each row execute function private.set_updated_at();

create table shared.notification_preferences (
  user_id     uuid not null references identity.profiles(id),
  channel     varchar(10) not null check (channel in ('email','push','in_app')),
  category    varchar(60) not null default '*',
  enabled     boolean not null,
  updated_at  timestamptz not null default now(),
  primary key (user_id, channel, category)
);

create table shared.user_devices (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references identity.profiles(id),
  push_token    text not null unique,
  platform      varchar(10) not null check (platform in ('ios','android','web')),
  status        varchar(20) not null default 'active' check (status in ('active','unregistered')),
  last_seen_at  timestamptz not null default now(),
  created_at    timestamptz not null default now()
);
create index idx_user_devices_user on shared.user_devices(user_id) where status = 'active';

-- Adresses en échec définitif (rebond, plainte) : exclues des envois.
create table shared.email_suppressions (
  email_normalized text primary key,
  reason           varchar(20) not null check (reason in ('bounced','complained','manual')),
  detail           text,
  created_at       timestamptz not null default now()
);

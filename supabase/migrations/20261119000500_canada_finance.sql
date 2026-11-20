-- ============================================================================
-- 20261119000500_canada_finance.sql
-- Tarification versionnée, taux de change historisés, devis versionnés,
-- paiements, transactions et remboursements.
--
-- Références : Cahier Modules 12-13 ; Spéc. backend §15 à §18 ; Dossier 05 Flux 05-07, 15.
-- Montants en NUMERIC (jamais de flottant), devise explicite sur chaque montant.
-- ============================================================================

create table canada.exchange_rates (
  id             uuid primary key default gen_random_uuid(),
  base_currency  char(3) not null references shared.currencies(code),
  quote_currency char(3) not null references shared.currencies(code),
  rate           numeric(24,10) not null check (rate > 0),
  effective_at   timestamptz not null,
  source         varchar(120) not null,
  created_by     uuid references identity.profiles(id),
  created_at     timestamptz not null default now(),
  constraint ck_rate_pair check (base_currency <> quote_currency),
  unique (base_currency, quote_currency, effective_at)
);
create index idx_exchange_rates_lookup on canada.exchange_rates(base_currency, quote_currency, effective_at desc);
-- Un taux historique ne se modifie jamais : on en publie un nouveau.
create trigger trg_exchange_rates_append_only before update or delete on canada.exchange_rates
  for each row execute function private.forbid_mutation();

-- Barèmes : une règle active est immuable ; un changement = nouvelle version.
create table canada.pricing_rules (
  id                  uuid primary key default gen_random_uuid(),
  code                varchar(60) not null,
  version             integer not null check (version > 0),
  origin_country      char(2) not null references shared.countries(code),
  destination_country char(2) not null references shared.countries(code),
  transport_mode      varchar(10) not null check (transport_mode in ('air','sea','road')),
  category            varchar(30),           -- null = toutes catégories
  currency            char(3) not null references shared.currencies(code),
  rate_per_kg         numeric(18,4) not null check (rate_per_kg >= 0),
  minimum_charge      numeric(18,4) not null default 0 check (minimum_charge >= 0),
  service_fee         numeric(18,4) not null default 0 check (service_fee >= 0),
  volumetric_divisor  integer not null check (volumetric_divisor > 0),
  effective_from      timestamptz not null,
  effective_to        timestamptz,
  status              varchar(20) not null default 'draft' check (status in ('draft','active','retired')),
  created_by          uuid references identity.profiles(id),
  activated_by        uuid references identity.profiles(id),
  activated_at        timestamptz,
  created_at          timestamptz not null default now(),
  unique (code, version),
  constraint ck_pricing_route check (origin_country <> destination_country),
  constraint ck_pricing_period check (effective_to is null or effective_to > effective_from)
);
create index idx_pricing_lookup on canada.pricing_rules(origin_country, destination_country, transport_mode, status);

create or replace function private.pricing_rule_immutable()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if old.status <> 'draft' then
      raise exception 'PRICING_RULE_IMMUTABLE: une règle activée ne se supprime pas' using errcode = '42501';
    end if;
    return old;
  end if;
  if old.status <> 'draft' then
    -- Seule transition permise : active -> retired (avec date de fin).
    if not (old.status = 'active' and new.status = 'retired'
            and (new.rate_per_kg, new.minimum_charge, new.service_fee, new.volumetric_divisor, new.currency,
                 new.origin_country, new.destination_country, new.transport_mode, new.category, new.effective_from)
                is not distinct from
                (old.rate_per_kg, old.minimum_charge, old.service_fee, old.volumetric_divisor, old.currency,
                 old.origin_country, old.destination_country, old.transport_mode, old.category, old.effective_from)) then
      raise exception 'PRICING_RULE_IMMUTABLE: créer une nouvelle version' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
create trigger trg_pricing_rules_immutable before update or delete on canada.pricing_rules
  for each row execute function private.pricing_rule_immutable();

-- ---------------------------------------------------------------------------
-- Devis (Spéc. backend §17, Dossier 05 Flux 05-06)
-- ---------------------------------------------------------------------------
create table canada.quotations (
  id                  uuid primary key default gen_random_uuid(),
  reference           varchar(30) not null unique,
  client_id           uuid not null references canada.clients(id),
  request_id          uuid references canada.requests(id),
  origin_country      char(2) not null references shared.countries(code),
  destination_country char(2) not null references shared.countries(code),
  agency_id           uuid not null references canada.agencies(id),
  current_version     integer not null default 1,
  source              varchar(20) not null default 'staff' check (source in ('staff','market','legacy_migration')),
  legacy_ref          text unique,
  created_by          uuid references identity.profiles(id),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index idx_quotations_client on canada.quotations(client_id);
create index idx_quotations_agency on canada.quotations(agency_id);
create trigger trg_quotations_updated before update on canada.quotations
  for each row execute function private.set_updated_at();

create table canada.quotation_versions (
  id                 uuid primary key default gen_random_uuid(),
  quotation_id       uuid not null references canada.quotations(id),
  version            integer not null check (version > 0),
  status             varchar(20) not null default 'draft' check (status in
    ('draft','under_review','issued','viewed','accepted','rejected','expired','cancelled','superseded')),
  currency           char(3) not null references shared.currencies(code),
  subtotal           numeric(18,2) not null default 0,
  total              numeric(18,2) not null default 0,
  pricing_rule_id    uuid references canada.pricing_rules(id),
  exchange_rates     jsonb not null default '[]'::jsonb,  -- taux appliqués (source, date)
  rounding_rule      varchar(40) not null default 'half_up_currency_minor_units',
  conditions         text,
  valid_until        timestamptz,
  issued_at          timestamptz,
  issued_by          uuid references identity.profiles(id),
  accepted_at        timestamptz,
  accepted_by        uuid references identity.profiles(id),
  acceptance_evidence jsonb,
  rejected_at        timestamptz,
  rejected_by        uuid references identity.profiles(id),
  rejection_reason   text,
  created_by         uuid references identity.profiles(id),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (quotation_id, version)
);
create trigger trg_quotation_versions_updated before update on canada.quotation_versions
  for each row execute function private.set_updated_at();

create table canada.quotation_lines (
  id                 uuid primary key default gen_random_uuid(),
  quotation_version_id uuid not null references canada.quotation_versions(id),
  line_no            integer not null check (line_no > 0),
  category           varchar(30) not null check (category in
    ('purchase','transport','service','handling','insurance','customs','delivery','other')),
  designation        varchar(240) not null,
  parcel_id          uuid references canada.parcels(id),
  quantity           numeric(18,4) not null check (quantity > 0),
  unit_price         numeric(18,4) not null check (unit_price >= 0),
  amount             numeric(18,2) not null check (amount >= 0),
  currency           char(3) not null references shared.currencies(code),
  calculation_rule   text not null,
  tax_rate           numeric(7,4),
  unique (quotation_version_id, line_no)
);

-- Une version émise est figée : ses montants et lignes ne changent plus.
create or replace function private.quotation_version_guard()
returns trigger language plpgsql as $$
begin
  if old.status <> 'draft' and (
      (new.currency, new.subtotal, new.total, new.pricing_rule_id, new.exchange_rates, new.conditions, new.valid_until, new.version, new.quotation_id)
      is distinct from
      (old.currency, old.subtotal, old.total, old.pricing_rule_id, old.exchange_rates, old.conditions, old.valid_until, old.version, old.quotation_id)) then
    raise exception 'QUOTE_VERSION_FROZEN: une version émise ne peut plus être modifiée' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger trg_quotation_versions_guard before update on canada.quotation_versions
  for each row execute function private.quotation_version_guard();

create or replace function private.quotation_line_guard()
returns trigger language plpgsql as $$
declare st text;
begin
  select status into st from canada.quotation_versions
   where id = coalesce(new.quotation_version_id, old.quotation_version_id);
  if st <> 'draft' then
    raise exception 'QUOTE_VERSION_FROZEN: lignes figées après émission' using errcode = '42501';
  end if;
  return coalesce(new, old);
end $$;
create trigger trg_quotation_lines_guard before insert or update or delete on canada.quotation_lines
  for each row execute function private.quotation_line_guard();

-- ---------------------------------------------------------------------------
-- Paiements (Spéc. backend §18, Dossier 05 Flux 07)
-- ---------------------------------------------------------------------------
create table canada.payments (
  id                   uuid primary key default gen_random_uuid(),
  reference            varchar(30) not null unique,
  legacy_invoice_number varchar(40) unique,
  client_id            uuid not null references canada.clients(id),
  agency_id            uuid not null references canada.agencies(id),
  quotation_version_id uuid references canada.quotation_versions(id),
  purpose              varchar(20) not null default 'logistics' check (purpose in
    ('logistics','goods','service','insurance','balance','other')),
  amount_due           numeric(18,2) not null check (amount_due > 0),
  amount_paid          numeric(18,2) not null default 0 check (amount_paid >= 0),
  amount_refunded      numeric(18,2) not null default 0 check (amount_refunded >= 0),
  currency             char(3) not null references shared.currencies(code),
  status               varchar(20) not null default 'pending' check (status in
    ('created','pending','processing','succeeded','failed','cancelled','expired','refunded','partially_refunded','under_review')),
  due_date             date,
  confirmed_at         timestamptz,
  cancelled_at         timestamptz,
  cancelled_by         uuid references identity.profiles(id),
  legacy_ref           text unique,
  created_by           uuid references identity.profiles(id),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint ck_payment_amounts check (amount_refunded <= amount_paid)
);
create index idx_payments_client on canada.payments(client_id);
create index idx_payments_agency_status on canada.payments(agency_id, status);
create trigger trg_payments_updated before update on canada.payments
  for each row execute function private.set_updated_at();
create trigger trg_payments_no_delete before delete on canada.payments
  for each row execute function private.forbid_mutation();

create table canada.payment_transactions (
  id                 uuid primary key default gen_random_uuid(),
  payment_id         uuid not null references canada.payments(id),
  kind               varchar(10) not null check (kind in ('charge','refund')),
  method             varchar(20) not null check (method in ('cash','mobile_money','bank_transfer','card','cheque','legacy')),
  amount             numeric(18,2) not null check (amount > 0),
  currency           char(3) not null references shared.currencies(code),
  status             varchar(20) not null check (status in ('pending','succeeded','failed','reversed')),
  -- Source vérifiable de la confirmation (jamais une redirection navigateur) :
  source             varchar(30) not null check (source in
    ('counter_receipt','provider_webhook','provider_query','legacy_migration')),
  provider           varchar(60),
  provider_reference varchar(160),
  receipt_reference  varchar(120),
  evidence           jsonb not null default '{}'::jsonb,
  recorded_by        uuid references identity.profiles(id),
  occurred_at        timestamptz not null default now(),
  created_at         timestamptz not null default now(),
  constraint ck_counter_receipt check (source <> 'counter_receipt' or (receipt_reference is not null and recorded_by is not null))
);
create index idx_payment_tx_payment on canada.payment_transactions(payment_id);
create unique index uq_payment_tx_provider on canada.payment_transactions(provider, provider_reference)
  where provider_reference is not null;
create unique index uq_payment_tx_receipt on canada.payment_transactions(payment_id, receipt_reference)
  where receipt_reference is not null;
create trigger trg_payment_tx_append_only before update or delete on canada.payment_transactions
  for each row execute function private.forbid_mutation();

create table canada.refunds (
  id                 uuid primary key default gen_random_uuid(),
  payment_id         uuid not null references canada.payments(id),
  amount             numeric(18,2) not null check (amount > 0),
  currency           char(3) not null references shared.currencies(code),
  reason             text not null,
  status             varchar(20) not null default 'requested' check (status in ('requested','approved','rejected','executed')),
  requested_by       uuid not null references identity.profiles(id),
  requested_at       timestamptz not null default now(),
  decided_by         uuid references identity.profiles(id),
  decided_at         timestamptz,
  decision_note      text,
  executed_by        uuid references identity.profiles(id),
  executed_at        timestamptz,
  transaction_id     uuid references canada.payment_transactions(id),
  -- Séparation des responsabilités : le demandeur n'approuve pas sa propre demande.
  constraint ck_refund_sod check (decided_by is null or decided_by <> requested_by)
);
create index idx_refunds_payment on canada.refunds(payment_id);
create trigger trg_refunds_no_delete before delete on canada.refunds
  for each row execute function private.forbid_mutation();

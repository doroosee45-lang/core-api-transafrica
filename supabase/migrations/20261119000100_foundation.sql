-- ============================================================================
-- 20261119000100_foundation.sql
-- Fondations : schémas logiques, fonctions utilitaires, référentiels partagés.
--
-- Références : Dossier 02 §2.1, Dossier 04 §6.2, Cahier §4.1, Spéc. backend §4.
-- Ce fichier ne crée AUCUN objet dans le schéma `auth` : il appartient à Supabase.
-- ============================================================================

create schema if not exists identity;
create schema if not exists access;
create schema if not exists organizations;
create schema if not exists shared;
create schema if not exists canada;
create schema if not exists audit;
create schema if not exists private;

-- Les schémas métier ne sont jamais ouverts au rôle PUBLIC.
revoke all on schema identity, access, organizations, shared, canada, audit, private from public;

-- ---------------------------------------------------------------------------
-- Fonctions utilitaires internes
-- ---------------------------------------------------------------------------
create or replace function private.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- Tables en ajout seul (journaux, historiques) : aucune modification ni suppression.
create or replace function private.forbid_mutation()
returns trigger language plpgsql as $$
begin
  raise exception 'APPEND_ONLY: % sur %.% est interdit (historique non modifiable)',
    tg_op, tg_table_schema, tg_table_name
    using errcode = '42501';
end $$;

-- Séquences métier lisibles (factures, références) : jamais réutilisées.
create table private.business_sequences (
  key        text primary key,
  last_value bigint not null default 0,
  updated_at timestamptz not null default now()
);

create or replace function private.next_sequence(p_key text, p_floor bigint default 0)
returns bigint language plpgsql as $$
declare v bigint;
begin
  insert into private.business_sequences(key, last_value) values (p_key, greatest(p_floor, 0))
  on conflict (key) do nothing;
  update private.business_sequences
     set last_value = greatest(last_value, p_floor) + 1, updated_at = now()
   where key = p_key
  returning last_value into v;
  return v;
end $$;

-- ---------------------------------------------------------------------------
-- Référentiels transversaux (Dossier 04 §6.2 : schéma shared)
-- ---------------------------------------------------------------------------
create table shared.currencies (
  code        char(3) primary key check (code ~ '^[A-Z]{3}$'),
  name        varchar(80) not null,
  minor_units smallint not null check (minor_units between 0 and 4),
  is_active   boolean not null default true
);

-- Pays ISO 3166-1 alpha-2. `is_operating` = pays d'exploitation Trans Afrique.
-- D'autres pays (escales, aéroports de transit) peuvent être ajoutés par un
-- administrateur global sans devenir pays d'exploitation.
create table shared.countries (
  code             char(2) primary key check (code ~ '^[A-Z]{2}$'),
  name_fr          varchar(120) not null,
  name_en          varchar(120) not null,
  default_currency char(3) references shared.currencies(code),
  phone_prefix     varchar(8),
  default_timezone varchar(64),
  is_operating     boolean not null default false,
  is_active        boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create trigger trg_countries_updated before update on shared.countries
  for each row execute function private.set_updated_at();

insert into shared.currencies(code, name, minor_units) values
  ('USD', 'Dollar américain', 2),
  ('EUR', 'Euro', 2),
  ('CAD', 'Dollar canadien', 2),
  ('CNY', 'Yuan renminbi', 2),
  ('XAF', 'Franc CFA (BEAC)', 0),
  ('CDF', 'Franc congolais', 2)
on conflict (code) do nothing;

-- Les cinq pays d'exploitation du cahier des charges (§1.1).
insert into shared.countries(code, name_fr, name_en, default_currency, phone_prefix, default_timezone, is_operating) values
  ('CN', 'Chine', 'China', 'CNY', '+86', 'Asia/Shanghai', true),
  ('CD', 'République démocratique du Congo', 'Democratic Republic of the Congo', 'CDF', '+243', 'Africa/Kinshasa', true),
  ('CG', 'République du Congo (Congo-Brazzaville)', 'Republic of the Congo', 'XAF', '+242', 'Africa/Brazzaville', true),
  ('CM', 'Cameroun', 'Cameroon', 'XAF', '+237', 'Africa/Douala', true),
  ('CA', 'Canada', 'Canada', 'CAD', '+1', 'America/Toronto', true)
on conflict (code) do nothing;

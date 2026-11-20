-- ============================================================================
-- 20261120000100_legacy_data_support.sql  (migration « expand », non destructive)
--
-- Reprise des données MongoDB (Document de migration §7) :
--  * les pesées historiques n'ont jamais eu de diviseur volumétrique : on
--    n'en invente pas. Diviseur et poids volumétrique deviennent facultatifs
--    UNIQUEMENT pour les mesures d'origine « legacy_migration » ;
--  * les colis historiques ne sont liés aux paiements que par une liste
--    d'identifiants : table d'association explicite (aucune relation perdue).
-- ============================================================================

alter table canada.parcel_measurements alter column volumetric_divisor drop not null;
alter table canada.parcel_measurements alter column volumetric_weight_kg drop not null;
alter table canada.parcel_measurements add constraint ck_measure_divisor_origin
  check (source = 'legacy_migration' or (volumetric_divisor is not null and volumetric_weight_kg is not null));

-- Lien paiement ↔ colis (multi-colis hérité du modèle Payment.packages).
create table canada.payment_parcels (
  payment_id uuid not null references canada.payments(id),
  parcel_id  uuid not null references canada.parcels(id),
  created_at timestamptz not null default now(),
  primary key (payment_id, parcel_id)
);
create trigger trg_payment_parcels_append_only before update or delete on canada.payment_parcels
  for each row execute function private.forbid_mutation();
alter table canada.payment_parcels enable row level security;
revoke all on canada.payment_parcels from anon, authenticated;

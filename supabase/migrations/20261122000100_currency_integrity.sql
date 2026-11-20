-- ============================================================================
-- 20261122000100_currency_integrity.sql
-- Cohérence des devises garantie par la base (défense en profondeur, Cahier §9.4,
-- Spéc. backend §16, Dossier 04 §11 « chaque montant possède une devise »).
-- Le service applicatif contrôle déjà ces règles ; la base les rend non contournables.
-- Migration ADDITIVE : aucune donnée existante n'est modifiée ; contrôle à l'écriture.
-- ============================================================================

create or replace function private.check_payment_child_currency()
returns trigger language plpgsql as $$
declare v_currency char(3);
begin
  select currency into v_currency from canada.payments where id = new.payment_id;
  if v_currency is distinct from new.currency then
    raise exception 'CURRENCY_MISMATCH: devise % différente de celle du paiement (%)', new.currency, v_currency
      using errcode = '23514';
  end if;
  return new;
end $$;

create trigger trg_payment_tx_currency before insert on canada.payment_transactions
  for each row execute function private.check_payment_child_currency();
create trigger trg_refunds_currency before insert or update of currency on canada.refunds
  for each row execute function private.check_payment_child_currency();

create or replace function private.check_quotation_line_currency()
returns trigger language plpgsql as $$
declare v_currency char(3);
begin
  select currency into v_currency from canada.quotation_versions where id = new.quotation_version_id;
  if v_currency is distinct from new.currency then
    raise exception 'CURRENCY_MISMATCH: ligne en % dans une version en %', new.currency, v_currency
      using errcode = '23514';
  end if;
  return new;
end $$;

create trigger trg_quotation_lines_currency before insert or update of currency on canada.quotation_lines
  for each row execute function private.check_quotation_line_currency();

-- Un paiement rattaché à une version de devis est dans la devise de cette version.
create or replace function private.check_payment_quote_currency()
returns trigger language plpgsql as $$
declare v_currency char(3);
begin
  if new.quotation_version_id is null then return new; end if;
  select currency into v_currency from canada.quotation_versions where id = new.quotation_version_id;
  if v_currency is distinct from new.currency then
    raise exception 'CURRENCY_MISMATCH: paiement en % pour un devis en %', new.currency, v_currency using errcode = '23514';
  end if;
  return new;
end $$;

create trigger trg_payments_quote_currency before insert or update of currency, quotation_version_id on canada.payments
  for each row execute function private.check_payment_quote_currency();

revoke all on function private.check_payment_child_currency(), private.check_quotation_line_currency(),
  private.check_payment_quote_currency() from public, anon, authenticated;

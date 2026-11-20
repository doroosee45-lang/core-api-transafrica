-- ============================================================================
-- 20261119000700_rls_policies.sql
-- Défense en profondeur (Dossier 03 §10.1, Spéc. identité §10.3).
--
-- Principe : le backend (Core API) est le point de passage des opérations
-- métier ; il se connecte avec un rôle serveur et applique RBAC + périmètres.
-- Les rôles Supabase `anon` et `authenticated` ne reçoivent AUCUN accès par
-- défaut. Seules quelques lectures « propriétaire » sont ouvertes, au cas où
-- un schéma serait un jour exposé à la Data API : refus par défaut ailleurs.
-- Ces schémas ne doivent PAS être ajoutés aux "Exposed schemas" de Supabase
-- sans revue de sécurité.
-- ============================================================================

do $$
declare r record;
begin
  for r in
    select n.nspname as s, c.relname as t
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where c.relkind = 'r'
       and n.nspname in ('identity','access','organizations','shared','canada','audit','private')
  loop
    execute format('alter table %I.%I enable row level security', r.s, r.t);
    execute format('revoke all on table %I.%I from anon, authenticated', r.s, r.t);
  end loop;
end $$;

revoke all on schema identity, access, organizations, shared, canada, audit, private from anon, authenticated;
revoke all on all functions in schema private from public, anon, authenticated;

-- Lectures « propriétaire » minimales pour un client authentifié.
grant usage on schema identity, shared, canada to authenticated;

grant select on identity.profiles to authenticated;
grant update (first_name, last_name, display_name, preferred_language) on identity.profiles to authenticated;
create policy profiles_select_own on identity.profiles
  for select to authenticated using (id = auth.uid());
create policy profiles_update_own on identity.profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

grant select on shared.notifications to authenticated;
grant update (read_at) on shared.notifications to authenticated;
create policy notifications_select_own on shared.notifications
  for select to authenticated using (user_id = auth.uid());
create policy notifications_update_own on shared.notifications
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

grant select on canada.clients to authenticated;
create policy clients_select_own on canada.clients
  for select to authenticated using (user_id = auth.uid());

grant select on canada.parcels to authenticated;
create policy parcels_select_own on canada.parcels
  for select to authenticated using (
    exists (select 1 from canada.clients c
             where c.user_id = auth.uid()
               and (c.id = canada.parcels.client_id or c.id = canada.parcels.recipient_client_id)));

grant select on canada.parcel_events to authenticated;
create policy parcel_events_select_own on canada.parcel_events
  for select to authenticated using (
    visibility = 'client' and exists (
      select 1 from canada.parcels p join canada.clients c
        on c.id = p.client_id or c.id = p.recipient_client_id
       where p.id = canada.parcel_events.parcel_id and c.user_id = auth.uid()));

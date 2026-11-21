-- Diagnostics READ ONLY à exécuter par le responsable DB en préproduction uniquement,
-- après approbation et depuis une session d'administration autorisée.
-- Ce fichier ne crée/modifie/supprime aucun rôle, droit, schéma ou donnée.
-- Ne pas ajouter/coller de chaînes de connexion, secrets ou résultats sensibles au dépôt.

-- 1) Rôle réel de la session de l'API : exécuter depuis le canal de connexion prévu,
--    sans jamais afficher DATABASE_URL.
select current_database() as database_name,
       session_user as session_role,
       current_user as effective_role,
       current_setting('pgrst.db_schemas', true) as postgrest_exposed_schemas;

select r.rolname,
       r.rolsuper,
       r.rolbypassrls,
       r.rolcreaterole,
       r.rolcreatedb,
       r.rolinherit,
       r.rolcanlogin
  from pg_roles r
 where r.rolname in (session_user, current_user)
 order by r.rolname;

-- 2) Schémas métier, rôles API/Supabase connus et droits USAGE/CREATE.
select r.rolname,
       n.nspname as schema_name,
       has_schema_privilege(r.oid, n.oid, 'USAGE') as can_use,
       has_schema_privilege(r.oid, n.oid, 'CREATE') as can_create
  from pg_roles r
 cross join pg_namespace n
 where r.rolname in (session_user, current_user, 'anon', 'authenticated', 'service_role')
   and n.nspname in ('public','identity','access','organizations','shared','canada','audit','private')
 order by r.rolname, n.nspname;

-- 3) RLS et force-RLS des relations métier.
select n.nspname as schema_name,
       c.relname as relation_name,
       c.relkind,
       c.relrowsecurity as rls_enabled,
       c.relforcerowsecurity as rls_forced,
       pg_get_userbyid(c.relowner) as owner_name
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
 where c.relkind in ('r','p','v','m')
   and n.nspname in ('identity','access','organizations','shared','canada','audit','private')
 order by n.nspname, c.relname;

-- 4) Privilèges objet accordés aux rôles de connexion/plateforme connus.
select grantee,
       table_schema,
       table_name,
       privilege_type
  from information_schema.table_privileges
 where grantee in (session_user, current_user, 'anon', 'authenticated', 'service_role')
   and table_schema in ('public','identity','access','organizations','shared','canada','audit','private')
 order by grantee, table_schema, table_name, privilege_type;

-- 5) Fonctions SECURITY DEFINER et fonctions exécutables par les rôles exposés.
select n.nspname as schema_name,
       p.proname as function_name,
       pg_get_userbyid(p.proowner) as owner_name,
       p.prosecdef as security_definer,
       has_function_privilege('anon', p.oid, 'EXECUTE') as anon_can_execute,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_can_execute,
       has_function_privilege(current_user, p.oid, 'EXECUTE') as api_role_can_execute
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname in ('identity','access','organizations','shared','canada','audit','private')
 order by n.nspname, p.proname;

-- Interprétation à documenter séparément : rôle attendu, privilèges nécessaires,
-- exposition Data API, contournement RLS éventuel et justification. Ne pas exécuter
-- ces diagnostics sur production sans autorisation écrite.

-- ============================================================================
-- 20261119000200_identity_access.sql
-- Identité commune, accès aux plateformes, RBAC à périmètres, organisations,
-- invitations et journaux d'audit.
--
-- Références : Dossier 02 (§3 à §9), Dossier 03 (§2, §6, §7, §9), Spéc. identité.
-- auth.users reste la source de vérité de l'authentification (Supabase).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- identity
-- ---------------------------------------------------------------------------
create table identity.profiles (
  id                   uuid primary key references auth.users(id) on delete restrict,
  first_name           varchar(100) not null check (length(trim(first_name)) > 0),
  last_name            varchar(100) not null check (length(trim(last_name)) > 0),
  display_name         varchar(160),
  avatar_path          text,
  country_of_residence char(2) references shared.countries(code),
  preferred_language   varchar(10) not null default 'fr' check (preferred_language in ('fr', 'en')),
  account_status       varchar(30) not null default 'pending_verification'
    check (account_status in ('pending_verification','active','restricted','suspended','deletion_pending','anonymized')),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create trigger trg_profiles_updated before update on identity.profiles
  for each row execute function private.set_updated_at();

create table identity.contact_methods (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references identity.profiles(id) on delete cascade,
  contact_type     varchar(20) not null check (contact_type in ('email', 'phone')),
  contact_value    text not null,
  normalized_value text not null,
  is_verified      boolean not null default false,
  is_primary       boolean not null default false,
  verified_at      timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index idx_contact_methods_user on identity.contact_methods(user_id);
create unique index uq_contact_primary on identity.contact_methods(user_id, contact_type) where is_primary;
create trigger trg_contact_methods_updated before update on identity.contact_methods
  for each row execute function private.set_updated_at();

create table identity.user_preferences (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references identity.profiles(id) on delete cascade,
  preference_key   varchar(100) not null,
  preference_value jsonb not null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (user_id, preference_key)
);
create trigger trg_user_preferences_updated before update on identity.user_preferences
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------------
-- access
-- ---------------------------------------------------------------------------
create table access.platforms (
  id          smallint primary key,
  code        varchar(20) not null unique,
  name        varchar(100) not null,
  description text,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now()
);
insert into access.platforms(id, code, name) values
  (1, 'CANADA', 'Trans Afrique Canada'),
  (2, 'MARKET', 'Trans Afrique Market')
on conflict (id) do nothing;

create table access.user_platform_access (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references identity.profiles(id) on delete restrict,
  platform_id   smallint not null references access.platforms(id),
  access_status varchar(30) not null default 'active' check (access_status in ('pending','active','suspended','revoked')),
  granted_at    timestamptz not null default now(),
  granted_by    uuid references identity.profiles(id),
  suspended_at  timestamptz,
  revoked_at    timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (user_id, platform_id)
);
create trigger trg_upa_updated before update on access.user_platform_access
  for each row execute function private.set_updated_at();

create table access.roles (
  id             uuid primary key default gen_random_uuid(),
  platform_id    smallint not null references access.platforms(id),
  code           varchar(80) not null,
  name           varchar(120) not null,
  description    text,
  is_system_role boolean not null default false,
  -- Rôles sensibles : comptent uniquement si la session est en AAL2 (MFA).
  requires_mfa   boolean not null default false,
  -- Rôle exceptionnel : attribution limitée dans le temps et justifiée.
  is_exceptional boolean not null default false,
  -- Périmètres autorisés pour ce rôle (ex. client => own uniquement).
  allowed_scopes text[] not null default array['global','country','agency','warehouse']::text[],
  is_active      boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (platform_id, code)
);
create trigger trg_roles_updated before update on access.roles
  for each row execute function private.set_updated_at();

create table access.permissions (
  id          uuid primary key default gen_random_uuid(),
  platform_id smallint not null references access.platforms(id),
  code        varchar(120) not null,
  module      varchar(80) not null,
  action      varchar(40) not null,
  description text,
  -- Permission qui n'a de sens qu'au périmètre global (ex. gestion des pays).
  global_only boolean not null default false,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  unique (platform_id, code)
);

create table access.role_permissions (
  role_id       uuid not null references access.roles(id) on delete cascade,
  permission_id uuid not null references access.permissions(id) on delete cascade,
  granted_at    timestamptz not null default now(),
  granted_by    uuid references identity.profiles(id),
  primary key (role_id, permission_id)
);

-- Cohérence de plateforme : une permission Market ne peut pas être liée à un rôle Canada.
create or replace function private.check_role_permission_platform()
returns trigger language plpgsql as $$
begin
  if (select platform_id from access.roles where id = new.role_id)
     is distinct from (select platform_id from access.permissions where id = new.permission_id) then
    raise exception 'PLATFORM_MISMATCH: rôle et permission de plateformes différentes' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger trg_role_permissions_platform before insert or update on access.role_permissions
  for each row execute function private.check_role_permission_platform();

create table access.user_roles (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references identity.profiles(id) on delete restrict,
  role_id           uuid not null references access.roles(id),
  scope_type        varchar(30) not null check (scope_type in ('global','country','organization','agency','warehouse','own')),
  scope_id          uuid,
  scope_country     char(2) references shared.countries(code),
  justification     text,
  assigned_by       uuid references identity.profiles(id),
  assigned_at       timestamptz not null default now(),
  valid_from        timestamptz not null default now(),
  expires_at        timestamptz,
  revoked_at        timestamptz,
  revoked_by        uuid references identity.profiles(id),
  revocation_reason text,
  constraint ck_user_roles_scope check (
    (scope_type in ('global','own') and scope_id is null and scope_country is null) or
    (scope_type = 'country' and scope_country is not null and scope_id is null) or
    (scope_type in ('organization','agency','warehouse') and scope_id is not null and scope_country is null)
  ),
  constraint ck_user_roles_expiry check (expires_at is null or expires_at > valid_from),
  constraint ck_user_roles_revocation check (revoked_at is not null or (revoked_by is null and revocation_reason is null))
);
create index idx_user_roles_user on access.user_roles(user_id) where revoked_at is null;
create index idx_user_roles_role on access.user_roles(role_id);
-- Une même attribution active ne peut exister deux fois.
create unique index uq_user_roles_active on access.user_roles(
  user_id, role_id, scope_type, coalesce(scope_id, '00000000-0000-0000-0000-000000000000'::uuid), coalesce(scope_country, '--')
) where revoked_at is null;

-- Une attribution révoquée n'est jamais supprimée (audit) : DELETE interdit.
create trigger trg_user_roles_no_delete before delete on access.user_roles
  for each row execute function private.forbid_mutation();

-- Contrôle de périmètre autorisé par rôle.
create or replace function private.check_user_role_scope()
returns trigger language plpgsql as $$
declare allowed text[];
begin
  select allowed_scopes into allowed from access.roles where id = new.role_id;
  if not (new.scope_type = any(allowed)) then
    raise exception 'SCOPE_NOT_ALLOWED: périmètre % interdit pour ce rôle', new.scope_type using errcode = '23514';
  end if;
  return new;
end $$;
create trigger trg_user_roles_scope before insert on access.user_roles
  for each row execute function private.check_user_role_scope();

-- Une attribution n'est modifiable que pour être révoquée, une seule fois.
create or replace function private.user_roles_revoke_only()
returns trigger language plpgsql as $$
begin
  if old.revoked_at is not null then
    raise exception 'ROLE_ALREADY_REVOKED: attribution déjà révoquée' using errcode = '42501';
  end if;
  if (new.user_id, new.role_id, new.scope_type, new.scope_id, new.scope_country, new.assigned_by,
      new.assigned_at, new.valid_from, new.expires_at, new.justification)
     is distinct from
     (old.user_id, old.role_id, old.scope_type, old.scope_id, old.scope_country, old.assigned_by,
      old.assigned_at, old.valid_from, old.expires_at, old.justification) then
    raise exception 'ROLE_ASSIGNMENT_IMMUTABLE: seule la révocation est autorisée' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger trg_user_roles_revoke_only before update on access.user_roles
  for each row execute function private.user_roles_revoke_only();

-- ---------------------------------------------------------------------------
-- organizations (Dossier 02 §5) — utilisé par Market (fournisseurs) et par les
-- partenaires. Les agences et entrepôts Canada restent des entités métier.
-- ---------------------------------------------------------------------------
create table organizations.organizations (
  id                  uuid primary key default gen_random_uuid(),
  platform_id         smallint not null references access.platforms(id),
  organization_type   varchar(50) not null check (organization_type in
    ('supplier','agency','warehouse_operator','logistics_partner','corporate_customer','other_authorized_type')),
  name                varchar(180) not null,
  legal_name          varchar(180),
  registration_number varchar(120),
  country_code        char(2) not null references shared.countries(code),
  status              varchar(30) not null default 'pending' check (status in ('pending','active','suspended','closed')),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index idx_organizations_platform_status on organizations.organizations(platform_id, status);
create trigger trg_organizations_updated before update on organizations.organizations
  for each row execute function private.set_updated_at();

create table organizations.organization_members (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references organizations.organizations(id),
  user_id           uuid not null references identity.profiles(id),
  membership_status varchar(30) not null default 'active' check (membership_status in ('invited','active','suspended','removed')),
  joined_at         timestamptz not null default now(),
  invited_by        uuid references identity.profiles(id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create unique index uq_org_member_active on organizations.organization_members(organization_id, user_id)
  where membership_status in ('invited','active');
create trigger trg_org_members_updated before update on organizations.organization_members
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------------
-- Invitations professionnelles (Dossier 02 §7.1) — le jeton brut n'est jamais stocké.
-- ---------------------------------------------------------------------------
create table access.invitations (
  id               uuid primary key default gen_random_uuid(),
  email_normalized text not null check (email_normalized = lower(trim(email_normalized))),
  platform_id      smallint not null references access.platforms(id),
  organization_id  uuid references organizations.organizations(id),
  role_id          uuid not null references access.roles(id),
  scope_type       varchar(30) not null,
  scope_id         uuid,
  scope_country    char(2) references shared.countries(code),
  token_hash       text not null unique,
  status           varchar(30) not null default 'pending' check (status in ('pending','accepted','revoked','expired')),
  invited_by       uuid not null references identity.profiles(id),
  expires_at       timestamptz not null,
  accepted_at      timestamptz,
  accepted_by      uuid references identity.profiles(id),
  revoked_at       timestamptz,
  created_at       timestamptz not null default now()
);
create index idx_invitations_email_status on access.invitations(email_normalized, status);

-- ---------------------------------------------------------------------------
-- audit — journaux en ajout seul
-- ---------------------------------------------------------------------------
create table audit.security_events (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid,
  platform_id    smallint,
  event_type     varchar(100) not null,
  actor_user_id  uuid,
  ip_address     inet,
  user_agent     text,
  correlation_id uuid,
  metadata       jsonb not null default '{}'::jsonb,
  occurred_at    timestamptz not null default now()
);
create index idx_security_events_user on audit.security_events(user_id, occurred_at desc);
create index idx_security_events_type on audit.security_events(event_type, occurred_at desc);

create table audit.access_changes (
  id             uuid primary key default gen_random_uuid(),
  actor_user_id  uuid,
  target_user_id uuid not null,
  platform_id    smallint not null,
  role_id        uuid,
  permission_id  uuid,
  change_type    varchar(30) not null check (change_type in ('grant','revoke','invite','invite_accept','invite_revoke','platform_access','role_definition')),
  reason         text,
  previous_state jsonb,
  new_state      jsonb,
  correlation_id uuid,
  occurred_at    timestamptz not null default now()
);
create index idx_access_changes_target on audit.access_changes(target_user_id, occurred_at desc);

-- Journal métier des opérations sensibles (Cahier §3.2, Spéc. backend §27.4).
create table audit.audit_events (
  id             uuid primary key default gen_random_uuid(),
  platform_id    smallint not null default 1,
  actor_user_id  uuid,
  actor_kind     varchar(20) not null default 'user' check (actor_kind in ('user','system','integration','migration')),
  action         varchar(120) not null,
  resource_type  varchar(80) not null,
  resource_id    text,
  country_code   char(2),
  agency_id      uuid,
  previous_value jsonb,
  new_value      jsonb,
  reason         text,
  correlation_id uuid,
  occurred_at    timestamptz not null default now()
);
create index idx_audit_events_resource on audit.audit_events(resource_type, resource_id, occurred_at desc);
create index idx_audit_events_actor on audit.audit_events(actor_user_id, occurred_at desc);
create index idx_audit_events_country on audit.audit_events(country_code, occurred_at desc);

create trigger trg_security_events_append_only before update or delete on audit.security_events
  for each row execute function private.forbid_mutation();
create trigger trg_access_changes_append_only before update or delete on audit.access_changes
  for each row execute function private.forbid_mutation();
create trigger trg_audit_events_append_only before update or delete on audit.audit_events
  for each row execute function private.forbid_mutation();

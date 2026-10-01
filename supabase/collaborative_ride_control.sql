-- Additive preparation only. Apply after admin_security.sql and ride-control setup.
-- This file neither initializes a draft nor enables shared mode for any plan.
-- Cutover and every writer's compatibility fence must be installed together later.
begin;

create table if not exists rides_private.ride_shared_workspaces (
  plan_date date primary key references rides_private.ride_plans(plan_date),
  draft_revision bigint not null default 0 check (draft_revision >= 0),
  published_revision bigint not null default 0 check (published_revision >= 0),
  baseline_published_revision bigint not null default 0 check (baseline_published_revision >= 0),
  event_cursor bigint not null default 0 check (event_cursor >= 0),
  drivers jsonb not null default '[]'::jsonb check (jsonb_typeof(drivers) = 'array'),
  settings jsonb not null default '{}'::jsonb check (jsonb_typeof(settings) = 'object'),
  settings_version bigint not null default 1 check (settings_version > 0),
  status text not null default 'draft' check (status in ('draft', 'published')),
  last_actor_key text,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table if not exists rides_private.ride_shared_riders (
  plan_date date not null references rides_private.ride_shared_workspaces(plan_date),
  id uuid not null default gen_random_uuid(),
  entity_version bigint not null default 1 check (entity_version > 0),
  driver_slug text not null default '',
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object'),
  deleted boolean not null default false,
  last_actor_key text,
  updated_at timestamptz not null default now(),
  primary key (plan_date, id)
);

create table if not exists rides_private.ride_shared_groups (
  plan_date date not null references rides_private.ride_shared_workspaces(plan_date),
  group_key text not null,
  group_version bigint not null default 1 check (group_version > 0),
  last_actor_key text,
  primary key (plan_date, group_key)
);

-- Master record versions are global, not tied to a particular plan's draft.
create table if not exists rides_private.ride_shared_person_versions (
  person_id uuid primary key,
  record_version bigint not null default 1 check (record_version > 0),
  last_actor_key text,
  updated_at timestamptz not null default now()
);
create table if not exists rides_private.ride_shared_settings_versions (
  settings_key text primary key,
  record_version bigint not null default 1 check (record_version > 0),
  last_actor_key text,
  updated_at timestamptz not null default now()
);

-- IDs order committed events when writers hold the workspace lock. No rider/contact
-- payload belongs here; readers fetch protected detail through the snapshot RPC.
create table if not exists rides_private.ride_shared_events (
  event_id bigint generated always as identity primary key,
  plan_date date not null references rides_private.ride_shared_workspaces(plan_date),
  draft_revision bigint not null check (draft_revision >= 0),
  actor_key text not null,
  event_type text not null,
  created_at timestamptz not null default now()
);
create index if not exists ride_shared_events_plan_cursor_idx
  on rides_private.ride_shared_events (plan_date, event_id);

-- Operation identity is scoped to plan and validated stable actor, never token.
-- canonical request is needed to reject a different body under the same UUID.
create table if not exists rides_private.ride_shared_operations (
  plan_date date not null references rides_private.ride_shared_workspaces(plan_date),
  actor_key text not null,
  operation_id uuid not null,
  request jsonb not null check (jsonb_typeof(request) = 'object'),
  result jsonb not null check (jsonb_typeof(result) = 'object'),
  created_at timestamptz not null default now(),
  primary key (plan_date, actor_key, operation_id)
);

create table if not exists rides_private.ride_shared_recovery_candidates (
  id uuid primary key default gen_random_uuid(),
  plan_date date not null references rides_private.ride_plans(plan_date),
  actor_key text not null,
  source text not null check (source in ('server', 'device')),
  source_key text not null,
  baseline_published_revision bigint check (baseline_published_revision >= 0),
  candidate jsonb not null check (jsonb_typeof(candidate) = 'object'),
  saved_at timestamptz,
  captured_at timestamptz not null default now(),
  unique (plan_date, actor_key, source, source_key)
);

create table if not exists rides_private.ride_shared_write_modes (
  plan_date date primary key references rides_private.ride_plans(plan_date),
  write_mode text not null default 'legacy' check (write_mode in ('legacy', 'shared', 'paused')),
  changed_by text,
  updated_at timestamptz not null default now()
);

-- No policies and no client grants: every private read/write goes through a
-- narrowly authorized RPC. Scope revocation to these new objects only.
do $$
declare v_table text;
begin
  foreach v_table in array array[
    'ride_shared_workspaces', 'ride_shared_riders', 'ride_shared_groups',
    'ride_shared_person_versions', 'ride_shared_settings_versions',
    'ride_shared_events', 'ride_shared_operations',
    'ride_shared_recovery_candidates', 'ride_shared_write_modes'
  ] loop
    execute format('alter table rides_private.%I enable row level security', v_table);
    execute format('alter table rides_private.%I force row level security', v_table);
    execute format('revoke all on table rides_private.%I from public, anon, authenticated', v_table);
  end loop;
end;
$$;
revoke all on sequence rides_private.ride_shared_events_event_id_seq from public, anon, authenticated;

create or replace function rides_private.ride_shared_actor(p_admin_code text)
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $$
declare
  v_profile jsonb;
  v_claims jsonb;
  v_user_id uuid;
  v_session_id uuid;
  v_exp numeric;
  v_admin record;
begin
  -- Use the current verified profile-session lookup, not client-supplied slugs.
  -- Profile-first precedence matches the existing draft actor key.
  v_profile := rides_private.ride_admin_profile_session_actor(p_admin_code);
  if v_profile->>'type' = 'profile' and nullif(v_profile->>'profileSlug', '') is not null then
    return v_profile || jsonb_build_object('actorKey', 'profile:' || lower(v_profile->>'profileSlug'));
  end if;

  -- JWT claims must come from the verified API gateway. Never consult user_metadata.
  -- Active admin membership AND the current server session are required.
  begin
    v_claims := auth.jwt();
    if jsonb_typeof(v_claims->'exp') is distinct from 'number' then return null; end if;
    v_user_id := auth.uid();
    v_session_id := nullif(v_claims->>'session_id', '')::uuid;
    v_exp := nullif(v_claims->>'exp', '')::numeric;
  exception when invalid_text_representation or numeric_value_out_of_range then
    return null;
  end;
  if v_user_id is null or v_session_id is null or v_exp is null
     or v_exp <= extract(epoch from statement_timestamp()) then
    return null;
  end if;
  select u.auth_user_id, u.email, u.display_name into v_admin
  from rides_private.ride_admin_users u
  join auth.sessions s on s.user_id = u.auth_user_id and s.id = v_session_id
  where u.auth_user_id = v_user_id and u.active
    and (s.not_after is null or s.not_after > statement_timestamp());
  if v_admin.auth_user_id is null then return null; end if;
  return jsonb_build_object(
    'type', 'user', 'userId', v_admin.auth_user_id::text,
    'email', v_admin.email, 'label', coalesce(nullif(v_admin.display_name, ''), v_admin.email),
    'actorKey', 'user:' || v_admin.auth_user_id::text
  );
end;
$$;
revoke execute on function rides_private.ride_shared_actor(text) from public, anon, authenticated;

create or replace function public.ride_admin_shared_context(
  p_admin_code text,
  p_plan_date date,
  p_after_event bigint default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $$
declare
  v_actor jsonb := rides_private.ride_shared_actor(p_admin_code);
  v_workspace rides_private.ride_shared_workspaces%rowtype;
  v_mode text;
  v_events jsonb;
begin
  if v_actor is null then return jsonb_build_object('ok', false, 'code', 'invalid_admin_code'); end if;
  if p_plan_date is null or not exists (select 1 from rides_private.ride_plans where plan_date = p_plan_date) then
    return jsonb_build_object('ok', false, 'code', 'plan_not_found');
  end if;
  select * into v_workspace from rides_private.ride_shared_workspaces where plan_date = p_plan_date;
  select write_mode into v_mode from rides_private.ride_shared_write_modes where plan_date = p_plan_date;
  select coalesce(jsonb_agg(jsonb_build_object(
    'eventCursor', e.event_id, 'planDate', e.plan_date, 'draftRevision', e.draft_revision,
    'actorKey', e.actor_key, 'type', e.event_type
  ) order by e.event_id), '[]'::jsonb) into v_events
  from rides_private.ride_shared_events e
  where e.plan_date = p_plan_date and e.event_id > greatest(coalesce(p_after_event, 0), 0)
    and e.event_id <= coalesce(v_workspace.event_cursor, 0);
  return jsonb_build_object(
    'ok', true, 'actor', v_actor - 'actorKey', 'actorKey', v_actor->>'actorKey',
    'planDate', p_plan_date, 'initialized', v_workspace.plan_date is not null,
    'writeMode', coalesce(v_mode, 'legacy'), 'draftRevision', coalesce(v_workspace.draft_revision, 0),
    'publishedRevision', coalesce(v_workspace.published_revision, 0),
    'baselinePublishedRevision', coalesce(v_workspace.baseline_published_revision, 0),
    'eventCursor', coalesce(v_workspace.event_cursor, 0),
    'settingsVersion', coalesce(v_workspace.settings_version, 1), 'events', v_events
  );
end;
$$;

create or replace function public.ride_admin_shared_snapshot(p_admin_code text, p_plan_date date)
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $$
declare
  v_actor jsonb := rides_private.ride_shared_actor(p_admin_code);
  v_workspace rides_private.ride_shared_workspaces%rowtype;
  v_mode text;
  v_riders jsonb;
  v_groups jsonb;
begin
  if v_actor is null then return jsonb_build_object('ok', false, 'code', 'invalid_admin_code'); end if;
  if p_plan_date is null or not exists (select 1 from rides_private.ride_plans where plan_date = p_plan_date) then
    return jsonb_build_object('ok', false, 'code', 'plan_not_found');
  end if;
  select * into v_workspace from rides_private.ride_shared_workspaces where plan_date = p_plan_date;
  if v_workspace.plan_date is null then return jsonb_build_object('ok', false, 'code', 'not_initialized'); end if;
  select write_mode into v_mode from rides_private.ride_shared_write_modes where plan_date = p_plan_date;
  select coalesce(jsonb_agg(r.payload || jsonb_build_object(
    'id', r.id::text, 'entityVersion', r.entity_version, 'driverSlug', r.driver_slug,
    'lastActorKey', r.last_actor_key
  ) order by r.driver_slug, r.id), '[]'::jsonb) into v_riders
  from rides_private.ride_shared_riders r where r.plan_date = p_plan_date and not r.deleted;
  select coalesce(jsonb_object_agg(g.group_key, g.group_version), '{}'::jsonb) into v_groups
  from rides_private.ride_shared_groups g where g.plan_date = p_plan_date;
  return jsonb_build_object(
    'ok', true, 'planDate', p_plan_date,
    'draftRevision', v_workspace.draft_revision, 'publishedRevision', v_workspace.published_revision,
    'baselinePublishedRevision', v_workspace.baseline_published_revision,
    'eventCursor', v_workspace.event_cursor, 'drivers', v_workspace.drivers,
    'riders', v_riders, 'groupVersions', v_groups, 'settings', v_workspace.settings,
    'settingsVersion', v_workspace.settings_version, 'writeMode', coalesce(v_mode, 'legacy'),
    'status', v_workspace.status, 'lastActorKey', v_workspace.last_actor_key,
    'publishedSnapshot', public.ride_admin_snapshot(p_admin_code, p_plan_date)
  );
end;
$$;

revoke execute on function public.ride_admin_shared_context(text, date, bigint) from public;
revoke execute on function public.ride_admin_shared_snapshot(text, date) from public;
grant execute on function public.ride_admin_shared_context(text, date, bigint) to anon, authenticated;
grant execute on function public.ride_admin_shared_snapshot(text, date) to anon, authenticated;
commit;

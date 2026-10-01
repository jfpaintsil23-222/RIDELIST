-- Additive preparation only. Apply after admin_security.sql and ride-control setup.
-- This file neither initializes a draft nor enables shared mode for any plan.
-- Production cutover/recovery is installed later; compatibility fences accompany these RPCs.
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
alter table rides_private.ride_shared_workspaces add column if not exists published_source_hash text;

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

-- Catalog identity is the stable slug; plan driver rows may be removed/recreated.
-- Credentials remain private and use the existing legacy hash implementation.
create table if not exists rides_private.ride_driver_catalog (
  slug text primary key, id uuid not null default gen_random_uuid() unique, display_name text not null, full_name text not null,
  initials text not null, route_notes text not null default '', access_code_hash text not null,
  created_at timestamptz not null default now()
);
alter table rides_private.ride_driver_catalog enable row level security;
alter table rides_private.ride_driver_catalog force row level security;
revoke all on rides_private.ride_driver_catalog from public,anon,authenticated;
insert into rides_private.ride_driver_catalog(slug,display_name,full_name,initials,route_notes,access_code_hash)
select distinct on (slug) slug,display_name,full_name,initials,coalesce(route_notes,''),access_code_hash
from rides_private.ride_drivers order by slug,updated_at desc,id
on conflict(slug) do nothing;

-- Resolve explicit UUID spellings only. Malformed legacy links remain unknown.
create or replace function rides_private.ride_shared_person_id(p_payload jsonb)
returns uuid language plpgsql immutable set search_path to '' as $$
begin
  return nullif(p_payload->>'personId','')::uuid;
exception when invalid_text_representation then return null;
end;
$$;
revoke execute on function rides_private.ride_shared_person_id(jsonb) from public,anon,authenticated;

-- A protected master projection: versions default to 1 for existing legacy records.
create or replace function rides_private.ride_shared_person_json(p_id uuid)
returns jsonb language sql stable security definer set search_path to '' as $$
  select jsonb_build_object('id',p.id,'name',p.name,'phone',p.phone,
    'homeAddress',p.home_address,'campusAddress',p.campus_address,
    'homeGoogleMaps',p.home_google_maps,'homeAppleMaps',p.home_apple_maps,
    'campusGoogleMaps',p.campus_google_maps,'campusAppleMaps',p.campus_apple_maps,
    'preferredAddressType',p.preferred_address_type,'sourceLabel',p.source_label,
    'notes',p.notes,'active',p.active,'recordVersion',coalesce(v.record_version,1))
  from rides_private.ride_people p left join rides_private.ride_shared_person_versions v on v.person_id=p.id
  where p.id=p_id;
$$;
revoke execute on function rides_private.ride_shared_person_json(uuid) from public,anon,authenticated;

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
  select coalesce(jsonb_agg(r.payload || case when rides_private.ride_shared_person_id(r.payload) is not null
    then jsonb_build_object('personId',rides_private.ride_shared_person_id(r.payload),'personLinkStatus','linked')
    else jsonb_build_object('personLinkStatus','unknown') end || jsonb_build_object(
    'id', r.id::text, 'entityVersion', r.entity_version, 'driverSlug', r.driver_slug,
    'lastActorKey', r.last_actor_key, 'unassigned', r.driver_slug = ''
  ) order by r.driver_slug, r.id), '[]'::jsonb) into v_riders
  from rides_private.ride_shared_riders r where r.plan_date = p_plan_date and not r.deleted;
  select coalesce(jsonb_object_agg(g.group_key, g.group_version), '{}'::jsonb) into v_groups
  from rides_private.ride_shared_groups g where g.plan_date = p_plan_date;
  return jsonb_build_object(
    'ok', true, 'planDate', p_plan_date,
    'draftRevision', v_workspace.draft_revision, 'publishedRevision', v_workspace.published_revision,
    'baselinePublishedRevision', v_workspace.baseline_published_revision,
    'eventCursor', v_workspace.event_cursor, 'drivers', (
      select coalesce(jsonb_agg(item.value || jsonb_build_object('driverId',catalog.id) order by item.ordinality),'[]'::jsonb)
      from jsonb_array_elements(v_workspace.drivers) with ordinality item(value,ordinality)
      left join rides_private.ride_driver_catalog catalog on catalog.slug=item.value->>'slug'),
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
-- Retain result/tombstone rows indefinitely in this release (at least 30 days).
-- Expired IDs are never executable again; status lookup still returns their outcome.
alter table rides_private.ride_shared_operations add column if not exists request_hash text;
update rides_private.ride_shared_operations set request_hash=md5(request::text) where request_hash is null;
alter table rides_private.ride_shared_operations alter column request_hash set not null;

create or replace function public.ride_admin_shared_operation(p_admin_code text,p_plan_date date,p_operation_id uuid)
returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare v_actor jsonb:=rides_private.ride_shared_actor(p_admin_code); v_result jsonb;
begin
  if v_actor is null then return jsonb_build_object('ok',false,'code','invalid_admin_code'); end if;
  select result into v_result from rides_private.ride_shared_operations
    where plan_date=p_plan_date and actor_key=v_actor->>'actorKey' and operation_id=p_operation_id;
  return coalesce(v_result,jsonb_build_object('ok',false,'code','not_found','operationId',p_operation_id));
end;
$$;

-- Single locked engine also owns publication deduplication. Clients cannot call it.
create or replace function rides_private.ride_shared_apply(p_admin_code text,p_plan_date date,p_request jsonb)
returns jsonb language plpgsql volatile security definer set search_path to '' as $$
declare
  v_actor jsonb:=rides_private.ride_shared_actor(p_admin_code);
  w rides_private.ride_shared_workspaces%rowtype;
  v_rider rides_private.ride_shared_riders%rowtype;
  previous rides_private.ride_shared_operations%rowtype;
  v_id uuid; v_entity uuid; v_kind text; v_payload jsonb; v_groups jsonb; v_key text;
  v_affected text[]:=array[]::text[]; v_changed uuid[]:=array[]::uuid[];
  v_new boolean:=false; v_old_slug text; v_slug text; v_version bigint;
  v_result jsonb; v_value jsonb; v_cursor bigint; v_code text; v_conflict jsonb;
  v_drivers jsonb; v_ids jsonb; v_plan_id uuid; v_stops jsonb; v_deleted text[];
  v_before_stops jsonb; v_before_stop jsonb; v_after_stop jsonb;
  v_person uuid; v_person_json jsonb; v_master_version bigint; v_other date;
  v_settings_key text; v_fields text[];
begin
  if v_actor is null then return jsonb_build_object('ok',false,'code','invalid_admin_code'); end if;
  if p_request is null or jsonb_typeof(p_request)<>'object' then return jsonb_build_object('ok',false,'code','validation_failed'); end if;
  begin v_id:=(p_request->>'operationId')::uuid;
  exception when invalid_text_representation then return jsonb_build_object('ok',false,'code','validation_failed'); end;
  if v_id is null then return jsonb_build_object('ok',false,'code','validation_failed'); end if;
  -- Global master writers lock ALL plans in date order before any workspace/master.
  -- Publication holds its plan lock through dependency checks and all live writes.
  v_kind:=p_request->>'kind';
  if v_kind in ('person_save','settings_branding','catalog_add') then
    perform 1 from rides_private.ride_plans order by plan_date for update;
  else
    perform 1 from rides_private.ride_plans where plan_date=p_plan_date for update;
  end if;
  select * into w from rides_private.ride_shared_workspaces where plan_date=p_plan_date for update;
  if w.plan_date is null then return jsonb_build_object('ok',false,'code','not_initialized','operationId',v_id); end if;
  select * into previous from rides_private.ride_shared_operations where plan_date=p_plan_date and actor_key=v_actor->>'actorKey' and operation_id=v_id;
  if previous.operation_id is not null then
    if previous.request_hash<>md5(p_request::text) or previous.request<>p_request then
      return jsonb_build_object('ok',false,'code','operation_id_reused','operationId',v_id,'draftRevision',w.draft_revision,'eventCursor',w.event_cursor);
    end if;
    if previous.created_at<statement_timestamp()-interval '30 days' then
      return jsonb_build_object('ok',false,'code','operation_expired','operationId',v_id,'draftRevision',w.draft_revision,'eventCursor',w.event_cursor);
    end if;
    return previous.result;
  end if;
  v_kind:=p_request->>'kind'; v_payload:=p_request->'payload'; v_groups:=p_request->'expectedGroupVersions';
  insert into rides_private.ride_shared_operations(plan_date,actor_key,operation_id,request,request_hash,result)
  values(p_plan_date,v_actor->>'actorKey',v_id,p_request,md5(p_request::text),
    case when v_kind='publish' then jsonb_build_object('auditTransaction',pg_current_xact_id()::text) else '{}'::jsonb end);
  -- Every expected failure is recorded, including conflicts, without advancing revision/events.
  begin
    if not exists(select 1 from rides_private.ride_shared_write_modes where plan_date=p_plan_date and write_mode='shared') then
      v_code:='update_required'; raise exception using errcode='RS001';
    end if;
    if (p_request->>'planDate')::date is distinct from p_plan_date or jsonb_typeof(v_payload) is distinct from 'object' or jsonb_typeof(v_groups) is distinct from 'object' then
      v_code:='validation_failed'; raise exception using errcode='RS001';
    end if;
    if v_kind not in ('person_save','settings_branding','catalog_add') and (p_request->>'expectedBaselinePublishedRevision')::bigint is distinct from w.baseline_published_revision then
      v_code:='conflict'; v_conflict:=jsonb_build_object('type','baseline','actualVersion',w.baseline_published_revision); raise exception using errcode='RS001';
    end if;
    if v_kind in ('publish','plan_drivers') then
      -- Legacy plans may add catalog entries after this file was installed. Capture
      -- missing identities under the plan lock before any plan-row removal.
      insert into rides_private.ride_driver_catalog(slug,display_name,full_name,initials,route_notes,access_code_hash)
        select distinct on (slug) slug,display_name,full_name,initials,coalesce(route_notes,''),access_code_hash
        from rides_private.ride_drivers order by slug,updated_at desc,id on conflict(slug) do nothing;
    end if;
    if v_kind='publish' then
      if (v_payload->>'expectedDraftRevision')::bigint is distinct from w.draft_revision then
        v_code:='conflict'; v_conflict:=jsonb_build_object('type','draft','actualVersion',w.draft_revision); raise exception using errcode='RS001';
      end if;
      -- Lock each explicit master dependency in stable UUID order. Unknown legacy
      -- links never infer identity by name; master saves invalidate their review.
      for v_person in select distinct (payload->>'personId')::uuid from rides_private.ride_shared_riders
        where plan_date=p_plan_date and not deleted and nullif(payload->>'personId','') is not null order by 1 loop
        perform 1 from rides_private.ride_people where id=v_person for update;
        v_person_json:=rides_private.ride_shared_person_json(v_person);
        if v_person_json is null or exists(select 1 from rides_private.ride_shared_riders
          where plan_date=p_plan_date and not deleted and rides_private.ride_shared_person_id(payload)=v_person
          and (payload->>'personVersion')::bigint is distinct from (v_person_json->>'recordVersion')::bigint) then
          v_code:='conflict'; v_conflict:=jsonb_build_object('type','person','personId',v_person,
            'actualVersion',v_person_json->'recordVersion'); raise exception using errcode='RS001';
        end if;
      end loop;
      perform set_config('request.ride_admin_code',coalesce(p_admin_code,''),true);
      select id into v_plan_id from rides_private.ride_plans where plan_date=p_plan_date;
      select coalesce(jsonb_agg(to_jsonb(stop) order by stop.id),'[]'::jsonb)
      into v_before_stops from rides_private.ride_stops stop
      join rides_private.ride_drivers driver on driver.id=stop.driver_id
      where driver.plan_id=v_plan_id;

      -- Candidate drivers derive metadata and secret hashes solely from server records.
      -- No hash is ever written to shared JSON or returned to the browser.
      if exists(select 1 from jsonb_array_elements(w.drivers) d where not exists(select 1 from rides_private.ride_driver_catalog x where x.slug=d->>'slug')) then
        v_code:='validation_failed'; v_value:=jsonb_build_object('error','driver_not_found'); raise exception using errcode='RS001';
      end if;
      insert into rides_private.ride_drivers(plan_id,slug,display_name,full_name,initials,subtitle,route_notes,access_code_hash,sort_order)
      select v_plan_id,source.slug,source.display_name,source.full_name,source.initials,'No pickups assigned',coalesce(nullif(source.route_notes,''),'No pickups assigned yet.'),source.access_code_hash,d.ordinality::integer
      from jsonb_array_elements(w.drivers) with ordinality d(value,ordinality)
      cross join lateral(select x.* from rides_private.ride_driver_catalog x where x.slug=d.value->>'slug') source
      on conflict(plan_id,slug) do update set sort_order=excluded.sort_order,updated_at=now();
      -- Only genuine removals are deleted. Surviving UUIDs keep their rows and
      -- creation metadata; canonical publication handles collision-free moves.
      select coalesce(array_agg(stop.id::text),array[]::text[]) into v_deleted
      from rides_private.ride_stops stop
      join rides_private.ride_drivers driver on driver.id=stop.driver_id
      where driver.plan_id=v_plan_id and not exists (
        select 1 from rides_private.ride_shared_riders rider
        where rider.plan_date=p_plan_date and not rider.deleted and rider.id=stop.id
      );
      select coalesce(jsonb_agg(payload || jsonb_build_object('id',id::text,'driverSlug',driver_slug) order by driver_slug,(payload->>'stopOrder')::integer,id),'[]'::jsonb) into v_stops from rides_private.ride_shared_riders where plan_date=p_plan_date and not deleted;
      -- Route settings become driver-visible only in this same rollback boundary.
      update rides_private.ride_plans set
        title=coalesce(w.settings->>'planTitle',title),
        service_day=coalesce(w.settings->>'serviceDay',service_day),
        destination_label=coalesce(w.settings->>'destinationLabel',destination_label),
        destination_address=coalesce(w.settings->>'destinationAddress',destination_address)
      where id=v_plan_id;
      v_value:=rides_private.ride_publish_plan_internal(p_admin_code,p_plan_date,v_stops,v_deleted,true);
      if (v_value->>'ok')::boolean is distinct from true then v_code:='validation_failed'; raise exception using errcode='RS001'; end if;
      delete from rides_private.ride_drivers driver
      where driver.plan_id=v_plan_id and not exists (
        select 1 from jsonb_array_elements(w.drivers) item where item->>'slug'=driver.slug
      );
      -- The actual audit trigger buffered intermediate order parking. Emit its
      -- existing event contract once per final change, under the validated actor.
      for v_before_stop in select value from jsonb_array_elements(v_before_stops) loop
        select to_jsonb(stop) into v_after_stop from rides_private.ride_stops stop
        where stop.id=(v_before_stop->>'id')::uuid;
        if v_after_stop is null then
          perform rides_private.log_ride_admin_event('publish_plan',p_plan_date,
            jsonb_build_object('change','DELETE','riderName',v_before_stop->>'rider_name'));
        elsif (v_before_stop - array['created_at','updated_at']) is distinct from (v_after_stop - array['created_at','updated_at']) then
          perform rides_private.log_ride_admin_event('publish_plan',p_plan_date,
            jsonb_build_object('change','UPDATE','riderName',v_after_stop->>'rider_name'));
        end if;
      end loop;
      for v_after_stop in
        select to_jsonb(stop) from rides_private.ride_stops stop
        join rides_private.ride_drivers driver on driver.id=stop.driver_id
        where driver.plan_id=v_plan_id and not exists (
          select 1 from jsonb_array_elements(v_before_stops) item where (item->>'id')::uuid=stop.id
        )
      loop
        perform rides_private.log_ride_admin_event('publish_plan',p_plan_date,
          jsonb_build_object('change','INSERT','riderName',v_after_stop->>'rider_name'));
      end loop;
      w.published_revision:=w.published_revision+1; w.baseline_published_revision:=w.published_revision; w.status:='published';
      -- Existing snapshot may contain admin-only pool detail: result uses revisions only.
      v_value:=jsonb_build_object('publishedRevision',w.published_revision,'baselinePublishedRevision',w.baseline_published_revision);
    else
      if v_kind in ('rider_add','rider_update','rider_move','rider_remove','person_pickup') then
        v_entity:=(p_request->>'entityId')::uuid;
        if v_entity is null then v_code:='validation_failed'; raise exception using errcode='RS001'; end if;
        select * into v_rider from rides_private.ride_shared_riders where plan_date=p_plan_date and id=v_entity;
        if (v_kind='rider_add' and (v_rider.id is not null or (p_request->>'expectedEntityVersion')::bigint is distinct from 0))
          or (v_kind<>'rider_add' and (v_rider.id is null or v_rider.deleted or (p_request->>'expectedEntityVersion')::bigint is distinct from v_rider.entity_version)) then
          v_code:='conflict'; v_conflict:=jsonb_build_object('type','entity','entityId',v_entity,'actualVersion',coalesce(v_rider.entity_version,0),
            'current',case when v_rider.id is null then null else v_rider.payload || jsonb_build_object(
              'id',v_rider.id,'entityVersion',v_rider.entity_version,'driverSlug',v_rider.driver_slug,
              'deleted',v_rider.deleted,'lastActorKey',v_rider.last_actor_key,'unassigned',v_rider.driver_slug='') end); raise exception using errcode='RS001';
        end if;
        if (v_kind='rider_move' and (v_payload - array['driverSlug','stopOrder'])<>'{}'::jsonb)
          or (v_kind='rider_remove' and v_payload<>'{}'::jsonb) then
          v_code:='validation_failed'; raise exception using errcode='RS001';
        end if;
        if v_kind='person_pickup' or v_payload ? 'personId' or v_payload ? 'personVersion' then
          v_person:=nullif(v_payload->>'personId','')::uuid;
          if v_kind='person_pickup' and ((v_payload-array['personId','personVersion'])<>'{}'::jsonb or v_person is null or rides_private.ride_shared_person_id(v_rider.payload) is distinct from v_person) then
            v_code:='validation_failed'; raise exception using errcode='RS001';
          end if;
          if v_person is not null then
            v_payload:=v_payload || jsonb_build_object('personId',v_person);
            perform 1 from rides_private.ride_people where id=v_person for update;
            v_person_json:=rides_private.ride_shared_person_json(v_person);
            if v_person_json is null or (v_payload->>'personVersion')::bigint is distinct from (v_person_json->>'recordVersion')::bigint then
              v_code:='conflict'; v_conflict:=jsonb_build_object('type','person','personId',v_person,'actualVersion',v_person_json->'recordVersion'); raise exception using errcode='RS001';
            end if;
            if v_kind='person_pickup' then
              v_payload:=jsonb_build_object('personId',v_person,'personVersion',v_person_json->'recordVersion',
                'name',v_person_json->>'name','phone',v_person_json->>'phone',
                'address',coalesce(nullif(case when v_person_json->>'preferredAddressType'='campus' then v_person_json->>'campusAddress' else v_person_json->>'homeAddress' end,''),
                  nullif(v_person_json->>'homeAddress',''),v_person_json->>'campusAddress'),
                'area',case when v_person_json->>'preferredAddressType'='campus' then 'Campus' else 'Home' end);
            end if;
          elsif v_payload ? 'personVersion' and v_payload->'personVersion'<>'null'::jsonb then
            v_code:='validation_failed'; raise exception using errcode='RS001';
          end if;
        end if;
        v_old_slug:=coalesce(v_rider.driver_slug,''); v_slug:=v_old_slug;
        if v_kind in ('rider_add','rider_move') then v_slug:=lower(btrim(coalesce(v_payload->>'driverSlug',''))); end if;
        if v_kind='rider_add' then v_affected:=array[v_slug];
        elsif v_kind='rider_move' then v_affected:=array[v_old_slug,v_slug];
        elsif v_kind='rider_remove' or v_payload ? 'stopOrder' then v_affected:=array[v_old_slug]; end if;
        if v_kind='rider_update' and v_payload ? 'driverSlug' and v_payload->>'driverSlug' is distinct from v_old_slug then v_code:='validation_failed'; raise exception using errcode='RS001'; end if;
        if v_kind in ('rider_add','rider_move') and v_slug<>'' and not exists(select 1 from jsonb_array_elements(w.drivers) d where d->>'slug'=v_slug) then v_code:='validation_failed'; raise exception using errcode='RS001'; end if;
        if v_kind='rider_add' or (v_kind='rider_update' and v_payload ? 'name') then
          if jsonb_typeof(v_payload->'name') is distinct from 'string' or btrim(v_payload->>'name')='' then v_code:='validation_failed'; raise exception using errcode='RS001'; end if;
        end if;
        if v_payload ? 'stopOrder' and ((v_payload->>'stopOrder')::integer<1 or jsonb_typeof(v_payload->'stopOrder') is distinct from 'number') then v_code:='validation_failed'; raise exception using errcode='RS001'; end if;
      elsif v_kind='reorder' then
        v_slug:=coalesce(v_payload->>'driverSlug',''); v_affected:=array[v_slug]; v_ids:=v_payload->'riderIds';
        if jsonb_typeof(v_ids) is distinct from 'array' or exists(select 1 from jsonb_array_elements(v_ids) x where jsonb_typeof(x)<>'string') then v_code:='validation_failed'; raise exception using errcode='RS001'; end if;
      elsif v_kind='plan_drivers' then
        v_ids:=v_payload->'driverSlugs';
        if jsonb_typeof(v_ids) is distinct from 'array' or exists(select 1 from jsonb_array_elements(v_ids) x where jsonb_typeof(x)<>'string') or (select count(distinct value) from jsonb_array_elements_text(v_ids))<>jsonb_array_length(v_ids) then v_code:='validation_failed'; raise exception using errcode='RS001'; end if;
        if exists(select 1 from jsonb_array_elements_text(v_ids) x where x.value<>lower(btrim(x.value)) or x.value='' or not exists(select 1 from rides_private.ride_driver_catalog d where d.slug=x.value)) then v_code:='validation_failed'; raise exception using errcode='RS001'; end if;
        select array_agg(distinct slug) into v_affected from (
          select '@drivers' slug union all
          select x.value from jsonb_array_elements_text(v_ids) x where not exists(select 1 from jsonb_array_elements(w.drivers) d where d->>'slug'=x.value)
          union all select d->>'slug' from jsonb_array_elements(w.drivers) d where not exists(select 1 from jsonb_array_elements_text(v_ids) x where x.value=d->>'slug')
          union all select '' where exists(select 1 from rides_private.ride_shared_riders r where r.plan_date=p_plan_date and not r.deleted and r.driver_slug<>'' and not exists(select 1 from jsonb_array_elements_text(v_ids) x where x.value=r.driver_slug))
        ) changed;
        select coalesce(jsonb_agg(jsonb_build_object('slug',source.slug,'driverId',source.id,'displayName',source.display_name,'fullName',source.full_name,'initials',source.initials) order by x.ordinality),'[]') into v_drivers
          from jsonb_array_elements_text(v_ids) with ordinality x(value,ordinality)
          cross join lateral(select d.* from rides_private.ride_driver_catalog d where d.slug=x.value) source;
      elsif v_kind in ('person_save','settings_route','settings_branding','catalog_add') then
        -- Typed public wrappers feed this same authenticated, deduplicated engine.
        if v_kind='person_save' then
          v_person:=(v_payload->>'id')::uuid;
          if v_person is null or jsonb_typeof(v_payload->'name') is distinct from 'string' or btrim(v_payload->>'name')='' then
            v_code:='validation_failed'; raise exception using errcode='RS001';
          end if;
          perform 1 from rides_private.ride_people where id=v_person for update;
          v_person_json:=rides_private.ride_shared_person_json(v_person);
          v_master_version:=coalesce((v_person_json->>'recordVersion')::bigint,0);
          if (p_request->>'expectedRecordVersion')::bigint is distinct from v_master_version then
            v_code:='conflict'; v_conflict:=jsonb_build_object('type','person','personId',v_person,'actualVersion',v_master_version,'current',v_person_json); raise exception using errcode='RS001';
          end if;
          v_payload:=coalesce(v_person_json,'{}') || v_payload;
          if coalesce(v_payload->>'preferredAddressType','home') not in ('home','campus')
            or exists(select 1 from rides_private.ride_people where name_key=rides_private.ride_people_name_key(v_payload->>'name') and id<>v_person) then
            v_code:='validation_failed'; raise exception using errcode='RS001';
          end if;
        elsif v_kind in ('settings_route','settings_branding') then
          v_fields:=case when v_kind='settings_route' then array['planTitle','serviceDay','destinationLabel','destinationAddress'] else array['homeTitle','homeSubtitle','homeCoverUrl','homeCoverAlt'] end;
          if (v_payload-v_fields)<>'{}'::jsonb or exists(select 1 from jsonb_each(v_payload) where jsonb_typeof(value)<>'string')
            or (v_payload ? 'planTitle' and btrim(v_payload->>'planTitle')='') then
            v_code:='validation_failed'; raise exception using errcode='RS001';
          end if;
          v_master_version:=w.settings_version;
          if v_kind='settings_branding' then
            perform 1 from rides_private.ride_app_settings where id='main' for update;
            select coalesce((select record_version from rides_private.ride_shared_settings_versions where settings_key='branding'),1) into v_master_version;
          end if;
          if (p_request->>'expectedRecordVersion')::bigint is distinct from v_master_version then
            v_code:='conflict'; v_conflict:=jsonb_build_object('type','settings','actualVersion',v_master_version); raise exception using errcode='RS001';
          end if;
        else
          v_slug:=trim(both '-' from regexp_replace(lower(btrim(v_payload->>'name')),'[^a-z0-9]+','-','g'));
          if coalesce(v_slug,'')='' or coalesce(btrim(v_payload->>'initials'),'')='' or exists(select 1 from rides_private.ride_driver_catalog where slug=v_slug) then
            v_code:='validation_failed'; raise exception using errcode='RS001';
          end if;
        end if;
      else v_code:='validation_failed'; raise exception using errcode='RS001'; end if;
      for v_key in select distinct key from (select unnest(v_affected) key union all select jsonb_object_keys(v_groups)) dependencies loop
        select group_version into v_version from rides_private.ride_shared_groups where plan_date=p_plan_date and group_key=v_key;
        if (v_groups->>v_key)::bigint is distinct from coalesce(v_version,0) then
          v_code:='conflict'; v_conflict:=jsonb_build_object('type','group','groupKey',v_key,'actualVersion',coalesce(v_version,0)); raise exception using errcode='RS001';
        end if;
      end loop;
      if v_kind='reorder' then
        if jsonb_array_length(v_ids)<>(select count(*) from rides_private.ride_shared_riders where plan_date=p_plan_date and driver_slug=v_slug and not deleted)
          or (select count(distinct value) from jsonb_array_elements_text(v_ids))<>jsonb_array_length(v_ids)
          or exists(select 1 from jsonb_array_elements_text(v_ids) x(value) where not exists(select 1 from rides_private.ride_shared_riders r where r.plan_date=p_plan_date and not r.deleted and r.driver_slug=v_slug and r.id::text=x.value)) then v_code:='validation_failed'; raise exception using errcode='RS001'; end if;
      end if;
      -- Validation complete. Any later error escapes or rolls back this whole subtransaction.
      if v_kind='rider_add' then
        insert into rides_private.ride_shared_riders(plan_date,id,driver_slug,payload,last_actor_key) values(p_plan_date,v_entity,v_slug,(v_payload - array['id','entityVersion','lastActorKey','driverSlug']) || jsonb_build_object('stopOrder',coalesce((v_payload->>'stopOrder')::integer,2147483647)),v_actor->>'actorKey'); v_new:=true;
      elsif v_kind in ('rider_update','rider_move','rider_remove','person_pickup') then
        update rides_private.ride_shared_riders set payload=payload || (v_payload - array['id','entityVersion','lastActorKey','driverSlug']),driver_slug=v_slug,deleted=(v_kind='rider_remove') where plan_date=p_plan_date and id=v_entity;
        v_changed:=array[v_entity];
      elsif v_kind='reorder' then
        with changed as(update rides_private.ride_shared_riders r set payload=payload || jsonb_build_object('stopOrder',x.ordinality) from jsonb_array_elements_text(v_ids) with ordinality x(value,ordinality) where r.plan_date=p_plan_date and r.id::text=x.value returning r.id)
        select coalesce(array_agg(id),array[]::uuid[]) into v_changed from changed;
      elsif v_kind='plan_drivers' then
        with changed as(update rides_private.ride_shared_riders r set driver_slug='' where r.plan_date=p_plan_date and not r.deleted and r.driver_slug<>'' and not exists(select 1 from jsonb_array_elements_text(v_ids) x where x.value=r.driver_slug) returning r.id)
        select coalesce(array_agg(id),array[]::uuid[]) into v_changed from changed;
        w.drivers:=v_drivers;
      elsif v_kind='person_save' then
        insert into rides_private.ride_people(id,name,name_key,phone,home_address,campus_address,
          home_google_maps,home_apple_maps,campus_google_maps,campus_apple_maps,preferred_address_type,source_label,notes)
        values(v_person,btrim(v_payload->>'name'),rides_private.ride_people_name_key(v_payload->>'name'),
          coalesce(v_payload->>'phone',''),coalesce(v_payload->>'homeAddress',''),coalesce(v_payload->>'campusAddress',''),
          coalesce(v_payload->>'homeGoogleMaps',''),coalesce(v_payload->>'homeAppleMaps',''),coalesce(v_payload->>'campusGoogleMaps',''),coalesce(v_payload->>'campusAppleMaps',''),
          coalesce(v_payload->>'preferredAddressType','home'),coalesce(v_payload->>'sourceLabel','PeopleData'),coalesce(v_payload->>'notes',''))
        on conflict(id) do update set name=excluded.name,name_key=excluded.name_key,phone=excluded.phone,
          home_address=excluded.home_address,campus_address=excluded.campus_address,home_google_maps=excluded.home_google_maps,
          home_apple_maps=excluded.home_apple_maps,campus_google_maps=excluded.campus_google_maps,campus_apple_maps=excluded.campus_apple_maps,
          preferred_address_type=excluded.preferred_address_type,source_label=excluded.source_label,notes=excluded.notes,updated_at=now();
        insert into rides_private.ride_shared_person_versions(person_id,record_version,last_actor_key) values(v_person,v_master_version+1,v_actor->>'actorKey')
          on conflict(person_id) do update set record_version=excluded.record_version,last_actor_key=excluded.last_actor_key,updated_at=now();
        -- Known links invalidate their plans; unknown legacy links conservatively
        -- invalidate every such plan. Never infer a link or copy a contact by name.
        for v_other in select workspace.plan_date from rides_private.ride_shared_workspaces workspace
          join rides_private.ride_shared_write_modes mode using(plan_date)
          where workspace.plan_date<>p_plan_date and mode.write_mode<>'legacy' and exists(
            select 1 from rides_private.ride_shared_riders rider where rider.plan_date=workspace.plan_date and not rider.deleted
            and (rides_private.ride_shared_person_id(rider.payload) is null or rides_private.ride_shared_person_id(rider.payload)=v_person)) order by workspace.plan_date loop
          update rides_private.ride_shared_workspaces set draft_revision=draft_revision+1,status='draft',last_actor_key=v_actor->>'actorKey',updated_at=now() where plan_date=v_other;
          insert into rides_private.ride_shared_events(plan_date,draft_revision,actor_key,event_type)
            select v_other,draft_revision,v_actor->>'actorKey','person_changed' from rides_private.ride_shared_workspaces where plan_date=v_other returning event_id into v_cursor;
          update rides_private.ride_shared_workspaces set event_cursor=v_cursor where plan_date=v_other;
        end loop;
        v_value:=jsonb_build_object('person',rides_private.ride_shared_person_json(v_person),'routeStopsUpdated',0);
      elsif v_kind='settings_route' then
        w.settings:=w.settings || v_payload; w.settings_version:=w.settings_version+1;
        v_value:=jsonb_build_object('settings',w.settings,'settingsVersion',w.settings_version);
      elsif v_kind='settings_branding' then
        update rides_private.ride_app_settings set home_title=coalesce(v_payload->>'homeTitle',home_title),
          home_subtitle=coalesce(v_payload->>'homeSubtitle',home_subtitle),home_cover_url=coalesce(v_payload->>'homeCoverUrl',home_cover_url),
          home_cover_alt=coalesce(v_payload->>'homeCoverAlt',home_cover_alt),updated_at=now() where id='main';
        insert into rides_private.ride_shared_settings_versions(settings_key,record_version,last_actor_key) values('branding',v_master_version+1,v_actor->>'actorKey')
          on conflict(settings_key) do update set record_version=excluded.record_version,last_actor_key=excluded.last_actor_key,updated_at=now();
        v_value:=jsonb_build_object('branding',v_payload,'recordVersion',v_master_version+1);
      elsif v_kind='catalog_add' then
        insert into rides_private.ride_driver_catalog(slug,display_name,full_name,initials,route_notes,access_code_hash)
          values(v_slug,btrim(v_payload->>'name'),btrim(v_payload->>'name'),upper(btrim(v_payload->>'initials')),
            case when coalesce(v_payload->>'phone','')='' then '' else 'Phone: ' || (v_payload->>'phone') end,
            rides_private.hash_driver_code(coalesce(nullif(v_payload->>'passcode',''),'rides123')));
        v_value:=jsonb_build_object('driver',jsonb_build_object('slug',v_slug,'driverId',(select id from rides_private.ride_driver_catalog where slug=v_slug),'displayName',btrim(v_payload->>'name'),
          'fullName',btrim(v_payload->>'name'),'initials',upper(btrim(v_payload->>'initials')),'active',false));
      end if;
      -- Normalize affected route orders and version any rider whose position changed.
      with ordered as(select id,row_number() over(partition by driver_slug order by (payload->>'stopOrder')::integer,id)::integer n from rides_private.ride_shared_riders where plan_date=p_plan_date and not deleted and driver_slug=any(v_affected)), changed as(
        update rides_private.ride_shared_riders r set payload=payload || jsonb_build_object('stopOrder',o.n) from ordered o where r.plan_date=p_plan_date and r.id=o.id and (payload->>'stopOrder')::integer is distinct from o.n returning r.id)
      select v_changed || coalesce(array_agg(id),array[]::uuid[]) into v_changed from changed;
      update rides_private.ride_shared_riders set entity_version=entity_version+1,last_actor_key=v_actor->>'actorKey',updated_at=now() where plan_date=p_plan_date and id=any(v_changed) and not(v_new and id=v_entity);
      for v_key in select distinct unnest(v_affected) loop
        insert into rides_private.ride_shared_groups(plan_date,group_key,last_actor_key) values(p_plan_date,v_key,v_actor->>'actorKey') on conflict(plan_date,group_key) do update set group_version=ride_shared_groups.group_version+1,last_actor_key=excluded.last_actor_key;
      end loop;
      w.draft_revision:=w.draft_revision+1; w.status:='draft';
      if v_entity is not null then select payload || jsonb_build_object('id',id,'entityVersion',entity_version,'driverSlug',driver_slug,'deleted',deleted) into v_value from rides_private.ride_shared_riders where plan_date=p_plan_date and id=v_entity; end if;
    end if;
    insert into rides_private.ride_shared_events(plan_date,draft_revision,actor_key,event_type) values(p_plan_date,w.draft_revision,v_actor->>'actorKey',v_kind) returning event_id into v_cursor;
    update rides_private.ride_shared_workspaces set draft_revision=w.draft_revision,published_revision=w.published_revision,baseline_published_revision=w.baseline_published_revision,event_cursor=v_cursor,drivers=w.drivers,settings=w.settings,settings_version=w.settings_version,status=w.status,last_actor_key=v_actor->>'actorKey',updated_at=now() where plan_date=p_plan_date;
    v_result:=jsonb_build_object('ok',true,'code','ok','operationId',v_id,'draftRevision',w.draft_revision,'eventCursor',v_cursor,'value',v_value);
  exception
    when sqlstate 'RS001' then
      -- PL/pgSQL variables survive rollback; reset response metadata to committed row.
      select * into w from rides_private.ride_shared_workspaces where plan_date=p_plan_date;
      v_result:=jsonb_build_object('ok',false,'code',v_code,'operationId',v_id,'draftRevision',w.draft_revision,'eventCursor',w.event_cursor);
      if v_conflict is not null then v_result:=v_result || jsonb_build_object('conflict',v_conflict); end if;
      if v_code='validation_failed' and v_value is not null then v_result:=v_result || jsonb_build_object('value',v_value); end if;
    when invalid_text_representation or numeric_value_out_of_range or datetime_field_overflow or invalid_datetime_format then
      select * into w from rides_private.ride_shared_workspaces where plan_date=p_plan_date;
      v_result:=jsonb_build_object('ok',false,'code','validation_failed','operationId',v_id,'draftRevision',w.draft_revision,'eventCursor',w.event_cursor);
  end;
  update rides_private.ride_shared_operations set result=v_result
  where plan_date=p_plan_date and actor_key=v_actor->>'actorKey' and operation_id=v_id;
  return v_result;
end;
$$;

create or replace function public.ride_admin_shared_mutate(p_admin_code text,p_plan_date date,p_operation jsonb)
returns jsonb language plpgsql volatile security definer set search_path to '' as $$
begin
  -- Publication has its own typed RPC; importing/recovery and global masters are later tasks.
  if rides_private.ride_shared_actor(p_admin_code) is null then return jsonb_build_object('ok',false,'code','invalid_admin_code'); end if;
  if p_operation->>'kind'='publish' then return jsonb_build_object('ok',false,'code','validation_failed'); end if;
  return rides_private.ride_shared_apply(p_admin_code,p_plan_date,p_operation);
end;
$$;
create or replace function public.ride_admin_shared_publish(p_admin_code text,p_plan_date date,p_expected_draft_revision bigint,p_expected_baseline_revision bigint,p_operation_id uuid)
returns jsonb language sql volatile security definer set search_path to '' as $$
  select rides_private.ride_shared_apply(p_admin_code,p_plan_date,jsonb_build_object('operationId',p_operation_id,'planDate',p_plan_date,'kind','publish','expectedBaselinePublishedRevision',p_expected_baseline_revision,'expectedGroupVersions','{}'::jsonb,'payload',jsonb_build_object('expectedDraftRevision',p_expected_draft_revision)));
$$;
revoke execute on function rides_private.ride_shared_apply(text,date,jsonb) from public,anon,authenticated;
revoke execute on function public.ride_admin_shared_mutate(text,date,jsonb) from public;
revoke execute on function public.ride_admin_shared_operation(text,date,uuid) from public;
revoke execute on function public.ride_admin_shared_publish(text,date,bigint,bigint,uuid) from public;
grant execute on function public.ride_admin_shared_mutate(text,date,jsonb),public.ride_admin_shared_operation(text,date,uuid),public.ride_admin_shared_publish(text,date,bigint,bigint,uuid) to anon,authenticated;

-- The Task 2 publisher relies on the actual admin_security.sql audit trigger.
-- Keep this installation gate even when a later operator changes write_mode by SQL.
create or replace function rides_private.ride_shared_activation_guard()
returns trigger language plpgsql security invoker set search_path to '' as $$
begin
  if new.write_mode = 'shared' and (
    to_regprocedure('rides_private.ride_publish_plan_internal(text,date,jsonb,text[],boolean)') is null
    or to_regprocedure('rides_private.log_ride_stop_admin_change()') is null
    or not exists (
      select 1 from pg_trigger t
      where t.tgrelid = 'rides_private.ride_stops'::regclass
        and t.tgname = 'ride_admin_audit_stops' and not t.tgisinternal
        and t.tgenabled in ('O','A')
        -- AFTER ROW on all three write events, without a conditional/column filter.
        and t.tgtype = 29 and t.tgqual is null and t.tgattr::text = ''
        and t.tgfoid = 'rides_private.log_ride_stop_admin_change()'::regprocedure
    )
    or position('auditTransaction' in pg_get_functiondef('rides_private.log_ride_stop_admin_change()'::regprocedure)) = 0
  ) then
    raise exception 'Install admin_security.sql audit trigger and canonical publisher before shared activation';
  end if;
  return new;
end;
$$;
revoke execute on function rides_private.ride_shared_activation_guard() from public,anon,authenticated;
drop trigger if exists ride_shared_activation_guard on rides_private.ride_shared_write_modes;
create trigger ride_shared_activation_guard before insert or update of write_mode
  on rides_private.ride_shared_write_modes for each row
  execute function rides_private.ride_shared_activation_guard();

-- Trusted database operator only. Run in an operator transaction after installing
-- all SQL, with a descriptive operator label; no admin token is supplied or stored.
-- This captures immutable legacy originals and seeds from actual published rows.
-- It deliberately leaves write_mode=legacy. Activation has a separate rollout gate.
create or replace function rides_private.ride_shared_capture_legacy(p_plan_date date)
returns integer language plpgsql volatile security invoker set search_path to '' as $$
declare v_count integer;
begin
  insert into rides_private.ride_shared_recovery_candidates
    (plan_date,actor_key,source,source_key,baseline_published_revision,candidate,saved_at)
  select p_plan_date,d.actor_key,'server',d.id::text || ':' || md5(d.draft::text || d.saved_at::text),
    case when jsonb_typeof(d.draft->'baselinePublishedRevision')='number'
      and (d.draft->>'baselinePublishedRevision') ~ '^[0-9]+$'
      and length(d.draft->>'baselinePublishedRevision')<=18
      then (d.draft->>'baselinePublishedRevision')::bigint else null end,
    d.draft,d.saved_at
  from rides_private.ride_admin_drafts d where d.plan_date=p_plan_date
  on conflict(plan_date,actor_key,source,source_key) do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke execute on function rides_private.ride_shared_capture_legacy(date) from public,anon,authenticated;

create or replace function rides_private.ride_shared_prepare(p_plan_date date,p_operator_label text)
returns jsonb language plpgsql volatile security invoker set search_path to '' as $$
declare
  v_plan_id uuid; v_drivers jsonb; v_settings jsonb; v_count integer; v_mode text; v_hash text;
begin
  if nullif(btrim(p_operator_label),'') is null then raise exception 'operator label required'; end if;
  select id into v_plan_id from rides_private.ride_plans where plan_date=p_plan_date for update;
  if v_plan_id is null then return jsonb_build_object('ok',false,'code','plan_not_found'); end if;
  select write_mode into v_mode from rides_private.ride_shared_write_modes where plan_date=p_plan_date for update;
  if coalesce(v_mode,'legacy') <> 'legacy' then return jsonb_build_object('ok',false,'code','update_required'); end if;
  if exists(select 1 from rides_private.ride_shared_workspaces where plan_date=p_plan_date) then
    return jsonb_build_object('ok',false,'code','already_prepared');
  end if;
  v_count:=rides_private.ride_shared_capture_legacy(p_plan_date);
  select coalesce(jsonb_agg(jsonb_build_object('slug',d.slug,'displayName',d.display_name,
    'fullName',d.full_name,'initials',d.initials,'subtitle',d.subtitle,'routeNotes',d.route_notes)
    order by d.sort_order,d.slug),'[]'::jsonb) into v_drivers
  from rides_private.ride_drivers d where d.plan_id=v_plan_id;
  select jsonb_build_object('planTitle',to_jsonb(p)->>'title','serviceDay',to_jsonb(p)->>'service_day',
    'destinationLabel',to_jsonb(p)->>'destination_label','destinationAddress',to_jsonb(p)->>'destination_address')
    into v_settings from rides_private.ride_plans p where p.id=v_plan_id;
  select md5(jsonb_build_object('plan',to_jsonb(p),
    'drivers',(select coalesce(jsonb_agg(to_jsonb(d) order by d.id),'[]'::jsonb) from rides_private.ride_drivers d where d.plan_id=v_plan_id),
    'stops',(select coalesce(jsonb_agg(to_jsonb(s) order by s.id),'[]'::jsonb) from rides_private.ride_stops s join rides_private.ride_drivers d on d.id=s.driver_id where d.plan_id=v_plan_id))::text)
    into v_hash from rides_private.ride_plans p where p.id=v_plan_id;
  insert into rides_private.ride_shared_workspaces(plan_date,drivers,settings,published_source_hash,last_actor_key)
    values(p_plan_date,v_drivers,v_settings,v_hash,'operator:' || btrim(p_operator_label));
  insert into rides_private.ride_shared_groups(plan_date,group_key,last_actor_key)
    select p_plan_date,key,'operator:' || btrim(p_operator_label)
    from (select '@drivers' key union select '' union select d.slug from rides_private.ride_drivers d where d.plan_id=v_plan_id) keys;
  insert into rides_private.ride_shared_riders(plan_date,id,driver_slug,payload,last_actor_key)
    select p_plan_date,s.id,d.slug,jsonb_build_object('name',s.rider_name,'phone',s.phone,
      'address',s.address,'area',s.area,'pickupTime',case when s.pickup_time is null then null else to_char(s.pickup_time,'FMHH12:MI AM') end,
      'readyBy',case when s.ready_by is null then null else to_char(s.ready_by,'FMHH12:MI AM') end,
      'routeLabel',s.route_label,'notes',s.notes,'stopOrder',s.stop_order),
      'operator:' || btrim(p_operator_label)
    from rides_private.ride_stops s join rides_private.ride_drivers d on d.id=s.driver_id
    where d.plan_id=v_plan_id;
  insert into rides_private.ride_shared_write_modes(plan_date,write_mode,changed_by)
    values(p_plan_date,'legacy','operator:' || btrim(p_operator_label))
    on conflict(plan_date) do update set changed_by=excluded.changed_by,updated_at=now();
  insert into rides_private.ride_admin_audit_log(action,plan_date,actor_type,actor_label,payload)
    values('shared_prepare',p_plan_date,'operator',btrim(p_operator_label),jsonb_build_object('candidatesCaptured',v_count));
  return jsonb_build_object('ok',true,'code','prepared','candidatesCaptured',v_count,
    'writeMode','legacy','baselinePublishedRevision',0);
end;
$$;
revoke execute on function rides_private.ride_shared_prepare(date,text) from public,anon,authenticated;

-- A separate deliberate operator gate. This transaction recaptures later
-- legacy saves, rebases from actual published rows, then fences legacy writes
-- with paused mode. It does not enable shared editing or publish anything.
create or replace function rides_private.ride_shared_freeze(p_plan_date date,p_operator_label text)
returns jsonb language plpgsql volatile security invoker set search_path to '' as $$
declare
  v_plan_id uuid; v_mode text; w rides_private.ride_shared_workspaces%rowtype;
  v_count integer; v_drivers jsonb; v_settings jsonb; v_hash text;
begin
  if nullif(btrim(p_operator_label),'') is null then raise exception 'operator label required'; end if;
  select id into v_plan_id from rides_private.ride_plans where plan_date=p_plan_date for update;
  if v_plan_id is null then return jsonb_build_object('ok',false,'code','plan_not_found'); end if;
  select * into w from rides_private.ride_shared_workspaces where plan_date=p_plan_date for update;
  if w.plan_date is null then return jsonb_build_object('ok',false,'code','not_initialized'); end if;
  select write_mode into v_mode from rides_private.ride_shared_write_modes where plan_date=p_plan_date for update;
  if v_mode is distinct from 'legacy' then return jsonb_build_object('ok',false,'code','update_required'); end if;
  if w.draft_revision<>0 or w.event_cursor<>0 or exists(select 1 from rides_private.ride_shared_operations where plan_date=p_plan_date) then
    return jsonb_build_object('ok',false,'code','draft_changed');
  end if;
  v_count:=rides_private.ride_shared_capture_legacy(p_plan_date);
  select coalesce(jsonb_agg(jsonb_build_object('slug',d.slug,'displayName',d.display_name,
    'fullName',d.full_name,'initials',d.initials,'subtitle',d.subtitle,'routeNotes',d.route_notes)
    order by d.sort_order,d.slug),'[]'::jsonb) into v_drivers
  from rides_private.ride_drivers d where d.plan_id=v_plan_id;
  select jsonb_build_object('planTitle',to_jsonb(p)->>'title','serviceDay',to_jsonb(p)->>'service_day',
    'destinationLabel',to_jsonb(p)->>'destination_label','destinationAddress',to_jsonb(p)->>'destination_address')
    into v_settings from rides_private.ride_plans p where p.id=v_plan_id;
  select md5(jsonb_build_object('plan',to_jsonb(p),
    'drivers',(select coalesce(jsonb_agg(to_jsonb(d) order by d.id),'[]'::jsonb) from rides_private.ride_drivers d where d.plan_id=v_plan_id),
    'stops',(select coalesce(jsonb_agg(to_jsonb(s) order by s.id),'[]'::jsonb) from rides_private.ride_stops s join rides_private.ride_drivers d on d.id=s.driver_id where d.plan_id=v_plan_id))::text)
    into v_hash from rides_private.ride_plans p where p.id=v_plan_id;
  delete from rides_private.ride_shared_riders where plan_date=p_plan_date;
  delete from rides_private.ride_shared_groups where plan_date=p_plan_date;
  update rides_private.ride_shared_workspaces set drivers=v_drivers,settings=v_settings,
    published_revision=case when published_source_hash is distinct from v_hash then published_revision+1 else published_revision end,
    baseline_published_revision=case when published_source_hash is distinct from v_hash then published_revision+1 else published_revision end,
    published_source_hash=v_hash,last_actor_key='operator:' || btrim(p_operator_label),updated_at=now()
    where plan_date=p_plan_date;
  insert into rides_private.ride_shared_groups(plan_date,group_key,last_actor_key)
    select p_plan_date,key,'operator:' || btrim(p_operator_label)
    from (select '@drivers' key union select '' union select d.slug from rides_private.ride_drivers d where d.plan_id=v_plan_id) keys;
  insert into rides_private.ride_shared_riders(plan_date,id,driver_slug,payload,last_actor_key)
    select p_plan_date,s.id,d.slug,jsonb_build_object('name',s.rider_name,'phone',s.phone,
      'address',s.address,'area',s.area,'pickupTime',case when s.pickup_time is null then null else to_char(s.pickup_time,'FMHH12:MI AM') end,
      'readyBy',case when s.ready_by is null then null else to_char(s.ready_by,'FMHH12:MI AM') end,
      'routeLabel',s.route_label,'notes',s.notes,'stopOrder',s.stop_order),
      'operator:' || btrim(p_operator_label)
    from rides_private.ride_stops s join rides_private.ride_drivers d on d.id=s.driver_id
    where d.plan_id=v_plan_id;
  update rides_private.ride_shared_write_modes set write_mode='paused',changed_by='operator:' || btrim(p_operator_label),updated_at=now()
    where plan_date=p_plan_date;
  insert into rides_private.ride_admin_audit_log(action,plan_date,actor_type,actor_label,payload)
    values('shared_freeze',p_plan_date,'operator',btrim(p_operator_label),jsonb_build_object('candidatesCaptured',v_count));
  return jsonb_build_object('ok',true,'code','paused','candidatesCaptured',v_count,
    'baselinePublishedRevision',(select baseline_published_revision from rides_private.ride_shared_workspaces where plan_date=p_plan_date));
end;
$$;
revoke execute on function rides_private.ride_shared_freeze(date,text) from public,anon,authenticated;

create or replace function public.ride_admin_shared_recovery(p_admin_code text,p_plan_date date)
returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare v_actor jsonb:=rides_private.ride_shared_actor(p_admin_code); v_candidates jsonb;
begin
  if v_actor is null then return jsonb_build_object('ok',false,'code','invalid_admin_code'); end if;
  select coalesce(jsonb_agg(jsonb_build_object('id',c.id,'planDate',c.plan_date,
    'actorKey',c.actor_key,'source',c.source,'savedAt',c.saved_at,
    'baselinePublishedRevision',c.baseline_published_revision,'candidate',c.candidate)
    order by c.captured_at,c.id),'[]'::jsonb) into v_candidates
  from rides_private.ride_shared_recovery_candidates c
  where c.plan_date=p_plan_date and c.actor_key=v_actor->>'actorKey';
  return jsonb_build_object('ok',true,'planDate',p_plan_date,'candidates',v_candidates);
end;
$$;
revoke execute on function public.ride_admin_shared_recovery(text,date) from public;
grant execute on function public.ride_admin_shared_recovery(text,date) to anon,authenticated;

-- Device bytes enter recovery only after the signed-in actor explicitly claims
-- ownership in the client review flow. Legacy plan-only keys are never uploaded
-- merely because a new account opens that plan.
create or replace function public.ride_admin_shared_save_recovery(
  p_admin_code text,p_plan_date date,p_source_key text,p_candidate jsonb)
returns jsonb language plpgsql volatile security definer set search_path to '' as $$
declare v_actor jsonb:=rides_private.ride_shared_actor(p_admin_code);
  v_existing rides_private.ride_shared_recovery_candidates%rowtype; v_id uuid;
  v_baseline bigint; v_saved_at timestamptz;
begin
  if v_actor is null then return jsonb_build_object('ok',false,'code','invalid_admin_code'); end if;
  if nullif(btrim(p_source_key),'') is null or length(p_source_key)>200
    or jsonb_typeof(p_candidate) is distinct from 'object'
    or jsonb_typeof(p_candidate->'stops') is distinct from 'array'
    or (p_candidate ? 'planDate' and p_candidate->>'planDate' is distinct from p_plan_date::text)
    or (p_candidate ? 'actorKey' and p_candidate->>'actorKey' is distinct from v_actor->>'actorKey') then
    return jsonb_build_object('ok',false,'code','validation_failed');
  end if;
  begin
    v_baseline:=nullif(p_candidate->>'baselinePublishedRevision','')::bigint;
  exception when invalid_text_representation or numeric_value_out_of_range then
    return jsonb_build_object('ok',false,'code','validation_failed');
  end;
  if v_baseline<0 then return jsonb_build_object('ok',false,'code','validation_failed'); end if;
  begin
    v_saved_at:=nullif(p_candidate->>'savedAt','')::timestamptz;
  exception when invalid_datetime_format or datetime_field_overflow then
    return jsonb_build_object('ok',false,'code','validation_failed');
  end;
  perform 1 from rides_private.ride_plans where plan_date=p_plan_date for update;
  if not found then return jsonb_build_object('ok',false,'code','plan_not_found'); end if;
  select * into v_existing from rides_private.ride_shared_recovery_candidates
    where plan_date=p_plan_date and actor_key=v_actor->>'actorKey' and source='device' and source_key=p_source_key;
  if v_existing.id is not null then
    if v_existing.candidate<>p_candidate then return jsonb_build_object('ok',false,'code','source_key_reused'); end if;
    return jsonb_build_object('ok',true,'code','ok','candidateId',v_existing.id);
  end if;
  insert into rides_private.ride_shared_recovery_candidates
    (plan_date,actor_key,source,source_key,baseline_published_revision,candidate,saved_at)
    values(p_plan_date,v_actor->>'actorKey','device',p_source_key,v_baseline,p_candidate,v_saved_at)
    returning id into v_id;
  return jsonb_build_object('ok',true,'code','ok','candidateId',v_id);
end;
$$;
revoke execute on function public.ride_admin_shared_save_recovery(text,date,text,jsonb) from public;
grant execute on function public.ride_admin_shared_save_recovery(text,date,text,jsonb) to anon,authenticated;

-- Import is a single versioned replacement of the private shared draft. It
-- never calls the publisher or changes ride_drivers/ride_stops. The source row
-- survives success, conflict, and retry. Import IDs share the Task 2 ledger.
create or replace function public.ride_admin_shared_import(
  p_admin_code text,p_plan_date date,p_candidate_id uuid,
  p_expected_draft_revision bigint,p_expected_baseline_revision bigint,p_operation_id uuid)
returns jsonb language plpgsql volatile security definer set search_path to '' as $$
declare
  v_actor jsonb:=rides_private.ride_shared_actor(p_admin_code);
  w rides_private.ride_shared_workspaces%rowtype;
  c rides_private.ride_shared_recovery_candidates%rowtype;
  previous rides_private.ride_shared_operations%rowtype;
  v_request jsonb; v_result jsonb; v_conflict jsonb; v_code text;
  v_stops jsonb; v_stop jsonb; v_id uuid; v_slug text; v_cursor bigint;
begin
  if v_actor is null then return jsonb_build_object('ok',false,'code','invalid_admin_code'); end if;
  if p_operation_id is null or p_candidate_id is null then return jsonb_build_object('ok',false,'code','validation_failed'); end if;
  v_request:=jsonb_build_object('kind','import','operationId',p_operation_id,
    'planDate',p_plan_date,'candidateId',p_candidate_id,
    'expectedDraftRevision',p_expected_draft_revision,
    'expectedBaselinePublishedRevision',p_expected_baseline_revision);
  perform 1 from rides_private.ride_plans where plan_date=p_plan_date for update;
  select * into w from rides_private.ride_shared_workspaces where plan_date=p_plan_date for update;
  if w.plan_date is null then return jsonb_build_object('ok',false,'code','not_initialized','operationId',p_operation_id); end if;
  select * into previous from rides_private.ride_shared_operations
    where plan_date=p_plan_date and actor_key=v_actor->>'actorKey' and operation_id=p_operation_id;
  if previous.operation_id is not null then
    if previous.request_hash<>md5(v_request::text) or previous.request<>v_request then
      return jsonb_build_object('ok',false,'code','operation_id_reused','operationId',p_operation_id,
        'draftRevision',w.draft_revision,'eventCursor',w.event_cursor);
    end if;
    if previous.created_at<statement_timestamp()-interval '30 days' then
      return jsonb_build_object('ok',false,'code','operation_expired','operationId',p_operation_id,
        'draftRevision',w.draft_revision,'eventCursor',w.event_cursor);
    end if;
    return previous.result;
  end if;
  insert into rides_private.ride_shared_operations(plan_date,actor_key,operation_id,request,request_hash,result)
    values(p_plan_date,v_actor->>'actorKey',p_operation_id,v_request,md5(v_request::text),'{}');
  begin
    if not exists(select 1 from rides_private.ride_shared_write_modes where plan_date=p_plan_date and write_mode='shared') then
      v_code:='update_required'; raise exception using errcode='RS001';
    end if;
    select * into c from rides_private.ride_shared_recovery_candidates
      where id=p_candidate_id and plan_date=p_plan_date and actor_key=v_actor->>'actorKey';
    if c.id is null then v_code:='candidate_not_found'; raise exception using errcode='RS001'; end if;
    if p_expected_baseline_revision is distinct from w.baseline_published_revision
      or c.baseline_published_revision is distinct from w.baseline_published_revision then
      v_code:='conflict'; v_conflict:=jsonb_build_object('type','baseline','actualVersion',w.baseline_published_revision,
        'candidateBaseline',c.baseline_published_revision); raise exception using errcode='RS001';
    end if;
    if p_expected_draft_revision is distinct from w.draft_revision then
      v_code:='conflict'; v_conflict:=jsonb_build_object('type','draft','actualVersion',w.draft_revision);
      raise exception using errcode='RS001';
    end if;
    v_stops:=c.candidate->'stops';
    if jsonb_typeof(v_stops) is distinct from 'array' then
      v_code:='validation_failed'; raise exception using errcode='RS001';
    end if;
    -- Validate shape before any UUID/integer cast or shared-row mutation.
    if exists(select 1 from jsonb_array_elements(v_stops) x where jsonb_typeof(x) is distinct from 'object'
        or jsonb_typeof(x->'id') is distinct from 'string'
        or (x->>'id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        or jsonb_typeof(x->'driverSlug') is distinct from 'string' or btrim(x->>'driverSlug')=''
        or jsonb_typeof(x->'name') is distinct from 'string' or btrim(x->>'name')=''
        or jsonb_typeof(x->'stopOrder') is distinct from 'number' or (x->>'stopOrder') !~ '^[1-9][0-9]*$'
        or length(x->>'stopOrder')>10
        or (length(x->>'stopOrder')=10 and (x->>'stopOrder')>'2147483647')) then
      v_code:='validation_failed'; raise exception using errcode='RS001';
    end if;
    if (select count(distinct x->>'id') from jsonb_array_elements(v_stops) x)<>jsonb_array_length(v_stops)
      or exists(select 1 from jsonb_array_elements(v_stops) x where
        not exists(select 1 from jsonb_array_elements(w.drivers) d where d->>'slug'=lower(btrim(x->>'driverSlug'))))
      or exists(select 1 from jsonb_array_elements(v_stops) x join rides_private.ride_stops s on s.id=(x->>'id')::uuid
        join rides_private.ride_drivers d on d.id=s.driver_id
        where d.plan_id<>(select id from rides_private.ride_plans where plan_date=p_plan_date)) then
      v_code:='validation_failed'; raise exception using errcode='RS001';
    end if;
    -- Keep tombstones so a removed ID cannot be silently resurrected by add.
    update rides_private.ride_shared_riders r set deleted=true,entity_version=entity_version+1,
      last_actor_key=v_actor->>'actorKey',updated_at=now()
      where r.plan_date=p_plan_date and not r.deleted
        and not exists(select 1 from jsonb_array_elements(v_stops) x where x->>'id'=r.id::text);
    for v_stop in select value from jsonb_array_elements(v_stops) loop
      v_id:=(v_stop->>'id')::uuid; v_slug:=lower(btrim(v_stop->>'driverSlug'));
      insert into rides_private.ride_shared_riders(plan_date,id,driver_slug,payload,last_actor_key)
        values(p_plan_date,v_id,v_slug,(v_stop - array['id','driverSlug','entityVersion','lastActorKey','deleted']) || jsonb_build_object('stopOrder',(v_stop->>'stopOrder')::integer),v_actor->>'actorKey')
      on conflict(plan_date,id) do update set driver_slug=excluded.driver_slug,
        payload=excluded.payload,deleted=false,entity_version=ride_shared_riders.entity_version+1,
        last_actor_key=excluded.last_actor_key,updated_at=now();
    end loop;
    with ordered as (
      select id,row_number() over(partition by driver_slug order by (payload->>'stopOrder')::integer,id)::integer n
      from rides_private.ride_shared_riders where plan_date=p_plan_date and not deleted
    ) update rides_private.ride_shared_riders r set payload=r.payload || jsonb_build_object('stopOrder',o.n)
      from ordered o where r.plan_date=p_plan_date and r.id=o.id and (r.payload->>'stopOrder')::integer is distinct from o.n;
    update rides_private.ride_shared_groups set group_version=group_version+1,last_actor_key=v_actor->>'actorKey'
      where plan_date=p_plan_date;
    w.draft_revision:=w.draft_revision+1;
    insert into rides_private.ride_shared_events(plan_date,draft_revision,actor_key,event_type)
      values(p_plan_date,w.draft_revision,v_actor->>'actorKey','import') returning event_id into v_cursor;
    update rides_private.ride_shared_workspaces set draft_revision=w.draft_revision,
      event_cursor=v_cursor,status='draft',last_actor_key=v_actor->>'actorKey',updated_at=now()
      where plan_date=p_plan_date;
    v_result:=jsonb_build_object('ok',true,'code','ok','operationId',p_operation_id,
      'draftRevision',w.draft_revision,'eventCursor',v_cursor,'value',jsonb_build_object('candidateId',c.id));
  exception when sqlstate 'RS001' then
    select * into w from rides_private.ride_shared_workspaces where plan_date=p_plan_date;
    v_result:=jsonb_build_object('ok',false,'code',v_code,'operationId',p_operation_id,
      'draftRevision',w.draft_revision,'eventCursor',w.event_cursor);
    if v_conflict is not null then v_result:=v_result || jsonb_build_object('conflict',v_conflict); end if;
  end;
  update rides_private.ride_shared_operations set result=v_result
    where plan_date=p_plan_date and actor_key=v_actor->>'actorKey' and operation_id=p_operation_id;
  return v_result;
end;
$$;
revoke execute on function public.ride_admin_shared_import(text,date,uuid,bigint,bigint,uuid) from public;
grant execute on function public.ride_admin_shared_import(text,date,uuid,bigint,bigint,uuid) to anon,authenticated;

create or replace function public.ride_admin_shared_save_person(p_admin_code text,p_plan_date date,p_person jsonb,p_expected_version bigint,p_operation_id uuid)
returns jsonb language sql volatile security definer set search_path to '' as $$
  select rides_private.ride_shared_apply(p_admin_code,p_plan_date,jsonb_build_object('operationId',p_operation_id,'planDate',p_plan_date,
    'kind','person_save','payload',p_person,'expectedRecordVersion',p_expected_version,'expectedGroupVersions','{}'::jsonb));
$$;
create or replace function public.ride_admin_shared_save_settings(p_admin_code text,p_plan_date date,p_scope text,p_settings jsonb,p_expected_version bigint,p_expected_baseline_revision bigint,p_operation_id uuid)
returns jsonb language sql volatile security definer set search_path to '' as $$
  select rides_private.ride_shared_apply(p_admin_code,p_plan_date,jsonb_build_object('operationId',p_operation_id,'planDate',p_plan_date,
    'kind',case when p_scope in ('route','branding') then 'settings_' || p_scope else 'invalid' end,'payload',p_settings,
    'expectedRecordVersion',p_expected_version,'expectedBaselinePublishedRevision',p_expected_baseline_revision,'expectedGroupVersions','{}'::jsonb));
$$;
create or replace function public.ride_admin_shared_add_driver(p_admin_code text,p_plan_date date,p_driver jsonb,p_operation_id uuid)
returns jsonb language sql volatile security definer set search_path to '' as $$
  select rides_private.ride_shared_apply(p_admin_code,p_plan_date,jsonb_build_object('operationId',p_operation_id,'planDate',p_plan_date,
    'kind','catalog_add','payload',p_driver,'expectedGroupVersions','{}'::jsonb));
$$;
create or replace function public.ride_admin_shared_secondary(p_admin_code text,p_plan_date date)
returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare v_actor jsonb:=rides_private.ride_shared_actor(p_admin_code); v_result jsonb;
begin
  if v_actor is null then return jsonb_build_object('ok',false,'code','invalid_admin_code'); end if;
  select jsonb_build_object('ok',true,'actorKey',v_actor->>'actorKey','planDate',p_plan_date,
    'people',(select coalesce(jsonb_agg(rides_private.ride_shared_person_json(id) order by name),'[]') from rides_private.ride_people where active),
    'driverPool',(select coalesce(jsonb_agg(jsonb_build_object('slug',slug,'driverId',id,'displayName',display_name,'fullName',full_name,'initials',initials) order by slug),'[]') from rides_private.ride_driver_catalog),
    'brandingVersion',coalesce((select record_version from rides_private.ride_shared_settings_versions where settings_key='branding'),1),
    'branding',(select jsonb_build_object('homeTitle',home_title,'homeSubtitle',home_subtitle,'homeCoverUrl',home_cover_url,'homeCoverAlt',home_cover_alt) from rides_private.ride_app_settings where id='main')) into v_result;
  return v_result;
end;
$$;
revoke execute on function public.ride_admin_shared_save_person(text,date,jsonb,bigint,uuid),public.ride_admin_shared_save_settings(text,date,text,jsonb,bigint,bigint,uuid),public.ride_admin_shared_add_driver(text,date,jsonb,uuid),public.ride_admin_shared_secondary(text,date) from public;
grant execute on function public.ride_admin_shared_save_person(text,date,jsonb,bigint,uuid),public.ride_admin_shared_save_settings(text,date,text,jsonb,bigint,bigint,uuid),public.ride_admin_shared_add_driver(text,date,jsonb,uuid),public.ride_admin_shared_secondary(text,date) to anon,authenticated;

commit;

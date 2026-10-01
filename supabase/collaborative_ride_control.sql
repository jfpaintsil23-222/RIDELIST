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
    'lastActorKey', r.last_actor_key, 'unassigned', r.driver_slug = ''
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
  v_drivers jsonb; v_ids jsonb; v_plan_id uuid; v_stops jsonb;
begin
  if v_actor is null then return jsonb_build_object('ok',false,'code','invalid_admin_code'); end if;
  if p_request is null or jsonb_typeof(p_request)<>'object' then return jsonb_build_object('ok',false,'code','validation_failed'); end if;
  begin v_id:=(p_request->>'operationId')::uuid;
  exception when invalid_text_representation then return jsonb_build_object('ok',false,'code','validation_failed'); end;
  if v_id is null then return jsonb_build_object('ok',false,'code','validation_failed'); end if;
  -- Lock order also serializes legacy writers and future operator cutover: plan, workspace.
  perform 1 from rides_private.ride_plans where plan_date=p_plan_date for update;
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
  -- Every expected failure is recorded, including conflicts, without advancing revision/events.
  begin
    if not exists(select 1 from rides_private.ride_shared_write_modes where plan_date=p_plan_date and write_mode='shared') then
      v_code:='update_required'; raise exception using errcode='RS001';
    end if;
    if (p_request->>'planDate')::date is distinct from p_plan_date or jsonb_typeof(v_payload) is distinct from 'object' or jsonb_typeof(v_groups) is distinct from 'object' then
      v_code:='validation_failed'; raise exception using errcode='RS001';
    end if;
    if (p_request->>'expectedBaselinePublishedRevision')::bigint is distinct from w.baseline_published_revision then
      v_code:='conflict'; v_conflict:=jsonb_build_object('type','baseline','actualVersion',w.baseline_published_revision); raise exception using errcode='RS001';
    end if;
    if v_kind='publish' then
      if (v_payload->>'expectedDraftRevision')::bigint is distinct from w.draft_revision then
        v_code:='conflict'; v_conflict:=jsonb_build_object('type','draft','actualVersion',w.draft_revision); raise exception using errcode='RS001';
      end if;
      select id into v_plan_id from rides_private.ride_plans where plan_date=p_plan_date;
      -- Candidate drivers derive metadata and secret hashes solely from server records.
      -- No hash is ever written to shared JSON or returned to the browser.
      if exists(select 1 from jsonb_array_elements(w.drivers) d where not exists(select 1 from rides_private.ride_drivers x where x.slug=d->>'slug')) then
        v_code:='validation_failed'; v_value:=jsonb_build_object('error','driver_not_found'); raise exception using errcode='RS001';
      end if;
      insert into rides_private.ride_drivers(plan_id,slug,display_name,full_name,initials,subtitle,route_notes,access_code_hash,sort_order)
      select v_plan_id,source.slug,source.display_name,source.full_name,source.initials,'No pickups assigned','No pickups assigned yet.',source.access_code_hash,d.ordinality::integer
      from jsonb_array_elements(w.drivers) with ordinality d(value,ordinality)
      cross join lateral(select x.* from rides_private.ride_drivers x where x.slug=d.value->>'slug' order by (x.plan_id=v_plan_id) desc,x.updated_at desc,x.id limit 1) source
      on conflict(plan_id,slug) do update set sort_order=excluded.sort_order,updated_at=now();
      -- Rebuild only this plan's published stops in the validation subtransaction;
      -- canonical helper performs actual name/driver/time/order/summary validation.
      delete from rides_private.ride_stops s using rides_private.ride_drivers d where s.driver_id=d.id and d.plan_id=v_plan_id;
      delete from rides_private.ride_drivers d where d.plan_id=v_plan_id and not exists(select 1 from jsonb_array_elements(w.drivers) x where x->>'slug'=d.slug);
      select coalesce(jsonb_agg(payload || jsonb_build_object('id',id::text,'driverSlug',driver_slug) order by driver_slug,(payload->>'stopOrder')::integer,id),'[]'::jsonb) into v_stops from rides_private.ride_shared_riders where plan_date=p_plan_date and not deleted;
      v_value:=rides_private.ride_publish_plan_internal(p_admin_code,p_plan_date,v_stops,array[]::text[],true);
      if (v_value->>'ok')::boolean is distinct from true then v_code:='validation_failed'; raise exception using errcode='RS001'; end if;
      w.published_revision:=w.published_revision+1; w.baseline_published_revision:=w.published_revision; w.status:='published';
      -- Existing snapshot may contain admin-only pool detail: result uses revisions only.
      v_value:=jsonb_build_object('publishedRevision',w.published_revision,'baselinePublishedRevision',w.baseline_published_revision);
    else
      if v_kind in ('rider_add','rider_update','rider_move','rider_remove') then
        v_entity:=(p_request->>'entityId')::uuid;
        if v_entity is null then v_code:='validation_failed'; raise exception using errcode='RS001'; end if;
        select * into v_rider from rides_private.ride_shared_riders where plan_date=p_plan_date and id=v_entity;
        if (v_kind='rider_add' and (v_rider.id is not null or (p_request->>'expectedEntityVersion')::bigint is distinct from 0))
          or (v_kind<>'rider_add' and (v_rider.id is null or v_rider.deleted or (p_request->>'expectedEntityVersion')::bigint is distinct from v_rider.entity_version)) then
          v_code:='conflict'; v_conflict:=jsonb_build_object('type','entity','entityId',v_entity,'actualVersion',coalesce(v_rider.entity_version,0)); raise exception using errcode='RS001';
        end if;
        if (v_kind='rider_move' and (v_payload - array['driverSlug','stopOrder'])<>'{}'::jsonb)
          or (v_kind='rider_remove' and v_payload<>'{}'::jsonb) then
          v_code:='validation_failed'; raise exception using errcode='RS001';
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
        if exists(select 1 from jsonb_array_elements_text(v_ids) x where x.value<>lower(btrim(x.value)) or x.value='' or not exists(select 1 from rides_private.ride_drivers d where d.slug=x.value)) then v_code:='validation_failed'; raise exception using errcode='RS001'; end if;
        select array_agg(distinct slug) into v_affected from (
          select '@drivers' slug union all
          select x.value from jsonb_array_elements_text(v_ids) x where not exists(select 1 from jsonb_array_elements(w.drivers) d where d->>'slug'=x.value)
          union all select d->>'slug' from jsonb_array_elements(w.drivers) d where not exists(select 1 from jsonb_array_elements_text(v_ids) x where x.value=d->>'slug')
          union all select '' where exists(select 1 from rides_private.ride_shared_riders r where r.plan_date=p_plan_date and not r.deleted and r.driver_slug<>'' and not exists(select 1 from jsonb_array_elements_text(v_ids) x where x.value=r.driver_slug))
        ) changed;
        select coalesce(jsonb_agg(jsonb_build_object('slug',source.slug,'displayName',source.display_name,'fullName',source.full_name,'initials',source.initials) order by x.ordinality),'[]') into v_drivers
          from jsonb_array_elements_text(v_ids) with ordinality x(value,ordinality)
          cross join lateral(select d.* from rides_private.ride_drivers d where d.slug=x.value order by d.updated_at desc,d.id limit 1) source;
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
      elsif v_kind in ('rider_update','rider_move','rider_remove') then
        update rides_private.ride_shared_riders set payload=payload || (v_payload - array['id','entityVersion','lastActorKey','driverSlug']),driver_slug=v_slug,deleted=(v_kind='rider_remove') where plan_date=p_plan_date and id=v_entity;
        v_changed:=array[v_entity];
      elsif v_kind='reorder' then
        with changed as(update rides_private.ride_shared_riders r set payload=payload || jsonb_build_object('stopOrder',x.ordinality) from jsonb_array_elements_text(v_ids) with ordinality x(value,ordinality) where r.plan_date=p_plan_date and r.id::text=x.value returning r.id)
        select coalesce(array_agg(id),array[]::uuid[]) into v_changed from changed;
      elsif v_kind='plan_drivers' then
        with changed as(update rides_private.ride_shared_riders r set driver_slug='' where r.plan_date=p_plan_date and not r.deleted and r.driver_slug<>'' and not exists(select 1 from jsonb_array_elements_text(v_ids) x where x.value=r.driver_slug) returning r.id)
        select coalesce(array_agg(id),array[]::uuid[]) into v_changed from changed;
        w.drivers:=v_drivers;
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
    update rides_private.ride_shared_workspaces set draft_revision=w.draft_revision,published_revision=w.published_revision,baseline_published_revision=w.baseline_published_revision,event_cursor=v_cursor,drivers=w.drivers,status=w.status,last_actor_key=v_actor->>'actorKey',updated_at=now() where plan_date=p_plan_date;
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
  insert into rides_private.ride_shared_operations(plan_date,actor_key,operation_id,request,request_hash,result) values(p_plan_date,v_actor->>'actorKey',v_id,p_request,md5(p_request::text),v_result);
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

commit;

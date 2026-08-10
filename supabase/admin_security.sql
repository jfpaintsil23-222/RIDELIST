create table if not exists rides_private.ride_admin_users (
  auth_user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null unique,
  display_name text not null default 'Ride Admin',
  active boolean not null default true,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now()
);

alter table rides_private.ride_admin_users enable row level security;
alter table rides_private.ride_admin_users force row level security;

create table if not exists rides_private.ride_admin_security_settings (
  id text primary key default 'main',
  require_signed_admin boolean not null default false,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now()
);

alter table rides_private.ride_admin_security_settings enable row level security;
alter table rides_private.ride_admin_security_settings force row level security;

insert into rides_private.ride_admin_security_settings (id, require_signed_admin)
values ('main', false)
on conflict (id) do nothing;

create table if not exists rides_private.ride_admin_audit_log (
  id uuid primary key default gen_random_uuid(),
  action text not null,
  plan_date date,
  actor_type text not null default 'unknown',
  actor_user_id uuid,
  actor_email text,
  actor_label text not null default 'Unknown admin',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamp with time zone not null default now()
);

alter table rides_private.ride_admin_audit_log enable row level security;
alter table rides_private.ride_admin_audit_log force row level security;

create or replace function rides_private.admin_login_required()
returns boolean
language sql
stable
security definer
set search_path to ''
as $$
  select coalesce((
    select s.require_signed_admin
    from rides_private.ride_admin_security_settings s
    where s.id = 'main'
  ), false);
$$;

create or replace function rides_private.is_ride_admin()
returns boolean
language sql
stable
security definer
set search_path to ''
as $$
  select exists (
    select 1
    from rides_private.ride_admin_users u
    where u.auth_user_id = (select auth.uid())
      and u.active
  );
$$;

create or replace function rides_private.is_ride_admin_passcode(p_code text)
returns boolean
language sql
stable
security definer
set search_path to ''
as $$
  select exists (
    select 1
    from rides_private.ride_admin_codes c
    where c.id = 'main'
      and c.access_code_hash = rides_private.hash_driver_code(p_code)
  );
$$;

create or replace function rides_private.is_ride_admin_code(p_code text)
returns boolean
language sql
stable
security definer
set search_path to ''
as $$
  select rides_private.is_ride_admin()
      or (
        not rides_private.admin_login_required()
        and rides_private.is_ride_admin_passcode(p_code)
      );
$$;

create or replace function rides_private.ride_admin_actor(p_code text)
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $$
declare
  v_admin record;
begin
  select u.auth_user_id, u.email, u.display_name
  into v_admin
  from rides_private.ride_admin_users u
  where u.auth_user_id = (select auth.uid())
    and u.active
  limit 1;

  if v_admin.auth_user_id is not null then
    return jsonb_build_object(
      'type', 'user',
      'userId', v_admin.auth_user_id::text,
      'email', v_admin.email,
      'label', coalesce(nullif(v_admin.display_name, ''), v_admin.email)
    );
  end if;

  if not rides_private.admin_login_required()
     and rides_private.is_ride_admin_passcode(p_code) then
    return jsonb_build_object(
      'type', 'code',
      'userId', null,
      'email', null,
      'label', 'Admin passcode'
    );
  end if;

  return jsonb_build_object(
    'type', 'unknown',
    'userId', null,
    'email', null,
    'label', 'Unknown admin'
  );
end;
$$;

create or replace function public.ride_admin_security_context(
  p_admin_code text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $$
declare
  v_login_required boolean := rides_private.admin_login_required();
  v_auth_admin boolean := rides_private.is_ride_admin();
  v_code_ok boolean := (not v_login_required and rides_private.is_ride_admin_passcode(p_admin_code));
begin
  if not v_auth_admin and not v_code_ok then
    return jsonb_build_object('ok', false, 'error', 'invalid_admin_code');
  end if;

  return jsonb_build_object(
    'ok', true,
    'loginRequired', v_login_required,
    'codeFallbackEnabled', not v_login_required,
    'signedInAdmin', v_auth_admin,
    'actor', rides_private.ride_admin_actor(p_admin_code)
  );
end;
$$;

create or replace function rides_private.log_ride_admin_event(
  p_action text,
  p_plan_date date default null,
  p_payload jsonb default '{}'::jsonb
)
returns void
language plpgsql
volatile
security definer
set search_path to ''
as $$
declare
  v_actor jsonb := rides_private.ride_admin_actor(null);
  v_type text := coalesce(nullif(v_actor->>'type', ''), 'unknown');
  v_user_id text := nullif(v_actor->>'userId', '');
begin
  if v_type = 'unknown' then
    v_actor := jsonb_build_object(
      'type', 'code',
      'userId', null,
      'email', null,
      'label', 'Admin passcode'
    );
    v_type := 'code';
  end if;

  insert into rides_private.ride_admin_audit_log (
    action,
    plan_date,
    actor_type,
    actor_user_id,
    actor_email,
    actor_label,
    payload
  )
  values (
    p_action,
    p_plan_date,
    v_type,
    case when v_user_id is null then null else v_user_id::uuid end,
    nullif(v_actor->>'email', ''),
    coalesce(nullif(v_actor->>'label', ''), 'Unknown admin'),
    coalesce(p_payload, '{}'::jsonb)
  );
end;
$$;

create or replace function public.ride_admin_activity(
  p_admin_code text default null,
  p_limit integer default 25
)
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $$
declare
  v_events jsonb;
begin
  if not rides_private.is_ride_admin_code(p_admin_code) then
    return jsonb_build_object('ok', false, 'error', 'invalid_admin_code');
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', event_rows.id::text,
        'action', event_rows.action,
        'planDate', event_rows.plan_date,
        'actorType', event_rows.actor_type,
        'actorEmail', event_rows.actor_email,
        'actorLabel', event_rows.actor_label,
        'payload', event_rows.payload,
        'createdAt', event_rows.created_at
      )
      order by event_rows.created_at desc
    ),
    '[]'::jsonb
  )
  into v_events
  from (
    select *
    from rides_private.ride_admin_audit_log
    order by created_at desc
    limit greatest(1, least(coalesce(p_limit, 25), 100))
  ) event_rows;

  return jsonb_build_object('ok', true, 'events', v_events);
end;
$$;

create or replace function rides_private.log_ride_stop_admin_change()
returns trigger
language plpgsql
volatile
security definer
set search_path to ''
as $$
declare
  v_driver_id uuid := case when tg_op = 'DELETE' then old.driver_id else new.driver_id end;
  v_plan_date date;
begin
  if tg_op = 'UPDATE'
     and old.driver_id is not distinct from new.driver_id
     and old.stop_order is not distinct from new.stop_order
     and old.rider_name is not distinct from new.rider_name
     and old.phone is not distinct from new.phone
     and old.address is not distinct from new.address
     and old.area is not distinct from new.area
     and old.pickup_time is not distinct from new.pickup_time
     and old.ready_by is not distinct from new.ready_by
     and old.route_label is not distinct from new.route_label
     and old.notes is not distinct from new.notes then
    return new;
  end if;

  select p.plan_date
  into v_plan_date
  from rides_private.ride_drivers d
  join rides_private.ride_plans p on p.id = d.plan_id
  where d.id = v_driver_id
  limit 1;

  perform rides_private.log_ride_admin_event(
    'publish_plan',
    v_plan_date,
    jsonb_build_object(
      'change', tg_op,
      'riderName', case when tg_op = 'DELETE' then old.rider_name else new.rider_name end
    )
  );

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists ride_admin_audit_stops on rides_private.ride_stops;
create trigger ride_admin_audit_stops
after insert or update or delete on rides_private.ride_stops
for each row execute function rides_private.log_ride_stop_admin_change();

grant execute on function public.ride_admin_security_context(text) to anon, authenticated;
grant execute on function public.ride_admin_activity(text, integer) to anon, authenticated;

notify pgrst, 'reload schema';

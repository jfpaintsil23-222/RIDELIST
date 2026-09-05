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

create table if not exists rides_private.ride_admin_profiles (
  slug text primary key,
  display_name text not null,
  initials text not null,
  password_hash text not null default '',
  active boolean not null default true,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now()
);

alter table rides_private.ride_admin_profiles enable row level security;
alter table rides_private.ride_admin_profiles force row level security;

insert into rides_private.ride_admin_profiles (slug, display_name, initials)
values
  ('joojo', 'Joojo', 'JJ'),
  ('faith', 'Faith', 'FA')
on conflict (slug) do update
set display_name = excluded.display_name,
    initials = excluded.initials,
    updated_at = now();

update rides_private.ride_admin_profiles target
set password_hash = source.password_hash,
    updated_at = now()
from rides_private.ride_admin_profiles source
where target.slug = 'joojo'
  and source.slug = 'jojo'
  and target.password_hash = ''
  and source.password_hash <> '';

update rides_private.ride_admin_profiles
set display_name = 'Joojo',
    initials = 'JJ',
    active = false,
    updated_at = now()
where slug = 'jojo';

create table if not exists rides_private.ride_admin_profile_sessions (
  id uuid primary key default gen_random_uuid(),
  profile_slug text not null references rides_private.ride_admin_profiles(slug) on delete cascade,
  session_token_hash text not null unique,
  expires_at timestamp with time zone not null default (now() + interval '16 hours'),
  created_at timestamp with time zone not null default now()
);

alter table rides_private.ride_admin_profile_sessions enable row level security;
alter table rides_private.ride_admin_profile_sessions force row level security;

create index if not exists ride_admin_profile_sessions_token_hash_idx
on rides_private.ride_admin_profile_sessions (session_token_hash);

create index if not exists ride_admin_profile_sessions_expires_at_idx
on rides_private.ride_admin_profile_sessions (expires_at);

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
  actor_profile_slug text,
  actor_initials text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamp with time zone not null default now()
);

alter table rides_private.ride_admin_audit_log
add column if not exists actor_profile_slug text;

alter table rides_private.ride_admin_audit_log
add column if not exists actor_initials text;

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

create or replace function rides_private.ride_admin_profile_session_actor(p_code text)
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $$
declare
  v_session record;
begin
  if nullif(trim(coalesce(p_code, '')), '') is null then
    return null;
  end if;

  select p.slug, p.display_name, p.initials
  into v_session
  from rides_private.ride_admin_profile_sessions s
  join rides_private.ride_admin_profiles p on p.slug = s.profile_slug
  where s.session_token_hash = rides_private.hash_driver_code(p_code)
    and s.expires_at > now()
    and p.active
  order by s.created_at desc
  limit 1;

  if v_session.slug is null then
    return null;
  end if;

  return jsonb_build_object(
    'type', 'profile',
    'userId', null,
    'email', null,
    'profileSlug', v_session.slug,
    'initials', v_session.initials,
    'label', coalesce(nullif(v_session.display_name, ''), v_session.slug)
  );
end;
$$;

create or replace function rides_private.is_ride_admin_profile_session(p_code text)
returns boolean
language sql
stable
security definer
set search_path to ''
as $$
  select rides_private.ride_admin_profile_session_actor(p_code) is not null;
$$;

create or replace function rides_private.is_ride_admin_code(p_code text)
returns boolean
language sql
stable
security definer
set search_path to ''
as $$
  select rides_private.is_ride_admin()
      or rides_private.is_ride_admin_profile_session(p_code)
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
  v_profile_actor jsonb;
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

  v_profile_actor := rides_private.ride_admin_profile_session_actor(p_code);
  if v_profile_actor is not null then
    return v_profile_actor;
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
  v_profile_ok boolean := rides_private.is_ride_admin_profile_session(p_admin_code);
  v_code_ok boolean := (not v_login_required and rides_private.is_ride_admin_passcode(p_admin_code));
begin
  if not v_auth_admin and not v_profile_ok and not v_code_ok then
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

create or replace function public.ride_admin_profile_login(
  p_profile_slug text,
  p_password text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path to ''
as $$
declare
  v_profile record;
  v_profile_slug text := lower(trim(coalesce(p_profile_slug, '')));
  v_password_hash text;
  v_password_ok boolean := false;
  v_token text;
begin
  if v_profile_slug = 'jojo' then
    v_profile_slug := 'joojo';
  end if;

  if nullif(v_profile_slug, '') is null
     or nullif(trim(coalesce(p_password, '')), '') is null then
    return jsonb_build_object('ok', false, 'error', 'invalid_admin_code');
  end if;

  select p.slug, p.display_name, p.initials, p.password_hash
  into v_profile
  from rides_private.ride_admin_profiles p
  where p.slug = v_profile_slug
    and p.active
  limit 1;

  if v_profile.slug is null then
    return jsonb_build_object('ok', false, 'error', 'invalid_admin_code');
  end if;

  v_password_hash := rides_private.hash_driver_code(p_password);
  v_password_ok := v_profile.password_hash <> '' and v_profile.password_hash = v_password_hash;

  if v_profile.slug = 'joojo' and rides_private.is_ride_admin_passcode(p_password) then
    v_password_ok := true;
  end if;

  if not v_password_ok then
    return jsonb_build_object('ok', false, 'error', 'invalid_admin_code');
  end if;

  delete from rides_private.ride_admin_profile_sessions
  where expires_at <= now();

  v_token := encode(extensions.gen_random_bytes(32), 'hex');

  insert into rides_private.ride_admin_profile_sessions (
    profile_slug,
    session_token_hash,
    expires_at
  )
  values (
    v_profile.slug,
    rides_private.hash_driver_code(v_token),
    now() + interval '16 hours'
  );

  insert into rides_private.ride_admin_audit_log (
    action,
    actor_type,
    actor_label,
    actor_profile_slug,
    actor_initials,
    payload
  )
  values (
    'admin_profile_login',
    'profile',
    coalesce(nullif(v_profile.display_name, ''), v_profile.slug),
    v_profile.slug,
    v_profile.initials,
    jsonb_build_object('profileSlug', v_profile.slug)
  );

  return jsonb_build_object(
    'ok', true,
    'adminCode', v_token,
    'actor', jsonb_build_object(
      'type', 'profile',
      'userId', null,
      'email', null,
      'profileSlug', v_profile.slug,
      'initials', v_profile.initials,
      'label', coalesce(nullif(v_profile.display_name, ''), v_profile.slug)
    )
  );
end;
$$;

create or replace function public.ride_admin_set_profile_password(
  p_admin_code text,
  p_profile_slug text,
  p_new_password text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path to ''
as $$
declare
  v_actor jsonb := rides_private.ride_admin_actor(p_admin_code);
  v_type text := coalesce(nullif(v_actor->>'type', ''), 'unknown');
  v_user_id text := nullif(v_actor->>'userId', '');
  v_profile_slug text := lower(trim(coalesce(p_profile_slug, '')));
  v_profile record;
begin
  if not rides_private.is_ride_admin()
     and not rides_private.is_ride_admin_passcode(p_admin_code) then
    return jsonb_build_object('ok', false, 'error', 'invalid_admin_code');
  end if;

  if v_profile_slug = 'jojo' then
    v_profile_slug := 'joojo';
  end if;

  if nullif(v_profile_slug, '') is null
     or length(trim(coalesce(p_new_password, ''))) < 6 then
    return jsonb_build_object('ok', false, 'error', 'invalid_admin_profile_password');
  end if;

  update rides_private.ride_admin_profiles p
  set password_hash = rides_private.hash_driver_code(p_new_password),
      updated_at = now()
  where p.slug = v_profile_slug
    and p.active
  returning p.slug, p.display_name, p.initials
  into v_profile;

  if v_profile.slug is null then
    return jsonb_build_object('ok', false, 'error', 'invalid_admin_profile');
  end if;

  delete from rides_private.ride_admin_profile_sessions s
  where s.profile_slug = v_profile.slug;

  insert into rides_private.ride_admin_audit_log (
    action,
    actor_type,
    actor_user_id,
    actor_email,
    actor_label,
    actor_profile_slug,
    actor_initials,
    payload
  )
  values (
    'admin_profile_password_set',
    v_type,
    case when v_user_id is null then null else v_user_id::uuid end,
    nullif(v_actor->>'email', ''),
    coalesce(nullif(v_actor->>'label', ''), 'Unknown admin'),
    nullif(v_actor->>'profileSlug', ''),
    nullif(v_actor->>'initials', ''),
    jsonb_build_object('profileSlug', v_profile.slug)
  );

  return jsonb_build_object(
    'ok', true,
    'profile', jsonb_build_object(
      'slug', v_profile.slug,
      'label', coalesce(nullif(v_profile.display_name, ''), v_profile.slug),
      'initials', v_profile.initials
    )
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
  v_actor jsonb := rides_private.ride_admin_actor(nullif(current_setting('request.ride_admin_code', true), ''));
  v_type text := coalesce(nullif(v_actor->>'type', ''), 'unknown');
  v_user_id text := nullif(v_actor->>'userId', '');
begin
  if v_type = 'unknown' then
    v_actor := jsonb_build_object(
      'type', 'code',
      'userId', null,
      'email', null,
      'profileSlug', null,
      'initials', null,
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
    actor_profile_slug,
    actor_initials,
    payload
  )
  values (
    p_action,
    p_plan_date,
    v_type,
    case when v_user_id is null then null else v_user_id::uuid end,
    nullif(v_actor->>'email', ''),
    coalesce(nullif(v_actor->>'label', ''), 'Unknown admin'),
    nullif(v_actor->>'profileSlug', ''),
    nullif(v_actor->>'initials', ''),
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
        'actorProfileSlug', event_rows.actor_profile_slug,
        'actorInitials', event_rows.actor_initials,
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

insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values (
  'ride-app-assets',
  'ride-app-assets',
  true,
  5242880,
  array['image/png', 'image/jpeg', 'image/webp']
)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Ride app assets are public" on storage.objects;
create policy "Ride app assets are public"
on storage.objects
for select
to anon, authenticated
using (bucket_id = 'ride-app-assets');

drop policy if exists "Ride admins can upload ride app assets" on storage.objects;
create policy "Ride admins can upload ride app assets"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'ride-app-assets'
  and (storage.foldername(name))[1] = 'home-covers'
  and rides_private.is_ride_admin()
);

drop policy if exists "Ride admins can update ride app assets" on storage.objects;
create policy "Ride admins can update ride app assets"
on storage.objects
for update
to authenticated
using (
  bucket_id = 'ride-app-assets'
  and (storage.foldername(name))[1] = 'home-covers'
  and rides_private.is_ride_admin()
)
with check (
  bucket_id = 'ride-app-assets'
  and (storage.foldername(name))[1] = 'home-covers'
  and rides_private.is_ride_admin()
);

drop policy if exists "Ride admins can delete ride app assets" on storage.objects;
create policy "Ride admins can delete ride app assets"
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'ride-app-assets'
  and (storage.foldername(name))[1] = 'home-covers'
  and rides_private.is_ride_admin()
);

grant execute on function public.ride_admin_security_context(text) to anon, authenticated;
revoke execute on function public.ride_admin_profile_login(text, text) from public;
revoke execute on function public.ride_admin_set_profile_password(text, text, text) from public;
grant execute on function public.ride_admin_profile_login(text, text) to anon, authenticated;
grant execute on function public.ride_admin_set_profile_password(text, text, text) to anon, authenticated;
grant execute on function public.ride_admin_activity(text, integer) to anon, authenticated;

notify pgrst, 'reload schema';

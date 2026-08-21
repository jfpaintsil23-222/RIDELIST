create table if not exists rides_private.ride_admin_codes (
  id text primary key,
  access_code_hash text not null,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now()
);

alter table rides_private.ride_admin_codes enable row level security;
alter table rides_private.ride_admin_codes force row level security;

-- Set the live admin code separately with:
-- update rides_private.ride_admin_codes
-- set access_code_hash = rides_private.hash_driver_code('<secret-admin-code>'),
--     updated_at = now()
-- where id = 'main';

create or replace function rides_private.is_ride_admin_code(p_code text)
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

create table if not exists rides_private.ride_people (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  name_key text not null unique,
  campus_address text not null default '',
  home_address text not null default '',
  phone text not null default '',
  campus_google_maps text not null default '',
  campus_apple_maps text not null default '',
  home_google_maps text not null default '',
  home_apple_maps text not null default '',
  preferred_address_type text not null default 'home',
  source_label text not null default 'PeopleData',
  notes text not null default '',
  active boolean not null default true,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  constraint ride_people_preferred_address_type_check
    check (preferred_address_type in ('home', 'campus'))
);

alter table rides_private.ride_people enable row level security;
alter table rides_private.ride_people force row level security;
alter table rides_private.ride_people
add column if not exists notes text not null default '';
alter table rides_private.ride_people
add column if not exists active boolean not null default true;

create table if not exists rides_private.ride_driver_push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  plan_date date not null,
  driver_slug text not null,
  endpoint text not null unique,
  subscription jsonb not null,
  user_agent text not null default '',
  active boolean not null default true,
  last_error text not null default '',
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now()
);

alter table rides_private.ride_driver_push_subscriptions enable row level security;
alter table rides_private.ride_driver_push_subscriptions force row level security;

create index if not exists ride_driver_push_subscriptions_driver_idx
on rides_private.ride_driver_push_subscriptions (plan_date, driver_slug)
where active;

create or replace function rides_private.ride_people_name_key(p_name text)
returns text
language sql
immutable
set search_path to ''
as $$
  select lower(regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g'));
$$;

create or replace function rides_private.ride_parse_time(p_value text)
returns time
language plpgsql
immutable
set search_path to ''
as $$
declare
  v_value text := upper(btrim(coalesce(p_value, '')));
begin
  if v_value = '' then
    return null;
  end if;

  begin
    return to_timestamp(v_value, 'HH12:MI AM')::time;
  exception when others then
    return null;
  end;
end;
$$;

create or replace function rides_private.rider_names_summary(p_driver_id uuid)
returns text
language sql
stable
security definer
set search_path to ''
as $$
  with names as (
    select array_agg(s.rider_name order by s.stop_order, s.rider_name) as rider_names
    from rides_private.ride_stops s
    where s.driver_id = p_driver_id
  )
  select case
    when coalesce(array_length(rider_names, 1), 0) = 0 then 'No pickups assigned'
    when array_length(rider_names, 1) = 1 then rider_names[1]
    when array_length(rider_names, 1) = 2 then rider_names[1] || ' and ' || rider_names[2]
    else array_to_string(rider_names[1:array_length(rider_names, 1) - 1], ', ') || ', and ' || rider_names[array_length(rider_names, 1)]
  end
  from names;
$$;

create or replace function public.ride_driver_save_push_subscription(
  p_driver_slug text,
  p_access_code text,
  p_plan_date date default null,
  p_subscription jsonb default '{}'::jsonb,
  p_user_agent text default ''
)
returns jsonb
language plpgsql
volatile
security definer
set search_path to ''
as $$
declare
  v_plan_date date := coalesce(p_plan_date, date '2026-08-09');
  v_plan_id uuid;
  v_driver record;
  v_endpoint text := btrim(coalesce(p_subscription->>'endpoint', ''));
begin
  if v_endpoint = '' then
    return jsonb_build_object('ok', false, 'error', 'missing_push_endpoint');
  end if;

  select p.id
  into v_plan_id
  from rides_private.ride_plans p
  where p.plan_date = v_plan_date
  limit 1;

  select d.id, d.slug, d.access_code_hash
  into v_driver
  from rides_private.ride_drivers d
  where d.plan_id = v_plan_id
    and d.slug = lower(btrim(coalesce(p_driver_slug, '')))
  limit 1;

  if v_driver.id is null or v_driver.access_code_hash <> rides_private.hash_driver_code(p_access_code) then
    return jsonb_build_object('ok', false, 'error', 'invalid_code');
  end if;

  insert into rides_private.ride_driver_push_subscriptions (
    plan_date,
    driver_slug,
    endpoint,
    subscription,
    user_agent,
    active,
    last_error,
    updated_at
  )
  values (
    v_plan_date,
    v_driver.slug,
    v_endpoint,
    p_subscription,
    btrim(coalesce(p_user_agent, '')),
    true,
    '',
    now()
  )
  on conflict (endpoint) do update
  set plan_date = excluded.plan_date,
      driver_slug = excluded.driver_slug,
      subscription = excluded.subscription,
      user_agent = excluded.user_agent,
      active = true,
      last_error = '',
      updated_at = now();

  return jsonb_build_object('ok', true, 'driverSlug', v_driver.slug);
end;
$$;

create or replace function public.ride_admin_driver_push_subscriptions(
  p_admin_code text,
  p_plan_date date default null,
  p_driver_slugs text[] default '{}'::text[]
)
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $$
declare
  v_plan_date date := coalesce(p_plan_date, date '2026-08-09');
begin
  if not rides_private.is_ride_admin_code(p_admin_code) then
    return jsonb_build_object('ok', false, 'error', 'invalid_admin_code');
  end if;

  return jsonb_build_object(
    'ok', true,
    'subscriptions', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', s.id::text,
          'driverSlug', s.driver_slug,
          'endpoint', s.endpoint,
          'subscription', s.subscription
        )
        order by s.driver_slug, s.updated_at desc
      )
      from rides_private.ride_driver_push_subscriptions s
      where s.plan_date = v_plan_date
        and s.active
        and (
          coalesce(array_length(p_driver_slugs, 1), 0) = 0
          or s.driver_slug = any(p_driver_slugs)
        )
    ), '[]'::jsonb)
  );
end;
$$;

create or replace function public.ride_admin_update_push_subscription_status(
  p_admin_code text,
  p_endpoint text,
  p_active boolean,
  p_last_error text default ''
)
returns jsonb
language plpgsql
volatile
security definer
set search_path to ''
as $$
begin
  if not rides_private.is_ride_admin_code(p_admin_code) then
    return jsonb_build_object('ok', false, 'error', 'invalid_admin_code');
  end if;

  update rides_private.ride_driver_push_subscriptions s
  set active = coalesce(p_active, s.active),
      last_error = btrim(coalesce(p_last_error, '')),
      updated_at = now()
  where s.endpoint = btrim(coalesce(p_endpoint, ''));

  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.ride_admin_snapshot(
  p_admin_code text,
  p_plan_date date default '2026-08-09'::date
)
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $$
declare
  v_plan record;
  v_drivers jsonb;
  v_stops jsonb;
  v_people jsonb;
  v_total_drivers integer;
  v_total_stops integer;
begin
  if not rides_private.is_ride_admin_code(p_admin_code) then
    return jsonb_build_object('ok', false, 'error', 'invalid_admin_code');
  end if;

  select p.id, p.title, p.service_day, p.plan_date, p.destination_label, p.destination_address
  into v_plan
  from rides_private.ride_plans p
  where p.plan_date = coalesce(p_plan_date, date '2026-08-09')
  limit 1;

  if v_plan.id is null then
    return jsonb_build_object('ok', false, 'error', 'plan_not_found');
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'slug', driver_rows.slug,
        'displayName', driver_rows.display_name,
        'fullName', driver_rows.full_name,
        'initials', driver_rows.initials,
        'subtitle', driver_rows.subtitle,
        'routeNotes', driver_rows.route_notes,
        'pickupCount', driver_rows.pickup_count,
        'sortOrder', driver_rows.sort_order
      )
      order by driver_rows.sort_order, driver_rows.display_name
    ),
    '[]'::jsonb
  )
  into v_drivers
  from (
    select
      d.slug,
      d.display_name,
      d.full_name,
      d.initials,
      d.subtitle,
      d.route_notes,
      d.sort_order,
      count(s.id)::integer as pickup_count
    from rides_private.ride_drivers d
    left join rides_private.ride_stops s on s.driver_id = d.id
    where d.plan_id = v_plan.id
    group by d.id, d.slug, d.display_name, d.full_name, d.initials, d.subtitle, d.route_notes, d.sort_order
  ) driver_rows;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', s.id::text,
        'driverSlug', d.slug,
        'driverName', d.display_name,
        'stopOrder', s.stop_order,
        'name', s.rider_name,
        'phone', s.phone,
        'address', s.address,
        'area', s.area,
        'pickupTime', case when s.pickup_time is null then null else to_char(s.pickup_time, 'FMHH12:MI AM') end,
        'readyBy', case when s.ready_by is null then null else to_char(s.ready_by, 'FMHH12:MI AM') end,
        'routeLabel', s.route_label,
        'notes', s.notes
      )
      order by d.sort_order, s.stop_order, s.rider_name
    ),
    '[]'::jsonb
  )
  into v_stops
  from rides_private.ride_stops s
  join rides_private.ride_drivers d on d.id = s.driver_id
  where d.plan_id = v_plan.id;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', p.id::text,
        'name', p.name,
        'campusAddress', p.campus_address,
        'homeAddress', p.home_address,
        'phone', p.phone,
        'preferredAddressType', p.preferred_address_type,
        'preferredAddress', case
          when p.preferred_address_type = 'campus' and p.campus_address <> '' then p.campus_address
          when p.home_address <> '' then p.home_address
          else p.campus_address
        end,
        'campusGoogleMaps', p.campus_google_maps,
        'campusAppleMaps', p.campus_apple_maps,
        'homeGoogleMaps', p.home_google_maps,
        'homeAppleMaps', p.home_apple_maps,
        'sourceLabel', p.source_label,
        'notes', p.notes,
        'active', p.active
      )
      order by lower(p.name), p.name
    ),
    '[]'::jsonb
  )
  into v_people
  from rides_private.ride_people p
  where p.active;

  select count(*)::integer into v_total_drivers
  from rides_private.ride_drivers d
  where d.plan_id = v_plan.id;

  select count(*)::integer into v_total_stops
  from rides_private.ride_stops s
  join rides_private.ride_drivers d on d.id = s.driver_id
  where d.plan_id = v_plan.id;

  return jsonb_build_object(
    'ok', true,
    'plan', jsonb_build_object(
      'title', v_plan.title,
      'serviceDay', v_plan.service_day,
      'date', v_plan.plan_date
    ),
    'destination', jsonb_build_object(
      'label', v_plan.destination_label,
      'address', v_plan.destination_address
    ),
    'stats', jsonb_build_object(
      'drivers', v_total_drivers,
      'assigned', v_total_stops,
      'review', 0
    ),
    'drivers', v_drivers,
    'stops', v_stops,
    'people', v_people
  );
end;
$$;

create or replace function public.ride_admin_upsert_people(
  p_admin_code text,
  p_people jsonb default '[]'::jsonb,
  p_source_label text default 'PeopleData'
)
returns jsonb
language plpgsql
volatile
security definer
set search_path to ''
as $$
declare
  v_person jsonb;
  v_name text;
  v_name_key text;
  v_person_id uuid;
  v_count integer := 0;
  v_preferred text;
  v_existing_name text;
  v_preferred_address text;
  v_route_area text;
  v_route_updates integer := 0;
  v_total_route_updates integer := 0;
begin
  if not rides_private.is_ride_admin_code(p_admin_code) then
    return jsonb_build_object('ok', false, 'error', 'invalid_admin_code');
  end if;

  if p_people is null or jsonb_typeof(p_people) <> 'array' then
    return jsonb_build_object('ok', false, 'error', 'people_array_required');
  end if;

  for v_person in select value from jsonb_array_elements(p_people) loop
    v_name := btrim(coalesce(v_person->>'name', ''));
    v_name_key := rides_private.ride_people_name_key(v_name);
    begin
      v_person_id := nullif(btrim(coalesce(v_person->>'id', '')), '')::uuid;
    exception when others then
      return jsonb_build_object('ok', false, 'error', 'invalid_person_id');
    end;

    if v_name = '' or v_name_key = '' then
      continue;
    end if;

    v_preferred := lower(btrim(coalesce(v_person->>'preferredAddressType', '')));
    if v_preferred not in ('home', 'campus') then
      v_preferred := case
        when btrim(coalesce(v_person->>'homeAddress', '')) = ''
             and btrim(coalesce(v_person->>'campusAddress', '')) <> '' then 'campus'
        else 'home'
      end;
    end if;

    v_preferred_address := case
      when v_preferred = 'campus' then btrim(coalesce(v_person->>'campusAddress', ''))
      else btrim(coalesce(v_person->>'homeAddress', ''))
    end;

    if v_preferred_address = '' then
      v_preferred_address := case
        when v_preferred = 'campus' then btrim(coalesce(v_person->>'homeAddress', ''))
        else btrim(coalesce(v_person->>'campusAddress', ''))
      end;
    end if;

    v_route_area := case
      when v_preferred_address = '' then ''
      when v_preferred = 'campus' and btrim(coalesce(v_person->>'campusAddress', '')) <> '' then 'Campus'
      when v_preferred = 'home' and btrim(coalesce(v_person->>'homeAddress', '')) <> '' then 'Home'
      else ''
    end;

    v_existing_name := v_name;

    if v_person_id is not null and exists (
      select 1
      from rides_private.ride_people p
      where p.id = v_person_id
    ) then
      select p.name
      into v_existing_name
      from rides_private.ride_people p
      where p.id = v_person_id
      limit 1;

      update rides_private.ride_people p
      set name = v_name,
          name_key = v_name_key,
          campus_address = btrim(coalesce(v_person->>'campusAddress', '')),
          home_address = btrim(coalesce(v_person->>'homeAddress', '')),
          phone = btrim(coalesce(v_person->>'phone', '')),
          campus_google_maps = btrim(coalesce(v_person->>'campusGoogleMaps', '')),
          campus_apple_maps = btrim(coalesce(v_person->>'campusAppleMaps', '')),
          home_google_maps = btrim(coalesce(v_person->>'homeGoogleMaps', '')),
          home_apple_maps = btrim(coalesce(v_person->>'homeAppleMaps', '')),
          preferred_address_type = v_preferred,
          source_label = btrim(coalesce(p_source_label, 'PeopleData')),
          notes = btrim(coalesce(v_person->>'notes', '')),
          active = true,
          updated_at = now()
      where p.id = v_person_id;
    else
      insert into rides_private.ride_people (
        name,
        name_key,
        campus_address,
        home_address,
        phone,
        campus_google_maps,
        campus_apple_maps,
        home_google_maps,
        home_apple_maps,
        preferred_address_type,
        source_label,
        notes,
        active
      )
      values (
        v_name,
        v_name_key,
        btrim(coalesce(v_person->>'campusAddress', '')),
        btrim(coalesce(v_person->>'homeAddress', '')),
        btrim(coalesce(v_person->>'phone', '')),
        btrim(coalesce(v_person->>'campusGoogleMaps', '')),
        btrim(coalesce(v_person->>'campusAppleMaps', '')),
        btrim(coalesce(v_person->>'homeGoogleMaps', '')),
        btrim(coalesce(v_person->>'homeAppleMaps', '')),
        v_preferred,
        btrim(coalesce(p_source_label, 'PeopleData')),
        btrim(coalesce(v_person->>'notes', '')),
        true
      )
      on conflict (name_key) do update
      set name = excluded.name,
          campus_address = excluded.campus_address,
          home_address = excluded.home_address,
          phone = excluded.phone,
          campus_google_maps = excluded.campus_google_maps,
          campus_apple_maps = excluded.campus_apple_maps,
          home_google_maps = excluded.home_google_maps,
          home_apple_maps = excluded.home_apple_maps,
          preferred_address_type = excluded.preferred_address_type,
          source_label = excluded.source_label,
          notes = excluded.notes,
          active = true,
          updated_at = now();
    end if;

    update rides_private.ride_stops s
    set rider_name = v_name,
        phone = btrim(coalesce(v_person->>'phone', '')),
        address = case when v_preferred_address <> '' then v_preferred_address else s.address end,
        area = case when v_route_area <> '' then v_route_area else s.area end,
        updated_at = now()
    from rides_private.ride_drivers d
    join rides_private.ride_plans rp on rp.id = d.plan_id
    where s.driver_id = d.id
      and rp.plan_date = rides_private.current_ride_plan_date()
      and lower(btrim(s.rider_name)) in (lower(btrim(v_name)), lower(btrim(coalesce(v_existing_name, v_name))));

    get diagnostics v_route_updates = row_count;
    v_total_route_updates := v_total_route_updates + v_route_updates;

    v_count := v_count + 1;
  end loop;

  update rides_private.ride_drivers d
  set subtitle = rides_private.rider_names_summary(d.id),
      updated_at = now()
  from rides_private.ride_plans rp
  where d.plan_id = rp.id
    and rp.plan_date = rides_private.current_ride_plan_date();

  return jsonb_build_object('ok', true, 'upserted', v_count, 'routeStopsUpdated', v_total_route_updates);
end;
$$;

create or replace function public.ride_admin_merge_people(
  p_admin_code text,
  p_primary_person_id uuid,
  p_duplicate_person_id uuid,
  p_primary_person jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path to ''
as $$
declare
  v_primary record;
  v_duplicate record;
  v_name text := btrim(coalesce(p_primary_person->>'name', ''));
  v_name_key text := rides_private.ride_people_name_key(btrim(coalesce(p_primary_person->>'name', '')));
  v_preferred text := lower(btrim(coalesce(p_primary_person->>'preferredAddressType', 'home')));
begin
  if not rides_private.is_ride_admin_code(p_admin_code) then
    return jsonb_build_object('ok', false, 'error', 'invalid_admin_code');
  end if;

  if p_primary_person_id is null or p_duplicate_person_id is null or p_primary_person_id = p_duplicate_person_id then
    return jsonb_build_object('ok', false, 'error', 'invalid_merge_people');
  end if;

  if v_name = '' or v_name_key = '' then
    return jsonb_build_object('ok', false, 'error', 'person_name_required');
  end if;

  if v_preferred not in ('home', 'campus') then
    v_preferred := 'home';
  end if;

  select p.id
  into v_primary
  from rides_private.ride_people p
  where p.id = p_primary_person_id
    and p.active
  limit 1;

  select p.id
  into v_duplicate
  from rides_private.ride_people p
  where p.id = p_duplicate_person_id
    and p.active
  limit 1;

  if v_primary.id is null or v_duplicate.id is null then
    return jsonb_build_object('ok', false, 'error', 'person_not_found');
  end if;

  update rides_private.ride_people p
  set active = false,
      name_key = rides_private.ride_people_name_key(p.name || ' merged ' || p.id::text),
      updated_at = now()
  where p.id = p_duplicate_person_id;

  update rides_private.ride_people p
  set name = v_name,
      name_key = v_name_key,
      campus_address = btrim(coalesce(p_primary_person->>'campusAddress', '')),
      home_address = btrim(coalesce(p_primary_person->>'homeAddress', '')),
      phone = btrim(coalesce(p_primary_person->>'phone', '')),
      preferred_address_type = v_preferred,
      source_label = btrim(coalesce(p_primary_person->>'sourceLabel', 'PeopleData')),
      notes = btrim(coalesce(p_primary_person->>'notes', '')),
      active = true,
      updated_at = now()
  where p.id = p_primary_person_id;

  return jsonb_build_object(
    'ok', true,
    'primaryPersonId', p_primary_person_id::text,
    'duplicatePersonId', p_duplicate_person_id::text
  );
end;
$$;

create or replace function public.ride_admin_archive_people(
  p_admin_code text,
  p_person_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path to ''
as $$
declare
  v_count integer := 0;
begin
  if not rides_private.is_ride_admin_code(p_admin_code) then
    return jsonb_build_object('ok', false, 'error', 'invalid_admin_code');
  end if;

  if p_person_id is null then
    return jsonb_build_object('ok', false, 'error', 'person_required');
  end if;

  update rides_private.ride_people p
  set active = false,
      name_key = rides_private.ride_people_name_key(p.name || ' archived ' || p.id::text),
      updated_at = now()
  where p.id = p_person_id
    and p.active;

  get diagnostics v_count = row_count;

  if v_count = 0 then
    return jsonb_build_object('ok', false, 'error', 'person_not_found');
  end if;

  return jsonb_build_object('ok', true, 'personId', p_person_id::text);
end;
$$;

create or replace function public.ride_admin_publish_plan(
  p_admin_code text,
  p_plan_date date default '2026-08-09'::date,
  p_stops jsonb default '[]'::jsonb,
  p_deleted_stop_ids text[] default '{}'::text[]
)
returns jsonb
language plpgsql
volatile
security definer
set search_path to ''
as $$
declare
  v_plan record;
  v_stop jsonb;
  v_driver record;
  v_stop_id text;
  v_stop_order integer;
  v_name text;
  v_address text;
begin
  if not rides_private.is_ride_admin_code(p_admin_code) then
    return jsonb_build_object('ok', false, 'error', 'invalid_admin_code');
  end if;

  select p.id
  into v_plan
  from rides_private.ride_plans p
  where p.plan_date = coalesce(p_plan_date, date '2026-08-09')
  limit 1;

  if v_plan.id is null then
    return jsonb_build_object('ok', false, 'error', 'plan_not_found');
  end if;

  if coalesce(array_length(p_deleted_stop_ids, 1), 0) > 0 then
    delete from rides_private.ride_stops s
    using rides_private.ride_drivers d
    where s.driver_id = d.id
      and d.plan_id = v_plan.id
      and s.id::text = any(p_deleted_stop_ids);
  end if;

  if p_stops is not null and jsonb_typeof(p_stops) = 'array' then
    for v_stop in select value from jsonb_array_elements(p_stops) loop
      v_name := btrim(coalesce(v_stop->>'name', ''));
      v_address := btrim(coalesce(v_stop->>'address', ''));

      if v_name = '' or v_address = '' then
        return jsonb_build_object('ok', false, 'error', 'rider_name_and_address_required');
      end if;

      select d.id, d.slug
      into v_driver
      from rides_private.ride_drivers d
      where d.plan_id = v_plan.id
        and d.slug = lower(btrim(coalesce(v_stop->>'driverSlug', '')))
      limit 1;

      if v_driver.id is null then
        return jsonb_build_object('ok', false, 'error', 'driver_not_found');
      end if;

      begin
        v_stop_order := greatest(1, coalesce((v_stop->>'stopOrder')::integer, 1));
      exception when others then
        select coalesce(max(s.stop_order), 0) + 1
        into v_stop_order
        from rides_private.ride_stops s
        where s.driver_id = v_driver.id;
      end;

      v_stop_id := nullif(btrim(coalesce(v_stop->>'id', '')), '');

      if exists (
        select 1
        from rides_private.ride_stops existing_stop
        where existing_stop.driver_id = v_driver.id
          and existing_stop.stop_order = v_stop_order
          and (v_stop_id is null or existing_stop.id::text <> v_stop_id)
      ) then
        select coalesce(max(s.stop_order), 0) + 1
        into v_stop_order
        from rides_private.ride_stops s
        where s.driver_id = v_driver.id;
      end if;

      if v_stop_id is not null and exists (
        select 1
        from rides_private.ride_stops s
        join rides_private.ride_drivers d on d.id = s.driver_id
        where s.id::text = v_stop_id
          and d.plan_id = v_plan.id
      ) then
        update rides_private.ride_stops s
        set driver_id = v_driver.id,
            stop_order = v_stop_order,
            rider_name = v_name,
            phone = btrim(coalesce(v_stop->>'phone', '')),
            address = v_address,
            area = btrim(coalesce(v_stop->>'area', '')),
            pickup_time = rides_private.ride_parse_time(v_stop->>'pickupTime'),
            ready_by = rides_private.ride_parse_time(v_stop->>'readyBy'),
            route_label = btrim(coalesce(v_stop->>'routeLabel', '')),
            notes = btrim(coalesce(v_stop->>'notes', '')),
            updated_at = now()
        where s.id::text = v_stop_id;
      else
        insert into rides_private.ride_stops (
          driver_id,
          stop_order,
          rider_name,
          phone,
          address,
          area,
          pickup_time,
          ready_by,
          route_label,
          notes
        )
        values (
          v_driver.id,
          v_stop_order,
          v_name,
          btrim(coalesce(v_stop->>'phone', '')),
          v_address,
          btrim(coalesce(v_stop->>'area', '')),
          rides_private.ride_parse_time(v_stop->>'pickupTime'),
          rides_private.ride_parse_time(v_stop->>'readyBy'),
          btrim(coalesce(v_stop->>'routeLabel', '')),
          btrim(coalesce(v_stop->>'notes', ''))
        );
      end if;
    end loop;
  end if;

  with ordered as (
    select
      s.id,
      row_number() over (
        partition by s.driver_id
        order by s.stop_order, s.created_at, s.rider_name
      )::integer as new_order
    from rides_private.ride_stops s
    join rides_private.ride_drivers d on d.id = s.driver_id
    where d.plan_id = v_plan.id
  )
  update rides_private.ride_stops s
  set stop_order = ordered.new_order,
      updated_at = now()
  from ordered
  where s.id = ordered.id;

  update rides_private.ride_drivers d
  set subtitle = rides_private.rider_names_summary(d.id),
      updated_at = now()
  where d.plan_id = v_plan.id;

  return public.ride_admin_snapshot(p_admin_code, coalesce(p_plan_date, date '2026-08-09'));
end;
$$;

grant execute on function public.ride_admin_snapshot(text, date) to anon, authenticated;
grant execute on function public.ride_admin_upsert_people(text, jsonb, text) to anon, authenticated;
grant execute on function public.ride_admin_merge_people(text, uuid, uuid, jsonb) to anon, authenticated;
grant execute on function public.ride_admin_archive_people(text, uuid) to anon, authenticated;
grant execute on function public.ride_admin_publish_plan(text, date, jsonb, text[]) to anon, authenticated;
grant execute on function public.ride_driver_save_push_subscription(text, text, date, jsonb, text) to anon, authenticated;
grant execute on function public.ride_admin_driver_push_subscriptions(text, date, text[]) to anon, authenticated;
grant execute on function public.ride_admin_update_push_subscription_status(text, text, boolean, text) to anon, authenticated;

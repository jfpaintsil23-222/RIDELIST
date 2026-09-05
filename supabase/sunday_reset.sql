create table if not exists rides_private.ride_app_settings (
  id text primary key,
  active_plan_date date not null,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now()
);

alter table rides_private.ride_app_settings enable row level security;
alter table rides_private.ride_app_settings force row level security;

alter table rides_private.ride_app_settings
add column if not exists home_title text not null default 'Sunday Ride Plan',
add column if not exists home_subtitle text not null default '',
add column if not exists home_cover_url text not null default 'assets/home-car.png',
add column if not exists home_cover_alt text not null default 'Church ride car';

create table if not exists rides_private.ride_admin_drafts (
  id uuid primary key default gen_random_uuid(),
  plan_date date not null,
  actor_key text not null,
  draft jsonb not null default '{}'::jsonb,
  saved_at timestamp with time zone not null default now(),
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  unique (plan_date, actor_key)
);

alter table rides_private.ride_admin_drafts enable row level security;
alter table rides_private.ride_admin_drafts force row level security;

insert into rides_private.ride_app_settings (id, active_plan_date)
values (
  'main',
  coalesce(
    (select p.plan_date from rides_private.ride_plans p where p.plan_date = date '2026-08-09' limit 1),
    (select max(p.plan_date) from rides_private.ride_plans p)
  )
)
on conflict (id) do nothing;

do $$
begin
  if to_regclass('rides_private.ride_people') is not null then
    alter table rides_private.ride_people
    add column if not exists notes text not null default '';
    alter table rides_private.ride_people
    add column if not exists active boolean not null default true;
  end if;
end;
$$;

create or replace function rides_private.current_ride_plan_date()
returns date
language sql
stable
security definer
set search_path to ''
as $$
  select coalesce(
    (select s.active_plan_date from rides_private.ride_app_settings s where s.id = 'main'),
    (select max(p.plan_date) from rides_private.ride_plans p),
    date '2026-08-09'
  );
$$;

create or replace function public.ride_app_context()
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $$
declare
  v_plan record;
begin
  select
    p.title,
    p.service_day,
    p.plan_date,
    p.destination_label,
    p.destination_address,
    s.home_title,
    s.home_subtitle,
    s.home_cover_url,
    s.home_cover_alt
  into v_plan
  from rides_private.ride_plans p
  left join rides_private.ride_app_settings s on s.id = 'main'
  where p.plan_date = rides_private.current_ride_plan_date()
  limit 1;

  if v_plan.plan_date is null then
    return jsonb_build_object('ok', false, 'error', 'plan_not_found');
  end if;

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
    'appSettings', jsonb_build_object(
      'homeTitle', coalesce(v_plan.home_title, 'Sunday Ride Plan'),
      'homeSubtitle', coalesce(v_plan.home_subtitle, ''),
      'homeCoverUrl', coalesce(v_plan.home_cover_url, 'assets/home-car.png'),
      'homeCoverAlt', coalesce(v_plan.home_cover_alt, 'Church ride car')
    )
  );
end;
$$;

create or replace function public.ride_driver_directory(p_plan_date date default null)
returns table (
  slug text,
  display_name text,
  initials text,
  subtitle text,
  pickup_count integer,
  sort_order integer
)
language sql
stable
security definer
set search_path to ''
as $$
  select
    d.slug,
    d.display_name,
    d.initials,
    d.subtitle,
    count(s.id)::integer as pickup_count,
    d.sort_order
  from rides_private.ride_drivers d
  join rides_private.ride_plans p on p.id = d.plan_id
  left join rides_private.ride_stops s on s.driver_id = d.id
  where p.plan_date = coalesce(p_plan_date, rides_private.current_ride_plan_date())
  group by d.id, d.slug, d.display_name, d.initials, d.subtitle, d.sort_order
  order by d.sort_order, d.display_name;
$$;

create or replace function public.ride_driver_route(
  p_driver_slug text,
  p_access_code text,
  p_plan_date date default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $$
declare
  v_driver record;
  v_code_hash text;
  v_riders jsonb;
begin
  if p_driver_slug is null or btrim(p_driver_slug) = '' or p_access_code is null or btrim(p_access_code) = '' then
    return jsonb_build_object('ok', false, 'error', 'code_required');
  end if;

  select
    d.id,
    d.slug,
    d.display_name,
    d.full_name,
    d.initials,
    d.subtitle,
    d.route_notes,
    d.access_code_hash,
    p.title,
    p.service_day,
    p.plan_date,
    p.destination_label,
    p.destination_address
  into v_driver
  from rides_private.ride_drivers d
  join rides_private.ride_plans p on p.id = d.plan_id
  where d.slug = lower(btrim(p_driver_slug))
    and p.plan_date = coalesce(p_plan_date, rides_private.current_ride_plan_date())
  limit 1;

  v_code_hash := rides_private.hash_driver_code(p_access_code);

  if v_driver.id is null or v_driver.access_code_hash <> v_code_hash then
    return jsonb_build_object('ok', false, 'error', 'invalid_code');
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
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
      order by s.stop_order
    ),
    '[]'::jsonb
  )
  into v_riders
  from rides_private.ride_stops s
  where s.driver_id = v_driver.id;

  return jsonb_build_object(
    'ok', true,
    'plan', jsonb_build_object(
      'title', v_driver.title,
      'serviceDay', v_driver.service_day,
      'date', v_driver.plan_date
    ),
    'destination', jsonb_build_object(
      'label', v_driver.destination_label,
      'address', v_driver.destination_address
    ),
    'driver', jsonb_build_object(
      'slug', v_driver.slug,
      'displayName', v_driver.display_name,
      'fullName', v_driver.full_name,
      'initials', v_driver.initials,
      'subtitle', v_driver.subtitle,
      'routeNotes', v_driver.route_notes
    ),
    'riders', v_riders
  );
end;
$$;

create or replace function public.ride_admin_snapshot(
  p_admin_code text,
  p_plan_date date default null
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
  v_driver_pool jsonb;
  v_stops jsonb;
  v_people jsonb;
  v_total_drivers integer;
  v_total_stops integer;
begin
  if not rides_private.is_ride_admin_code(p_admin_code) then
    return jsonb_build_object('ok', false, 'error', 'invalid_admin_code');
  end if;

  select
    p.id,
    p.title,
    p.service_day,
    p.plan_date,
    p.destination_label,
    p.destination_address,
    s.home_title,
    s.home_subtitle,
    s.home_cover_url,
    s.home_cover_alt
  into v_plan
  from rides_private.ride_plans p
  left join rides_private.ride_app_settings s on s.id = 'main'
  where p.plan_date = coalesce(p_plan_date, rides_private.current_ride_plan_date())
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

  with active_driver_rows as (
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
  ), saved_driver_rows as (
    select *
    from (
      select
        d.slug,
        d.display_name,
        d.full_name,
        d.initials,
        d.subtitle,
        d.route_notes,
        d.sort_order,
        row_number() over (
          partition by d.slug
          order by case when d.plan_id = v_plan.id then 0 else 1 end, d.updated_at desc
        ) as row_rank
      from rides_private.ride_drivers d
    ) ranked_saved_drivers
    where ranked_saved_drivers.row_rank = 1
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'slug', saved_driver_rows.slug,
        'displayName', coalesce(active_driver_rows.display_name, saved_driver_rows.display_name),
        'fullName', coalesce(active_driver_rows.full_name, saved_driver_rows.full_name),
        'initials', coalesce(active_driver_rows.initials, saved_driver_rows.initials),
        'subtitle', coalesce(active_driver_rows.subtitle, saved_driver_rows.subtitle),
        'routeNotes', coalesce(active_driver_rows.route_notes, saved_driver_rows.route_notes),
        'pickupCount', coalesce(active_driver_rows.pickup_count, 0),
        'sortOrder', coalesce(active_driver_rows.sort_order, saved_driver_rows.sort_order),
        'active', active_driver_rows.slug is not null
      )
      order by
        case when active_driver_rows.slug is null then 1 else 0 end,
        coalesce(active_driver_rows.sort_order, saved_driver_rows.sort_order),
        coalesce(active_driver_rows.display_name, saved_driver_rows.display_name)
    ),
    '[]'::jsonb
  )
  into v_driver_pool
  from saved_driver_rows
  left join active_driver_rows on active_driver_rows.slug = saved_driver_rows.slug;

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
    'appSettings', jsonb_build_object(
      'homeTitle', coalesce(v_plan.home_title, 'Sunday Ride Plan'),
      'homeSubtitle', coalesce(v_plan.home_subtitle, ''),
      'homeCoverUrl', coalesce(v_plan.home_cover_url, 'assets/home-car.png'),
      'homeCoverAlt', coalesce(v_plan.home_cover_alt, 'Church ride car')
    ),
    'stats', jsonb_build_object(
      'drivers', v_total_drivers,
      'assigned', v_total_stops,
      'review', 0
    ),
    'drivers', v_drivers,
    'driverPool', v_driver_pool,
    'stops', v_stops,
    'people', v_people
  );
end;
$$;

create or replace function public.ride_admin_publish_plan(
  p_admin_code text,
  p_plan_date date default null,
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
  v_driver_slug text;
begin
  if not rides_private.is_ride_admin_code(p_admin_code) then
    return jsonb_build_object('ok', false, 'error', 'invalid_admin_code');
  end if;

  perform set_config('request.ride_admin_code', coalesce(p_admin_code, ''), true);

  select p.id
  into v_plan
  from rides_private.ride_plans p
  where p.plan_date = coalesce(p_plan_date, rides_private.current_ride_plan_date())
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
      v_driver_slug := lower(btrim(coalesce(v_stop->>'driverSlug', '')));

      if v_name = '' then
        return jsonb_build_object('ok', false, 'error', 'rider_name_required');
      end if;

      if v_driver_slug = '' then
        return jsonb_build_object(
          'ok', false,
          'error', 'driver_required',
          'riderName', v_name,
          'driverSlug', v_driver_slug
        );
      end if;

      select d.id, d.slug
      into v_driver
      from rides_private.ride_drivers d
      where d.plan_id = v_plan.id
        and d.slug = v_driver_slug
      limit 1;

      if v_driver.id is null then
        return jsonb_build_object(
          'ok', false,
          'error', 'driver_not_found',
          'riderName', v_name,
          'driverSlug', v_driver_slug
        );
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

  return public.ride_admin_snapshot(p_admin_code, coalesce(p_plan_date, rides_private.current_ride_plan_date()));
end;
$$;

create or replace function public.ride_admin_publish_plan_dry_run(
  p_admin_code text,
  p_plan_date date default null,
  p_stops jsonb default '[]'::jsonb,
  p_deleted_stop_ids text[] default '{}'::text[]
)
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $$
declare
  v_plan record;
  v_stop jsonb;
  v_driver_id uuid;
  v_index integer := 0;
  v_name text;
  v_driver_slug text;
  v_issues jsonb := '[]'::jsonb;
begin
  if not rides_private.is_ride_admin_code(p_admin_code) then
    return jsonb_build_object('ok', false, 'error', 'invalid_admin_code');
  end if;

  select p.id
  into v_plan
  from rides_private.ride_plans p
  where p.plan_date = coalesce(p_plan_date, rides_private.current_ride_plan_date())
  limit 1;

  if v_plan.id is null then
    return jsonb_build_object('ok', false, 'error', 'plan_not_found');
  end if;

  if p_stops is null or jsonb_typeof(p_stops) <> 'array' then
    return jsonb_build_object('ok', false, 'error', 'stops_array_required');
  end if;

  for v_stop in select value from jsonb_array_elements(p_stops) loop
    v_index := v_index + 1;
    v_name := btrim(coalesce(v_stop->>'name', ''));
    v_driver_slug := lower(btrim(coalesce(v_stop->>'driverSlug', '')));

    if v_name = '' then
      v_issues := v_issues || jsonb_build_array(jsonb_build_object(
        'error', 'rider_name_required',
        'title', 'Rider name is missing',
        'index', v_index
      ));
      continue;
    end if;

    if v_driver_slug = '' then
      v_issues := v_issues || jsonb_build_array(jsonb_build_object(
        'error', 'driver_required',
        'title', v_name || ' is not assigned to a driver',
        'riderName', v_name,
        'driverSlug', v_driver_slug,
        'index', v_index
      ));
      continue;
    end if;

    v_driver_id := null;
    select d.id
    into v_driver_id
    from rides_private.ride_drivers d
    where d.plan_id = v_plan.id
      and d.slug = v_driver_slug
    limit 1;

    if v_driver_id is null then
      v_issues := v_issues || jsonb_build_array(jsonb_build_object(
        'error', 'driver_not_found',
        'title', v_name || ' is assigned to a driver that is not active',
        'riderName', v_name,
        'driverSlug', v_driver_slug,
        'index', v_index
      ));
    end if;
  end loop;

  return jsonb_build_object(
    'ok', true,
    'issues', v_issues,
    'issueCount', jsonb_array_length(v_issues),
    'deletedStopCount', coalesce(array_length(p_deleted_stop_ids, 1), 0)
  );
end;
$$;

grant execute on function public.ride_admin_publish_plan_dry_run(text, date, jsonb, text[]) to anon, authenticated;

create or replace function public.ride_admin_save_draft(
  p_admin_code text,
  p_plan_date date default null,
  p_draft jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path to ''
as $$
declare
  v_plan_date date := coalesce(p_plan_date, rides_private.current_ride_plan_date());
  v_saved_at timestamp with time zone := now();
  v_actor_key text := coalesce('user:' || (select auth.uid())::text, 'code:' || md5(coalesce(p_admin_code, '')));
  v_draft jsonb;
begin
  if not rides_private.is_ride_admin_code(p_admin_code) then
    return jsonb_build_object('ok', false, 'error', 'invalid_admin_code');
  end if;

  if not exists (
    select 1
    from rides_private.ride_plans p
    where p.plan_date = v_plan_date
  ) then
    return jsonb_build_object('ok', false, 'error', 'plan_not_found');
  end if;

  if p_draft is null or jsonb_typeof(p_draft) <> 'object' then
    return jsonb_build_object('ok', false, 'error', 'draft_object_required');
  end if;

  v_draft := p_draft || jsonb_build_object(
    'version', 1,
    'source', 'server',
    'planDate', v_plan_date,
    'savedAt', v_saved_at
  );

  insert into rides_private.ride_admin_drafts (
    plan_date,
    actor_key,
    draft,
    saved_at,
    updated_at
  )
  values (
    v_plan_date,
    v_actor_key,
    v_draft,
    v_saved_at,
    v_saved_at
  )
  on conflict (plan_date, actor_key) do update
  set draft = excluded.draft,
      saved_at = excluded.saved_at,
      updated_at = excluded.updated_at;

  return jsonb_build_object('ok', true, 'draft', v_draft);
end;
$$;

create or replace function public.ride_admin_get_draft(
  p_admin_code text,
  p_plan_date date default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $$
declare
  v_plan_date date := coalesce(p_plan_date, rides_private.current_ride_plan_date());
  v_actor_key text := coalesce('user:' || (select auth.uid())::text, 'code:' || md5(coalesce(p_admin_code, '')));
  v_draft jsonb;
begin
  if not rides_private.is_ride_admin_code(p_admin_code) then
    return jsonb_build_object('ok', false, 'error', 'invalid_admin_code');
  end if;

  select d.draft
  into v_draft
  from rides_private.ride_admin_drafts d
  where d.plan_date = v_plan_date
    and d.actor_key = v_actor_key
  limit 1;

  return jsonb_build_object('ok', true, 'draft', v_draft);
end;
$$;

create or replace function public.ride_admin_clear_draft(
  p_admin_code text,
  p_plan_date date default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path to ''
as $$
declare
  v_plan_date date := coalesce(p_plan_date, rides_private.current_ride_plan_date());
  v_actor_key text := coalesce('user:' || (select auth.uid())::text, 'code:' || md5(coalesce(p_admin_code, '')));
begin
  if not rides_private.is_ride_admin_code(p_admin_code) then
    return jsonb_build_object('ok', false, 'error', 'invalid_admin_code');
  end if;

  delete from rides_private.ride_admin_drafts d
  where d.plan_date = v_plan_date
    and d.actor_key = v_actor_key;

  return jsonb_build_object('ok', true);
end;
$$;

grant execute on function public.ride_admin_save_draft(text, date, jsonb) to anon, authenticated;
grant execute on function public.ride_admin_get_draft(text, date) to anon, authenticated;
grant execute on function public.ride_admin_clear_draft(text, date) to anon, authenticated;

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

create or replace function public.ride_admin_update_event_setup(
  p_admin_code text,
  p_plan_date date default null,
  p_event jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path to ''
as $$
declare
  v_plan_date date := coalesce(p_plan_date, rides_private.current_ride_plan_date());
  v_plan record;
  v_home_title text := btrim(coalesce(p_event->>'homeTitle', ''));
  v_home_subtitle text := btrim(coalesce(p_event->>'homeSubtitle', ''));
  v_home_cover_url text := btrim(coalesce(p_event->>'homeCoverUrl', ''));
  v_home_cover_alt text := btrim(coalesce(p_event->>'homeCoverAlt', ''));
  v_plan_title text := btrim(coalesce(p_event->>'planTitle', ''));
  v_service_day text := btrim(coalesce(p_event->>'serviceDay', ''));
  v_destination_label text := btrim(coalesce(p_event->>'destinationLabel', ''));
  v_destination_address text := btrim(coalesce(p_event->>'destinationAddress', ''));
begin
  if not rides_private.is_ride_admin_code(p_admin_code) then
    return jsonb_build_object('ok', false, 'error', 'invalid_admin_code');
  end if;

  select p.id
  into v_plan
  from rides_private.ride_plans p
  where p.plan_date = v_plan_date
  limit 1;

  if v_plan.id is null then
    return jsonb_build_object('ok', false, 'error', 'plan_not_found');
  end if;

  if v_plan_title = '' then
    return jsonb_build_object('ok', false, 'error', 'plan_title_required');
  end if;

  update rides_private.ride_plans p
  set title = v_plan_title,
      service_day = coalesce(nullif(v_service_day, ''), trim(to_char(v_plan_date, 'Day'))),
      destination_label = coalesce(nullif(v_destination_label, ''), p.destination_label),
      destination_address = coalesce(nullif(v_destination_address, ''), p.destination_address),
      updated_at = now()
  where p.id = v_plan.id;

  update rides_private.ride_app_settings s
  set home_title = coalesce(nullif(v_home_title, ''), v_plan_title),
      home_subtitle = v_home_subtitle,
      home_cover_url = coalesce(nullif(v_home_cover_url, ''), s.home_cover_url),
      home_cover_alt = coalesce(nullif(v_home_cover_alt, ''), 'Church ride car'),
      updated_at = now()
  where s.id = 'main';

  return public.ride_admin_snapshot(p_admin_code, v_plan_date);
end;
$$;

create or replace function public.ride_admin_start_new_sunday(
  p_admin_code text,
  p_plan_date date,
  p_driver_slugs text[] default null,
  p_source_plan_date date default null,
  p_make_active boolean default true
)
returns jsonb
language plpgsql
volatile
security definer
set search_path to ''
as $$
declare
  v_source_plan record;
  v_target_plan record;
  v_driver_count integer;
  v_has_filter boolean := coalesce(array_length(p_driver_slugs, 1), 0) > 0;
  v_service_day text;
begin
  if not rides_private.is_ride_admin_code(p_admin_code) then
    return jsonb_build_object('ok', false, 'error', 'invalid_admin_code');
  end if;

  if p_plan_date is null then
    return jsonb_build_object('ok', false, 'error', 'plan_date_required');
  end if;

  v_service_day := to_char(p_plan_date, 'FMDay');

  select p.id, p.title, p.service_day, p.destination_label, p.destination_address
  into v_source_plan
  from rides_private.ride_plans p
  where p.plan_date = coalesce(p_source_plan_date, rides_private.current_ride_plan_date())
  limit 1;

  if v_source_plan.id is null then
    return jsonb_build_object('ok', false, 'error', 'source_plan_not_found');
  end if;

  with selected_slugs as (
    select lower(btrim(slug_value)) as slug, min(ordinality)::integer as selected_order
    from unnest(coalesce(p_driver_slugs, array[]::text[])) with ordinality as input(slug_value, ordinality)
    where btrim(coalesce(slug_value, '')) <> ''
    group by lower(btrim(slug_value))
  )
  select count(*)::integer
  into v_driver_count
  from rides_private.ride_drivers d
  left join selected_slugs ss on ss.slug = d.slug
  where d.plan_id = v_source_plan.id
    and (not v_has_filter or ss.slug is not null);

  if v_driver_count = 0 then
    return jsonb_build_object('ok', false, 'error', 'no_drivers_selected');
  end if;

  insert into rides_private.ride_plans (
    plan_date,
    title,
    service_day,
    destination_label,
    destination_address
  )
  values (
    p_plan_date,
    v_service_day || ' Ride Plan',
    v_service_day,
    v_source_plan.destination_label,
    v_source_plan.destination_address
  )
  on conflict (plan_date) do update
  set title = excluded.title,
      service_day = excluded.service_day,
      destination_label = excluded.destination_label,
      destination_address = excluded.destination_address,
      updated_at = now()
  returning id, plan_date
  into v_target_plan;

  delete from rides_private.ride_stops s
  using rides_private.ride_drivers d
  where s.driver_id = d.id
    and d.plan_id = v_target_plan.id;

  with selected_slugs as (
    select lower(btrim(slug_value)) as slug, min(ordinality)::integer as selected_order
    from unnest(coalesce(p_driver_slugs, array[]::text[])) with ordinality as input(slug_value, ordinality)
    where btrim(coalesce(slug_value, '')) <> ''
    group by lower(btrim(slug_value))
  ), source_drivers as (
    select
      d.slug,
      d.display_name,
      d.full_name,
      d.initials,
      d.subtitle,
      d.route_notes,
      d.access_code_hash,
      coalesce(ss.selected_order, d.sort_order) as next_sort_order
    from rides_private.ride_drivers d
    left join selected_slugs ss on ss.slug = d.slug
    where d.plan_id = v_source_plan.id
      and (not v_has_filter or ss.slug is not null)
  ), removed_drivers as (
    delete from rides_private.ride_drivers d
    where d.plan_id = v_target_plan.id
      and not exists (
        select 1
        from source_drivers sd
        where sd.slug = d.slug
      )
    returning d.id
  )
  insert into rides_private.ride_drivers (
    plan_id,
    slug,
    display_name,
    full_name,
    initials,
    subtitle,
    route_notes,
    access_code_hash,
    sort_order
  )
  select
    v_target_plan.id,
    sd.slug,
    sd.display_name,
    sd.full_name,
    sd.initials,
    coalesce(nullif(sd.subtitle, ''), 'No pickups assigned'),
    coalesce(nullif(sd.route_notes, ''), 'No pickups assigned yet.'),
    sd.access_code_hash,
    sd.next_sort_order
  from source_drivers sd
  on conflict (plan_id, slug) do update
  set display_name = excluded.display_name,
      full_name = excluded.full_name,
      initials = excluded.initials,
      subtitle = excluded.subtitle,
      route_notes = excluded.route_notes,
      access_code_hash = excluded.access_code_hash,
      sort_order = excluded.sort_order,
      updated_at = now();

  if coalesce(p_make_active, true) then
    insert into rides_private.ride_app_settings (id, active_plan_date)
    values ('main', p_plan_date)
    on conflict (id) do update
    set active_plan_date = excluded.active_plan_date,
        updated_at = now();
  end if;

  return public.ride_admin_snapshot(p_admin_code, p_plan_date);
end;
$$;

create or replace function public.ride_admin_update_plan_drivers(
  p_admin_code text,
  p_plan_date date default null,
  p_active_driver_slugs text[] default '{}'::text[]
)
returns jsonb
language plpgsql
volatile
security definer
set search_path to ''
as $$
declare
  v_plan record;
begin
  if not rides_private.is_ride_admin_code(p_admin_code) then
    return jsonb_build_object('ok', false, 'error', 'invalid_admin_code');
  end if;

  select p.id
  into v_plan
  from rides_private.ride_plans p
  where p.plan_date = coalesce(p_plan_date, rides_private.current_ride_plan_date())
  limit 1;

  if v_plan.id is null then
    return jsonb_build_object('ok', false, 'error', 'plan_not_found');
  end if;

  with selected_slugs as (
    select lower(btrim(slug_value)) as slug, min(ordinality)::integer as selected_order
    from unnest(coalesce(p_active_driver_slugs, array[]::text[])) with ordinality as input(slug_value, ordinality)
    where btrim(coalesce(slug_value, '')) <> ''
    group by lower(btrim(slug_value))
  ), source_drivers as (
    select distinct on (d.slug)
      d.slug,
      d.display_name,
      d.full_name,
      d.initials,
      d.access_code_hash,
      coalesce(ss.selected_order, d.sort_order) as next_sort_order
    from selected_slugs ss
    join rides_private.ride_drivers d on d.slug = ss.slug
    order by d.slug, case when d.plan_id = v_plan.id then 0 else 1 end, d.updated_at desc
  ), removed_drivers as (
    delete from rides_private.ride_drivers d
    where d.plan_id = v_plan.id
      and not exists (
        select 1
        from selected_slugs ss
        where ss.slug = d.slug
      )
      and not exists (
        select 1
        from rides_private.ride_stops s
        where s.driver_id = d.id
      )
    returning d.id
  )
  insert into rides_private.ride_drivers (
    plan_id,
    slug,
    display_name,
    full_name,
    initials,
    subtitle,
    route_notes,
    access_code_hash,
    sort_order
  )
  select
    v_plan.id,
    sd.slug,
    sd.display_name,
    sd.full_name,
    sd.initials,
    'No pickups assigned',
    'No pickups assigned yet.',
    sd.access_code_hash,
    sd.next_sort_order
  from source_drivers sd
  on conflict (plan_id, slug) do update
  set display_name = excluded.display_name,
      full_name = excluded.full_name,
      initials = excluded.initials,
      access_code_hash = excluded.access_code_hash,
      sort_order = excluded.sort_order,
      updated_at = now();

  update rides_private.ride_drivers d
  set subtitle = rides_private.rider_names_summary(d.id),
      updated_at = now()
  where d.plan_id = v_plan.id;

  return public.ride_admin_snapshot(p_admin_code, coalesce(p_plan_date, rides_private.current_ride_plan_date()));
end;
$$;

create or replace function public.ride_admin_add_driver(
  p_admin_code text,
  p_plan_date date default null,
  p_driver jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path to ''
as $$
declare
  v_plan record;
  v_name text := btrim(coalesce(p_driver->>'name', p_driver->>'driverName', ''));
  v_slug text;
  v_initials text := upper(btrim(coalesce(p_driver->>'initials', p_driver->>'driverInitials', '')));
  v_phone text := btrim(coalesce(p_driver->>'phone', p_driver->>'driverPhone', ''));
  v_passcode text := btrim(coalesce(p_driver->>'passcode', p_driver->>'driverPasscode', 'rides123'));
  v_sort_order integer;
begin
  if not rides_private.is_ride_admin_code(p_admin_code) then
    return jsonb_build_object('ok', false, 'error', 'invalid_admin_code');
  end if;

  select p.id
  into v_plan
  from rides_private.ride_plans p
  where p.plan_date = coalesce(p_plan_date, rides_private.current_ride_plan_date())
  limit 1;

  if v_plan.id is null then
    return jsonb_build_object('ok', false, 'error', 'plan_not_found');
  end if;

  if v_name = '' or v_initials = '' then
    return jsonb_build_object('ok', false, 'error', 'driver_name_and_initials_required');
  end if;

  v_slug := regexp_replace(lower(v_name), '[^a-z0-9]+', '-', 'g');
  v_slug := regexp_replace(v_slug, '(^-|-$)', '', 'g');
  v_passcode := coalesce(nullif(v_passcode, ''), 'rides123');

  if v_slug = '' then
    return jsonb_build_object('ok', false, 'error', 'driver_slug_required');
  end if;

  if exists (
    select 1
    from rides_private.ride_drivers d
    where d.plan_id = v_plan.id
      and d.slug = v_slug
  ) then
    return jsonb_build_object('ok', false, 'error', 'driver_exists');
  end if;

  select coalesce(max(d.sort_order), 0) + 1
  into v_sort_order
  from rides_private.ride_drivers d
  where d.plan_id = v_plan.id;

  insert into rides_private.ride_drivers (
    plan_id,
    slug,
    display_name,
    full_name,
    initials,
    subtitle,
    route_notes,
    access_code_hash,
    sort_order
  )
  values (
    v_plan.id,
    v_slug,
    v_name,
    v_name,
    v_initials,
    'No pickups assigned',
    case when v_phone = '' then 'No pickups assigned yet.' else 'Phone: ' || v_phone end,
    rides_private.hash_driver_code(v_passcode),
    v_sort_order
  );

  return public.ride_admin_snapshot(p_admin_code, coalesce(p_plan_date, rides_private.current_ride_plan_date()));
end;
$$;

grant execute on function public.ride_app_context() to anon, authenticated;
grant execute on function public.ride_driver_directory(date) to anon, authenticated;
grant execute on function public.ride_driver_route(text, text, date) to anon, authenticated;
grant execute on function public.ride_admin_snapshot(text, date) to anon, authenticated;
grant execute on function public.ride_admin_publish_plan(text, date, jsonb, text[]) to anon, authenticated;
grant execute on function public.ride_admin_publish_plan_dry_run(text, date, jsonb, text[]) to anon, authenticated;
grant execute on function public.ride_admin_save_draft(text, date, jsonb) to anon, authenticated;
grant execute on function public.ride_admin_get_draft(text, date) to anon, authenticated;
grant execute on function public.ride_admin_clear_draft(text, date) to anon, authenticated;
grant execute on function public.ride_admin_merge_people(text, uuid, uuid, jsonb) to anon, authenticated;
grant execute on function public.ride_admin_archive_people(text, uuid) to anon, authenticated;
grant execute on function public.ride_admin_update_event_setup(text, date, jsonb) to anon, authenticated;
grant execute on function public.ride_admin_start_new_sunday(text, date, text[], date, boolean) to anon, authenticated;
grant execute on function public.ride_admin_update_plan_drivers(text, date, text[]) to anon, authenticated;
grant execute on function public.ride_admin_add_driver(text, date, jsonb) to anon, authenticated;

notify pgrst, 'reload schema';

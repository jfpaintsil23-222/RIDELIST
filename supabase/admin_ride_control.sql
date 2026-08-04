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

create or replace function public.ride_admin_snapshot(
  p_admin_code text,
  p_plan_date date default '2026-08-02'::date
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
  v_total_drivers integer;
  v_total_stops integer;
begin
  if not rides_private.is_ride_admin_code(p_admin_code) then
    return jsonb_build_object('ok', false, 'error', 'invalid_admin_code');
  end if;

  select p.id, p.title, p.service_day, p.plan_date, p.destination_label, p.destination_address
  into v_plan
  from rides_private.ride_plans p
  where p.plan_date = coalesce(p_plan_date, date '2026-08-02')
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
    'stops', v_stops
  );
end;
$$;

create or replace function public.ride_admin_publish_plan(
  p_admin_code text,
  p_plan_date date default '2026-08-02'::date,
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
  where p.plan_date = coalesce(p_plan_date, date '2026-08-02')
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

  return public.ride_admin_snapshot(p_admin_code, coalesce(p_plan_date, date '2026-08-02'));
end;
$$;

grant execute on function public.ride_admin_snapshot(text, date) to anon, authenticated;
grant execute on function public.ride_admin_publish_plan(text, date, jsonb, text[]) to anon, authenticated;

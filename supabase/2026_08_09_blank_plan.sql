with source_plan as (
  select id, service_day, destination_label, destination_address
  from rides_private.ride_plans
  where plan_date = date '2026-08-02'
), upsert_plan as (
  insert into rides_private.ride_plans (
    plan_date,
    title,
    service_day,
    destination_label,
    destination_address
  )
  select
    date '2026-08-09',
    'August 9 Ride Plan',
    service_day,
    destination_label,
    destination_address
  from source_plan
  on conflict (plan_date) do update
  set title = excluded.title,
      service_day = excluded.service_day,
      destination_label = excluded.destination_label,
      destination_address = excluded.destination_address,
      updated_at = now()
  returning id
), upsert_drivers as (
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
    upsert_plan.id,
    d.slug,
    d.display_name,
    d.full_name,
    d.initials,
    d.subtitle,
    d.route_notes,
    d.access_code_hash,
    d.sort_order
  from upsert_plan
  join source_plan on true
  join rides_private.ride_drivers d on d.plan_id = source_plan.id
  on conflict (plan_id, slug) do update
  set display_name = excluded.display_name,
      full_name = excluded.full_name,
      initials = excluded.initials,
      subtitle = excluded.subtitle,
      route_notes = excluded.route_notes,
      access_code_hash = excluded.access_code_hash,
      sort_order = excluded.sort_order,
      updated_at = now()
  returning id
), deleted_stops as (
  delete from rides_private.ride_stops s
  using rides_private.ride_drivers d, upsert_plan
  where s.driver_id = d.id
    and d.plan_id = upsert_plan.id
  returning s.id
)
select
  (select id from upsert_plan) as plan_id,
  (select count(*) from upsert_drivers) as drivers_copied,
  (select count(*) from deleted_stops) as stops_deleted,
  (
    select count(*)
    from rides_private.ride_stops s
    join rides_private.ride_drivers d on d.id = s.driver_id
    join upsert_plan on d.plan_id = upsert_plan.id
  ) as stops_remaining;

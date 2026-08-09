with plan_row as (
  select id
  from rides_private.ride_plans
  where plan_date = date '2026-08-09'
), shared_code as (
  select d.access_code_hash
  from rides_private.ride_drivers d
  join plan_row p on p.id = d.plan_id
  where d.slug = 'joojo'
  limit 1
), cleared_stops as (
  delete from rides_private.ride_stops s
  using rides_private.ride_drivers d, plan_row p
  where s.driver_id = d.id
    and d.plan_id = p.id
  returning s.id
), removed_drivers as (
  delete from rides_private.ride_drivers d
  using plan_row p
  where d.plan_id = p.id
    and d.slug in ('naa', 'blue')
  returning d.id
), driver_seed(slug, display_name, full_name, initials, sort_order, route_notes) as (
  values
    ('danny', 'Danny', 'Danny', 'DN', 1, 'Pick up Faith at 8:45 AM and Zoe.'),
    ('john-mark', 'John Mark', 'John Mark', 'JM', 2, 'Huntsville route: Siah, nadia, and Nehemiah. Target return: by 12:45 PM.'),
    ('dq', 'DQ', 'DQ', 'DQ', 3, 'South Houston route: A''lena and Christopher L at 12:00 PM.'),
    ('annie', 'Annie', 'Annie', 'AK', 4, 'Nicholas, Vera, and Zay route. Estimated route from first pickup to UH Hilton: about 35 minutes.'),
    ('dawson', 'Dawson', 'Dawson', 'DW', 5, 'Two-seat route. Arrive to Sherese by 11:45 AM and Amanda by 12:00 PM.'),
    ('precious', 'Precious', 'Precious', 'PR', 6, 'Pick up DaSilva and Emmanuel Mitch by about 10:30 AM, then Christopher R.'),
    ('joojo', 'Joojo', 'Joojo Paintsil', 'JP', 7, 'Kayla Williams, Simi, and Simi''s brother.')
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
    p.id,
    ds.slug,
    ds.display_name,
    ds.full_name,
    ds.initials,
    'No pickups assigned',
    ds.route_notes,
    coalesce(existing.access_code_hash, shared_code.access_code_hash),
    ds.sort_order
  from plan_row p
  cross join shared_code
  join driver_seed ds on true
  left join rides_private.ride_drivers existing
    on existing.plan_id = p.id
   and existing.slug = ds.slug
  on conflict (plan_id, slug) do update
  set display_name = excluded.display_name,
      full_name = excluded.full_name,
      initials = excluded.initials,
      route_notes = excluded.route_notes,
      access_code_hash = excluded.access_code_hash,
      sort_order = excluded.sort_order,
      updated_at = now()
  returning id, slug
), stop_seed(driver_slug, stop_order, rider_name, phone, address, area, pickup_time, ready_by, route_label, notes) as (
  values
    ('danny', 1, 'Faith', '', '7539 Keystone Blossom Trl, Richmond, TX 77407', 'Richmond', '8:45 AM', '8:40 AM', 'Morning route', 'Estimated arrival at UH Hilton: 9:45-9:50 AM.'),
    ('danny', 2, 'Zoe', '', '5502 Mustang Lane, Fulshear Tx', 'Home', null, null, '', ''),
    ('john-mark', 1, 'Siah', '(301) 543-7407', '2304 Sam Houston Ave, Huntsville, TX', 'Huntsville', '9:10 AM', '9:05 AM', 'Far route', 'First far pickup. John Mark should be back by 12:45 PM.'),
    ('john-mark', 2, 'nadia', '6125980698', '2523 avenue m huntsville texas 77430', 'Huntsville', '9:25 AM', '9:20 AM', 'Far route', 'Added from PeopleData.'),
    ('john-mark', 3, 'Nehemiah', '(346) 280-2774', '24157 Wilde Dr, Magnolia, TX', 'Magnolia', '10:35 AM', '10:30 AM', 'Far route', 'Second far pickup before heading toward Houston.'),
    ('dq', 1, 'A''lena', '(713) 902-2393', '9425 Ashville Dr, Houston, TX', 'South Houston', '12:00 PM', '11:55 AM', 'DQ route', 'DQ pickup at the same address as Christopher L.'),
    ('dq', 2, 'Christopher L', '(832) 942-1381', '9425 Ashville Dr, Houston, TX', 'South Houston', '12:00 PM', '11:55 AM', 'DQ route', 'Same pickup stop as A''lena.'),
    ('annie', 1, 'Nicholas Montiel', '(832) 794-2032', '11525 Burdine St, Houston, TX 77035', 'Westbury', '11:15 AM', '11:10 AM', 'Annie route', 'Annie gets Nicholas Montiel.'),
    ('annie', 2, 'Vera', '8325178929', '4971 Martin Luther King Blvd, Houston, TX 77021', 'Southeast Houston', '11:40 AM', '11:35 AM', 'Annie route', ''),
    ('annie', 3, 'Zay', '7134473139', '5050 Sunflower St, Houston, TX 77033', 'South Houston', '11:50 AM', '11:45 AM', 'Annie route', ''),
    ('dawson', 1, 'Sherese', '', '3416 Benfield Dr, Houston, TX', 'West Houston', '11:45 AM', '11:40 AM', 'Dawson route', 'Dawson has two seats.'),
    ('dawson', 2, 'Amanda', '', '9700 Leawood Blvd Apt 1004, Houston, TX', 'Southwest Houston', '12:00 PM', '11:55 AM', 'Dawson route', 'Dawson has two seats.'),
    ('precious', 1, 'DaSilva', '(928) 310-2377', '9796 Windwater Dr, Houston, TX', 'Southeast Houston', '10:00 AM', '9:55 AM', 'Precious route', 'Precious should pick up DaSilva and Emmanuel Mitch by about 10:30 AM.'),
    ('precious', 2, 'Emmanuel Mitch', '(281) 841-8159', '1805 Valentine St, Houston, TX', 'Midtown', '10:25 AM', '10:20 AM', 'Precious route', 'Precious should pick up DaSilva and Emmanuel Mitch by about 10:30 AM.'),
    ('precious', 3, 'Christopher R', '(832) 299-0964', '2418 Francis St, Houston, TX', 'Third Ward', '10:35 AM', '10:30 AM', 'Precious route', ''),
    ('joojo', 1, 'Kayla Williams', '', '2926 Barker Cypress Rd, Houston, TX', 'Campus', null, null, '', ''),
    ('joojo', 2, 'Simi', '(832) 406-1493', '17254 Cricketbriar Ct, Houston, TX', 'Northwest Houston', '11:15 AM', '11:10 AM', 'Joojo route', ''),
    ('joojo', 3, 'Simi''s brother', '', '17254 Cricketbriar Ct, Houston, TX', 'Northwest Houston', '11:15 AM', '11:10 AM', 'Joojo route', 'Same pickup stop as Simi.')
), inserted_stops as (
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
  select
    d.id,
    ss.stop_order,
    ss.rider_name,
    ss.phone,
    ss.address,
    ss.area,
    rides_private.ride_parse_time(ss.pickup_time),
    rides_private.ride_parse_time(ss.ready_by),
    ss.route_label,
    ss.notes
  from stop_seed ss
  join upsert_drivers d
    on d.slug = ss.driver_slug
  returning id
), updated_subtitles as (
  update rides_private.ride_drivers d
  set subtitle = rides_private.rider_names_summary(d.id),
      updated_at = now()
  from plan_row p
  where d.plan_id = p.id
  returning d.id
)
select
  (select count(*) from cleared_stops) as stops_cleared,
  (select count(*) from removed_drivers) as drivers_removed,
  (select count(*) from upsert_drivers) as drivers_ready,
  (select count(*) from inserted_stops) as stops_inserted,
  (select count(*) from updated_subtitles) as subtitles_updated;

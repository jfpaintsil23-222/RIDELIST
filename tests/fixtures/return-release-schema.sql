-- Synthetic, isolated PostgreSQL fixture: never load into a live project.
create role anon; create role authenticated;
create schema rides_private;
create table rides_private.ride_plans(id uuid primary key default gen_random_uuid(),plan_date date unique,title text,service_day text,destination_label text,destination_address text,created_at timestamptz default now(),updated_at timestamptz default now());
create table rides_private.ride_drivers(id uuid primary key default gen_random_uuid(),plan_id uuid references rides_private.ride_plans,slug text,display_name text,full_name text,initials text,subtitle text,route_notes text,access_code_hash text,sort_order integer,created_at timestamptz default now(),updated_at timestamptz default now());
create table rides_private.ride_stops(id uuid primary key default gen_random_uuid(),driver_id uuid references rides_private.ride_drivers,stop_order integer,rider_name text,phone text,address text,area text,pickup_time time,ready_by time,route_label text,notes text,created_at timestamptz default now(),updated_at timestamptz default now(),unique(driver_id,stop_order));
create table rides_private.ride_app_settings(id text primary key,active_plan_date date,home_title text,home_subtitle text,home_cover_url text,home_cover_alt text,updated_at timestamptz default now());
create table rides_private.ride_driver_push_subscriptions(id uuid primary key default gen_random_uuid(),plan_date date,driver_slug text,endpoint text unique,subscription jsonb,active boolean default true,last_error text default '',updated_at timestamptz default now());
create function rides_private.current_ride_plan_date() returns date language sql as $$ select date '2099-01-04' $$;
create function rides_private.is_ride_admin_code(text) returns boolean language sql as $$ select $1='synthetic-admin' $$;
create function rides_private.hash_driver_code(text) returns text language sql as $$ select md5($1) $$;
insert into rides_private.ride_plans(id,plan_date,title,service_day,destination_label,destination_address) values('00000000-0000-0000-0000-000000000001','2099-01-04','Sunday','Sunday','Venue','100 Example Rd'),('00000000-0000-0000-0000-000000000002','2099-01-11','Future','Sunday','Venue','100 Example Rd');
insert into rides_private.ride_app_settings(id,active_plan_date,home_title) values('main','2099-01-04','Sunday');
insert into rides_private.ride_drivers(id,plan_id,slug,display_name,full_name,initials,subtitle,route_notes,access_code_hash,sort_order) values
('00000000-0000-0000-0000-000000000010','00000000-0000-0000-0000-000000000001','example','Example','Example Driver','ED','Private return rider','Private return notes',md5('driver-code'),1),
('00000000-0000-0000-0000-000000000011','00000000-0000-0000-0000-000000000001','empty','Empty','Empty Driver','EE','','',md5('empty-code'),2);
insert into rides_private.ride_stops(driver_id,stop_order,rider_name,phone,address,area,route_label) values
('00000000-0000-0000-0000-000000000010',101,'Pickup A','5550000001','1 Sample St','HCU','Pickup HCU Run 1'),
('00000000-0000-0000-0000-000000000010',1,'Private return rider','5550000002','2 Secret Sample St','HCU','Rides Back HCU Run 1'),
('00000000-0000-0000-0000-000000000010',201,'Late rider','5550000003','3 Late Sample St','Later','Later Return 6:00 PM');
insert into rides_private.ride_driver_push_subscriptions(plan_date,driver_slug,endpoint,subscription) values('2098-12-28','example','https://push.example/old','{}'),('2099-01-04','example','https://push.example/current','{}');

create function public.ride_admin_snapshot(text,date default null) returns jsonb language sql as $$ select jsonb_build_object('ok',$1='synthetic-admin','stops','[]'::jsonb) $$;

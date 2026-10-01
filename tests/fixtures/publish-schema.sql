-- Synthetic schema for the real publish function. No production data or endpoints.
create schema rides_private;
create table rides_private.ride_plans (id uuid primary key, plan_date date unique);
create table rides_private.ride_drivers (
  id uuid primary key, plan_id uuid references rides_private.ride_plans,
  slug text, subtitle text default '', updated_at timestamptz default now()
);
create table rides_private.ride_stops (
  id uuid primary key default gen_random_uuid(), driver_id uuid references rides_private.ride_drivers,
  stop_order integer, rider_name text, phone text, address text, area text,
  pickup_time time, ready_by time, route_label text, notes text,
  created_at timestamptz default now(), updated_at timestamptz default now(),
  constraint synthetic_write_failure check (rider_name <> 'FORCE_DATABASE_ERROR')
);
create table rides_private.test_audit (operation text, stop_id uuid);
create function rides_private.test_audit_stop() returns trigger language plpgsql as $$
begin
  insert into rides_private.test_audit values (tg_op, coalesce(new.id, old.id));
  return coalesce(new, old);
end;
$$;
create trigger audit_stop after insert or update or delete on rides_private.ride_stops
for each row execute function rides_private.test_audit_stop();
-- Authorization and snapshot boundaries are synthetic; writes and trigger effects are real.
create function rides_private.is_ride_admin_code(text) returns boolean language sql as $$
  select $1 = 'synthetic-admin';
$$;
create function rides_private.current_ride_plan_date() returns date language sql as $$
  select date '2099-01-04';
$$;
create function public.ride_admin_snapshot(text, date) returns jsonb language sql as $$
  select jsonb_build_object('ok', true, 'stops', coalesce((select jsonb_agg(to_jsonb(s) order by s.id)
    from rides_private.ride_stops s), '[]'::jsonb));
$$;
insert into rides_private.ride_plans values ('00000000-0000-0000-0000-000000000001', '2099-01-04');
insert into rides_private.ride_drivers (id, plan_id, slug, subtitle) values
 ('00000000-0000-0000-0000-000000000010', '00000000-0000-0000-0000-000000000001', 'test-driver', 'Original summary');
insert into rides_private.ride_stops (id, driver_id, stop_order, rider_name, address) values
 ('00000000-0000-0000-0000-000000000100', '00000000-0000-0000-0000-000000000010', 1, 'Original rider', 'Synthetic address'),
 ('00000000-0000-0000-0000-000000000101', '00000000-0000-0000-0000-000000000010', 2, 'Delete candidate', 'Synthetic address');
truncate rides_private.test_audit;

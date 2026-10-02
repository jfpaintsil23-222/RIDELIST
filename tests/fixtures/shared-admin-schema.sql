-- Synthetic-only fixture. Loaded into its own disposable database, never production.
drop schema if exists rides_private cascade;
drop schema if exists auth cascade;
create schema rides_private;
create schema auth;
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
do $$ begin
  if not exists (select from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
end $$;
grant usage on schema public to anon, authenticated;
-- Grant schema usage so tests reach table/function grants and RLS themselves.
grant usage on schema rides_private to anon, authenticated;
create table auth.users (id uuid primary key);
create table auth.sessions (id uuid primary key, user_id uuid references auth.users, not_after timestamptz);
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb);
$$;
create function auth.uid() returns uuid language sql stable as $$ select (auth.jwt()->>'sub')::uuid; $$;
create table rides_private.ride_admin_profiles (
  slug text primary key, display_name text not null, initials text not null,
  password_hash text not null default '', active boolean not null default true
);
create table rides_private.ride_admin_profile_sessions (
  id uuid primary key default gen_random_uuid(), profile_slug text references rides_private.ride_admin_profiles,
  session_token_hash text unique not null, expires_at timestamptz not null, created_at timestamptz default now()
);
create table rides_private.ride_admin_users (
  auth_user_id uuid primary key references auth.users, email text not null, display_name text not null, active boolean default true
);
create function rides_private.hash_driver_code(p_code text) returns text language sql immutable as $$ select md5(p_code); $$;
create table rides_private.ride_admin_codes (id text primary key, access_code_hash text not null);
insert into rides_private.ride_admin_codes values ('main', md5('legacy-shared-code'));
create table rides_private.ride_admin_security_settings (id text primary key, require_signed_admin boolean not null);
insert into rides_private.ride_admin_security_settings values ('main', false);
create table rides_private.ride_plans (id uuid primary key default gen_random_uuid(), plan_date date unique not null);
insert into rides_private.ride_plans (plan_date) values ('2099-01-04'), ('2099-01-11');
insert into rides_private.ride_admin_profiles (slug, display_name, initials) values
  ('alpha', 'Synthetic Alpha', 'AA'), ('beta', 'Synthetic Beta', 'BB'), ('gamma', 'Synthetic Gamma', 'CC'),
  ('disabled', 'Synthetic Disabled', 'DD');
update rides_private.ride_admin_profiles set active = false where slug = 'disabled';
insert into rides_private.ride_admin_profile_sessions (profile_slug, session_token_hash, expires_at) values
  ('alpha', md5('alpha-token'), now() + interval '1 hour'),
  ('alpha', md5('alpha-refreshed-token'), now() + interval '2 hours'),
  ('beta', md5('beta-token'), now() + interval '1 hour'),
  ('gamma', md5('gamma-token'), now() + interval '1 hour'),
  ('disabled', md5('disabled-token'), now() + interval '1 hour'),
  ('alpha', md5('expired-token'), now() - interval '1 hour');
insert into auth.users values ('00000000-0000-0000-0000-000000000001'), ('00000000-0000-0000-0000-000000000002');
insert into auth.sessions values
  ('00000000-0000-0000-0000-000000000011', '00000000-0000-0000-0000-000000000001', now() + interval '1 hour'),
  ('00000000-0000-0000-0000-000000000012', '00000000-0000-0000-0000-000000000002', null);
insert into rides_private.ride_admin_users values ('00000000-0000-0000-0000-000000000001', 'synthetic@example.invalid', 'Synthetic JWT Admin', true);
drop table if exists public.synthetic_church_records cascade;
create table public.synthetic_church_records (id integer primary key, value text);
insert into public.synthetic_church_records values (1, 'unrelated synthetic church record');
create or replace function public.synthetic_church_read() returns text language sql as $$ select value from public.synthetic_church_records where id = 1; $$;
create or replace function public.ride_admin_snapshot(p_admin_code text, p_plan_date date) returns jsonb language sql as $$
  select jsonb_build_object('ok', true, 'plan', jsonb_build_object('date', p_plan_date),
    'destination', '{}'::jsonb, 'appSettings', '{}'::jsonb, 'drivers', '[]'::jsonb,
    'stops', '[]'::jsonb, 'people', '[]'::jsonb, 'driverPool', '[]'::jsonb, 'security', '{}'::jsonb);
$$;

create table rides_private.ride_admin_drafts (id uuid default gen_random_uuid(), plan_date date, actor_key text, draft jsonb, saved_at timestamptz, updated_at timestamptz, primary key(plan_date,actor_key));
create table rides_private.ride_drivers (
 id uuid primary key default gen_random_uuid(), plan_id uuid references rides_private.ride_plans,
 slug text, display_name text, full_name text, initials text, access_code_hash text,
 subtitle text default '', route_notes text default '', sort_order integer, updated_at timestamptz default now(), unique(plan_id,slug)
);
create table rides_private.ride_stops (
 id uuid primary key default gen_random_uuid(), driver_id uuid references rides_private.ride_drivers on delete cascade,
 stop_order integer, rider_name text, phone text, address text, area text, pickup_time time, ready_by time,
 route_label text, notes text, created_at timestamptz default now(), updated_at timestamptz default now(),
 constraint synthetic_write_failure check(rider_name <> 'FORCE_DATABASE_ERROR'),
 unique(driver_id,stop_order)
);
insert into rides_private.ride_drivers (plan_id,slug,display_name,full_name,initials,access_code_hash,sort_order)
select id,slug,'Synthetic driver','Synthetic Driver','SD',md5('synthetic-driver-secret'),ordinality
from rides_private.ride_plans cross join unnest(array['driver-a','driver-b']) with ordinality d(slug,ordinality) where plan_date='2099-01-11';

create table rides_private.ride_app_settings (id text primary key, active_plan_date date);

alter table rides_private.ride_plans add column title text default 'Synthetic plan', add column service_day text default 'Sunday', add column destination_label text default 'Synthetic destination', add column destination_address text default 'Old destination', add column updated_at timestamptz default now();
alter table rides_private.ride_app_settings add column home_title text default 'Synthetic home', add column home_subtitle text default '', add column home_cover_url text default '', add column home_cover_alt text default '', add column updated_at timestamptz default now();
insert into rides_private.ride_app_settings(id,active_plan_date) values('main','2099-01-04');

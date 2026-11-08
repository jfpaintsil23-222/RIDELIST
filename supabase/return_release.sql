-- Admin-controlled return release. Existing plans remain legacy until explicitly enrolled.
begin;
create or replace function rides_private.ride_stop_direction(p_label text)
returns text language sql immutable set search_path='' as $$
 select case when coalesce(p_label,'') ~* '(^|[^a-z])(later|late[[:space:]]+drop)' then 'later'
 when coalesce(p_label,'') ~* '(^|[^a-z])(rides?[[:space:]]+(back|home)|return)([^a-z]|$)' then 'return' else 'pickup' end
$$;
alter table rides_private.ride_stops add column if not exists ride_direction text;
update rides_private.ride_stops set ride_direction=rides_private.ride_stop_direction(route_label) where ride_direction is null;
alter table rides_private.ride_stops alter column ride_direction set not null;
do $$ begin if not exists(select 1 from pg_constraint where conrelid='rides_private.ride_stops'::regclass and conname='ride_direction_valid') then alter table rides_private.ride_stops add constraint ride_direction_valid check(ride_direction in('pickup','return','later')); end if; end $$;
create or replace function rides_private.ride_preserve_direction() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if tg_op='INSERT' then new.ride_direction:=coalesce(new.ride_direction,rides_private.ride_stop_direction(new.route_label));
 elsif new.ride_direction is distinct from old.ride_direction then raise exception 'Ride direction cannot change through a route edit'; end if;
 return new;
end $$;
drop trigger if exists ride_preserve_direction on rides_private.ride_stops;
create trigger ride_preserve_direction before insert or update on rides_private.ride_stops for each row execute function rides_private.ride_preserve_direction();
alter table rides_private.ride_drivers add column if not exists pickup_route_notes text;
alter table rides_private.ride_drivers add column if not exists return_route_notes text;
create table if not exists rides_private.ride_plan_phases(
 plan_date date primary key references rides_private.ride_plans(plan_date),
 phase text not null default 'pickup' check(phase in ('pickup','return')),
 release_id uuid unique, operation_id uuid unique, released_at timestamptz,
 released_by text, return_revision text,
 check((phase='pickup' and release_id is null) or (phase='return' and release_id is not null))
);
create table if not exists rides_private.ride_return_notifications(
 id uuid primary key default gen_random_uuid(), release_id uuid not null,
 plan_date date not null references rides_private.ride_plans(plan_date), driver_slug text not null,
 subscription_id uuid references rides_private.ride_driver_push_subscriptions(id) on delete set null,
 status text not null default 'pending' check(status in('pending','sending','sent','failed','unknown','no_device')),
 lease_token uuid, claimed_at timestamptz, updated_at timestamptz default now(), error text not null default '',
 unique(release_id,driver_slug,subscription_id)
);
create table if not exists rides_private.ride_return_unassigned(
 id uuid primary key default gen_random_uuid(), plan_date date not null references rides_private.ride_plans(plan_date),
 rider_name text not null, phone text not null default '', address text not null default '',
 ride_direction text not null check(ride_direction in('return','later')), ready_by time, notes text not null default ''
);
alter table rides_private.ride_plan_phases enable row level security;
alter table rides_private.ride_plan_phases force row level security;
alter table rides_private.ride_return_notifications enable row level security;
alter table rides_private.ride_return_notifications force row level security;
alter table rides_private.ride_return_unassigned enable row level security;
alter table rides_private.ride_return_unassigned force row level security;
revoke all on rides_private.ride_plan_phases,rides_private.ride_return_notifications,rides_private.ride_return_unassigned from public,anon,authenticated;
create index if not exists ride_return_notification_work on rides_private.ride_return_notifications(plan_date,release_id,status);

-- Freeze the review revision against concurrent edits without replacing the existing editor.
create or replace function rides_private.ride_phase_write_lock()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_plan uuid;
begin
 if tg_table_name='ride_drivers' then v_plan:=coalesce(new.plan_id,old.plan_id);
 else select d.plan_id into v_plan from rides_private.ride_drivers d where d.id=coalesce(new.driver_id,old.driver_id); end if;
 perform 1 from rides_private.ride_plans where id=v_plan for update;
 return coalesce(new,old);
end $$;
drop trigger if exists ride_phase_stops_lock on rides_private.ride_stops;
create trigger ride_phase_stops_lock before insert or update or delete on rides_private.ride_stops for each row execute function rides_private.ride_phase_write_lock();
drop trigger if exists ride_phase_drivers_lock on rides_private.ride_drivers;
create trigger ride_phase_drivers_lock before update or delete on rides_private.ride_drivers for each row execute function rides_private.ride_phase_write_lock();

-- Retain legacy behavior in private, non-RPC-callable functions for unenrolled plans.
do $$
begin
 if to_regprocedure('rides_private.ride_driver_route_before_phases(text,text,date)') is null then
  alter function public.ride_driver_route(text,text,date) rename to ride_driver_route_before_phases;
  alter function public.ride_driver_route_before_phases(text,text,date) set schema rides_private;
 end if;
 if to_regprocedure('rides_private.ride_driver_directory_before_phases(date)') is null then
  alter function public.ride_driver_directory(date) rename to ride_driver_directory_before_phases;
  alter function public.ride_driver_directory_before_phases(date) set schema rides_private;
 end if;
 if to_regprocedure('rides_private.ride_admin_snapshot_before_phases(text,date)') is null and to_regprocedure('public.ride_admin_snapshot(text,date)') is not null then
  alter function public.ride_admin_snapshot(text,date) rename to ride_admin_snapshot_before_phases;
  alter function public.ride_admin_snapshot_before_phases(text,date) set schema rides_private;
 end if;
 if to_regprocedure('rides_private.ride_app_context_before_phases()') is null then
  alter function public.ride_app_context() rename to ride_app_context_before_phases;
  alter function public.ride_app_context_before_phases() set schema rides_private;
 end if;
end $$;
revoke all on function rides_private.ride_driver_route_before_phases(text,text,date),rides_private.ride_driver_directory_before_phases(date),rides_private.ride_app_context_before_phases() from public,anon,authenticated;

create or replace function public.ride_driver_route(p_driver_slug text,p_access_code text,p_plan_date date default null)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_date date:=coalesce(p_plan_date,rides_private.current_ride_plan_date()); v_result jsonb; v_phase rides_private.ride_plan_phases; v_notes text; v_riders jsonb;
begin
 v_result:=rides_private.ride_driver_route_before_phases(p_driver_slug,p_access_code,v_date);
 if not coalesce((v_result->>'ok')::boolean,false) then return v_result; end if;
 select * into v_phase from rides_private.ride_plan_phases where plan_date=v_date;
 if not found then return v_result; end if;
 select coalesce(jsonb_agg(r||jsonb_build_object('direction',v_phase.phase) order by (r->>'stopOrder')::integer),'[]'::jsonb) into v_riders
 from jsonb_array_elements(v_result->'riders') r where exists(
 select 1 from rides_private.ride_stops s join rides_private.ride_drivers d on d.id=s.driver_id join rides_private.ride_plans p on p.id=d.plan_id
 where p.plan_date=v_date and d.slug=lower(btrim(p_driver_slug)) and s.stop_order=(r->>'stopOrder')::integer and s.ride_direction=v_phase.phase);
 select case when v_phase.phase='return' then coalesce(d.return_route_notes,'') else coalesce(d.pickup_route_notes,'') end into v_notes
 from rides_private.ride_drivers d join rides_private.ride_plans p on p.id=d.plan_id where p.plan_date=v_date and d.slug=lower(btrim(p_driver_slug));
 v_result:=v_result||jsonb_build_object('phase',v_phase.phase,'releaseVersion',coalesce(v_phase.release_id::text,'pickup'),'riders',v_riders,
 'driver',(v_result->'driver')||jsonb_build_object('routeNotes',v_notes,'subtitle',case when v_phase.phase='return' then 'Rides Home' else 'Pickups' end));
 if v_phase.phase='return' then
  v_result:=v_result||jsonb_build_object('plan',(v_result->'plan')||jsonb_build_object('title','Rides Home'),'destination',jsonb_build_object('label','Riders'' destinations','address',''));
 end if;
 return v_result;
end $$;

create or replace function public.ride_driver_directory(p_plan_date date default null)
returns table(slug text,display_name text,initials text,subtitle text,route_label text,route_notes text,pickup_count integer,sort_order integer)
language plpgsql stable security definer set search_path='' as $$
declare v_date date:=coalesce(p_plan_date,rides_private.current_ride_plan_date()); v_phase text;
begin
 select ph.phase into v_phase from rides_private.ride_plan_phases ph where ph.plan_date=v_date;
 if v_phase is null then return query select * from rides_private.ride_driver_directory_before_phases(v_date); return; end if;
 return query select d.slug,d.display_name,d.initials,
 case when v_phase='return' then 'Rides Home' else 'Pickups' end,
 coalesce((array_agg(nullif(btrim(s.route_label),'') order by s.stop_order) filter(where s.id is not null))[1],''),
 case when v_phase='return' then coalesce(d.return_route_notes,'') else coalesce(d.pickup_route_notes,'') end,
 count(s.id)::integer,d.sort_order
 from rides_private.ride_drivers d join rides_private.ride_plans p on p.id=d.plan_id
 left join rides_private.ride_stops s on s.driver_id=d.id and s.ride_direction=v_phase
 where p.plan_date=v_date group by d.id,d.slug,d.display_name,d.initials,d.sort_order,d.pickup_route_notes,d.return_route_notes order by d.sort_order,d.display_name;
end $$;

create or replace function public.ride_app_context()
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_result jsonb; v_phase rides_private.ride_plan_phases;
begin
 v_result:=rides_private.ride_app_context_before_phases();
 select * into v_phase from rides_private.ride_plan_phases where plan_date=rides_private.current_ride_plan_date();
 if not found then return v_result; end if;
 v_result:=v_result||jsonb_build_object('phase',v_phase.phase,'releaseVersion',coalesce(v_phase.release_id::text,'pickup'));
 if v_phase.phase='return' then v_result:=v_result||jsonb_build_object('plan',(v_result->'plan')||jsonb_build_object('title','Rides Home'),'appSettings',(v_result->'appSettings')||jsonb_build_object('homeTitle','Rides Home','homeSubtitle','Your return rides are ready'),'destination',jsonb_build_object('label','Riders'' destinations','address','')); end if;
 return v_result;
end $$;

create or replace function rides_private.ride_return_revision(p_plan_date date)
returns text language sql stable set search_path='' as $$
 select md5(coalesce(jsonb_agg(jsonb_build_object('id',s.id,'driver',d.slug,'displayName',d.display_name,'notes',d.return_route_notes,'stop',to_jsonb(s)) order by s.id)::text,'[]'))
 from rides_private.ride_stops s join rides_private.ride_drivers d on d.id=s.driver_id join rides_private.ride_plans p on p.id=d.plan_id
 where p.plan_date=p_plan_date and s.ride_direction='return'
$$;

create or replace function public.ride_admin_snapshot(p_admin_code text,p_plan_date date default null)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_result jsonb; v_stops jsonb;
begin
 v_result:=rides_private.ride_admin_snapshot_before_phases(p_admin_code,p_plan_date);
 if not coalesce((v_result->>'ok')::boolean,false) then return v_result; end if;
 select coalesce(jsonb_agg(r||jsonb_build_object('direction',s.ride_direction) order by ord),'[]'::jsonb) into v_stops
 from jsonb_array_elements(coalesce(v_result->'stops','[]'::jsonb)) with ordinality t(r,ord)
 left join rides_private.ride_stops s on s.id::text=r->>'id';
 return v_result||jsonb_build_object('stops',v_stops);
end $$;
revoke all on function rides_private.ride_admin_snapshot_before_phases(text,date) from public,anon,authenticated;
revoke all on function public.ride_admin_snapshot(text,date) from public;
grant execute on function public.ride_admin_snapshot(text,date) to anon,authenticated;

create or replace function public.ride_admin_return_state(p_admin_code text,p_plan_date date)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_phase rides_private.ride_plan_phases; v_riders jsonb; v_drivers jsonb; v_later jsonb; v_unassigned jsonb; v_summary jsonb;
begin
 if not rides_private.is_ride_admin_code(p_admin_code) then return jsonb_build_object('ok',false,'error','invalid_admin_code'); end if;
 if not exists(select 1 from rides_private.ride_plans where plan_date=p_plan_date) then return jsonb_build_object('ok',false,'error','plan_not_found'); end if;
 select * into v_phase from rides_private.ride_plan_phases where plan_date=p_plan_date;
 select coalesce(jsonb_agg(jsonb_build_object('id',s.id,'driverSlug',d.slug,'stopOrder',s.stop_order,'name',s.rider_name,'phone',s.phone,'address',s.address,'area',s.area,'routeLabel',s.route_label,'direction',s.ride_direction,'notes',s.notes) order by d.sort_order,s.stop_order),'[]') into v_riders
 from rides_private.ride_stops s join rides_private.ride_drivers d on d.id=s.driver_id join rides_private.ride_plans p on p.id=d.plan_id where p.plan_date=p_plan_date and s.ride_direction='return';
 select coalesce(jsonb_agg(jsonb_build_object('slug',d.slug,'displayName',d.display_name,'routeNotes',coalesce(d.return_route_notes,''),'hasAlerts',exists(select 1 from rides_private.ride_driver_push_subscriptions u where u.plan_date=p_plan_date and u.driver_slug=d.slug and u.active)) order by d.sort_order),'[]') into v_drivers
 from rides_private.ride_drivers d join rides_private.ride_plans p on p.id=d.plan_id where p.plan_date=p_plan_date and exists(select 1 from rides_private.ride_stops s where s.driver_id=d.id and s.ride_direction='return');
 select coalesce(jsonb_agg(jsonb_build_object('name',s.rider_name,'address',s.address,'readyBy',case when s.ready_by is null then null else to_char(s.ready_by,'FMHH12:MI AM') end,'driverSlug',d.slug)),'[]') into v_later from rides_private.ride_stops s join rides_private.ride_drivers d on d.id=s.driver_id join rides_private.ride_plans p on p.id=d.plan_id where p.plan_date=p_plan_date and s.ride_direction='later';
 select coalesce(jsonb_agg(jsonb_build_object('name',u.rider_name,'address',u.address,'readyBy',case when u.ready_by is null then null else to_char(u.ready_by,'FMHH12:MI AM') end,'direction',u.ride_direction,'notes',u.notes) order by u.rider_name),'[]') into v_unassigned from rides_private.ride_return_unassigned u where u.plan_date=p_plan_date;
 select jsonb_build_object('pending',count(*) filter(where status='pending'),'sending',count(*) filter(where status='sending'),'sent',count(*) filter(where status='sent'),'failed',count(*) filter(where status='failed'),'unknown',count(*) filter(where status='unknown'),'noDevice',count(*) filter(where status='no_device')) into v_summary from rides_private.ride_return_notifications where plan_date=p_plan_date and release_id=v_phase.release_id;
 return jsonb_build_object('ok',true,'enabled',v_phase.plan_date is not null,'planDate',p_plan_date,'phase',coalesce(v_phase.phase,'legacy'),'revision',rides_private.ride_return_revision(p_plan_date),'releaseId',v_phase.release_id,'releasedAt',v_phase.released_at,'drivers',v_drivers,'riders',v_riders,'laterRiders',v_later,'unassignedRiders',v_unassigned,'alertSummary',v_summary);
end $$;

create or replace function public.ride_admin_release_returns(p_admin_code text,p_plan_date date,p_expected_revision text,p_operation_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_phase rides_private.ride_plan_phases; v_id uuid:=gen_random_uuid(); v_revision text;
begin
 if not rides_private.is_ride_admin_code(p_admin_code) then return jsonb_build_object('ok',false,'error','invalid_admin_code'); end if;
 if p_operation_id is null then return jsonb_build_object('ok',false,'error','operation_required'); end if;
 perform 1 from rides_private.ride_plans where plan_date=p_plan_date for update;
 select * into v_phase from rides_private.ride_plan_phases where plan_date=p_plan_date for update;
 if not found then return jsonb_build_object('ok',false,'error','phase_not_enabled'); end if;
 if v_phase.phase='return' then return public.ride_admin_return_state(p_admin_code,p_plan_date); end if;
 v_revision:=rides_private.ride_return_revision(p_plan_date);
 if p_expected_revision is distinct from v_revision then return jsonb_build_object('ok',false,'error','revision_changed'); end if;
 if not exists(select 1 from rides_private.ride_stops s join rides_private.ride_drivers d on d.id=s.driver_id join rides_private.ride_plans p on p.id=d.plan_id where p.plan_date=p_plan_date and s.ride_direction='return') then return jsonb_build_object('ok',false,'error','no_return_riders'); end if;
 update rides_private.ride_plan_phases set phase='return',release_id=v_id,operation_id=p_operation_id,released_at=now(),released_by='authenticated-admin',return_revision=v_revision where plan_date=p_plan_date;
 insert into rides_private.ride_return_notifications(release_id,plan_date,driver_slug,subscription_id,status)
 select v_id,p_plan_date,d.slug,u.id,case when u.id is null then 'no_device' else 'pending' end from rides_private.ride_drivers d join rides_private.ride_plans p on p.id=d.plan_id
 left join rides_private.ride_driver_push_subscriptions u on u.plan_date=p_plan_date and u.driver_slug=d.slug and u.active
 where p.plan_date=p_plan_date and exists(select 1 from rides_private.ride_stops s where s.driver_id=d.id and s.ride_direction='return');
 return public.ride_admin_return_state(p_admin_code,p_plan_date);
end $$;

create or replace function public.ride_admin_claim_return_notifications(p_admin_code text,p_plan_date date,p_release_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_jobs jsonb;
begin
 if not rides_private.is_ride_admin_code(p_admin_code) then return jsonb_build_object('ok',false,'error','invalid_admin_code'); end if;
 if not exists(select 1 from rides_private.ride_plan_phases where plan_date=p_plan_date and release_id=p_release_id and phase='return') then return jsonb_build_object('ok',false,'error','release_not_found'); end if;
 update rides_private.ride_return_notifications set status='unknown',error='Delivery result not confirmed',updated_at=now() where release_id=p_release_id and status='sending' and claimed_at<now()-interval '5 minutes';
 with candidates as(select n.id from rides_private.ride_return_notifications n where n.release_id=p_release_id and n.plan_date=p_plan_date and n.status in('pending','failed') order by n.id for update skip locked limit 1),
 claimed as(update rides_private.ride_return_notifications n set status='sending',lease_token=gen_random_uuid(),claimed_at=now(),updated_at=now() from candidates c where n.id=c.id returning n.*)
 select coalesce(jsonb_agg(jsonb_build_object('id',n.id,'driverSlug',n.driver_slug,'leaseToken',n.lease_token,'active',coalesce(s.active,false),'subscription',s.subscription)),'[]') into v_jobs
 from claimed n left join rides_private.ride_driver_push_subscriptions s on s.id=n.subscription_id and s.plan_date=n.plan_date and s.driver_slug=n.driver_slug;
 return jsonb_build_object('ok',true,'jobs',v_jobs);
end $$;

create or replace function public.ride_admin_finish_return_notification(p_admin_code text,p_job_id uuid,p_lease_token uuid,p_status text,p_error text default '')
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_count integer;
begin
 if not rides_private.is_ride_admin_code(p_admin_code) then return jsonb_build_object('ok',false,'error','invalid_admin_code'); end if;
 if p_status not in('sent','failed','unknown','no_device') then return jsonb_build_object('ok',false,'error','invalid_status'); end if;
 update rides_private.ride_return_notifications set status=p_status,error=left(coalesce(p_error,''),200),updated_at=now()
 where id=p_job_id and lease_token=p_lease_token and status='sending';
 get diagnostics v_count=row_count;
 return jsonb_build_object('ok',v_count=1);
end $$;

revoke all on function rides_private.ride_preserve_direction() from public,anon,authenticated;
revoke all on function rides_private.ride_stop_direction(text),rides_private.ride_phase_write_lock(),rides_private.ride_return_revision(date) from public,anon,authenticated;
revoke all on function public.ride_driver_route(text,text,date),public.ride_driver_directory(date),public.ride_app_context(),public.ride_admin_return_state(text,date),public.ride_admin_release_returns(text,date,text,uuid),public.ride_admin_claim_return_notifications(text,date,uuid),public.ride_admin_finish_return_notification(text,uuid,uuid,text,text) from public;
grant execute on function public.ride_driver_route(text,text,date),public.ride_driver_directory(date),public.ride_app_context(),public.ride_admin_return_state(text,date),public.ride_admin_release_returns(text,date,text,uuid),public.ride_admin_claim_return_notifications(text,date,uuid),public.ride_admin_finish_return_notification(text,uuid,uuid,text,text) to anon,authenticated;
notify pgrst,'reload schema';
commit;

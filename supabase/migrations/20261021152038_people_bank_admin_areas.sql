-- Admin-only classification metadata. Never rewrites contact or route addresses.
alter table rides_private.ride_people
  add column if not exists pickup_area text not null default ''
  check (pickup_area in ('', 'tsu', 'hcu', 'uh', 'off-campus', 'shsu'));

create or replace function public.ride_admin_people_areas(p_admin_code text)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if not coalesce(rides_private.is_ride_admin_code(p_admin_code), false) then
    return jsonb_build_object('ok', false, 'error', 'unauthorized');
  end if;
  return jsonb_build_object('ok', true, 'areas', coalesce((
    select jsonb_object_agg(id::text, pickup_area)
    from rides_private.ride_people where active
  ), '{}'::jsonb));
end;
$$;

create or replace function public.ride_admin_set_people_area(
  p_admin_code text, p_person_id uuid, p_area text, p_expected_area text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare current_area text;
begin
  if not coalesce(rides_private.is_ride_admin_code(p_admin_code), false) then
    return jsonb_build_object('ok', false, 'error', 'unauthorized');
  end if;
  if p_area is null or p_area not in ('', 'tsu', 'hcu', 'uh', 'off-campus', 'shsu') then
    return jsonb_build_object('ok', false, 'error', 'invalid_area');
  end if;
  select pickup_area into current_area from rides_private.ride_people
    where id = p_person_id and active for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'person_not_found');
  end if;
  if current_area is distinct from p_expected_area then
    return jsonb_build_object('ok', false, 'error', 'area_conflict');
  end if;
  update rides_private.ride_people set pickup_area = p_area where id = p_person_id;
  return jsonb_build_object('ok', true, 'personId', p_person_id, 'pickupArea', p_area);
end;
$$;

revoke all on function public.ride_admin_people_areas(text) from public;
revoke all on function public.ride_admin_set_people_area(text, uuid, text, text) from public;
grant execute on function public.ride_admin_people_areas(text) to anon, authenticated;
grant execute on function public.ride_admin_set_people_area(text, uuid, text, text) to anon, authenticated;

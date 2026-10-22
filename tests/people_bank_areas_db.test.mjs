import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { before, test } from 'node:test';
const container = process.env.RIDELIST_TEST_CONTAINER || '';
const enabled = /^ridelist-publish-test-/.test(container);
const db = 'ridelist_people_areas_test';
function sql(query, database = db, failure = false) {
  const r = spawnSync('docker', ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', database, '-X', '-v', 'ON_ERROR_STOP=1', '-Atq'], { input: query, encoding: 'utf8' });
  if (failure) { assert.notEqual(r.status, 0); return; }
  assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
}
const id = '00000000-0000-4000-8000-000000000001';
before(() => {
  if (!enabled) return;
  const info = JSON.parse(spawnSync('docker', ['inspect', container], { encoding: 'utf8' }).stdout)[0];
  assert.equal(info.HostConfig.NetworkMode, 'none');
  assert.deepEqual(info.HostConfig.PortBindings || {}, {});
  assert.ok(Object.hasOwn(info.HostConfig.Tmpfs || {}, '/var/lib/postgresql/data'));
  assert.match(sql('show server_version;', 'postgres'), /^17\./);
  if (sql(`select count(*) from pg_database where datname='${db}';`, 'postgres') === '0') sql(`create database ${db};`, 'postgres');
  sql(`drop schema if exists rides_private cascade; create schema rides_private;
    do $$ begin if not exists(select 1 from pg_roles where rolname='anon') then create role anon; end if;
    if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if; end $$;
    create table rides_private.ride_people(id uuid primary key, name text, home_address text, campus_address text, active boolean default true);
    alter table rides_private.ride_people enable row level security; alter table rides_private.ride_people force row level security;
    create function rides_private.is_ride_admin_code(text) returns boolean language sql as $$select $1='valid-admin'$$;
    insert into rides_private.ride_people values('${id}','Synthetic Rider','10 Example Road','',true);`);
  sql(readFileSync(new URL('../supabase/migrations/20261021152038_people_bank_admin_areas.sql', import.meta.url), 'utf8'));
});
test('People Bank area metadata requires existing admin authorization', {skip:!enabled}, () => {
  const result = JSON.parse(sql("set role anon; select public.ride_admin_people_areas('wrong');"));
  assert.equal(result.ok,false);
  const write = JSON.parse(sql(`set role anon; select public.ride_admin_set_people_area('wrong','${id}','tsu','');`));
  assert.equal(write.ok,false);
  sql('set role anon; select * from rides_private.ride_people;',db,true);
});
test('Area saves preserve addresses and reject stale or invalid labels', {skip:!enabled}, () => {
  const result = JSON.parse(sql(`set role anon; select public.ride_admin_set_people_area('valid-admin','${id}','tsu','');`));
  assert.equal(result.pickupArea,'tsu');
  assert.equal(sql(`select home_address from rides_private.ride_people where id='${id}';`),'10 Example Road');
  const stale = JSON.parse(sql(`set role anon; select public.ride_admin_set_people_area('valid-admin','${id}','hcu','');`));
  assert.equal(stale.error,'area_conflict');
  const invalid = JSON.parse(sql(`set role anon; select public.ride_admin_set_people_area('valid-admin','${id}','imaginary','tsu');`));
  assert.equal(invalid.error,'invalid_area');
  const result2 = JSON.parse(sql("set role anon; select public.ride_admin_people_areas('valid-admin');"));
  assert.equal(result2.areas[id],'tsu');
  assert.ok(!JSON.stringify(result2).includes('Example Road'));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {buildRollout,extractFunction} from '../tools/build-collaborative-rollout.mjs';
const sources=Object.fromEntries(['admin_security','admin_ride_control','sunday_reset','collaborative_ride_control'].map(name=>[name,readFileSync(new URL(`../supabase/${name}.sql`,import.meta.url),'utf8')]));
test('rollout bundle fails closed on missing duplicate or unsupported function boundaries and trigger drift',()=>{
 const name='rides_private.ride_admin_actor',source=sources.admin_security;
 assert.throws(()=>extractFunction('',name),/exactly one/);
 assert.throws(()=>extractFunction(source+source,name),/exactly one/);
 assert.throws(()=>extractFunction(extractFunction(source,name).replace('as $$','as $changed$'),name),/Unsupported|security|boundary/);
 assert.throws(()=>buildRollout({...sources,admin_security:source.replace('after insert or update or delete on rides_private.ride_stops','after insert on rides_private.ride_stops')}),/trigger shape/);
});
test('rollout artifact is deterministic and excludes setup seeds auth redefinition and mode transitions',()=>{
 const sql=buildRollout();assert.equal(sql,buildRollout());
 for(const forbidden of ['insert into storage.buckets','create or replace function public.ride_admin_profile_login(','create or replace function rides_private.is_ride_admin_code(','insert into rides_private.ride_admin_profiles','insert into rides_private.ride_admin_profile_sessions'])assert.equal(sql.includes(forbidden),false,forbidden);
 assert.equal(sql.startsWith('-- Generated additive'),true);assert.ok(sql.endsWith('commit;\n'));
 assert.match(sql,/Missing existing prerequisite/);assert.match(sql,/revoke execute on function rides_private\.ride_publish_plan_internal/);
});
test('rollout bundle preserves deployed NULL plan default and current-plan publication fallback',()=>{
 const fn=extractFunction(buildRollout(),'public.ride_admin_publish_plan');
 assert.match(fn,/p_plan_date date default null/);
 assert.match(fn,/coalesce\(p_plan_date,rides_private.current_ride_plan_date\(\)\)/);
});

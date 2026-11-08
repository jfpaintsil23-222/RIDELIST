import assert from 'node:assert/strict';
import {test, before} from 'node:test';
import {readFileSync,existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const container=process.env.RIDELIST_TEST_CONTAINER;
const enabled=Boolean(container);
if(enabled&&!/^ridelist-publish-test-[a-z0-9-]+$/.test(container))throw Error('Disposable test container required');
const db='ridelist_return_release_test';
function sql(input, database=db, fail=false){
 const r=spawnSync('docker',['exec','-i',container,'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U','postgres','-d',database],{input,encoding:'utf8',timeout:20000});
 if(fail){assert.notEqual(r.status,0);return r.stderr;} assert.equal(r.status,0,r.stderr);return r.stdout.trim();
}
const q=x=>"'"+String(x).replaceAll("'","''")+"'";
const rpc=(name,args)=>JSON.parse(sql('set role anon; select public.'+name+'('+args.map(q).join(',')+');'));
function def(source,name){const start=source.indexOf('create or replace function '+name+'(');assert.ok(start>=0);return source.slice(start,source.indexOf('$$;',start)+3);}
before(()=>{
 if(!enabled)return;
 const info=JSON.parse(spawnSync('docker',['inspect',container],{encoding:'utf8'}).stdout)[0];assert.equal(info.HostConfig.NetworkMode,'none');assert.ok(Object.hasOwn(info.HostConfig.Tmpfs,'/var/lib/postgresql/data'));
 sql('drop database if exists '+db+'; create database '+db+';','postgres');
 let fixture=readFileSync(new URL('./fixtures/return-release-schema.sql',import.meta.url),'utf8');
 fixture=fixture.replace('create role anon; create role authenticated;',()=>"do $$ begin if not exists(select from pg_roles where rolname='anon') then create role anon; end if; if not exists(select from pg_roles where rolname='authenticated') then create role authenticated; end if; end $$;");
 const src=readFileSync(new URL('../supabase/sunday_reset.sql',import.meta.url),'utf8');
 fixture+=['ride_driver_route','ride_driver_directory','ride_app_context'].map(n=>def(src,'public.'+n)).join('\n');
 sql(fixture);
 const migration=new URL('../supabase/return_release.sql',import.meta.url);
 if(existsSync(migration)){sql(readFileSync(migration,'utf8'));sql("insert into rides_private.ride_plan_phases(plan_date) values('2099-01-04'); update rides_private.ride_drivers set pickup_route_notes='Leave by 11:00 AM',return_route_notes='Return after event';");}
});
test('unreleased returns and late riders never appear in a driver route',{skip:!enabled},()=>{
 const r=rpc('ride_driver_route',['example','driver-code','2099-01-04']);assert.equal(r.ok,true);assert.deepEqual(r.riders.map(x=>x.name),['Pickup A']);assert.doesNotMatch(JSON.stringify(r),/Private return|Late rider|Secret Sample/);
});
test('directory cannot leak unreleased names or notes',{skip:!enabled},()=>{
 const r=sql("set role anon; select row_to_json(d) from public.ride_driver_directory('2099-01-04') d;");
 assert.doesNotMatch(r,/Private return/);assert.match(r,/"pickup_count":1/);
});
test('renaming a return route never changes its private direction',{skip:!enabled},()=>{
 sql("update rides_private.ride_stops set route_label='HCU Run 1' where stop_order=1;");
 const r=rpc('ride_driver_route',['example','driver-code','2099-01-04']);assert.deepEqual(r.riders.map(x=>x.name),['Pickup A']);
 assert.equal(sql("select ride_direction from rides_private.ride_stops where stop_order=1;"),'return');
});
test('admin review, revision guard, release idempotency and phase switching',{skip:!enabled},()=>{
 const exists=sql("select to_regprocedure('public.ride_admin_return_state(text,date)') is not null;");assert.equal(exists,'t','admin release API is missing');
 assert.equal(rpc('ride_admin_return_state',['wrong','2099-01-04']).ok,false);
 let state=rpc('ride_admin_return_state',['synthetic-admin','2099-01-04']);assert.equal(state.phase,'pickup');assert.equal(state.riders.length,1);assert.equal(state.laterRiders.length,1);
 assert.equal(rpc('ride_admin_release_returns',['synthetic-admin','2099-01-04','stale','00000000-0000-0000-0000-000000000099']).error,'revision_changed');
 const released=rpc('ride_admin_release_returns',['synthetic-admin','2099-01-04',state.revision,'00000000-0000-0000-0000-000000000099']);assert.equal(released.phase,'return');assert.equal(released.ok,true);
 const twice=rpc('ride_admin_release_returns',['synthetic-admin','2099-01-04',state.revision,'00000000-0000-0000-0000-000000000099']);assert.equal(twice.releaseId,released.releaseId);
 assert.equal(sql('select count(*) from rides_private.ride_return_notifications;'),'1','one current-plan device only');
 const route=rpc('ride_driver_route',['example','driver-code','2099-01-04']);assert.deepEqual(route.riders.map(x=>x.name),['Private return rider']);assert.equal(route.phase,'return');assert.equal(route.destination.address,'');
 assert.equal(rpc('ride_driver_route',['empty','empty-code','2099-01-04']).riders.length,0);
 assert.equal(rpc('ride_driver_route',['example','empty-code','2099-01-04']).ok,false);
 assert.equal(sql("select count(*) from rides_private.ride_stops;"),'3','pickup and later rows preserved');
 assert.equal(sql("select count(*) from rides_private.ride_plan_phases where plan_date='2099-01-11';"),'0');
});
test('notification jobs need admin auth and matching leases; sent jobs are never reclaimed',{skip:!enabled},()=>{
 assert.equal(sql("select to_regprocedure('public.ride_admin_claim_return_notifications(text,date,uuid)') is not null;"),'t');
 const state=rpc('ride_admin_return_state',['synthetic-admin','2099-01-04']);
 assert.equal(rpc('ride_admin_claim_return_notifications',['bad','2099-01-04',state.releaseId]).ok,false);
 sql("insert into rides_private.ride_driver_push_subscriptions(plan_date,driver_slug,endpoint,subscription) values('2099-01-04','example','https://push.example/second','{}'),('2099-01-04','example','https://push.example/third','{}'); insert into rides_private.ride_return_notifications(release_id,plan_date,driver_slug,subscription_id) select ph.release_id,ph.plan_date,u.driver_slug,u.id from rides_private.ride_plan_phases ph join rides_private.ride_driver_push_subscriptions u on u.plan_date=ph.plan_date where u.endpoint in('https://push.example/second','https://push.example/third');");
 const claim=rpc('ride_admin_claim_return_notifications',['synthetic-admin','2099-01-04',state.releaseId]);assert.equal(claim.jobs.length,1);
 assert.equal(sql("select count(*) from rides_private.ride_return_notifications where status='pending';"),'2','unattempted jobs remain pending');
 const job=claim.jobs[0];
 assert.equal(rpc('ride_admin_finish_return_notification',['synthetic-admin',job.id,'00000000-0000-0000-0000-000000000098','sent','']).ok,false);
 assert.equal(rpc('ride_admin_finish_return_notification',['synthetic-admin',job.id,job.leaseToken,'sent','']).ok,true);
 for(let i=0;i<2;i++){const next=rpc('ride_admin_claim_return_notifications',['synthetic-admin','2099-01-04',state.releaseId]);assert.equal(next.jobs.length,1);assert.equal(rpc('ride_admin_finish_return_notification',['synthetic-admin',next.jobs[0].id,next.jobs[0].leaseToken,'sent','']).ok,true);}
 assert.equal(rpc('ride_admin_claim_return_notifications',['synthetic-admin','2099-01-04',state.releaseId]).jobs.length,0);
 assert.equal(sql('set role anon; select * from rides_private.ride_plan_phases;',db,true).includes('permission denied'),true);
});

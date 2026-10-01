import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { before, test } from 'node:test';

const container = process.env.RIDELIST_TEST_CONTAINER;
const enabled = Boolean(container);
if (enabled && !/^ridelist-publish-test-[a-z0-9-]+$/.test(container)) {
  throw new Error('Use a disposable ridelist-publish-test-* container');
}
// Keep this file isolated from publish_atomicity's schema recreation in postgres.
const database = 'ridelist_shared_admin_test';
function sql(command, db = database, expectFailure = false) {
  const result = spawnSync('docker', ['exec', '-i', container, 'psql', '-X', '-qAt',
    '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', db], {
    input: command, encoding: 'utf8', timeout: 20000,
  });
  if (expectFailure) {
    assert.notEqual(result.status, 0, 'Direct private access unexpectedly succeeded');
    assert.match(result.stderr, /permission denied/);
    return;
  }
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result.stdout.trim();
}
function definition(source, name) {
  const start = source.indexOf(`create or replace function ${name}(`);
  assert.ok(start >= 0, `Missing existing ${name}`);
  return source.slice(start, source.indexOf('$$;', start) + 3);
}
const quote = value => `'${String(value).replaceAll("'", "''")}'`;
function rpc(name, code, date = '2099-01-04', extra = '') {
  return JSON.parse(sql(`set role anon; select public.${name}(${quote(code)}, ${quote(date)}::date${extra});`));
}
before(() => {
  if (!enabled) return;
  const inspect = spawnSync('docker', ['inspect', container], { encoding: 'utf8' });
  assert.equal(inspect.status, 0, inspect.stderr);
  const info = JSON.parse(inspect.stdout)[0];
  assert.equal(info.HostConfig.NetworkMode, 'none', 'Fixture must have no network');
  assert.deepEqual(info.HostConfig.PortBindings ?? {}, {}, 'Fixture must have no exposed ports');
  assert.ok(Object.hasOwn(info.HostConfig.Tmpfs ?? {}, '/var/lib/postgresql/data'), 'Fixture must use ephemeral data');
  assert.match(sql('show server_version;', 'postgres'), /^17\./);
  if (sql(`select count(*) from pg_database where datname = ${quote(database)};`, 'postgres') === '0') {
    sql(`create database ${database};`, 'postgres');
  }
  const fixture = readFileSync(new URL('./fixtures/shared-admin-schema.sql', import.meta.url), 'utf8');
  const security = readFileSync(new URL('../supabase/admin_security.sql', import.meta.url), 'utf8');
  const path = new URL('../supabase/collaborative_ride_control.sql', import.meta.url);
  const authHelpers = ['admin_login_required', 'is_ride_admin', 'is_ride_admin_passcode',
    'ride_admin_profile_session_actor', 'is_ride_admin_profile_session', 'is_ride_admin_code']
    .map(name => definition(security, `rides_private.${name}`)).join('\n');
  const control = readFileSync(new URL('../supabase/admin_ride_control.sql', import.meta.url), 'utf8');
  const legacy = ['rides_private.ride_parse_time', 'rides_private.rider_names_summary', 'rides_private.ride_admin_draft_actor_key', 'rides_private.ride_people_name_key', 'public.ride_admin_update_event_setup', 'public.ride_admin_upsert_people', 'public.ride_admin_merge_people', 'public.ride_admin_archive_people', 'public.ride_admin_publish_plan', 'public.ride_admin_save_draft', 'public.ride_admin_clear_draft'].map(name => definition(control, name)).join('\n');
  const sunday = readFileSync(new URL('../supabase/sunday_reset.sql', import.meta.url), 'utf8');
  const otherWriters = ['rides_private.current_ride_plan_date', 'public.ride_admin_start_new_sunday', 'public.ride_admin_update_plan_drivers', 'public.ride_admin_add_driver'].map(name=>definition(sunday,name)).join('\n');
  const internal = control.includes('create or replace function rides_private.ride_publish_plan_internal(') ? definition(control, 'rides_private.ride_publish_plan_internal') + '\n' + control.match(/revoke execute on function rides_private\.ride_publish_plan_internal[^;]+;/)[0] : '';
  const auditStart=security.indexOf('create table if not exists rides_private.ride_admin_audit_log (');
  const auditTable=security.slice(auditStart,security.indexOf(');',auditStart)+2);
  const auditFunctions=['rides_private.ride_admin_actor','rides_private.log_ride_admin_event','rides_private.log_ride_stop_admin_change'].map(name=>definition(security,name)).join('\n');
  const auditTrigger='create trigger ride_admin_audit_stops after insert or update or delete on rides_private.ride_stops for each row execute function rides_private.log_ride_stop_admin_change();';
  sql(fixture + '\n' + auditTable + '\n' + auditFunctions + '\n' + auditTrigger + '\n' + authHelpers + '\n' + legacy + '\n' + otherWriters + '\n' + internal + '\n' +
    (existsSync(path) ? readFileSync(path, 'utf8') : ''));
});

test('shared_context_requires_valid_actor', { skip: !enabled }, () => {
  assert.equal(sql("select rides_private.is_ride_admin_code('legacy-shared-code');"), 't', 'Fixture must exercise a genuinely valid legacy shared code');
  for (const code of ['', 'wrong', 'expired-token', 'disabled-token', 'driver-token', 'legacy-shared-code', 'alpha']) {
    assert.deepEqual(rpc('ride_admin_shared_context', code, undefined, ', 0'), { ok: false, code: 'invalid_admin_code' });
    assert.deepEqual(rpc('ride_admin_shared_snapshot', code), { ok: false, code: 'invalid_admin_code' });
  }
  sql("delete from rides_private.ride_admin_profile_sessions where session_token_hash = md5('gamma-token');");
  assert.deepEqual(rpc('ride_admin_shared_context', 'gamma-token', undefined, ', 0'), { ok: false, code: 'invalid_admin_code' });
  sql("insert into rides_private.ride_admin_profile_sessions (profile_slug, session_token_hash, expires_at) values ('gamma', md5('gamma-token'), now() + interval '1 hour');");
});

test('shared_context_preserves_existing_profile_identity', { skip: !enabled }, () => {
  for (const [token, slug] of [['alpha-token', 'alpha'], ['alpha-refreshed-token', 'alpha'], ['beta-token', 'beta'], ['gamma-token', 'gamma']]) {
    const result = rpc('ride_admin_shared_context', token, undefined, ', 0');
    assert.equal(result.ok, true);
    assert.equal(result.actorKey, `profile:${slug}`);
    assert.equal(result.actor.profileSlug, slug);
    assert.equal(result.actor.type, 'profile');
    assert.equal(result.writeMode, 'legacy');
    assert.equal(result.initialized, false);
    assert.deepEqual(rpc('ride_admin_shared_snapshot', token), { ok: false, code: 'not_initialized' });
  }
});

test('shared_tables_deny_direct_anon_access', { skip: !enabled }, () => {
  const tables = sql("select tablename from pg_tables where schemaname = 'rides_private' and tablename like 'ride_shared_%' order by tablename;").split('\n');
  assert.equal(tables.length, 9, 'Missing private shared schema');
  const firstColumns = JSON.parse(sql("select jsonb_object_agg(c.relname, a.attname) from pg_class c join pg_namespace n on n.oid=c.relnamespace join pg_attribute a on a.attrelid=c.oid and a.attnum=(select min(attnum) from pg_attribute where attrelid=c.oid and attnum>0 and attidentity='' and not attisdropped) where n.nspname='rides_private' and c.relkind='r' and c.relname like 'ride_shared_%';"));
  for (const role of ['anon', 'authenticated']) {
    for (const table of tables) {
      for (const command of [`select * from rides_private.${table};`, `delete from rides_private.${table};`,
        `update rides_private.${table} set ${firstColumns[table]} = ${firstColumns[table]};`, `insert into rides_private.${table} default values;`]) {
        sql(`set role ${role}; ${command}`, database, true);
      }
    }
    sql(`set role ${role}; select rides_private.ride_shared_actor('alpha-token');`, database, true);
  }
  assert.equal(sql("select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='rides_private' and c.relname like 'ride_shared_%' and c.relkind='r' and c.relrowsecurity and c.relforcerowsecurity;"), '9');
  // Defense in depth: an accidental future SELECT grant still exposes no rows.
  sql("insert into rides_private.ride_shared_write_modes (plan_date) values ('2099-01-11'); grant select on rides_private.ride_shared_write_modes to anon;");
  assert.equal(sql('set role anon; select count(*) from rides_private.ride_shared_write_modes;'), '0');
  sql('revoke select on rides_private.ride_shared_write_modes from anon;');
});

test('shared_context_rejects_forged_or_revoked_jwt_identity', { skip: !enabled }, () => {
  const jwt = (sub, session, exp = 4070908800) => ({ sub, session_id: session, exp, user_metadata: { role: 'admin' } });
  function context(claims) {
    return JSON.parse(sql(`set role authenticated; set request.jwt.claims = ${quote(JSON.stringify(claims))}; select public.ride_admin_shared_context('', '2099-01-04', 0);`));
  }
  const admin = '00000000-0000-0000-0000-000000000001';
  const driver = '00000000-0000-0000-0000-000000000002';
  const session = '00000000-0000-0000-0000-000000000011';
  for (const claims of [jwt(driver, '00000000-0000-0000-0000-000000000012'), jwt(admin, session, 1),
    jwt(admin, '00000000-0000-0000-0000-000000000099'), jwt(admin, 'not-a-uuid'), jwt('not-a-uuid', session),
    jwt(admin, session, 'NaN'), { sub: admin }]) {
    assert.deepEqual(context(claims), { ok: false, code: 'invalid_admin_code' });
  }
  assert.equal(context(jwt(admin, session)).actorKey, `user:${admin}`);
  sql(`update auth.sessions set not_after = now() - interval '1 minute' where id = '${session}';`);
  assert.deepEqual(context(jwt(admin, session)), { ok: false, code: 'invalid_admin_code' });
  sql(`update auth.sessions set not_after = now() + interval '1 hour' where id = '${session}';`);
  sql(`update rides_private.ride_admin_users set active = false where auth_user_id = '${admin}';`);
  assert.deepEqual(context(jwt(admin, session)), { ok: false, code: 'invalid_admin_code' });
  sql(`update rides_private.ride_admin_users set active = true where auth_user_id = '${admin}'; delete from auth.sessions where id = '${session}';`);
  assert.deepEqual(context(jwt(admin, session)), { ok: false, code: 'invalid_admin_code' });
});

test('shared_snapshot_is_same_plan_for_three_admins_with_minimal_ordered_events', { skip: !enabled }, () => {
  sql(`insert into rides_private.ride_shared_workspaces (plan_date, drivers, settings) values ('2099-01-04', '[{"slug":"synthetic-driver"}]', '{"destination":"Synthetic destination"}');
    insert into rides_private.ride_shared_write_modes (plan_date, write_mode) values ('2099-01-04', 'shared');
    insert into rides_private.ride_shared_riders (plan_date, id, driver_slug, payload) values ('2099-01-04', '00000000-0000-0000-0000-000000000100', 'synthetic-driver', '{"name":"Synthetic Rider","phone":"000-000-0000","stopOrder":1}');
    insert into rides_private.ride_shared_groups (plan_date, group_key) values ('2099-01-04', 'synthetic-driver');
    insert into rides_private.ride_shared_events (plan_date, draft_revision, actor_key, event_type) values ('2099-01-04', 1, 'profile:alpha', 'rider_added'), ('2099-01-04', 2, 'profile:beta', 'rider_updated');
    update rides_private.ride_shared_workspaces set draft_revision = 2, event_cursor = (select max(event_id) from rides_private.ride_shared_events) where plan_date='2099-01-04';`);
  const snapshots = ['alpha-token', 'beta-token', 'gamma-token'].map(token => rpc('ride_admin_shared_snapshot', token));
  assert.deepEqual(snapshots[0], snapshots[1]); assert.deepEqual(snapshots[1], snapshots[2]);
  const snapshot = snapshots[0];
  assert.equal(snapshot.ok, true); assert.equal(snapshot.planDate, '2099-01-04');
  assert.equal(snapshot.draftRevision, 2); assert.equal(snapshot.publishedRevision, 0);
  assert.equal(snapshot.baselinePublishedRevision, 0); assert.equal(snapshot.settingsVersion, 1);
  assert.equal(snapshot.riders[0].entityVersion, 1); assert.equal(snapshot.riders[0].driverSlug, 'synthetic-driver');
  assert.deepEqual(snapshot.groupVersions, { 'synthetic-driver': 1 });
  assert.equal(snapshot.writeMode, 'shared'); assert.ok(snapshot.publishedSnapshot.plan);
  const context = rpc('ride_admin_shared_context', 'beta-token', undefined, ', 0');
  assert.deepEqual(context.events.map(event => event.type), ['rider_added', 'rider_updated']);
  for (const event of context.events) assert.deepEqual(Object.keys(event).sort(), ['actorKey', 'draftRevision', 'eventCursor', 'planDate', 'type']);
  assert.equal(rpc('ride_admin_shared_context', 'alpha-token', undefined, `, ${context.events[0].eventCursor}`).events.length, 1);
  assert.deepEqual(rpc('ride_admin_shared_context', 'alpha-token', '2099-01-11', ', 0').events, []);
  assert.equal(sql('select count(*) from rides_private.ride_shared_workspaces;'), '1', 'Read must not initialize a legacy workspace');
  assert.equal(sql('select public.synthetic_church_read();'), 'unrelated synthetic church record');
  assert.equal(sql('select count(*) from rides_private.ride_admin_profiles;'), '4');
});

test('shared_schema_reapply_preserves_workspaces_credentials_and_unrelated_objects', { skip: !enabled }, () => {
  const before = rpc('ride_admin_shared_snapshot', 'alpha-token');
  const legacyQuery = "select jsonb_build_object('profiles', (select jsonb_agg(to_jsonb(p) order by slug) from rides_private.ride_admin_profiles p), 'sessions', (select jsonb_agg(to_jsonb(s) order by id) from rides_private.ride_admin_profile_sessions s), 'church', (select pg_get_functiondef('public.synthetic_church_read()'::regprocedure)), 'profileHelper', (select pg_get_functiondef('rides_private.ride_admin_profile_session_actor(text)'::regprocedure)));";
  const legacy = sql(legacyQuery);
  sql(readFileSync(new URL('../supabase/collaborative_ride_control.sql', import.meta.url), 'utf8'));
  assert.deepEqual(rpc('ride_admin_shared_snapshot', 'alpha-token'), before);
  assert.equal(sql(legacyQuery), legacy);
  const functions = JSON.parse(sql("select jsonb_object_agg(p.proname, jsonb_build_object('definer',p.prosecdef,'config',p.proconfig)) from pg_proc p where p.proname in ('ride_shared_actor','ride_admin_shared_context','ride_admin_shared_snapshot');"));
  for (const definition of Object.values(functions)) {
    assert.equal(definition.definer, true);
    assert.deepEqual(definition.config, ['search_path=""']);
  }
});

// Task 2 fixtures explicitly initialize synthetic state. Production cutover is Task 3.
const riderA = '00000000-0000-0000-0000-000000000201';
const riderB = '00000000-0000-0000-0000-000000000202';
let opCounter = 300;
const operationId = () => `00000000-0000-0000-0000-${String(++opCounter).padStart(12, '0')}`;
function initialize() {
  sql(`delete from rides_private.ride_shared_operations; delete from rides_private.ride_shared_events;
    delete from rides_private.ride_shared_riders; delete from rides_private.ride_shared_groups;
    delete from rides_private.ride_shared_workspaces; delete from rides_private.ride_shared_write_modes;
    delete from rides_private.ride_stops; delete from rides_private.ride_drivers where plan_id=(select id from rides_private.ride_plans where plan_date='2099-01-04');
    truncate rides_private.ride_admin_audit_log;
    insert into rides_private.ride_shared_workspaces (plan_date, drivers) values ('2099-01-04','[{"slug":"driver-a"},{"slug":"driver-b"}]');
    insert into rides_private.ride_shared_write_modes (plan_date,write_mode) values ('2099-01-04','shared');
    insert into rides_private.ride_shared_groups (plan_date,group_key) values ('2099-01-04','driver-a'),('2099-01-04','driver-b'),('2099-01-04','@drivers');
    insert into rides_private.ride_shared_riders (plan_date,id,driver_slug,payload) values
      ('2099-01-04','${riderA}','driver-a','{"name":"Synthetic A","stopOrder":1}'),
      ('2099-01-04','${riderB}','driver-a','{"name":"Synthetic B","stopOrder":2}');`);
}
function operation(kind='rider_update', entityId=riderA, payload={name:'Changed A'}, groups={}) {
  return {operationId:operationId(), planDate:'2099-01-04',kind,entityId,expectedEntityVersion:1,
    expectedGroupVersions:groups,expectedBaselinePublishedRevision:0,payload};
}
function mutateSql(op, token='alpha-token') {
  return `set role anon; select public.ride_admin_shared_mutate(${quote(token)},'2099-01-04',${quote(JSON.stringify(op))}::jsonb);`;
}
const mutate = (op, token) => JSON.parse(sql(mutateSql(op,token)));
function publishSql(revision=0,baseline=0,id=operationId(),token='alpha-token') {
  return `set role anon; select public.ride_admin_shared_publish(${quote(token)},'2099-01-04',${revision},${baseline},'${id}');`;
}
const published = () => sql(`select md5(jsonb_build_object('stops',(select coalesce(jsonb_agg(to_jsonb(s) order by id),'[]') from rides_private.ride_stops s),'drivers',(select coalesce(jsonb_agg(to_jsonb(d) order by id),'[]') from rides_private.ride_drivers d),'audit',(select coalesce(jsonb_agg(to_jsonb(a)),'[]') from rides_private.ride_admin_audit_log a))::text);`);
const sharedHash = () => sql(`select md5(jsonb_build_object('workspace',(select to_jsonb(w) from rides_private.ride_shared_workspaces w),'riders',(select jsonb_agg(to_jsonb(r) order by id) from rides_private.ride_shared_riders r),'groups',(select jsonb_agg(to_jsonb(g) order by group_key) from rides_private.ride_shared_groups g),'events',(select coalesce(jsonb_agg(to_jsonb(e) order by event_id),'[]') from rides_private.ride_shared_events e))::text);`);
function counts(revision, events) {
  const snap = rpc('ride_admin_shared_snapshot','alpha-token');
  assert.equal(snap.draftRevision,revision); assert.equal(Number(sql('select count(*) from rides_private.ride_shared_events;')),events);
  return snap;
}
// Independent psql connections: first owns the workspace lock in an open transaction;
// second must be observed waiting on that lock before first is allowed to commit.
async function race(first, second) {
  const args = ['exec','-i',container,'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U','postgres','-d',database];
  const holder = spawn('docker',args,{stdio:['pipe','pipe','pipe']});
  let output='', errors='';
  const firstResult = new Promise((resolve,reject) => {
    holder.stdout.on('data',chunk => { output += chunk; if(output.includes('BARRIER')) resolve(JSON.parse(output.split('\n').find(line=>line.startsWith('{')))); });
    holder.stderr.on('data',chunk=>{errors+=chunk;});
    holder.on('exit',code=>{if(code) reject(new Error(errors));});
  });
  holder.stdin.write(`begin; ${first} select 'BARRIER';\n`);
  let contender;
  try {
    const a = await firstResult;
    contender = spawn('docker',['exec','-i','-e','PGAPPNAME=shared-race-contender',container,...args.slice(3)],{stdio:['pipe','pipe','pipe']});
    let out='',err='';
    const done = new Promise((resolve,reject)=>{contender.stdout.on('data',c=>out+=c); contender.stderr.on('data',c=>err+=c); contender.on('close',code=>code?reject(new Error(err)):resolve(JSON.parse(out.trim())));});
    contender.stdin.end(second);
    let waiting=false;
    for(let i=0;i<50;i++) {
      if(sql("select count(*) from pg_stat_activity where application_name='shared-race-contender' and wait_event_type='Lock';")==='1'){waiting=true;break;}
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    assert.ok(waiting,'Contender must reach the workspace lock before commit');
    holder.stdin.end('commit;\n');
    return [a, await done];
  } finally { if(!holder.stdin.writableEnded) holder.stdin.end('rollback;\n'); if(contender && !contender.stdin.writableEnded) contender.stdin.end(); }
}

test('different_riders_both_save', {skip:!enabled}, async()=>{
  initialize(); const before=published();
  const [a,b]=await race(mutateSql(operation()),mutateSql(operation('rider_update',riderB,{name:'Changed B'}),'beta-token'));
  assert.equal(a.ok,true); assert.equal(b.ok,true); assert.equal(counts(2,2).riders.filter(r=>r.name.startsWith('Changed')).length,2); assert.equal(published(),before);
});
test('same_rider_conflicts', {skip:!enabled}, async()=>{
  initialize(); const [a,b]=await race(mutateSql(operation()),mutateSql(operation('rider_update',riderA,{name:'Second'}),'beta-token'));
  assert.equal(a.ok,true); assert.equal(b.code,'conflict'); assert.equal(counts(1,1).riders.find(r=>r.id===riderA).name,'Changed A');
});
test('move_delete_reorder_race', {skip:!enabled}, async()=>{
  for(const kind of ['rider_remove','reorder']) {
    initialize(); const move=operation('rider_move',riderA,{driverSlug:'driver-b',stopOrder:1},{'driver-a':1,'driver-b':1});
    const other=kind==='reorder'?operation(kind,undefined,{driverSlug:'driver-a',riderIds:[riderB,riderA]},{'driver-a':1}):operation(kind,riderA,{}, {'driver-a':1});
    const [a,b]=await race(mutateSql(move),mutateSql(other,'beta-token'));
    assert.equal(a.ok,true); assert.equal(b.code,'conflict'); const snap=counts(1,1); assert.equal(snap.riders.find(r=>r.id===riderA).driverSlug,'driver-b'); assert.deepEqual(snap.groupVersions,{'@drivers':1,'driver-a':2,'driver-b':2});
  }
});
test('duplicate_operation_is_once', {skip:!enabled}, async()=>{
  initialize(); const op=operation(); const [a,b]=await race(mutateSql(op),mutateSql(op));
  assert.deepEqual(a,b); assert.equal(a.ok,true); counts(1,1); assert.equal(sql('select count(*) from rides_private.ride_shared_operations;'),'1');
});
test('changed_body_same_id_rejected', {skip:!enabled},()=>{
  initialize(); const op=operation(); assert.equal(mutate(op).ok,true); const before=sharedHash();
  assert.equal(mutate({...op,payload:{name:'Different'}}).code,'operation_id_reused'); assert.equal(sharedHash(),before); counts(1,1);
});
test('token_refresh_same_actor_retries', {skip:!enabled},()=>{
  initialize(); const op=operation(); const result=mutate(op);
  assert.deepEqual(mutate(op,'alpha-refreshed-token'),result); assert.deepEqual(rpc('ride_admin_shared_operation','alpha-refreshed-token',undefined,`, '${op.operationId}'::uuid`),result);
  assert.equal(rpc('ride_admin_shared_operation','beta-token',undefined,`, '${op.operationId}'::uuid`).code,'not_found'); counts(1,1);
  sql("update rides_private.ride_shared_operations set created_at=now()-interval '31 days';");
  assert.equal(mutate(op).code,'operation_expired'); counts(1,1);
});
test('stale_publish_rejected', {skip:!enabled},()=>{
  initialize(); mutate(operation()); const before=published();
  assert.equal(JSON.parse(sql(publishSql())).code,'conflict'); assert.equal(published(),before); counts(1,1);
});
test('save_publish_race', {skip:!enabled}, async()=>{
  initialize(); const before=published(); const [a,b]=await race(mutateSql(operation()),publishSql());
  assert.equal(a.ok,true); assert.equal(b.code,'conflict'); counts(1,1); assert.equal(published(),before);
  initialize(); const [p,m]=await race(publishSql(),mutateSql(operation()));
  assert.equal(p.ok,true); assert.equal(m.code,'conflict'); const snap=counts(0,1); assert.equal(snap.baselinePublishedRevision,1); assert.equal(snap.publishedRevision,1);
});
test('two_publishers_one_baseline', {skip:!enabled}, async()=>{
  initialize(); const [a,b]=await race(publishSql(),publishSql(0,0,operationId(),'beta-token'));
  assert.equal(a.ok,true); assert.equal(b.code,'conflict'); const snap=counts(0,1); assert.equal(snap.publishedRevision,1);
  assert.equal(sql(`select count(*) from rides_private.ride_stops where id in ('${riderA}','${riderB}');`),'2','First publish must preserve UUIDs');
  assert.equal(sql("select subtitle from rides_private.ride_drivers where slug='driver-a' and plan_id=(select id from rides_private.ride_plans where plan_date='2099-01-04');"),'Synthetic A and Synthetic B');
});
test('failed_publish_rolls_back_events_and_driver_rows', {skip:!enabled},()=>{
  initialize(); assert.equal(mutate(operation('rider_update',riderB,{name:'FORCE_DATABASE_ERROR'})).ok,true);
  const before=published(), draft=sharedHash(); assert.throws(()=>sql(publishSql(1)),/synthetic_write_failure/);
  assert.equal(published(),before); assert.equal(sharedHash(),draft); counts(1,1);
  assert.equal(mutate(operation('rider_move',riderA,{driverSlug:'',stopOrder:1},{'driver-a':1,'':0})).ok,true);
  const state=published(), shared=sharedHash(); const result=JSON.parse(sql(publishSql(2)));
  assert.equal(result.code,'validation_failed'); assert.equal(result.value.error,'driver_required'); assert.equal(published(),state); assert.equal(sharedHash(),shared); counts(2,2);
});
test('rider_add_remove_reorder_and_driver_activation_validate_versions', {skip:!enabled},()=>{
  initialize(); const added=operation('rider_add',operationId(),{name:'Added',driverSlug:'driver-b',stopOrder:1},{'driver-b':1}); added.expectedEntityVersion=0;
  assert.equal(mutate(added).ok,true);
  assert.equal(mutate(operation('reorder',undefined,{driverSlug:'driver-a',riderIds:[riderB,riderA]},{'driver-a':1})).ok,true);
  assert.equal(mutate(operation('rider_remove',riderA,{}, {'driver-a':2})).code,'conflict');
  const remove=operation('rider_remove',riderA,{}, {'driver-a':2}); remove.expectedEntityVersion=2; assert.equal(mutate(remove).ok,true);
  const activate=operation('plan_drivers',undefined,{driverSlugs:[]},{'@drivers':1,'driver-a':3,'driver-b':2,'':0});
  assert.equal(mutate(activate).ok,true); const snap=counts(4,4); assert.deepEqual(snap.drivers,[]); assert.ok(snap.riders.every(r=>r.driverSlug===''));
  assert.equal(JSON.parse(sql(publishSql(4))).code,'validation_failed');
  initialize(); sql('delete from rides_private.ride_shared_riders;'); assert.equal(mutate(operation('plan_drivers',undefined,{driverSlugs:[]},{'@drivers':1,'driver-a':1,'driver-b':1})).ok,true); assert.equal(JSON.parse(sql(publishSql(1))).ok,true);
});
test('legacy_whole_writes_are_fenced_before_effects', {skip:!enabled},()=>{
  initialize(); const before=published(), draft=sharedHash();
  for(const query of ["select public.ride_admin_save_draft('alpha-token','2099-01-04','{}');", "select public.ride_admin_clear_draft('alpha-token','2099-01-04');", "select public.ride_admin_publish_plan('alpha-token','2099-01-04','[]','{}');"]) {
    assert.equal(JSON.parse(sql('set role anon; '+query)).code,'update_required'); assert.equal(published(),before); assert.equal(sharedHash(),draft);
  }
});

test('every_shared_writer_requires_individual_actor_and_private_helpers_deny_execute', {skip:!enabled},()=>{
  initialize(); const before=published(), shared=sharedHash();
  for(const token of ['wrong','expired-token','disabled-token','legacy-shared-code','alpha']) {
    assert.equal(mutate(operation(),token).code,'invalid_admin_code');
    assert.equal(JSON.parse(sql(publishSql(0,0,operationId(),token))).code,'invalid_admin_code');
    assert.equal(rpc('ride_admin_shared_operation',token,undefined,`, '${operationId()}'::uuid`).code,'invalid_admin_code');
  }
  assert.equal(published(),before); assert.equal(sharedHash(),shared);
  for(const role of ['anon','authenticated']) {
    sql(`set role ${role}; select rides_private.ride_shared_apply('alpha-token','2099-01-04','{}');`,database,true);
    sql(`set role ${role}; select rides_private.ride_publish_plan_internal('alpha-token','2099-01-04','[]','{}',true);`,database,true);
  }
  const configuration=JSON.parse(sql("select jsonb_object_agg(proname,proconfig) from pg_proc where proname in ('ride_shared_apply','ride_publish_plan_internal','ride_admin_shared_mutate','ride_admin_shared_operation','ride_admin_shared_publish');"));
  assert.equal(Object.keys(configuration).length,5); for(const config of Object.values(configuration)) assert.deepEqual(config,['search_path=""']);
});
test('canonical_request_keys_and_recorded_conflicts_are_retry_stable', {skip:!enabled},()=>{
  initialize(); const op=operation(); const value=mutate(op); const before=sharedHash();
  assert.deepEqual(mutate(Object.fromEntries(Object.entries(op).reverse())),value); assert.equal(sharedHash(),before);
  const conflict=operation(); const failed=mutate(conflict); assert.equal(failed.code,'conflict');
  assert.deepEqual(mutate(conflict,'alpha-refreshed-token'),failed); assert.equal(sharedHash(),before);
  const id=operationId(); const publishedOnce=JSON.parse(sql(publishSql(1,0,id))); assert.equal(publishedOnce.ok,true);
  const after=published(); assert.deepEqual(JSON.parse(sql(publishSql(1,0,id,'alpha-refreshed-token'))),publishedOnce); assert.equal(published(),after);
  assert.equal(JSON.parse(sql(publishSql(0,0,id))).code,'operation_id_reused');
});
test('malformed_requests_and_invalid_mutation_fields_do_not_change_state', {skip:!enabled},()=>{
  initialize(); const before=sharedHash(),live=published();
  for(const op of [null,{}, {...operation(),planDate:'2099-01-11'}, {...operation(),planDate:'invalid-date'}, {...operation(),expectedEntityVersion:null},
    {...operation(),payload:{name:''}}, {...operation(),payload:{driverSlug:'driver-b'}},
    operation('rider_move',riderA,{driverSlug:'driver-b',name:''},{'driver-a':1,'driver-b':1}),
    operation('rider_remove',riderA,{name:'Unsupported removal patch'},{'driver-a':1}),
    operation('reorder',undefined,{driverSlug:'driver-a',riderIds:[riderA,riderA]},{'driver-a':1}),
    operation('rider_move',riderA,{driverSlug:'unknown'},{'driver-a':1,'unknown':0}),
    operation('plan_drivers',undefined,{driverSlugs:['unknown']},{'@drivers':1,'unknown':0})]) {
    const result=mutate(op); assert.equal(result.ok,false); assert.ok(['validation_failed','conflict'].includes(result.code)); assert.equal(sharedHash(),before); assert.equal(published(),live);
  }
});
test('shared_uuid_cannot_take_a_stop_owned_by_another_plan', {skip:!enabled},()=>{
  initialize(); sql(`insert into rides_private.ride_stops(id,driver_id,rider_name,stop_order) select '${riderA}',id,'Other plan synthetic rider',1 from rides_private.ride_drivers where slug='driver-a' and plan_id=(select id from rides_private.ride_plans where plan_date='2099-01-11');`);
  const before=published(),shared=sharedHash(); const result=JSON.parse(sql(publishSql()));
  assert.equal(result.code,'validation_failed'); assert.equal(result.value.error,'stop_id_conflict'); assert.equal(published(),before); assert.equal(sharedHash(),shared);
});
test('legacy_global_master_settings_import_and_plan_drivers_are_fenced', {skip:!enabled},()=>{
  initialize(); const before=published(), shared=sharedHash();
  for(const query of [
    "select public.ride_admin_update_event_setup('alpha-token','2099-01-11','{}');",
    "select public.ride_admin_upsert_people('alpha-token','[]','Synthetic');",
    "select public.ride_admin_merge_people('alpha-token',null,null,'{}');",
    "select public.ride_admin_archive_people('alpha-token',null);",
    "select public.ride_admin_start_new_sunday('alpha-token','2099-01-11','{}');",
    "select public.ride_admin_update_plan_drivers('alpha-token','2099-01-04','{}');",
    "select public.ride_admin_add_driver('alpha-token','2099-01-04','{}');"
  ]) {
    assert.equal(JSON.parse(sql('set role anon; '+query)).code,'update_required'); assert.equal(published(),before); assert.equal(sharedHash(),shared);
  }
  assert.equal(sql('select public.synthetic_church_read();'),'unrelated synthetic church record');
});
test('activation_metadata_and_secret_copy_are_server_owned', {skip:!enabled},()=>{
  initialize(); const op=operation('plan_drivers',undefined,{driverSlugs:['driver-b'],access_code_hash:'client-forged'},{'@drivers':1,'driver-a':1,'':0});
  assert.equal(mutate(op).ok,true); const snap=rpc('ride_admin_shared_snapshot','alpha-token');
  assert.equal(snap.drivers[0].displayName,'Synthetic driver'); assert.ok(!JSON.stringify(snap).includes('access_code_hash')); assert.ok(!JSON.stringify(snap).includes('client-forged'));
  sql('delete from rides_private.ride_shared_riders;'); assert.equal(JSON.parse(sql(publishSql(1))).ok,true);
  assert.equal(sql("select count(*) from rides_private.ride_drivers current_driver join rides_private.ride_drivers source on source.slug=current_driver.slug and source.plan_id<>current_driver.plan_id where current_driver.plan_id=(select id from rides_private.ride_plans where plan_date='2099-01-04') and current_driver.access_code_hash=source.access_code_hash;"),'1');
});

test('declared_group_dependencies_and_invalid_second_publish_preserve_live_state', {skip:!enabled},()=>{
  initialize(); const dependency=operation(); dependency.expectedGroupVersions={'driver-a':0};
  assert.equal(mutate(dependency).code,'conflict'); counts(0,0);
  assert.equal(JSON.parse(sql(publishSql())).ok,true); const live=published();
  const bad=operation('rider_update',riderB,{name:'FORCE_DATABASE_ERROR'}); bad.expectedBaselinePublishedRevision=1;
  assert.equal(mutate(bad).ok,true); const draft=sharedHash();
  assert.throws(()=>sql(publishSql(1,1)),/synthetic_write_failure/); assert.equal(published(),live); assert.equal(sharedHash(),draft); counts(1,2);
  assert.equal(sql(`select count(*) from rides_private.ride_stops where id in ('${riderA}','${riderB}');`),'2');
});

const audit = () => JSON.parse(sql(`select coalesce(jsonb_agg(jsonb_build_object('change',payload->>'change','riderName',payload->>'riderName','actor',actor_profile_slug,'label',actor_label) order by payload->>'change',payload->>'riderName'),'[]') from rides_private.ride_admin_audit_log;`));
const liveStops = () => sql("select jsonb_agg(to_jsonb(s) order by id) from rides_private.ride_stops s;");
function withBaseline(op,baseline=1) { return {...op,expectedBaselinePublishedRevision:baseline}; }
test('republish_preserves_unchanged_rows_creation_times_and_has_no_false_audit', {skip:!enabled},()=>{
  initialize(); assert.equal(JSON.parse(sql(publishSql())).ok,true);
  sql("update rides_private.ride_stops set created_at='2000-01-01',updated_at='2001-01-01'; truncate rides_private.ride_admin_audit_log;");
  const stops=liveStops(); const id=operationId(); assert.equal(JSON.parse(sql(publishSql(0,1,id,'beta-token'))).ok,true);
  assert.equal(liveStops(),stops); assert.deepEqual(audit(),[]); counts(0,2);
  assert.equal(JSON.parse(sql(publishSql(0,1,id,'beta-token'))).ok,true); assert.deepEqual(audit(),[]); counts(0,2);
});
test('publication_audit_reports_only_real_changes_with_individual_actor', {skip:!enabled},()=>{
  initialize(); assert.equal(JSON.parse(sql(publishSql())).ok,true); sql("update rides_private.ride_stops set created_at='2000-01-01'; truncate rides_private.ride_admin_audit_log;");
  assert.equal(mutate(withBaseline(operation('rider_update',riderA,{name:'Updated synthetic A'})),'beta-token').ok,true);
  const updatePublishId=operationId();
  const updateResult=JSON.parse(sql(publishSql(1,1,updatePublishId,'beta-token'))); assert.equal(updateResult.ok,true);
  assert.deepEqual(JSON.parse(sql(publishSql(1,1,updatePublishId,'beta-token'))),updateResult);
  assert.deepEqual(audit(),[{change:'UPDATE',riderName:'Updated synthetic A',actor:'beta',label:'Synthetic Beta'}]);
  assert.equal(sql("select count(*) from rides_private.ride_stops where created_at='2000-01-01';"),'2');
  sql('truncate rides_private.ride_admin_audit_log;');
  assert.equal(mutate(withBaseline(operation('rider_remove',riderB,{}, {'driver-a':1}),2),'gamma-token').ok,true);
  assert.equal(JSON.parse(sql(publishSql(2,2,operationId(),'gamma-token'))).ok,true);
  assert.deepEqual(audit(),[{change:'DELETE',riderName:'Synthetic B',actor:'gamma',label:'Synthetic Gamma'}]);
  sql('truncate rides_private.ride_admin_audit_log;');
  const add=withBaseline(operation('rider_add',operationId(),{name:'New synthetic rider',driverSlug:'driver-b',stopOrder:1},{'driver-b':1}),3); add.expectedEntityVersion=0;
  assert.equal(mutate(add,'beta-token').ok,true);assert.equal(JSON.parse(sql(publishSql(3,3,operationId(),'beta-token'))).ok,true);
  assert.deepEqual(audit(),[{change:'INSERT',riderName:'New synthetic rider',actor:'beta',label:'Synthetic Beta'}]);
});
test('reorder_and_cross_driver_swap_honor_immediate_unique_and_audit_final_changes_once', {skip:!enabled},()=>{
  initialize(); assert.equal(JSON.parse(sql(publishSql())).ok,true); sql("update rides_private.ride_stops set created_at='2000-01-01'; truncate rides_private.ride_admin_audit_log;");
  assert.equal(mutate(withBaseline(operation('reorder',undefined,{driverSlug:'driver-a',riderIds:[riderB,riderA]},{'driver-a':1})),'beta-token').ok,true);
  assert.equal(JSON.parse(sql(publishSql(1,1,operationId(),'beta-token'))).ok,true);
  assert.equal(sql(`select stop_order from rides_private.ride_stops where id='${riderB}';`),'1');
  assert.deepEqual(audit().map(a=>[a.change,a.actor]),[['UPDATE','beta'],['UPDATE','beta']]);
  assert.equal(sql("select count(*) from rides_private.ride_stops where created_at='2000-01-01';"),'2');
  sql('truncate rides_private.ride_admin_audit_log;');
  const move=withBaseline(operation('rider_move',riderA,{driverSlug:'driver-b',stopOrder:1},{'driver-a':2,'driver-b':1}),2); move.expectedEntityVersion=2;
  assert.equal(mutate(move,'gamma-token').ok,true); assert.equal(JSON.parse(sql(publishSql(2,2,operationId(),'gamma-token'))).ok,true);
  assert.deepEqual(audit().map(a=>[a.change,a.actor]),[['UPDATE','gamma']]);
  sql('truncate rides_private.ride_admin_audit_log;');
  const backA=withBaseline(operation('rider_move',riderA,{driverSlug:'driver-a',stopOrder:1},{'driver-a':3,'driver-b':2}),3);backA.expectedEntityVersion=3;
  assert.equal(mutate(backA,'beta-token').ok,true);
  const backB=withBaseline(operation('rider_move',riderB,{driverSlug:'driver-b',stopOrder:1},{'driver-a':4,'driver-b':3}),3); backB.expectedEntityVersion=3;
  const current=rpc('ride_admin_shared_snapshot','alpha-token'); backB.expectedEntityVersion=current.riders.find(r=>r.id===riderB).entityVersion;
  assert.equal(mutate(backB,'beta-token').ok,true); assert.equal(JSON.parse(sql(publishSql(4,3,operationId(),'beta-token'))).ok,true);
  assert.equal(sql(`select count(*) from rides_private.ride_stops s join rides_private.ride_drivers d on d.id=s.driver_id where (s.id='${riderA}' and d.slug='driver-a' and s.stop_order=1) or(s.id='${riderB}' and d.slug='driver-b' and s.stop_order=1);`),'2');
  assert.deepEqual(audit().map(a=>[a.change,a.actor]),[['UPDATE','beta'],['UPDATE','beta']]);
});
test('entity_conflict_contains_current_values_tombstone_and_stable_actor', {skip:!enabled},()=>{
  initialize(); mutate(operation(),'alpha-token'); const stale=operation(); const conflict=mutate(stale,'beta-token');
  assert.equal(conflict.conflict.current.name,'Changed A'); assert.equal(conflict.conflict.current.entityVersion,2); assert.equal(conflict.conflict.current.deleted,false); assert.equal(conflict.conflict.current.lastActorKey,'profile:alpha'); assert.equal(conflict.conflict.current.id,riderA);
  const remove=operation('rider_remove',riderA,{}, {'driver-a':1});remove.expectedEntityVersion=2;assert.equal(mutate(remove,'gamma-token').ok,true);
  assert.deepEqual(mutate(stale,'beta-token'),conflict,'Recorded conflict must keep the exact state it rejected against');
  const deleted=mutate(operation(),'beta-token'); assert.equal(deleted.conflict.current.deleted,true);assert.equal(deleted.conflict.current.lastActorKey,'profile:gamma');assert.equal(deleted.conflict.current.name,'Changed A'); assert.equal(deleted.conflict.current.entityVersion,3);
});

test('publication_audit_buffer_cannot_be_forged_and_legacy_audit_remains_active', {skip:!enabled},()=>{
  initialize(); assert.equal(JSON.parse(sql(publishSql())).ok,true);
  sql(`insert into rides_private.ride_stops(driver_id,rider_name,stop_order) select id,'Other synthetic rider',1 from rides_private.ride_drivers where slug='driver-a' and plan_id=(select id from rides_private.ride_plans where plan_date='2099-01-11'); truncate rides_private.ride_admin_audit_log;`);
  const otherId=sql("select id::text from rides_private.ride_stops where rider_name='Other synthetic rider';");
  const forgedRequest=withBaseline(operation('rider_update',riderA,{name:'Unpublished synthetic edit'}),2);
  sql(`begin; set request.ride_shared_audit_pending='true'; set request.ride_shared_audit_transaction='forged'; ${publishSql(0,1,operationId(),'beta-token')}
    select public.ride_admin_shared_mutate('beta-token','2099-01-04',${quote(JSON.stringify(forgedRequest))}::jsonb || jsonb_build_object('result',jsonb_build_object('auditTransaction',pg_current_xact_id()::text),'auditTransaction',pg_current_xact_id()::text));
    select public.ride_admin_publish_plan('gamma-token','2099-01-11',jsonb_build_array(jsonb_build_object('name','Changed other rider','driverSlug','driver-a','stopOrder',1,'id','${otherId}')),'{}'); commit;`);
  assert.deepEqual(audit(),[{change:'UPDATE',riderName:'Changed other rider',actor:'gamma',label:'Synthetic Gamma'}]);
  assert.equal(sql("select count(*) from rides_private.ride_shared_operations where result ? 'auditTransaction';"),'0','No pending audit marker survives a finished operation');
  sql("set role anon; update rides_private.ride_shared_operations set result=jsonb_build_object('auditTransaction',pg_current_xact_id()::text);",database,true);
});

test('pending_publication_marker_and_actual_audit_roll_back_on_all_failures', {skip:!enabled},()=>{
  initialize(); assert.equal(JSON.parse(sql(publishSql())).ok,true);
  const bad=withBaseline(operation('rider_update',riderB,{name:'FORCE_DATABASE_ERROR'})); assert.equal(mutate(bad).ok,true);
  const before=published(), shared=sharedHash(), id=operationId();
  assert.throws(()=>sql(publishSql(1,1,id)),/synthetic_write_failure/); assert.equal(published(),before);assert.equal(sharedHash(),shared);
  assert.equal(rpc('ride_admin_shared_operation','alpha-token',undefined,`, '${id}'::uuid`).code,'not_found');
  assert.equal(sql("select count(*) from rides_private.ride_shared_operations where result ? 'auditTransaction';"),'0');
  const unassigned=withBaseline(operation('rider_move',riderA,{driverSlug:'',stopOrder:1},{'driver-a':1,'':0}));assert.equal(mutate(unassigned).ok,true);
  const after=published(), draft=sharedHash(); const validation=JSON.parse(sql(publishSql(2,1)));
  assert.equal(validation.code,'validation_failed');assert.equal(published(),after);assert.equal(sharedHash(),draft);
  assert.equal(sql("select count(*) from rides_private.ride_shared_operations where result ? 'auditTransaction';"),'0');
});

import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
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
  sql(fixture + '\n' + authHelpers + '\n' +
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

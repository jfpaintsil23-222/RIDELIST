import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

// Opt in only to a named disposable container, never a remote database URL.
const container = process.env.RIDELIST_TEST_CONTAINER;
const enabled = Boolean(container);
if (enabled && !/^ridelist-publish-test-[a-z0-9-]+$/.test(container)) {
  throw new Error('Use a disposable ridelist-publish-test-* container');
}
const schema = readFileSync(new URL('./fixtures/publish-schema.sql', import.meta.url), 'utf8');
const control = readFileSync(new URL('../supabase/admin_ride_control.sql', import.meta.url), 'utf8');
function definition(source, name) {
  const start = source.indexOf(`create or replace function ${name}(`);
  assert.ok(start >= 0, `Missing ${name}`);
  const end = source.indexOf('$$;', start);
  assert.ok(end >= 0);
  return source.slice(start, end + 3);
}
const helpers = definition(control, 'rides_private.ride_parse_time') + '\n' +
  definition(control, 'rides_private.rider_names_summary');
function sql(command) {
  const result = spawnSync('docker', ['exec', '-i', container, 'psql', '-X', '-qAt',
    '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres'], {
    input: command, encoding: 'utf8', timeout: 20000,
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result.stdout.trim();
}
const baseline = `select jsonb_build_object(
 'stops', (select jsonb_agg(to_jsonb(s) order by id) from rides_private.ride_stops s),
 'drivers', (select jsonb_agg(to_jsonb(d) order by id) from rides_private.ride_drivers d),
 'audit', (select coalesce(jsonb_agg(to_jsonb(a)), '[]'::jsonb) from rides_private.test_audit a));`;
function publish(stops, deletions = [], code = 'synthetic-admin') {
  const payload = JSON.stringify(stops).replaceAll("'", "''");
  const deleted = deletions.map(id => `'${id}'`).join(',');
  return `select public.ride_admin_publish_plan('${code}', '2099-01-04', '${payload}'::jsonb, array[${deleted}]::text[]);`;
}
const update = { id: '00000000-0000-0000-0000-000000000100', name: 'Updated rider', driverSlug: 'test-driver', stopOrder: 1 };
const deleted = ['00000000-0000-0000-0000-000000000101'];

for (const file of ['admin_ride_control.sql', 'sunday_reset.sql']) {
  const source = readFileSync(new URL(`../supabase/${file}`, import.meta.url), 'utf8');
  const fn = definition(source, 'public.ride_admin_publish_plan');
  function setup() {
    sql('drop schema if exists rides_private cascade; drop function if exists public.ride_admin_snapshot(text,date);\n' + schema + helpers + fn);
  }
  for (const [name, invalid, expected] of [
    ['missing driver', { name: 'Invalid rider', driverSlug: '' }, { ok: false, error: 'driver_required', riderName: 'Invalid rider', driverSlug: '' }],
    ['unknown driver', { name: 'Invalid rider', driverSlug: 'missing' }, { ok: false, error: 'driver_not_found', riderName: 'Invalid rider', driverSlug: 'missing' }],
    ['missing name', { name: '', driverSlug: 'test-driver' }, { ok: false, error: 'rider_name_required' }],
  ]) {
    test(`${file}: ${name} rolls back earlier update, deletion and audit writes`, { skip: !enabled }, () => {
      setup();
      const before = sql(baseline);
      assert.deepEqual(JSON.parse(sql(publish([update, invalid], deleted))), expected);
      assert.equal(sql(baseline), before, 'Failed publish changed database state');
    });
  }
  test(`${file}: malformed stops cannot commit deletions`, { skip: !enabled }, () => {
    for (const value of [null, {}, 'invalid']) {
      setup(); const before = sql(baseline);
      assert.deepEqual(JSON.parse(sql(publish(value, deleted))), { ok: false, error: 'stops_array_required' });
      assert.equal(sql(baseline), before);
    }
  });
  test(`${file}: successful publish commits updates, inserts, deletion and summary`, { skip: !enabled }, () => {
    setup();
    const result = JSON.parse(sql(publish([update, { name: 'Added rider', driverSlug: 'test-driver', stopOrder: 2 }], deleted)));
    assert.equal(result.ok, true);
    assert.deepEqual(result.stops.map(s => s.rider_name).sort(), ['Added rider', 'Updated rider']);
    assert.equal(sql('select subtitle from rides_private.ride_drivers;'), 'Updated rider and Added rider');
    assert.ok(Number(sql('select count(*) from rides_private.test_audit;')) > 0);
  });
  test(`${file}: unexpected database error aborts writes and remains an error`, { skip: !enabled }, () => {
    setup(); const before = sql(baseline);
    assert.throws(() => sql(publish([update, { name: 'FORCE_DATABASE_ERROR', driverSlug: 'test-driver' }], deleted)), /synthetic_write_failure/);
    assert.equal(sql(baseline), before);
  });
  test(`${file}: wrong admin code cannot change the plan`, { skip: !enabled }, () => {
    setup(); const before = sql(baseline);
    assert.deepEqual(JSON.parse(sql(publish([update], deleted, 'wrong'))), { ok: false, error: 'invalid_admin_code' });
    assert.equal(sql(baseline), before);
  });
}

import assert from "node:assert/strict";
import test from "node:test";
import { runSourceHealthCheck } from "../tools/health-check-core.mjs";
import {
  buildReadOnlyReadinessSql,
  buildSupabaseReadinessSummary,
  REQUIRED_SUPABASE_READINESS_ITEMS,
} from "../tools/supabase-readiness.mjs";

const healthyFiles = {
  "index.html": "<script type=\"module\">import './src/ride-health.js'; ride_app_context ride_admin_snapshot ride_admin_publish_plan ride_admin_publish_plan_dry_run ride_admin_save_draft ride_admin_get_draft ride_admin_clear_draft ride_admin_profile_login ride_admin_set_profile_password ride_admin_update_event_setup ride_admin_start_new_sunday ride_driver_directory ride_driver_route</script>",
  "supabase/sunday_reset.sql": "ride_app_context ride_admin_snapshot ride_admin_publish_plan ride_admin_publish_plan_dry_run ride_admin_save_draft ride_admin_get_draft ride_admin_clear_draft ride_admin_update_event_setup ride_admin_start_new_sunday ride_driver_directory ride_driver_route ride_admin_drafts",
  "supabase/admin_ride_control.sql": "ride_app_context ride_admin_snapshot ride_admin_publish_plan ride_admin_publish_plan_dry_run ride_admin_save_draft ride_admin_get_draft ride_admin_clear_draft ride_admin_update_event_setup ride_admin_start_new_sunday ride_driver_directory ride_driver_route",
  "supabase/admin_security.sql": "ride-app-assets ride_admin_profile_login ride_admin_set_profile_password ride_admin_profiles ride_admin_profile_sessions",
  "supabase/functions/ride-route-timing/index.ts": "GOOGLE_ROUTES_API_KEY",
  "supabase/functions/ride-place-autocomplete/index.ts": "GOOGLE_PLACES_API_KEY",
  "supabase/functions/ride-driver-notifications/index.ts": "ride_admin_driver_push_subscriptions",
  "sw.js": "push notificationclick",
  "manifest.webmanifest": "{\"name\":\"RIDELIST\"}",
  "src/ride-health.js": "export function sourceHealthSummary() {}",
};

test("source health check fails when frontend contains Google keys", async () => {
  const result = await runSourceHealthCheck({
    files: {
      ...healthyFiles,
      "index.html": "const key = 'AIzaSyBadKey';",
    },
  });

  assert.equal(result.ok, false);
  assert.match(result.failures.join("\n"), /Google API key/);
});

test("source health check fails when a required Supabase RPC source is missing", async () => {
  const result = await runSourceHealthCheck({
    files: {
      ...healthyFiles,
      "supabase/sunday_reset.sql": "ride_app_context ride_admin_snapshot ride_admin_publish_plan ride_admin_save_draft ride_admin_get_draft ride_admin_clear_draft ride_admin_update_event_setup ride_admin_start_new_sunday ride_driver_directory ride_driver_route ride_admin_drafts",
      "supabase/admin_ride_control.sql": "ride_app_context ride_admin_snapshot ride_admin_publish_plan ride_admin_save_draft ride_admin_get_draft ride_admin_clear_draft ride_admin_update_event_setup ride_admin_start_new_sunday ride_driver_directory ride_driver_route",
    },
  });

  assert.equal(result.ok, false);
  assert.match(result.failures.join("\n"), /ride_admin_publish_plan_dry_run/);
});

test("source health check passes when required internals are present", async () => {
  const result = await runSourceHealthCheck({ files: healthyFiles });

  assert.equal(result.ok, true, result.failures.join("\n"));
  assert.deepEqual(result.failures, []);
  assert.match(result.summary.join("\n"), /Required RPCs/);
});

test("Supabase readiness summary includes deployment-critical RIDELIST checks", () => {
  const summary = buildSupabaseReadinessSummary({
    projectId: "cpkimtrribpvqxbywfry",
    sourceHealth: {
      ok: true,
      warnings: [],
      failures: [],
    },
  }).join("\n");

  assert.match(summary, /cpkimtrribpvqxbywfry/);
  assert.match(summary, /ride_admin_publish_plan_dry_run/);
  assert.match(summary, /ride_admin_save_draft/);
  assert.match(summary, /ride-route-timing/);
  assert.match(summary, /GOOGLE_ROUTES_API_KEY/);
  assert.match(summary, /Friday/);
  assert.match(summary, /Saturday 11 PM/);
  assert.match(summary, /Sunday 7 AM/);
  assert.equal(REQUIRED_SUPABASE_READINESS_ITEMS.some((item) => item.includes("PeopleData")), false);
});

test("Supabase readiness live SQL is read-only", () => {
  const sql = buildReadOnlyReadinessSql();

  assert.match(sql, /ride_app_settings/);
  assert.match(sql, /ride_stop_count/);
  assert.doesNotMatch(sql, /\b(insert|update|delete|truncate|alter|drop|create)\b/i);
});

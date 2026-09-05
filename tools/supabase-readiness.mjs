#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { runSourceHealthCheck } from "./health-check-core.mjs";

export const DEFAULT_SUPABASE_PROJECT_ID = "cpkimtrribpvqxbywfry";

export const REQUIRED_SUPABASE_READINESS_ITEMS = [
  "ride_app_context returns active plan, destination, and app settings",
  "ride_admin_publish_plan_dry_run validates before ride_admin_publish_plan writes",
  "ride_admin_save_draft, ride_admin_get_draft, and ride_admin_clear_draft protect admin work",
  "ride_admin_profile_login and profile sessions keep Faith/Joojo admin changes attributable",
  "ride_admin_update_event_setup saves homepage/event setup only after admin validation",
  "ride-route-timing Edge Function reads GOOGLE_ROUTES_API_KEY server-side",
  "ride-place-autocomplete Edge Function reads GOOGLE_PLACES_API_KEY server-side",
  "ride-driver-notifications Edge Function uses protected subscription RPCs",
  "ride-app-assets storage upload policies require signed-in ride admins",
];

export const READINESS_WINDOWS = [
  "Friday: source health, pending SQL/RPC/storage checks, and active plan sanity.",
  "Saturday 11 PM: active plan has the expected drivers and published stops.",
  "Sunday 7 AM: driver dashboards and route timing are available.",
  "Sunday 10 AM: late changes, notifications, and final rider counts are checked.",
];

export function buildReadOnlyReadinessSql() {
  return `
with active_setting as (
  select active_plan_date
  from rides_private.ride_app_settings
  where id = 'main'
),
active_plan as (
  select p.id, p.plan_date, p.title, p.service_day, p.destination_label, p.destination_address
  from rides_private.ride_plans p
  join active_setting s on s.active_plan_date = p.plan_date
),
driver_counts as (
  select d.plan_id, count(*)::integer as ride_driver_count
  from rides_private.ride_drivers d
  join active_plan p on p.id = d.plan_id
  group by d.plan_id
),
stop_counts as (
  select d.plan_id, count(s.id)::integer as ride_stop_count
  from rides_private.ride_drivers d
  join active_plan p on p.id = d.plan_id
  left join rides_private.ride_stops s on s.driver_id = d.id
  group by d.plan_id
)
select
  p.plan_date,
  p.title,
  p.service_day,
  p.destination_label,
  coalesce(dc.ride_driver_count, 0) as ride_driver_count,
  coalesce(sc.ride_stop_count, 0) as ride_stop_count
from active_plan p
left join driver_counts dc on dc.plan_id = p.id
left join stop_counts sc on sc.plan_id = p.id;
`.trim();
}

export function buildSupabaseReadinessSummary({
  projectId = DEFAULT_SUPABASE_PROJECT_ID,
  sourceHealth = null,
} = {}) {
  const lines = [
    `Project: ${projectId}`,
    "Required Supabase items:",
    ...REQUIRED_SUPABASE_READINESS_ITEMS.map((item) => `- ${item}`),
    "Recurring check windows:",
    ...READINESS_WINDOWS.map((item) => `- ${item}`),
    "Read-only live SQL: active plan, ride_driver_count, and ride_stop_count.",
  ];

  if (sourceHealth) {
    lines.push(`Source health: ${sourceHealth.ok ? "OK" : "BLOCKED"}`);
    lines.push(`Source warnings: ${sourceHealth.warnings?.length || 0}`);
    lines.push(`Source failures: ${sourceHealth.failures?.length || 0}`);
  }

  return lines;
}

async function main() {
  const sourceHealth = await runSourceHealthCheck({ rootDir: process.cwd() });
  const summary = buildSupabaseReadinessSummary({ sourceHealth });

  console.log("RIDELIST Supabase readiness");
  for (const line of summary) console.log(line);
  console.log("\nRead-only SQL for live sanity check:");
  console.log(buildReadOnlyReadinessSql());

  if (!sourceHealth.ok) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  await main();
}

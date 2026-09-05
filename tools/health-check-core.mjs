import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const REQUIRED_SOURCE_FILES = [
  "index.html",
  "manifest.webmanifest",
  "sw.js",
  "supabase/sunday_reset.sql",
  "supabase/admin_ride_control.sql",
  "supabase/admin_security.sql",
  "supabase/functions/ride-route-timing/index.ts",
  "supabase/functions/ride-place-autocomplete/index.ts",
  "supabase/functions/ride-driver-notifications/index.ts",
];

export const REQUIRED_RPC_NAMES = [
  "ride_app_context",
  "ride_admin_snapshot",
  "ride_admin_publish_plan",
  "ride_admin_publish_plan_dry_run",
  "ride_admin_save_draft",
  "ride_admin_get_draft",
  "ride_admin_clear_draft",
  "ride_admin_profile_login",
  "ride_admin_set_profile_password",
  "ride_admin_update_event_setup",
  "ride_admin_start_new_sunday",
  "ride_driver_directory",
  "ride_driver_route",
];

export const REQUIRED_EDGE_FUNCTION_FILES = [
  "supabase/functions/ride-route-timing/index.ts",
  "supabase/functions/ride-place-autocomplete/index.ts",
  "supabase/functions/ride-driver-notifications/index.ts",
];

export const REQUIRED_SQL_TOKENS = [
  "ride_admin_publish_plan_dry_run",
  "ride_admin_save_draft",
  "ride_admin_get_draft",
  "ride_admin_clear_draft",
  "ride_admin_drafts",
  "ride_admin_profiles",
  "ride_admin_profile_sessions",
];

const FRONTEND_SECRET_PATTERNS = [
  { label: "Google API key", pattern: /AIza[0-9A-Za-z_-]+/ },
  { label: "Google API env name", pattern: /GOOGLE_(?:ROUTES|PLACES)_API_KEY/ },
  { label: "Supabase service-role secret", pattern: /SUPABASE_SERVICE_ROLE_KEY|service_role/ },
];

async function readFilesFromDisk(rootDir) {
  const files = {};
  for (const filePath of REQUIRED_SOURCE_FILES) {
    try {
      files[filePath] = await readFile(join(rootDir, filePath), "utf8");
    } catch (error) {
      files[filePath] = null;
    }
  }

  for (const filePath of ["src/ride-health.js", "src/admin-draft-core.js"]) {
    try {
      files[filePath] = await readFile(join(rootDir, filePath), "utf8");
    } catch (error) {
      files[filePath] = null;
    }
  }

  return files;
}

function fileText(files, filePath) {
  const value = files?.[filePath];
  return typeof value === "string" ? value : "";
}

function hasToken(files, token) {
  return Object.values(files || {}).some((value) => typeof value === "string" && value.includes(token));
}

export async function runSourceHealthCheck({ rootDir = process.cwd(), files = null } = {}) {
  const sourceFiles = files || await readFilesFromDisk(rootDir);
  const failures = [];
  const warnings = [];
  const summary = [];
  const indexHtml = fileText(sourceFiles, "index.html");

  for (const filePath of REQUIRED_SOURCE_FILES) {
    if (typeof sourceFiles[filePath] !== "string") {
      failures.push(`Missing required source file: ${filePath}`);
    }
  }

  for (const { label, pattern } of FRONTEND_SECRET_PATTERNS) {
    if (pattern.test(indexHtml)) {
      failures.push(`${label} must not be present in index.html`);
    }
  }

  for (const rpcName of REQUIRED_RPC_NAMES) {
    if (!hasToken(sourceFiles, rpcName)) {
      failures.push(`Required RPC is missing from source: ${rpcName}`);
    }
  }

  const sqlText = [
    fileText(sourceFiles, "supabase/sunday_reset.sql"),
    fileText(sourceFiles, "supabase/admin_ride_control.sql"),
    fileText(sourceFiles, "supabase/admin_security.sql"),
  ].join("\n");
  for (const token of REQUIRED_SQL_TOKENS) {
    if (!sqlText.includes(token)) {
      failures.push(`Required SQL token is missing: ${token}`);
    }
  }

  if (!fileText(sourceFiles, "supabase/functions/ride-route-timing/index.ts").includes("GOOGLE_ROUTES_API_KEY")) {
    failures.push("Route timing Edge Function must read GOOGLE_ROUTES_API_KEY server-side");
  }
  if (!fileText(sourceFiles, "supabase/functions/ride-place-autocomplete/index.ts").includes("GOOGLE_PLACES_API_KEY")) {
    failures.push("Place autocomplete Edge Function must read GOOGLE_PLACES_API_KEY server-side");
  }
  if (!fileText(sourceFiles, "supabase/functions/ride-driver-notifications/index.ts").includes("ride_admin_driver_push_subscriptions")) {
    failures.push("Driver notification Edge Function must use protected subscription RPCs");
  }

  if (!fileText(sourceFiles, "sw.js").includes("push")) {
    warnings.push("Service worker does not show push handling.");
  }
  if (!fileText(sourceFiles, "manifest.webmanifest").trim()) {
    warnings.push("Manifest is empty.");
  }
  if (!fileText(sourceFiles, "src/ride-health.js")) {
    warnings.push("Health helper module is not extracted yet.");
  }
  if (!fileText(sourceFiles, "src/admin-draft-core.js")) {
    warnings.push("Admin draft helper module is not extracted yet.");
  }

  summary.push(`Required files checked: ${REQUIRED_SOURCE_FILES.length}`);
  summary.push(`Required RPCs checked: ${REQUIRED_RPC_NAMES.length}`);
  summary.push(`Edge Functions checked: ${REQUIRED_EDGE_FUNCTION_FILES.length}`);
  summary.push(`Warnings: ${warnings.length}`);

  return {
    ok: failures.length === 0,
    failures,
    warnings,
    summary,
  };
}

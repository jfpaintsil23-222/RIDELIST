import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import {
  GOOGLE_ROUTE_FIELD_MASK,
  buildGoogleRouteBody,
  buildRouteWarnings,
  orderedStops,
  routeTimingFromGoogleRoute,
  stopsForDriver,
} from "./route-timing-core.js";

type Driver = {
  slug?: string;
  displayName?: string;
  display_name?: string;
};

type Stop = {
  driverSlug?: string;
  stopOrder?: number;
  name?: string;
  phone?: string;
  address?: string;
  pickupTime?: string;
};

type Destination = {
  label?: string;
  address?: string;
};

type Timing = {
  status: string;
  totalMinutes?: number;
  durationText?: string;
  distanceText?: string;
  etaText?: string;
  warning?: string;
  warnings?: ReturnType<typeof buildRouteWarnings>;
};

const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "authorization, apikey, content-type",
  "content-type": "application/json",
};

const DEFAULT_DESTINATION = {
  label: "UH Hilton",
  address: "4450 University Drive, Houston, TX 77204",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: corsHeaders,
  });
}

function readDefaultKey(envName: string) {
  const raw = Deno.env.get(envName);
  if (!raw) return "";
  try {
    return JSON.parse(raw).default || "";
  } catch (_error) {
    return raw;
  }
}

function publishableKey() {
  return readDefaultKey("SUPABASE_PUBLISHABLE_KEYS") || Deno.env.get("SUPABASE_ANON_KEY") || "";
}

async function callRpc(name: string, body: Record<string, unknown>, authorization = "") {
  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const key = publishableKey();
  if (!supabaseUrl || !key) throw new Error("missing_supabase_env");

  const response = await fetch(`${supabaseUrl}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: {
      apikey: key,
      authorization: authorization || `Bearer ${key}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(payload?.message || payload?.error || "supabase_rpc_failed");
  return payload;
}

async function computeGoogleRoute(body: Record<string, unknown>, googleKey: string) {
  const response = await fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-goog-api-key": googleKey,
      "x-goog-fieldmask": GOOGLE_ROUTE_FIELD_MASK,
    },
    body: JSON.stringify(body),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.warn("Google route timing failed", response.status, payload?.error?.message || payload);
    return null;
  }
  return payload?.routes?.[0] || null;
}

async function timingForDriver(driver: Driver, stops: Stop[], destination: Destination, googleKey: string): Promise<Timing> {
  const routeStops = orderedStops(stops);
  let timing: Timing;

  if (!routeStops.length) {
    timing = { status: "empty", warning: "No riders assigned" };
  } else if (!googleKey) {
    timing = { status: "error", warning: "Route time unavailable" };
  } else {
    const routeBody = buildGoogleRouteBody(routeStops, destination);
    if (!routeBody) {
      timing = { status: "error", warning: "Route time unavailable" };
    } else {
      const googleRoute = await computeGoogleRoute(routeBody, googleKey);
      timing = googleRoute
        ? routeTimingFromGoogleRoute({ stops: routeStops as any, googleRoute }) as Timing
        : { status: "error", warning: "Route time unavailable" };
    }
  }

  timing.warnings = buildRouteWarnings(routeStops as any, timing as any);
  return timing;
}

async function timingsForDrivers(drivers: Driver[], stops: Stop[], destination: Destination) {
  const googleKey = Deno.env.get("GOOGLE_ROUTES_API_KEY") || "";
  const destinationForRoute = destination?.address ? destination : DEFAULT_DESTINATION;
  const timings: Record<string, Timing> = {};

  for (const driver of drivers) {
    const slug = driver.slug || "";
    if (!slug) continue;
    const driverStops = stopsForDriver(drivers as any, stops as any, slug) as Stop[];
    timings[slug] = await timingForDriver(driver, driverStops, destinationForRoute, googleKey);
  }

  return timings;
}

async function handleDriver(body: Record<string, unknown>) {
  const driverSlug = String(body.driverSlug || "");
  const accessCode = String(body.accessCode || "");
  const planDate = String(body.planDate || "");
  if (!driverSlug || !accessCode || !planDate) {
    return json({ ok: false, error: "missing_driver_route_fields" }, 400);
  }

  const route = await callRpc("ride_driver_route", {
    p_driver_slug: driverSlug,
    p_access_code: accessCode,
    p_plan_date: planDate,
  });

  if (!route?.ok) {
    return json({ ok: false, error: route?.error || "invalid_code" }, 401);
  }

  const driver = route.driver || { slug: driverSlug };
  const timings = await timingsForDrivers([driver], route.riders || [], route.destination || DEFAULT_DESTINATION);
  return json({ ok: true, timings, warnings: timings[driverSlug]?.warnings || [] });
}

async function handleAdmin(req: Request, body: Record<string, unknown>) {
  const planDate = String(body.planDate || "");
  if (!planDate) return json({ ok: false, error: "missing_plan_date" }, 400);

  const authHeader = req.headers.get("authorization") || "";
  const snapshot = await callRpc("ride_admin_snapshot", {
    p_admin_code: String(body.adminCode || ""),
    p_plan_date: planDate,
  }, authHeader);

  if (!snapshot?.ok) {
    return json({ ok: false, error: snapshot?.error || "invalid_admin_code" }, 401);
  }

  const drivers = Array.isArray(body.drivers) ? body.drivers as Driver[] : snapshot.drivers || [];
  const stops = Array.isArray(body.stops) ? body.stops as Stop[] : snapshot.stops || [];
  const destination = (body.destination || snapshot.destination || DEFAULT_DESTINATION) as Destination;
  const timings = await timingsForDrivers(drivers, stops, destination);
  const warningCount = Object.values(timings).reduce((sum, timing) => sum + Number(timing.warnings?.length || 0), 0);

  return json({ ok: true, timings, warningCount });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

  try {
    const body = await req.json();
    if (body?.mode === "driver") return await handleDriver(body);
    if (body?.mode === "admin") return await handleAdmin(req, body);
    return json({ ok: false, error: "unknown_mode" }, 400);
  } catch (error) {
    console.error(error);
    return json({ ok: false, error: "route_timing_failed" }, 500);
  }
});

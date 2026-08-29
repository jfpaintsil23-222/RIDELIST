import "jsr:@supabase/functions-js/edge-runtime.d.ts";

type PlaceSuggestion = {
  placeId: string;
  text: string;
  mainText: string;
  secondaryText: string;
};

const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "authorization, apikey, content-type",
  "content-type": "application/json",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders });
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

function googlePlacesKey() {
  return Deno.env.get("GOOGLE_PLACES_API_KEY") || Deno.env.get("GOOGLE_ROUTES_API_KEY") || "";
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

async function verifyAdmin(body: Record<string, unknown>, authorization = "") {
  const adminCode = String(body.adminCode || "");
  if (!adminCode) return false;

  const snapshot = await callRpc("ride_admin_snapshot", {
    p_admin_code: adminCode,
    p_plan_date: String(body.planDate || "") || null,
  }, authorization);
  return Boolean(snapshot?.ok);
}

function normalizeSuggestion(raw: Record<string, any>): PlaceSuggestion | null {
  const prediction = raw?.placePrediction;
  const placeId = String(prediction?.placeId || "");
  const text = String(prediction?.text?.text || "");
  if (!placeId || !text) return null;

  return {
    placeId,
    text,
    mainText: String(prediction?.structuredFormat?.mainText?.text || text),
    secondaryText: String(prediction?.structuredFormat?.secondaryText?.text || ""),
  };
}

async function handleSuggest(body: Record<string, unknown>) {
  const googleKey = googlePlacesKey();
  if (!googleKey) return json({ ok: false, error: "places_not_configured" }, 503);

  const input = String(body.input || "").trim();
  const sessionToken = String(body.sessionToken || "").trim();
  if (input.length < 3) return json({ ok: true, suggestions: [] });
  if (!sessionToken) return json({ ok: false, error: "missing_session_token" }, 400);

  const response = await fetch("https://places.googleapis.com/v1/places:autocomplete", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-goog-api-key": googleKey,
      "x-goog-fieldmask": "suggestions.placePrediction.placeId,suggestions.placePrediction.text.text,suggestions.placePrediction.structuredFormat.mainText.text,suggestions.placePrediction.structuredFormat.secondaryText.text",
    },
    body: JSON.stringify({
      input,
      sessionToken,
      includedRegionCodes: ["us"],
      includeQueryPredictions: false,
      locationRestriction: {
        rectangle: {
          low: {
            latitude: 29.2,
            longitude: -96.4,
          },
          high: {
            latitude: 30.95,
            longitude: -94.8,
          },
        },
      },
    }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.warn("Google Places autocomplete failed", response.status, payload?.error?.message || payload);
    return json({ ok: false, error: "places_request_failed" }, response.status >= 500 ? 502 : 400);
  }

  const suggestions = Array.isArray(payload?.suggestions)
    ? payload.suggestions.map(normalizeSuggestion).filter(Boolean).slice(0, 5)
    : [];
  return json({ ok: true, suggestions });
}

async function handleDetails(body: Record<string, unknown>) {
  const googleKey = googlePlacesKey();
  if (!googleKey) return json({ ok: false, error: "places_not_configured" }, 503);

  const placeId = String(body.placeId || "").trim();
  const sessionToken = String(body.sessionToken || "").trim();
  if (!placeId) return json({ ok: false, error: "missing_place_id" }, 400);
  if (!sessionToken) return json({ ok: false, error: "missing_session_token" }, 400);

  const url = new URL(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`);
  url.searchParams.set("sessionToken", sessionToken);

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: {
      "x-goog-api-key": googleKey,
      "x-goog-fieldmask": "id,formattedAddress,location,displayName",
    },
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.warn("Google Places details failed", response.status, payload?.error?.message || payload);
    return json({ ok: false, error: "places_details_failed" }, response.status >= 500 ? 502 : 400);
  }

  return json({
    ok: true,
    place: {
      placeId: payload?.id || placeId,
      formattedAddress: payload?.formattedAddress || "",
      latitude: payload?.location?.latitude ?? null,
      longitude: payload?.location?.longitude ?? null,
      displayName: payload?.displayName?.text || "",
    },
  });
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

  try {
    const body = await request.json().catch(() => ({}));
    const isAdmin = await verifyAdmin(body, request.headers.get("authorization") || "");
    if (!isAdmin) return json({ ok: false, error: "invalid_admin_code" }, 403);

    if (body?.mode === "suggest") return await handleSuggest(body);
    if (body?.mode === "details") return await handleDetails(body);
    return json({ ok: false, error: "unknown_mode" }, 400);
  } catch (error) {
    console.error(error);
    return json({ ok: false, error: "place_autocomplete_failed" }, 500);
  }
});

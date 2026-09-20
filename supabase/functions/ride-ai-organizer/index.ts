import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import {
  AI_ORGANIZER_SCHEMA,
  buildOrganizerPrompt,
  normalizeOrganizerResult,
  parseOpenAiJson,
  safeDriversForAi,
  safeStopsForAi,
} from "./organizer-core.js";

const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "authorization, apikey, content-type",
  "content-type": "application/json",
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

async function verifyAdmin(req: Request, body: Record<string, unknown>) {
  const snapshot = await callRpc("ride_admin_snapshot", {
    p_admin_code: String(body.adminCode || ""),
    p_plan_date: String(body.planDate || "") || null,
  }, req.headers.get("authorization") || "");
  if (!snapshot?.ok) return null;
  return snapshot;
}

async function callOpenAi(prompt: string) {
  const openAiKey = Deno.env.get("OPENAI_API_KEY") || "";
  if (!openAiKey) return { ok: false, error: "ai_not_configured", status: 503 };

  const model = Deno.env.get("OPENAI_MODEL") || "gpt-6-astra";
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "authorization": `Bearer ${openAiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      input: [
        {
          role: "system",
          content: "You organize church ride pickup lists into reviewable route drafts. Reply only through the provided JSON schema.",
        },
        {
          role: "user",
          content: prompt,
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "ridelist_ai_route_plan",
          strict: true,
          schema: AI_ORGANIZER_SCHEMA,
        },
      },
    }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.warn("OpenAI organizer failed", response.status, payload?.error?.message || payload);
    return { ok: false, error: "ai_request_failed", status: response.status >= 500 ? 502 : 400 };
  }

  return { ok: true, payload };
}

async function handleOrganize(req: Request, body: Record<string, unknown>) {
  const planDate = String(body.planDate || "");
  const prompt = String(body.prompt || "").trim();
  if (!planDate) return json({ ok: false, error: "missing_plan_date" }, 400);
  if (!prompt) return json({ ok: false, error: "missing_prompt" }, 400);

  const snapshot = await verifyAdmin(req, body);
  if (!snapshot?.ok) return json({ ok: false, error: "invalid_admin_code" }, 403);

  const drivers = safeDriversForAi(Array.isArray(body.drivers) ? body.drivers : snapshot.drivers || []);
  const stops = safeStopsForAi(Array.isArray(body.stops) ? body.stops : snapshot.stops || []);
  const destination = body.destination || snapshot.destination || {};
  const organizerPrompt = buildOrganizerPrompt({
    adminPrompt: prompt,
    destination,
    drivers,
    stops,
  });

  const ai = await callOpenAi(organizerPrompt);
  if (!ai.ok) return json({ ok: false, error: ai.error }, ai.status || 500);

  const rawResult = parseOpenAiJson(ai.payload);
  const result = normalizeOrganizerResult(rawResult, { drivers, stops });
  return json(result);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

  try {
    const body = await req.json().catch(() => ({}));
    return await handleOrganize(req, body);
  } catch (error) {
    console.error(error);
    return json({ ok: false, error: "ai_organizer_failed" }, 500);
  }
});

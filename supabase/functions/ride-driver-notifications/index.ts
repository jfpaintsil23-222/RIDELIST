import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import webpush from "npm:web-push@3.6.7";
import {
  buildRouteUpdatePayload,
  buildReturnReleasePayload,
  dispatchReturnJobs,
  isExpiredSubscriptionStatus,
  normalizeDriverSlugs,
  summarizeSendResults,
} from "./notification-core.js";

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

function configureWebPush() {
  const publicKey = Deno.env.get("VAPID_PUBLIC_KEY") || "";
  const privateKey = Deno.env.get("VAPID_PRIVATE_KEY") || "";
  const subject = Deno.env.get("VAPID_SUBJECT") || "mailto:admin@example.com";
  if (!publicKey || !privateKey) return { ok: false, publicKey };
  webpush.setVapidDetails(subject, publicKey, privateKey);
  return { ok: true, publicKey };
}

async function handlePublicKey() {
  const publicKey = Deno.env.get("VAPID_PUBLIC_KEY") || "";
  if (!publicKey) return json({ ok: false, error: "push_not_configured" }, 503);
  return json({ ok: true, publicKey });
}

async function handleSend(body: Record<string, unknown>, authorization = "") {
  const config = configureWebPush();
  if (!config.ok) return json({ ok: false, error: "push_not_configured" }, 503);

  const adminCode = String(body.adminCode || "");
  const planDate = String(body.planDate || "");
  const driverSlugs = normalizeDriverSlugs(Array.isArray(body.driverSlugs) ? body.driverSlugs : []);
  const message = String(body.message || "Your pickup list was updated. Open your route review.");
  if (!adminCode || !planDate || !driverSlugs.length) return json({ ok: false, error: "missing_notification_fields" }, 400);

  const subscriptions = await callRpc("ride_admin_driver_push_subscriptions", {
    p_admin_code: adminCode,
    p_plan_date: planDate,
    p_driver_slugs: driverSlugs,
  }, authorization);

  if (!subscriptions?.ok) return json(subscriptions, 403);

  const payload = JSON.stringify(buildRouteUpdatePayload({ message, url: "./" }));
  const results = [];

  for (const item of subscriptions.subscriptions || []) {
    try {
      await webpush.sendNotification(item.subscription, payload);
      results.push({ driverSlug: item.driverSlug, endpoint: item.endpoint, ok: true });
    } catch (error) {
      const pushError = error as { status?: number; statusCode?: number; message?: string };
      const statusCode = Number(pushError?.statusCode || pushError?.status || 0);
      const expired = isExpiredSubscriptionStatus(statusCode);
      results.push({
        driverSlug: item.driverSlug,
        endpoint: item.endpoint,
        ok: false,
        error: pushError?.message || "push_failed",
      });
      if (expired) {
        await callRpc("ride_admin_update_push_subscription_status", {
          p_admin_code: adminCode,
          p_endpoint: item.endpoint,
          p_active: false,
          p_last_error: pushError?.message || `push_failed_${statusCode}`,
        }, authorization);
      }
    }
  }

  return json({ ok: true, ...summarizeSendResults(results), results });
}


async function handleReturnRelease(body: Record<string, unknown>, authorization = "") {
  const adminCode = String(body.adminCode || "");
  const planDate = String(body.planDate || "");
  const releaseId = String(body.releaseId || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(planDate) || !/^[0-9a-f-]{36}$/i.test(releaseId)) return json({ok:false,error:"invalid_return_request"},400);
  // Authorize before touching the provider; a missing sender setup leaves jobs pending.
  const state = await callRpc("ride_admin_return_state", {p_admin_code:adminCode,p_plan_date:planDate}, authorization);
  if (!state?.ok) return json({ok:false,error:"invalid_admin_code"},403);
  if (state.releaseId !== releaseId || state.phase !== "return") return json({ok:false,error:"release_not_found"},409);
  if (!configureWebPush().ok) return json({ok:false,error:"push_not_configured"},503);
  const payload = JSON.stringify(buildReturnReleasePayload(releaseId));
  const summary = {sent:0,failed:0,unknown:0,noDevice:0};
  for (let index=0;index<100;index++) {
    const claim = await callRpc("ride_admin_claim_return_notifications",{p_admin_code:adminCode,p_plan_date:planDate,p_release_id:releaseId},authorization);
    if (!claim?.ok) return json(claim,403);
    if (!claim.jobs?.length) break;
    const result = await dispatchReturnJobs(claim.jobs,{
      send: async (job: {subscription: Record<string,unknown>}) => { await webpush.sendNotification(job.subscription, payload); },
      finish: async (job: {id:string,leaseToken:string},status:string,error:string) => {
        const saved = await callRpc("ride_admin_finish_return_notification",{p_admin_code:adminCode,p_job_id:job.id,p_lease_token:job.leaseToken,p_status:status,p_error:error},authorization);
        if (!saved?.ok) throw Error("notification_result_not_saved");
      },
    });
    summary.sent+=result.sent;summary.failed+=result.failed;summary.unknown+=result.unknown;summary.noDevice+=result.noDevice;
    if(result.failed) break; // Do not immediately reclaim the same failed job in this send attempt.
  }
  return json({ok:true,...summary});
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

  try {
    const body = await request.json().catch(() => ({}));
    if (body?.mode === "public-key") return await handlePublicKey();
    if (body?.mode === "send-return-release") return await handleReturnRelease(body, request.headers.get("authorization") || "");
    if (body?.mode === "send-route-update") return await handleSend(body, request.headers.get("authorization") || "");
    return json({ ok: false, error: "unknown_mode" }, 400);
  } catch (error) {
    console.error(error);
    return json({ ok: false, error: "notification_function_failed" }, 500);
  }
});

# Admin Driver Push Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build version 1 admin-to-driver route update push notifications for RIDELIST.

**Architecture:** Drivers opt in from the unlocked driver route screen. The browser registers a root service worker, requests Web Push permission, and stores the subscription through an admin/driver-code-protected Supabase RPC. Admins publish route changes first, then review affected drivers and send through a Supabase Edge Function that holds private push secrets server-side.

**Tech Stack:** Static `index.html` app, root `sw.js`, Web Push API, Supabase Postgres RPCs, Supabase Edge Functions with Deno, `npm:web-push@3.6.7`, Node test runner.

## Global Constraints

- Admin-to-driver notifications only.
- Drivers opt in from their driver route experience.
- Admins review recipients and message text before sending.
- Notifications are for route updates after admin saves changes.
- Keep the UI mobile-first, black/white, and calm.
- Do not add chat, rider notifications, church-wide announcements, or automatic alerts while admins are still editing.
- No service-role key or push private key in `index.html`.
- The frontend may use a public VAPID key to subscribe, but never stores private push secrets.
- Tapping a notification must not bypass driver route access.
- Do not deploy live Supabase SQL, Edge Function code, or secrets until the user approves deployment.

---

## File Structure

- Modify `index.html`: driver alert UI, service worker registration, subscription save RPC, affected-driver tracking, admin notify review/send UI.
- Create `sw.js`: root service worker for push display and notification click handling.
- Leave `manifest.webmanifest` unchanged unless verification shows a concrete installability issue; the current manifest already has `display`, `scope`, `start_url`, and app icons.
- Modify `supabase/admin_ride_control.sql`: add private subscription table and protected RPCs.
- Create `supabase/functions/ride-driver-notifications/index.ts`: Edge Function for public VAPID key lookup and admin send.
- Create `supabase/functions/ride-driver-notifications/deno.json`: Deno compiler/import config.
- Create `supabase/functions/ride-driver-notifications/notification-core.js`: pure helpers for payloads, slug normalization, and send result summaries.
- Modify `tests/admin_ui.test.mjs`: UI/static tests for driver opt-in, admin review, no secrets, service worker registration, SQL source.
- Create `tests/notification_core.test.mjs`: pure helper tests for notification payloads and partial send handling.

---

### Task 1: Service Worker And Notification Helpers

**Files:**
- Create: `sw.js`
- Create: `supabase/functions/ride-driver-notifications/notification-core.js`
- Create: `tests/notification_core.test.mjs`
- Modify: `tests/admin_ui.test.mjs`

**Interfaces:**
- Produces: `buildRouteUpdatePayload({ message, url })`, `normalizeDriverSlugs(slugs)`, `isExpiredSubscriptionStatus(status)`, `summarizeSendResults(results)`.
- Produces: service worker handlers for `push` and `notificationclick`.
- Consumes: no app state yet.

- [ ] **Step 1: Write failing notification helper tests**

Add `tests/notification_core.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRouteUpdatePayload,
  isExpiredSubscriptionStatus,
  normalizeDriverSlugs,
  summarizeSendResults,
} from "../supabase/functions/ride-driver-notifications/notification-core.js";

test("normalizeDriverSlugs lowercases trims and deduplicates drivers", () => {
  assert.deepEqual(
    normalizeDriverSlugs([" Joojo ", "dq", "JOOJO", "", null, "john-mark"]),
    ["joojo", "dq", "john-mark"],
  );
});

test("buildRouteUpdatePayload keeps the first route message plain", () => {
  assert.deepEqual(
    buildRouteUpdatePayload({ message: "Your pickup list was updated. Open your route review.", url: "./?route=review" }),
    {
      title: "RIDELIST",
      body: "Your pickup list was updated. Open your route review.",
      url: "./?route=review",
      tag: "ridelist-route-update",
    },
  );
});

test("expired subscription status only flags gone endpoints", () => {
  assert.equal(isExpiredSubscriptionStatus(404), true);
  assert.equal(isExpiredSubscriptionStatus(410), true);
  assert.equal(isExpiredSubscriptionStatus(201), false);
  assert.equal(isExpiredSubscriptionStatus(500), false);
});

test("summarizeSendResults returns partial success counts", () => {
  assert.deepEqual(
    summarizeSendResults([
      { driverSlug: "joojo", ok: true },
      { driverSlug: "dq", ok: false, error: "Gone" },
      { driverSlug: "dq", ok: true },
    ]),
    { sent: 2, failed: 1, driverSlugs: ["joojo", "dq"] },
  );
});
```

- [ ] **Step 2: Write failing service worker static test**

Append to `tests/admin_ui.test.mjs`:

```js
test("app includes a root push service worker", async () => {
  const sw = await readFile(new URL("../sw.js", import.meta.url), "utf8");

  assert.match(sw, /addEventListener\("push"/);
  assert.match(sw, /showNotification/);
  assert.match(sw, /addEventListener\("notificationclick"/);
  assert.match(sw, /clients\.openWindow/);
  assert.match(sw, /ridelist-route-update/);
});
```

- [ ] **Step 3: Run tests to verify failure**

Run:

```bash
node --test tests/notification_core.test.mjs tests/admin_ui.test.mjs
```

Expected: FAIL because `notification-core.js` and `sw.js` do not exist yet.

- [ ] **Step 4: Implement notification helper module**

Create `supabase/functions/ride-driver-notifications/notification-core.js`:

```js
export function normalizeDriverSlugs(slugs = []) {
  const seen = new Set();
  return slugs
    .map((slug) => String(slug || "").trim().toLowerCase())
    .filter((slug) => {
      if (!slug || seen.has(slug)) return false;
      seen.add(slug);
      return true;
    });
}

export function buildRouteUpdatePayload({ message = "", url = "./" } = {}) {
  return {
    title: "RIDELIST",
    body: String(message || "Your pickup list was updated. Open your route review.").trim(),
    url: String(url || "./"),
    tag: "ridelist-route-update",
  };
}

export function isExpiredSubscriptionStatus(status) {
  return Number(status) === 404 || Number(status) === 410;
}

export function summarizeSendResults(results = []) {
  const driverSlugs = normalizeDriverSlugs(results.map((result) => result.driverSlug));
  return {
    sent: results.filter((result) => result.ok).length,
    failed: results.filter((result) => !result.ok).length,
    driverSlugs,
  };
}
```

- [ ] **Step 5: Implement root service worker**

Create `sw.js`:

```js
self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (_error) {
    payload = {};
  }

  const title = payload.title || "RIDELIST";
  const options = {
    body: payload.body || "Your pickup list was updated. Open your route review.",
    icon: "assets/app-icon-192.png",
    badge: "assets/app-icon-192.png",
    tag: payload.tag || "ridelist-route-update",
    data: {
      url: payload.url || "./",
    },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = new URL(event.notification.data?.url || "./", self.registration.scope).href;

  event.waitUntil((async () => {
    const windows = await clients.matchAll({ type: "window", includeUncontrolled: true });
    const existing = windows.find((client) => new URL(client.url).origin === new URL(targetUrl).origin);
    if (existing) {
      await existing.focus();
      if ("navigate" in existing) return existing.navigate(targetUrl);
      return existing;
    }
    return clients.openWindow(targetUrl);
  })());
});
```

- [ ] **Step 6: Run tests to verify pass**

Run:

```bash
node --test tests/notification_core.test.mjs tests/admin_ui.test.mjs
```

Expected: PASS for the new helper/service worker tests.

- [ ] **Step 7: Commit**

```bash
git add sw.js supabase/functions/ride-driver-notifications/notification-core.js tests/notification_core.test.mjs tests/admin_ui.test.mjs
git commit -m "Add push notification service worker helpers"
```

---

### Task 2: Supabase Subscription SQL Source

**Files:**
- Modify: `supabase/admin_ride_control.sql`
- Modify: `tests/admin_ui.test.mjs`

**Interfaces:**
- Consumes: existing `rides_private.hash_driver_code`, `rides_private.is_ride_admin_code`, `rides_private.ride_plans`, `rides_private.ride_drivers`.
- Produces: `public.ride_driver_save_push_subscription(text, text, date, jsonb, text)`.
- Produces: `public.ride_admin_driver_push_subscriptions(text, date, text[])`.
- Produces: `public.ride_admin_update_push_subscription_status(text, text, boolean, text)`.

- [ ] **Step 1: Write failing SQL source test**

Append to `tests/admin_ui.test.mjs`:

```js
test("SQL source protects driver push subscriptions", async () => {
  const sql = await readFile(new URL("../supabase/admin_ride_control.sql", import.meta.url), "utf8");

  assert.match(sql, /create table if not exists rides_private\.ride_driver_push_subscriptions/);
  assert.match(sql, /alter table rides_private\.ride_driver_push_subscriptions enable row level security/);
  assert.match(sql, /create or replace function public\.ride_driver_save_push_subscription/);
  assert.match(sql, /create or replace function public\.ride_admin_driver_push_subscriptions/);
  assert.match(sql, /create or replace function public\.ride_admin_update_push_subscription_status/);
  assert.match(sql, /rides_private\.is_ride_admin_code\(p_admin_code\)/);
  assert.match(sql, /rides_private\.hash_driver_code\(p_access_code\)/);
  assert.match(sql, /grant execute on function public\.ride_driver_save_push_subscription/);
});
```

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
node --test tests/admin_ui.test.mjs
```

Expected: FAIL because the SQL source does not define push subscriptions yet.

- [ ] **Step 3: Add private subscription table**

Add near the other `rides_private` tables in `supabase/admin_ride_control.sql`:

```sql
create table if not exists rides_private.ride_driver_push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  plan_date date not null,
  driver_slug text not null,
  endpoint text not null unique,
  subscription jsonb not null,
  user_agent text not null default '',
  active boolean not null default true,
  last_error text not null default '',
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now()
);

alter table rides_private.ride_driver_push_subscriptions enable row level security;
alter table rides_private.ride_driver_push_subscriptions force row level security;

create index if not exists ride_driver_push_subscriptions_driver_idx
on rides_private.ride_driver_push_subscriptions (plan_date, driver_slug)
where active;
```

- [ ] **Step 4: Add driver subscription save RPC**

Add this function after driver/admin helper functions:

```sql
create or replace function public.ride_driver_save_push_subscription(
  p_driver_slug text,
  p_access_code text,
  p_plan_date date default null,
  p_subscription jsonb default '{}'::jsonb,
  p_user_agent text default ''
)
returns jsonb
language plpgsql
volatile
security definer
set search_path to ''
as $$
declare
  v_plan_date date := coalesce(p_plan_date, date '2026-08-09');
  v_plan_id uuid;
  v_driver record;
  v_endpoint text := btrim(coalesce(p_subscription->>'endpoint', ''));
begin
  if v_endpoint = '' then
    return jsonb_build_object('ok', false, 'error', 'missing_push_endpoint');
  end if;

  select p.id
  into v_plan_id
  from rides_private.ride_plans p
  where p.plan_date = v_plan_date
  limit 1;

  select d.id, d.slug, d.access_code_hash
  into v_driver
  from rides_private.ride_drivers d
  where d.plan_id = v_plan_id
    and d.slug = lower(btrim(coalesce(p_driver_slug, '')))
  limit 1;

  if v_driver.id is null or v_driver.access_code_hash <> rides_private.hash_driver_code(p_access_code) then
    return jsonb_build_object('ok', false, 'error', 'invalid_code');
  end if;

  insert into rides_private.ride_driver_push_subscriptions (
    plan_date,
    driver_slug,
    endpoint,
    subscription,
    user_agent,
    active,
    last_error,
    updated_at
  )
  values (
    v_plan_date,
    v_driver.slug,
    v_endpoint,
    p_subscription,
    btrim(coalesce(p_user_agent, '')),
    true,
    '',
    now()
  )
  on conflict (endpoint) do update
  set plan_date = excluded.plan_date,
      driver_slug = excluded.driver_slug,
      subscription = excluded.subscription,
      user_agent = excluded.user_agent,
      active = true,
      last_error = '',
      updated_at = now();

  return jsonb_build_object('ok', true, 'driverSlug', v_driver.slug);
end;
$$;
```

- [ ] **Step 5: Add admin recipient and status RPCs**

Add:

```sql
create or replace function public.ride_admin_driver_push_subscriptions(
  p_admin_code text,
  p_plan_date date default null,
  p_driver_slugs text[] default '{}'::text[]
)
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $$
declare
  v_plan_date date := coalesce(p_plan_date, date '2026-08-09');
begin
  if not rides_private.is_ride_admin_code(p_admin_code) then
    return jsonb_build_object('ok', false, 'error', 'invalid_admin_code');
  end if;

  return jsonb_build_object(
    'ok', true,
    'subscriptions', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', s.id::text,
          'driverSlug', s.driver_slug,
          'endpoint', s.endpoint,
          'subscription', s.subscription
        )
        order by s.driver_slug, s.updated_at desc
      )
      from rides_private.ride_driver_push_subscriptions s
      where s.plan_date = v_plan_date
        and s.active
        and (
          coalesce(array_length(p_driver_slugs, 1), 0) = 0
          or s.driver_slug = any(p_driver_slugs)
        )
    ), '[]'::jsonb)
  );
end;
$$;

create or replace function public.ride_admin_update_push_subscription_status(
  p_admin_code text,
  p_endpoint text,
  p_active boolean,
  p_last_error text default ''
)
returns jsonb
language plpgsql
volatile
security definer
set search_path to ''
as $$
begin
  if not rides_private.is_ride_admin_code(p_admin_code) then
    return jsonb_build_object('ok', false, 'error', 'invalid_admin_code');
  end if;

  update rides_private.ride_driver_push_subscriptions s
  set active = coalesce(p_active, s.active),
      last_error = btrim(coalesce(p_last_error, '')),
      updated_at = now()
  where s.endpoint = btrim(coalesce(p_endpoint, ''));

  return jsonb_build_object('ok', true);
end;
$$;
```

- [ ] **Step 6: Grant RPC execute**

Add:

```sql
grant execute on function public.ride_driver_save_push_subscription(text, text, date, jsonb, text) to anon, authenticated;
grant execute on function public.ride_admin_driver_push_subscriptions(text, date, text[]) to anon, authenticated;
grant execute on function public.ride_admin_update_push_subscription_status(text, text, boolean, text) to anon, authenticated;
```

- [ ] **Step 7: Run test to verify pass**

Run:

```bash
node --test tests/admin_ui.test.mjs
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add supabase/admin_ride_control.sql tests/admin_ui.test.mjs
git commit -m "Add push subscription SQL source"
```

---

### Task 3: Supabase Edge Function Source

**Files:**
- Create: `supabase/functions/ride-driver-notifications/index.ts`
- Create: `supabase/functions/ride-driver-notifications/deno.json`
- Modify: `tests/admin_ui.test.mjs`

**Interfaces:**
- Consumes: `normalizeDriverSlugs`, `buildRouteUpdatePayload`, `isExpiredSubscriptionStatus`, `summarizeSendResults`.
- Consumes RPCs: `ride_admin_driver_push_subscriptions`, `ride_admin_update_push_subscription_status`.
- Produces Edge Function modes: `public-key`, `send-route-update`.

- [ ] **Step 1: Write failing Edge Function source test**

Append to `tests/admin_ui.test.mjs`:

```js
test("driver notification Edge Function keeps push secrets server-side", async () => {
  const fn = await readFile(new URL("../supabase/functions/ride-driver-notifications/index.ts", import.meta.url), "utf8");

  assert.match(fn, /Deno\.env\.get\("VAPID_PUBLIC_KEY"\)/);
  assert.match(fn, /Deno\.env\.get\("VAPID_PRIVATE_KEY"\)/);
  assert.match(fn, /Deno\.env\.get\("VAPID_SUBJECT"\)/);
  assert.match(fn, /ride_admin_driver_push_subscriptions/);
  assert.match(fn, /ride_admin_update_push_subscription_status/);
  assert.match(fn, /sendNotification/);
  assert.doesNotMatch(fn, /GOOGLE_ROUTES_API_KEY/);
});
```

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
node --test tests/admin_ui.test.mjs
```

Expected: FAIL because the function source does not exist yet.

- [ ] **Step 3: Add Deno config**

Create `supabase/functions/ride-driver-notifications/deno.json`:

```json
{
  "compilerOptions": {
    "allowJs": true,
    "lib": ["deno.window", "dom", "dom.iterable"],
    "strict": true
  },
  "imports": {}
}
```

- [ ] **Step 4: Implement Edge Function**

Create `supabase/functions/ride-driver-notifications/index.ts`:

```ts
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import webpush from "npm:web-push@3.6.7";
import {
  buildRouteUpdatePayload,
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
      const statusCode = Number(error?.statusCode || error?.status || 0);
      const expired = isExpiredSubscriptionStatus(statusCode);
      results.push({ driverSlug: item.driverSlug, endpoint: item.endpoint, ok: false, error: error?.message || "push_failed" });
      if (expired) {
        await callRpc("ride_admin_update_push_subscription_status", {
          p_admin_code: adminCode,
          p_endpoint: item.endpoint,
          p_active: false,
          p_last_error: error?.message || `push_failed_${statusCode}`,
        }, authorization);
      }
    }
  }

  return json({ ok: true, ...summarizeSendResults(results), results });
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

  try {
    const body = await request.json().catch(() => ({}));
    if (body?.mode === "public-key") return await handlePublicKey();
    if (body?.mode === "send-route-update") return await handleSend(body, request.headers.get("authorization") || "");
    return json({ ok: false, error: "unknown_mode" }, 400);
  } catch (error) {
    console.error(error);
    return json({ ok: false, error: "notification_function_failed" }, 500);
  }
});
```

- [ ] **Step 5: Run tests to verify pass**

Run:

```bash
node --test tests/admin_ui.test.mjs tests/notification_core.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/ride-driver-notifications tests/admin_ui.test.mjs
git commit -m "Add driver notification Edge Function source"
```

---

### Task 4: Driver Route Alert Opt-In UI

**Files:**
- Modify: `index.html`
- Modify: `tests/admin_ui.test.mjs`

**Interfaces:**
- Consumes RPC: `ride_driver_save_push_subscription`.
- Consumes Edge Function mode: `public-key`.
- Produces functions: `driverRouteAlertsHtml()`, `refreshDriverPushStatus()`, `enableDriverRouteAlerts()`, `pushRequest(mode, payload)`, `urlBase64ToUint8Array(value)`.
- Produces state fields: `driverAccessCode`, `pushStatus`, `pushMessage`, `pushPublicKey`.

- [ ] **Step 1: Write failing driver UI tests**

Append to `tests/admin_ui.test.mjs`:

```js
test("driver dashboard exposes simple route alert opt-in states", async () => {
  const app = await loadApp();
  app.state.route = {
    driver: { slug: "john-mark", displayName: "John Mark" },
    riders: [],
    destination: { label: "UH Hilton", address: "4450 University Dr" },
  };

  app.state.pushStatus = "available";
  let html = app.driverHomeView();
  assert.match(html, /Route alerts/);
  assert.match(html, /Get notified if admin changes your pickups/);
  assert.match(html, /data-action="enableRouteAlerts"/);

  app.state.pushStatus = "enabled";
  html = app.driverHomeView();
  assert.match(html, /Route alerts on/);
  assert.match(html, /This phone will get updates for John Mark&#39;s route/);

  app.state.pushStatus = "unsupported";
  html = app.driverHomeView();
  assert.match(html, /Add RIDELIST to your Home Screen/i);
});

test("driver push subscription uses Supabase without private keys", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");

  assert.match(html, /navigator\.serviceWorker\.register\("\.\/sw\.js"\)/);
  assert.match(html, /PushManager/);
  assert.match(html, /ride_driver_save_push_subscription/);
  assert.match(html, /ride-driver-notifications/);
  assert.doesNotMatch(html, /VAPID_PRIVATE_KEY|service_role|SUPABASE_SERVICE_ROLE_KEY/);
});
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
node --test tests/admin_ui.test.mjs
```

Expected: FAIL because driver alert UI/functions are missing.

- [ ] **Step 3: Add state fields**

In `state`, add:

```js
driverAccessCode: "",
pushStatus: "idle",
pushMessage: "",
pushPublicKey: "",
```

- [ ] **Step 4: Add push request and browser helpers**

Add near `secureRouteTimingRequest`:

```js
async function pushRequest(mode, payload = {}) {
  const headers = {
    "apikey": SUPABASE_KEY,
    "content-type": "application/json",
  };
  if (mode === "send-route-update" && state.adminSession?.access_token) {
    headers.authorization = "Bearer " + state.adminSession.access_token;
  }

  const response = await fetch(SUPABASE_URL + "/functions/v1/ride-driver-notifications", {
    method: "POST",
    headers,
    body: JSON.stringify({ mode, ...payload }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error || "push_request_failed");
  return data;
}

function pushSupported() {
  return Boolean(
    window.isSecureContext &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

function urlBase64ToUint8Array(value) {
  const padding = "=".repeat((4 - value.length % 4) % 4);
  const base64 = (value + padding).replaceAll("-", "+").replaceAll("_", "/");
  const raw = atob(base64);
  return Uint8Array.from([...raw].map((char) => char.charCodeAt(0)));
}
```

- [ ] **Step 5: Add service worker registration and status refresh**

Add:

```js
async function pushServiceWorkerRegistration() {
  if (!pushSupported()) return null;
  return navigator.serviceWorker.register("./sw.js");
}

async function loadPushPublicKey() {
  if (state.pushPublicKey) return state.pushPublicKey;
  const data = await pushRequest("public-key");
  if (!data?.ok || !data.publicKey) throw new Error("push_not_configured");
  state.pushPublicKey = data.publicKey;
  return state.pushPublicKey;
}

async function refreshDriverPushStatus() {
  if (!pushSupported()) {
    state.pushStatus = "unsupported";
    state.pushMessage = "Add RIDELIST to your Home Screen on iPhone, or use a browser that supports alerts.";
    render();
    return;
  }

  if (Notification.permission === "denied") {
    state.pushStatus = "denied";
    state.pushMessage = "Alerts are off for this browser.";
    render();
    return;
  }

  try {
    const registration = await pushServiceWorkerRegistration();
    const subscription = await registration.pushManager.getSubscription();
    state.pushStatus = subscription ? "enabled" : "available";
    state.pushMessage = "";
  } catch (error) {
    state.pushStatus = "error";
    state.pushMessage = "Route alerts are not ready on this browser.";
    console.warn(error);
  }
  render();
}
```

- [ ] **Step 6: Add subscription action**

Add:

```js
async function enableDriverRouteAlerts() {
  if (!state.route?.driver?.slug || !state.driverAccessCode) return;
  state.pushStatus = "loading";
  state.pushMessage = "";
  render();

  try {
    if (!pushSupported()) throw new Error("push_unsupported");
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      state.pushStatus = permission === "denied" ? "denied" : "available";
      state.pushMessage = permission === "denied" ? "Alerts are off for this browser." : "Alerts were not turned on.";
      render();
      return;
    }

    const registration = await pushServiceWorkerRegistration();
    const publicKey = await loadPushPublicKey();
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });

    const saved = await rpc("ride_driver_save_push_subscription", {
      p_driver_slug: state.route.driver.slug,
      p_access_code: state.driverAccessCode,
      p_plan_date: activePlanDate(),
      p_subscription: subscription.toJSON(),
      p_user_agent: navigator.userAgent || "",
    });

    if (!saved?.ok) throw new Error(saved?.error || "push_save_failed");
    state.pushStatus = "enabled";
    state.pushMessage = "";
  } catch (error) {
    state.pushStatus = error.message === "push_unsupported" ? "unsupported" : "error";
    state.pushMessage = state.pushStatus === "unsupported"
      ? "Add RIDELIST to your Home Screen on iPhone, or use a browser that supports alerts."
      : "Could not turn on route alerts. Try again later.";
    console.warn(error);
  }
  render();
}
```

- [ ] **Step 7: Add driver alert card renderer**

Add before `driverHomeView`:

```js
function driverRouteAlertsHtml() {
  const driverName = state.route?.driver?.displayName || "this driver";
  if (state.pushStatus === "enabled") {
    return `
      <section class="driver-alert-card enabled" aria-label="Route alerts">
        <span class="driver-alert-icon">${iconSvg("bell")}</span>
        <span>
          <strong>Route alerts on</strong>
          <small>This phone will get updates for ${escapeHtml(driverName)}&#39;s route.</small>
        </span>
      </section>`;
  }

  const unsupported = state.pushStatus === "unsupported" || state.pushStatus === "denied";
  return `
    <section class="driver-alert-card" aria-label="Route alerts">
      <span class="driver-alert-icon">${iconSvg("bell")}</span>
      <span>
        <strong>Route alerts</strong>
        <small>${escapeHtml(state.pushMessage || "Get notified if admin changes your pickups.")}</small>
      </span>
      ${unsupported ? "" : `<button class="secondary-action compact" type="button" data-action="enableRouteAlerts">${state.pushStatus === "loading" ? "Turning on..." : "Turn on"}</button>`}
    </section>`;
}
```

- [ ] **Step 8: Place card in `driverHomeView`**

Insert after the route overview card:

```js
${driverRouteAlertsHtml()}
```

- [ ] **Step 9: Store driver passcode in memory and refresh status**

In `submitCode`, after a successful driver route response:

```js
state.driverAccessCode = driverCode.value;
refreshDriverPushStatus();
```

Clear it in `openHome()` or driver logout equivalent only if the app returns to public home without a route.

- [ ] **Step 10: Wire click handler**

In the screen click handler:

```js
if (action === "enableRouteAlerts") enableDriverRouteAlerts();
```

- [ ] **Step 11: Add CSS**

Add styles near driver overview card styles:

```css
.driver-alert-card {
  display: grid;
  grid-template-columns: 38px minmax(0, 1fr) auto;
  gap: 12px;
  align-items: center;
  padding: 14px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: #ffffff;
}

.driver-alert-card.enabled {
  grid-template-columns: 38px minmax(0, 1fr);
}

.driver-alert-icon {
  display: grid;
  place-items: center;
  width: 38px;
  height: 38px;
  border-radius: 50%;
  background: var(--soft);
}

.driver-alert-card strong,
.driver-alert-card small {
  display: block;
}

.driver-alert-card strong {
  font-size: 16px;
  font-weight: 750;
}

.driver-alert-card small {
  color: var(--muted);
  font-size: 13px;
  line-height: 1.35;
}

.secondary-action.compact {
  min-height: 38px;
  padding-inline: 14px;
  font-size: 14px;
}
```

- [ ] **Step 12: Run tests to verify pass**

Run:

```bash
node --test tests/admin_ui.test.mjs tests/notification_core.test.mjs
```

Expected: PASS.

- [ ] **Step 13: Commit**

```bash
git add index.html tests/admin_ui.test.mjs
git commit -m "Add driver route alert opt-in UI"
```

---

### Task 5: Admin Notify Review And Send UI

**Files:**
- Modify: `index.html`
- Modify: `tests/admin_ui.test.mjs`

**Interfaces:**
- Consumes Edge Function mode: `send-route-update`.
- Consumes `adminChangeList`, `publishAdminDraft`, `pushRequest`.
- Produces functions: `adminAffectedDriverSlugs()`, `adminNotifyPromptHtml()`, `openAdminNotifyReview()`, `sendAdminRouteNotifications()`.
- Produces state fields: `adminNotifyDraft`, `adminNotifyMode`, `adminNotifyStatus`.

- [ ] **Step 1: Write failing affected driver tests**

Append to `tests/admin_ui.test.mjs`:

```js
test("admin affected drivers include added updated removed and moved routes", async () => {
  const app = await loadApp();
  app.state.admin = {
    drivers: [
      { slug: "dq", displayName: "DQ", initials: "DQ" },
      { slug: "annie", displayName: "Annie", initials: "AN" },
      { slug: "joojo", displayName: "Joojo", initials: "JP" },
    ],
    stops: [
      { id: "stop-1", driverSlug: "dq", stopOrder: 1, name: "A'lena", phone: "", address: "A", pickupTime: "", readyBy: "", routeLabel: "", notes: "" },
      { id: "stop-2", driverSlug: "annie", stopOrder: 1, name: "Nicholas", phone: "", address: "B", pickupTime: "", readyBy: "", routeLabel: "", notes: "" },
    ],
  };
  app.state.adminDraftStops = [
    { ...app.state.admin.stops[0], phone: "555-555-5555" },
    { ...app.state.admin.stops[1], driverSlug: "joojo" },
    { id: "temp-1", driverSlug: "annie", stopOrder: 2, name: "New", phone: "", address: "C", pickupTime: "", readyBy: "", routeLabel: "", notes: "" },
  ];
  app.state.adminDeletedStopIds = ["stop-1"];

  assert.deepEqual(app.adminAffectedDriverSlugs(), ["dq", "annie", "joojo"]);
});
```

- [ ] **Step 2: Write failing admin notify UI test**

Append:

```js
test("admin reviews driver notification before sending", async () => {
  const app = await loadApp();
  app.state.admin = {
    drivers: [
      { slug: "dq", displayName: "DQ", initials: "DQ" },
      { slug: "john-mark", displayName: "John Mark", initials: "JM" },
    ],
    stops: [],
    people: [],
  };
  app.state.adminNotifyDraft = {
    driverSlugs: ["dq", "john-mark"],
    message: "Your pickup list was updated. Open your route review.",
  };
  app.state.adminNotifyMode = "prompt";

  let html = app.adminView();
  assert.match(html, /Notify drivers\?/);
  assert.match(html, /2 drivers had route changes/);
  assert.match(html, /data-action="adminNotifyReview"/);

  app.state.adminNotifyMode = "review";
  html = app.adminView();
  assert.match(html, /Message preview/);
  assert.match(html, /DQ/);
  assert.match(html, /John Mark/);
  assert.match(html, /data-action="adminNotifySend"/);
});
```

- [ ] **Step 3: Export functions in test harness**

In `loadApp()` export object, add:

```js
adminAffectedDriverSlugs: typeof adminAffectedDriverSlugs === "function" ? adminAffectedDriverSlugs : undefined,
```

- [ ] **Step 4: Run tests to verify failure**

Run:

```bash
node --test tests/admin_ui.test.mjs
```

Expected: FAIL because admin notification state/UI/functions are missing.

- [ ] **Step 5: Add admin notification state**

In `state`, add:

```js
adminNotifyDraft: null,
adminNotifyMode: "prompt",
adminNotifyStatus: "idle",
```

- [ ] **Step 6: Add affected driver helper**

Add near `adminChangeList()`:

```js
function adminAffectedDriverSlugs() {
  const original = adminOriginalStopMap();
  const seen = new Set();
  const slugs = [];
  const add = (slug) => {
    const value = String(slug || "").trim();
    if (!value || seen.has(value)) return;
    seen.add(value);
    slugs.push(value);
  };

  state.adminDeletedStopIds.forEach((stopId) => add(original.get(stopId)?.driverSlug));

  adminStops().forEach((stop) => {
    const before = original.get(stop.id);
    if (!before || String(stop.id || "").startsWith("temp-")) {
      add(stop.driverSlug);
      return;
    }
    if (JSON.stringify(adminComparableStop(before)) !== JSON.stringify(adminComparableStop(stop))) {
      add(before.driverSlug);
      add(stop.driverSlug);
    }
  });

  const order = new Map(adminDrivers().map((driver, index) => [driver.slug, index]));
  return slugs.sort((a, b) => (order.get(a) ?? 999) - (order.get(b) ?? 999) || a.localeCompare(b));
}
```

- [ ] **Step 7: Add admin notify UI renderer**

Add:

```js
function adminNotifyDriverNames(driverSlugs = []) {
  return driverSlugs.map((slug) => adminDriverName(slug));
}

function adminNotifyPromptHtml() {
  const draft = state.adminNotifyDraft;
  if (!draft?.driverSlugs?.length) return "";
  const count = draft.driverSlugs.length;
  const names = adminNotifyDriverNames(draft.driverSlugs);
  const review = state.adminNotifyMode === "review";
  const statusLine = state.adminNotifyStatus === "sending"
    ? "Sending route updates..."
    : `${count} ${count === 1 ? "driver had" : "drivers had"} route changes.`;

  return `
    <section class="admin-notify-card" aria-label="Notify drivers">
      <div class="admin-notify-heading">
        <span class="admin-control-action-icon" data-detail-icon="send">${peopleDetailIcon("send")}</span>
        <span>
          <strong>${review ? "Send route update" : "Notify drivers?"}</strong>
          <small>${escapeHtml(statusLine)}</small>
        </span>
      </div>
      ${review ? `
        <section class="admin-notify-preview">
          <small>Recipients</small>
          <strong>${escapeHtml(names.join(", "))}</strong>
          <small>Message preview</small>
          <p>${escapeHtml(draft.message)}</p>
        </section>
        <div class="admin-form-actions">
          <button class="secondary-action" type="button" data-action="adminNotifyCancel">Cancel</button>
          <button class="primary-action" type="button" data-action="adminNotifySend">${state.adminNotifyStatus === "sending" ? "Sending..." : "Send"}</button>
        </div>
      ` : `
        <button class="secondary-action" type="button" data-action="adminNotifyReview">Review message</button>
      `}
    </section>`;
}
```

- [ ] **Step 8: Place notify card in `adminView`**

Insert after admin messages:

```js
${adminNotifyPromptHtml()}
```

- [ ] **Step 9: Update publish flow to create draft after save**

At the start of `publishAdminDraft()` before `state.adminLoading = true`:

```js
const affectedDriverSlugs = adminAffectedDriverSlugs();
```

After a successful publish, replace the message block with:

```js
state.adminNotifyDraft = affectedDriverSlugs.length ? {
  driverSlugs: affectedDriverSlugs,
  message: "Your pickup list was updated. Open your route review.",
} : null;
state.adminNotifyMode = "prompt";
state.adminNotifyStatus = "idle";
state.adminMessage = affectedDriverSlugs.length ? "Route changes published." : "Route changes published.";
```

Do not call the send function inside `publishAdminDraft()`.

- [ ] **Step 10: Add review/send/cancel handlers**

Add:

```js
function openAdminNotifyReview() {
  if (!state.adminNotifyDraft?.driverSlugs?.length) return;
  state.adminNotifyMode = "review";
  state.adminNotifyStatus = "idle";
  state.adminError = "";
  render();
}

function cancelAdminNotify() {
  state.adminNotifyDraft = null;
  state.adminNotifyMode = "prompt";
  state.adminNotifyStatus = "idle";
  render();
}

async function sendAdminRouteNotifications() {
  const draft = state.adminNotifyDraft;
  if (!draft?.driverSlugs?.length) return;
  state.adminNotifyStatus = "sending";
  state.adminError = "";
  render();

  try {
    const sent = await pushRequest("send-route-update", {
      adminCode: state.adminCode,
      planDate: activePlanDate(),
      driverSlugs: draft.driverSlugs,
      message: draft.message,
    });

    if (!sent?.ok) throw new Error(sent?.error || "push_send_failed");
    state.adminNotifyDraft = null;
    state.adminNotifyMode = "prompt";
    state.adminNotifyStatus = "idle";
    state.adminMessage = sent.failed
      ? `${sent.sent} route updates sent. ${sent.failed} failed.`
      : `${sent.sent} route updates sent.`;
  } catch (error) {
    state.adminNotifyStatus = "error";
    state.adminError = "Could not send route updates.";
    console.error(error);
  }
  render();
}
```

- [ ] **Step 11: Wire click actions**

In the screen click handler:

```js
if (action === "adminNotifyReview") openAdminNotifyReview();
if (action === "adminNotifyCancel") cancelAdminNotify();
if (action === "adminNotifySend") sendAdminRouteNotifications();
```

- [ ] **Step 12: Add CSS**

Add:

```css
.admin-notify-card {
  display: grid;
  gap: 14px;
  padding: 16px;
  border: 1px solid #d8dce2;
  border-radius: 8px;
  background: #ffffff;
}

.admin-notify-heading {
  display: grid;
  grid-template-columns: 34px minmax(0, 1fr);
  gap: 12px;
  align-items: center;
}

.admin-notify-heading strong,
.admin-notify-preview strong {
  display: block;
  color: #050505;
  font-size: 17px;
  font-weight: 750;
  line-height: 1.25;
}

.admin-notify-heading small,
.admin-notify-preview small,
.admin-notify-preview p {
  color: var(--muted);
  font-size: 14px;
  line-height: 1.35;
}

.admin-notify-preview {
  display: grid;
  gap: 8px;
  padding-top: 12px;
  border-top: 1px solid var(--line);
}
```

- [ ] **Step 13: Run tests to verify pass**

Run:

```bash
node --test tests/admin_ui.test.mjs tests/notification_core.test.mjs
```

Expected: PASS.

- [ ] **Step 14: Commit**

```bash
git add index.html tests/admin_ui.test.mjs
git commit -m "Add admin route update notification review"
```

---

### Task 6: Final Local Verification And Deployment Notes

**Files:**
- Modify: `docs/future-plans.md` if the tracker needs a note.
- No live Supabase deploy in this task unless the user approves it after local verification.

**Interfaces:**
- Consumes all previous tasks.
- Produces verified local implementation and a clear deploy checklist.

- [ ] **Step 1: Run non-mutating tests**

Run:

```bash
node --test tests/admin_ui.test.mjs tests/route_timing_core.test.mjs tests/notification_core.test.mjs
```

Expected: PASS.

- [ ] **Step 2: Run static secret scan**

Run:

```bash
rg -n "VAPID_PRIVATE_KEY|SUPABASE_SERVICE_ROLE_KEY|service_role|AIza|GOOGLE_ROUTES_API_KEY" index.html sw.js manifest.webmanifest
```

Expected: no matches.

- [ ] **Step 3: Check git diff**

Run:

```bash
git status --short --branch
git diff --check
```

Expected: clean whitespace and only intended files changed if any remain uncommitted.

- [ ] **Step 4: Document live deployment requirements in final response**

Report:

```text
Local push notification code is built and tested.
Live enablement still needs:
- Apply Supabase SQL source to project cpkimtrribpvqxbywfry.
- Set Edge Function secrets VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT.
- Deploy ride-driver-notifications with verify_jwt false because it uses custom admin/driver-code authorization.
- Push GitHub Pages source after final approval.
```

- [ ] **Step 5: Commit any final documentation-only changes**

If `docs/future-plans.md` changes:

```bash
git add docs/future-plans.md
git commit -m "Update push notification tracker"
```

Expected: no code changes left uncommitted.

---

## Self-Review

- Spec coverage: driver opt-in is covered in Task 4; admin review/send is covered in Task 5; Supabase storage is covered in Task 2; Edge Function secrets are covered in Task 3; service worker/tap behavior is covered in Task 1; verification is covered in Task 6.
- Scope check: no rider notifications, no chat, no church-wide announcements, and no automatic sends while admins edit.
- Security check: private VAPID and service-role secrets never enter frontend files; subscription registration validates the unlocked driver route; admin send validates the existing admin code.
- Ambiguity check: affected drivers are explicitly defined as saved route changes, including added, removed, moved, timing, address, phone/name, area, route label, and notes changes through `adminComparableStop`.

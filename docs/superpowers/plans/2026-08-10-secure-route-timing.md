# Secure Route Timing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add secure Google-backed route timing and admin route warnings without exposing route API secrets in the browser.

**Architecture:** Keep the existing single-file app render pattern. Add a Supabase Edge Function for Google Routes calls, small app helpers for route timing state, and warning chips in admin route cards.

**Tech Stack:** Static HTML/CSS/JavaScript, Supabase Edge Functions on Deno, Google Routes API `computeRoutes`, Node test runner.

## Global Constraints

- Keep RIDELIST mobile-first and visually consistent with the current black/white Uber-like UI.
- Never place `GOOGLE_ROUTES_API_KEY` or any secret key in public frontend code.
- Keep existing driver passcode flow simple: drivers type `rides123`.
- Keep admin warnings advisory, not blocking.
- Preserve existing weather and Sunday reset behavior.

---

### Task 1: Frontend Timing State And Warnings

**Files:**
- Modify: `tests/admin_ui.test.mjs`
- Modify: `index.html`

**Interfaces:**
- Produces: `routeTimingForDriver(slug)` returning the timing object from `state.routeTimings`.
- Produces: `adminRouteWarnings(driver, stops, timing)` returning warning objects.
- Produces: `secureRouteTimingRequest(mode, payload)` for browser-to-function calls.

- [x] **Step 1: Write failing UI tests**

Add tests that expect driver home to show live timing when present, show manual fallback when unavailable, and admin route cards to show warning chips for missing phone/address/time and route timing unavailable.

- [x] **Step 2: Run tests to verify failure**

Run: `node --test tests/admin_ui.test.mjs`
Expected: FAIL because the timing/warning helpers and markup do not exist.

- [x] **Step 3: Implement the smallest frontend helpers and markup**

Add timing state, helper functions, warning chips, and safe function invocation that catches failures and keeps fallback text.

- [x] **Step 4: Run tests to verify pass**

Run: `node --test tests/admin_ui.test.mjs`
Expected: PASS.

### Task 2: Supabase Edge Function

**Files:**
- Create: `supabase/functions/ride-route-timing/index.ts`
- Create: `supabase/functions/ride-route-timing/deno.json`

**Interfaces:**
- Consumes: `mode: "driver" | "admin"`, `planDate`, `driverSlug`, `accessCode`, `adminCode`, `drivers`, `stops`, and `destination`.
- Produces: JSON `{ ok, timings, warnings, error }`.

- [x] **Step 1: Write function code with internal pure helpers**

Implement CORS, request parsing, existing RPC authorization, Google `computeRoutes`, duration parsing, ETA formatting, and warning generation.

- [x] **Step 2: Deploy the function with custom auth**

Deploy with `verify_jwt: false` because the function performs its own driver/admin authorization and must allow driver passcode requests from the public page.

- [x] **Step 3: Verify function health without Google secret**

Call the deployed function with a harmless request and confirm it returns a controlled `missing_google_key` or authorization response rather than crashing.

### Task 3: Integration, Verification, And Push

**Files:**
- Modify: `index.html`
- Modify: `tests/admin_ui.test.mjs`
- Create: `supabase/functions/ride-route-timing/index.ts`
- Create: `supabase/functions/ride-route-timing/deno.json`

- [x] **Step 1: Run local tests**

Run: `node --test tests/admin_ui.test.mjs`
Expected: all UI tests pass.

- [x] **Step 2: Check diff hygiene**

Run: `git diff --check`
Expected: no whitespace errors.

- [ ] **Step 3: Commit and push**

Commit the frontend, function source, docs, and tests, then push `main` so GitHub Pages updates.

- [ ] **Step 4: Report setup requirement**

Tell the user that live Google timing needs `GOOGLE_ROUTES_API_KEY` saved in Supabase Edge Function secrets with Routes API enabled.

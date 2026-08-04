# Admin Ride Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a protected mobile admin area for last-minute Sunday ride route changes.

**Architecture:** Keep the static GitHub Pages app, and add Supabase RPCs for admin read/write actions. The frontend keeps edits as a local draft until publishing them through one admin RPC.

**Tech Stack:** Static HTML/CSS/JavaScript, Supabase Postgres RPC, GitHub Pages, Node built-in test runner.

## Global Constraints

- Do not expose the admin passcode in JavaScript.
- Use the existing Supabase publishable key only; never expose service-role credentials.
- Keep private ride tables private and RLS-enabled.
- Driver notifications and People Bank bulk import are remembered follow-up features, not part of this first build.
- Preserve the current mobile app look: black/white Uber-like admin controls, no phone outline.

---

### Task 1: Admin RPC tests

**Files:**
- Create: `tests/admin_rpc.test.mjs`
- Create: `tests/admin_ui.test.mjs`

**Interfaces:**
- Consumes: public Supabase RPC endpoint.
- Produces: failing checks for `ride_admin_snapshot`, `ride_admin_publish_plan`, and admin UI entry points.

- [ ] Add tests that call admin RPCs with a wrong passcode and with `RIDES_ADMIN_CODE`.
- [ ] Add tests that insert, move, update, and delete a temporary rider through the publish RPC.
- [ ] Add tests that read `index.html` and assert admin UI functions and RPC names are present.
- [ ] Run `node --test tests/*.test.mjs` and confirm the tests fail before implementation.

### Task 2: Supabase admin RPCs

**Files:**
- Create: `supabase/admin_ride_control.sql`

**Interfaces:**
- Produces: `public.ride_admin_snapshot(p_admin_code text, p_plan_date date)` and `public.ride_admin_publish_plan(p_admin_code text, p_plan_date date, p_stops jsonb, p_deleted_stop_ids text[])`.

- [ ] Add `rides_private.ride_admin_codes` with an `access_code_hash`.
- [ ] Insert or update the initial admin code using `rides_private.hash_driver_code`, without committing the readable code.
- [ ] Add a private admin assertion helper.
- [ ] Add snapshot and publish RPCs with `SECURITY DEFINER` and `search_path` set to empty.
- [ ] Apply SQL using Supabase execute SQL.
- [ ] Run the admin RPC tests until they pass.

### Task 3: Admin UI

**Files:**
- Modify: `index.html`

**Interfaces:**
- Consumes: `ride_admin_snapshot` and `ride_admin_publish_plan`.
- Produces: admin login, route control view, edit/add rider form, local drafts, and publish action.

- [ ] Add CSS for admin button, admin route cards, rider cards, form fields, and publish banner.
- [ ] Add admin state fields to the existing `state` object.
- [ ] Add `openAdminModal`, `submitAdminCode`, `adminView`, `adminEditView`, and draft helper functions.
- [ ] Add event handlers for opening admin, editing riders, adding riders, saving draft changes, deleting draft riders, and publishing.
- [ ] Keep driver views unchanged except for receiving updated Supabase data after publish.
- [ ] Run UI tests until they pass.

### Task 4: Verification and deployment

**Files:**
- Modify: `index.html`
- Commit docs, tests, SQL, and app changes.

**Interfaces:**
- Produces: live GitHub Pages app with admin ride control.

- [ ] Run `node --test tests/*.test.mjs`.
- [ ] Open the local app in a mobile viewport and verify admin login and route control.
- [ ] Publish a temporary rider, move it, verify driver route output, then delete it.
- [ ] Push to GitHub Pages.
- [ ] Verify the live page with a cache-busted URL.

# Admin Ride Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a protected mobile admin area for last-minute Sunday ride route changes, including a searchable PeopleData bank.

**Architecture:** Keep the static GitHub Pages app, and add Supabase RPCs for admin read/write actions. The frontend keeps edits as a local draft until publishing them through one admin RPC.

**Tech Stack:** Static HTML/CSS/JavaScript, Supabase Postgres RPC, GitHub Pages, Node built-in test runner.

## Global Constraints

- Do not expose the admin passcode in JavaScript.
- Use the existing Supabase publishable key only; never expose service-role credentials.
- Keep private ride tables private and RLS-enabled.
- Driver notifications are remembered as a follow-up feature, not part of this first build.
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
- [ ] Add tests that assert admin UI entry points, functional `Routes`/`Riders`/`Data`/`Changes` tabs, PeopleData search, driver dropdowns, move controls, edit-screen removal, and changes review output.
- [ ] Run `node --test tests/*.test.mjs` and confirm the tests fail before implementation.

### Task 2: Supabase admin RPCs

**Files:**
- Create: `supabase/admin_ride_control.sql`

**Interfaces:**
- Produces: `public.ride_admin_snapshot(p_admin_code text, p_plan_date date)` and `public.ride_admin_publish_plan(p_admin_code text, p_plan_date date, p_stops jsonb, p_deleted_stop_ids text[])`.

- [ ] Add `rides_private.ride_admin_codes` with an `access_code_hash`.
- [ ] Add `rides_private.ride_people` for private PeopleData storage.
- [ ] Insert or update the initial admin code using `rides_private.hash_driver_code`, without committing the readable code.
- [ ] Add a private admin assertion helper.
- [ ] Add snapshot, publish, and PeopleData upsert RPCs with `SECURITY DEFINER` and `search_path` set to empty.
- [ ] Seed PeopleData from the workbook `PeopleData` sheet, preserving the newer Nicholas address correction.
- [ ] Apply SQL using Supabase execute SQL.
- [ ] Run the admin RPC tests until they pass.

### Task 3: Admin UI

**Files:**
- Modify: `index.html`

**Interfaces:**
- Consumes: `ride_admin_snapshot` and `ride_admin_publish_plan`.
- Produces: admin login, route control view, edit/add rider form, local drafts, and publish action.

- [ ] Add CSS for admin button, four admin tabs, compact route dropdown cards, rider cards, PeopleData cards, search fields, change cards, form fields, and publish banner.
- [ ] Add admin state fields to the existing `state` object.
- [ ] Add `openAdminModal`, `submitAdminCode`, `adminView`, `adminEditView`, and draft helper functions.
- [ ] Add event handlers for opening admin, switching admin tabs, expanding drivers, searching PeopleData, adding saved people, editing riders, moving riders, saving draft changes, deleting draft riders from edit, and publishing.
- [ ] Rename the Blue display initials to `BLU`.
- [ ] Keep driver views unchanged except for receiving updated Supabase data after publish.
- [ ] Run UI tests until they pass.

### Task 4: Verification and deployment

**Files:**
- Modify: `index.html`
- Commit docs, tests, SQL, and app changes.

**Interfaces:**
- Produces: live GitHub Pages app with admin ride control.

- [ ] Run `node --test tests/*.test.mjs`.
- [ ] Open the local app in a mobile viewport and verify admin login, route control dropdowns, PeopleData search, saved-person add draft, edit-screen removal, and changes review.
- [ ] Push to GitHub Pages.
- [ ] Verify the live page with a cache-busted URL.

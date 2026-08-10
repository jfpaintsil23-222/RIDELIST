# Sunday Reset Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an admin flow that creates a new blank Sunday plan from selected existing drivers while keeping PeopleData intact.

**Architecture:** Supabase owns the active ride plan date and exposes reset RPCs. The static HTML app loads the active plan before drivers, then Admin can start a new Sunday and switch the active plan to it.

**Tech Stack:** Static HTML/CSS/JavaScript, Supabase Postgres RPCs, Node built-in test runner.

## Global Constraints

- Do not delete PeopleData during reset.
- The new Sunday starts with selected drivers and zero assigned rider stops.
- Driver passcodes are copied from the source plan.
- Existing Sunday plans remain queryable by date.
- The public app should load the active plan date from Supabase instead of relying only on the hardcoded fallback date.

---

### Task 1: Add Tests For Sunday Reset

**Files:**
- Modify: `tests/admin_ui.test.mjs`
- Modify: `tests/admin_rpc.test.mjs`

**Interfaces:**
- Consumes: current `adminView`, admin state shape, Supabase RPC test helper.
- Produces: failing expectations for `ride_app_context`, `ride_admin_start_new_sunday`, and the admin reset screen.

- [ ] **Step 1: Write failing UI tests**

Add assertions that the app includes active plan loading, a `Start New Sunday` admin action, and an admin reset view showing driver checkboxes and copy-free reset messaging.

- [ ] **Step 2: Write failing RPC tests**

Call `ride_admin_start_new_sunday` with `p_make_active: false`, date `2099-01-04`, and driver slugs `["joojo", "annie"]`; expect two drivers, zero stops, and PeopleData retained.

- [ ] **Step 3: Run tests to verify failure**

Run: `RIDES_ADMIN_CODE=... node --test tests/*.test.mjs`

Expected: tests fail because reset RPC/UI do not exist yet.

### Task 2: Add Supabase Reset RPCs

**Files:**
- Modify: `supabase/admin_ride_control.sql`

**Interfaces:**
- Produces: `public.ride_app_context()`, `public.ride_admin_start_new_sunday(text, date, text[], date, boolean)`, and active-plan-aware existing RPC defaults.

- [ ] **Step 1: Add active plan storage**

Create `rides_private.ride_app_settings` with `active_plan_date`, RLS enabled and forced, and a private helper `rides_private.current_ride_plan_date()`.

- [ ] **Step 2: Add public active context**

Create `public.ride_app_context()` returning `{ ok, plan, destination }` for the active plan.

- [ ] **Step 3: Add admin reset RPC**

Create `public.ride_admin_start_new_sunday(...)` validating admin code, Sunday date, and selected drivers, then upserting a blank plan with copied drivers and no stops.

- [ ] **Step 4: Update existing RPC fallbacks**

Make `ride_driver_directory`, `ride_driver_route`, `ride_admin_snapshot`, and `ride_admin_publish_plan` use `rides_private.current_ride_plan_date()` when `p_plan_date` is null.

### Task 3: Add Admin Reset UI

**Files:**
- Modify: `index.html`

**Interfaces:**
- Consumes: `ride_app_context`, `ride_admin_start_new_sunday`, current admin snapshot shape.
- Produces: `adminResetView`, `openAdminReset`, dynamic `state.planDate`, and reset form submission.

- [ ] **Step 1: Load active plan before drivers**

Replace direct `PLAN_DATE` usage with `state.planDate`, initialized from `ride_app_context()` with fallback `2026-08-09`.

- [ ] **Step 2: Render reset entry and reset screen**

Add `Start New Sunday` button in Admin and a reset form with date input, driver checkboxes, and clear copy about keeping PeopleData but clearing assignments.

- [ ] **Step 3: Submit reset**

On submit, call `ride_admin_start_new_sunday`, load the returned blank snapshot, refresh driver directory, and show a success message.

### Task 4: Verify And Push

**Files:**
- All modified files.

**Interfaces:**
- Consumes: all test and RPC behavior.
- Produces: pushed commit.

- [ ] **Step 1: Run full tests**

Run: `RIDES_ADMIN_CODE=... node --test tests/*.test.mjs`

- [ ] **Step 2: Apply SQL to Supabase and verify**

Use Supabase SQL execution, then run RPC tests against live database.

- [ ] **Step 3: Run pre-push checks**

Run `git diff --check`, `git status --short`, and a secret scan over `index.html tests supabase`.

- [ ] **Step 4: Commit and push**

Commit message: `Add admin Sunday reset flow`

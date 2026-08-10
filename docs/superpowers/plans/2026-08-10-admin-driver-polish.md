# Admin Driver Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Improve the admin route controls and driver dashboard so route areas, first pickup timing, move/edit actions, and completed-route navigation are easier to understand.

**Architecture:** Keep the single-file app structure in `index.html` and follow the current render-helper pattern. Add small helper functions for route timing/labels, then update admin and driver view markup without changing the Supabase schema.

**Tech Stack:** Static HTML/CSS/JavaScript, Node test runner, Supabase RPCs already used by existing tests.

## Global Constraints

- Keep the app mobile-first and Uber-like with black/white UI.
- Do not add Google route timing or weather API in this task.
- Keep admin email/password only in admin auth; drivers continue using the shared route passcode flow.
- Preserve existing PeopleData and Sunday reset behavior.
- Run `RIDES_ADMIN_CODE=<secret> RIDES_DRIVER_CODE=rides123 node --test tests/*.test.mjs` before pushing.

---

### Task 1: Admin Route Header Polish

**Files:**
- Modify: `tests/admin_ui.test.mjs`
- Modify: `index.html`

**Interfaces:**
- Consumes: `adminRouteCard(driver)`, `adminStopsForDriver(slug)`, `driverRouteSummary(driver)`.
- Produces: `adminRouteHeaderSummary(driver, stops)` returning `{ routeLabel: string, timingLabel: string }`.

- [x] **Step 1: Write the failing test**

Add a test that expands a driver route and expects the collapsed/expanded header to show the computed route area, first pickup time, and existing rider actions.

- [x] **Step 2: Run test to verify it fails**

Run: `node --test tests/admin_ui.test.mjs`
Expected: FAIL because `adminRouteHeaderSummary` and the new header copy do not exist yet.

- [x] **Step 3: Write minimal implementation**

Add `normalizeRouteArea`, `adminRouteHeaderSummary`, and update `adminRouteCard` header copy.

- [x] **Step 4: Run test to verify it passes**

Run: `node --test tests/admin_ui.test.mjs`
Expected: PASS.

### Task 2: Driver Dashboard And Completion Polish

**Files:**
- Modify: `tests/admin_ui.test.mjs`
- Modify: `index.html`

**Interfaces:**
- Consumes: `driverHomeView()`, `ridesView()`, `routeTarget(riders, destination)`, `driverRouteSummary(driver)`, `getPicked(stopOrder)`.
- Produces: `driverDashboardMeta(driver, riders, destination)` returning route label, first pickup line, route timing line, and destination line.

- [x] **Step 1: Write the failing test**

Add a test that renders driver home and rides views, expecting a clear route overview and an "All pickups complete" block only after all riders are marked picked up.

- [x] **Step 2: Run test to verify it fails**

Run: `node --test tests/admin_ui.test.mjs`
Expected: FAIL because the route overview and completion block are not rendered yet.

- [x] **Step 3: Write minimal implementation**

Add `driverDashboardMeta`, render a `driver-overview-card` on driver home, and render a completion card in `ridesView()` when `target.allPicked` is true.

- [x] **Step 4: Run test to verify it passes**

Run: `node --test tests/admin_ui.test.mjs`
Expected: PASS.

### Task 3: Verify And Push

**Files:**
- No new production files beyond `index.html`.

**Interfaces:**
- Consumes: all updated tests.
- Produces: a pushed GitHub Pages update.

- [x] **Step 1: Run full verification**

Run: `RIDES_ADMIN_CODE=<secret> RIDES_DRIVER_CODE=rides123 node --test tests/*.test.mjs`
Expected: all tests pass.

- [x] **Step 2: Check diff hygiene**

Run: `git diff --check`
Expected: no output.

- [x] **Step 3: Commit and push**

Run:
```bash
git add index.html tests/admin_ui.test.mjs docs/superpowers/plans/2026-08-10-admin-driver-polish.md
git commit -m "Polish admin routes and driver dashboard"
git push origin main
```

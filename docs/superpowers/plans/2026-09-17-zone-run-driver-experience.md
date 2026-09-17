# Zone and Run Driver Experience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local driver experience that groups each driver's riders into zone/run rows and opens a filtered Run Details screen without changing live data.

**Architecture:** Keep the existing single-file application structure in `index.html`, but isolate zone/run parsing and grouping in pure helpers. Add one selected-run state value and reuse the current `rides` and `detail` views so rider navigation, pickup checkmarks, weather, route timing, and protected details continue to work.

**Tech Stack:** Static HTML/CSS/JavaScript, Node.js built-in test runner, Supabase-backed data already loaded by RIDELIST.

**Spec:** `docs/superpowers/specs/2026-09-17-zone-run-driver-experience-design.md`

## Global Constraints

- Build and test locally only; do not push or deploy.
- Do not modify live Supabase data or PeopleData.
- Do not add Twilio in this phase.
- Do not put Google, OpenAI, Twilio, or Supabase secret keys in frontend code.
- Preserve driver passcode login, weather, secure route timing, rider details, pickup checkmarks, route alerts, and admin publish safeguards.
- Stops without a usable route label must remain visible in `Assigned pickups`.
- Confirmation statuses must not pretend to be live; missing stored status renders `Waiting`.

## File Structure

- Modify `index.html`: add pure grouping/status helpers, selected-run state, driver overview run rows, filtered Run Details, status styling, and navigation actions.
- Modify `tests/admin_ui.test.mjs`: expose helpers to the test harness and cover grouping, overview, run filtering, status rendering, fallbacks, and existing route behavior.
- Do not create a new runtime module in this phase because the current application and test harness intentionally load the inline script from `index.html`.

---

### Task 1: Zone and Run Grouping Helpers

**Files:**
- Modify: `index.html:4843-4935`
- Test: `tests/admin_ui.test.mjs:55-140`
- Test: `tests/admin_ui.test.mjs:1640-1730`

**Interfaces:**
- Consumes: ride stops shaped as `{ stopOrder, name, area, pickupTime, routeLabel, confirmationStatus?, confirmationUpdatedAt? }`.
- Produces: `driverRunLabel(stop) -> string`, `driverRunKey(stop) -> string`, `driverRuns(riders) -> Array<{ key, label, riders, riderCount, departureTime, meetupLabel }>`, and `riderConfirmationMeta(rider) -> { key, label, detail }`.

- [ ] **Step 1: Expose the planned helpers in the test harness**

Add these properties to `globalThis.__app` in `tests/admin_ui.test.mjs`:

```js
driverRunLabel: typeof driverRunLabel === "function" ? driverRunLabel : undefined,
driverRunKey: typeof driverRunKey === "function" ? driverRunKey : undefined,
driverRuns: typeof driverRuns === "function" ? driverRuns : undefined,
riderConfirmationMeta: typeof riderConfirmationMeta === "function" ? riderConfirmationMeta : undefined,
```

- [ ] **Step 2: Write failing grouping tests**

Add tests that call the pure helpers directly:

```js
test("driver runs group route labels and keep unlabeled riders visible", async () => {
  const app = await loadApp();
  const riders = [
    { stopOrder: 1, name: "Aamiyah", area: "TSU", routeLabel: "TSU Zone · Run 2", pickupTime: "12:15 PM" },
    { stopOrder: 2, name: "Nick", area: "TSU", routeLabel: "TSU Zone · Run 1", pickupTime: "11:45 AM" },
    { stopOrder: 3, name: "Elise", area: "TSU", routeLabel: "TSU Zone · Run 2", pickupTime: "12:15 PM" },
    { stopOrder: 4, name: "Armani", area: "TSU", routeLabel: "", pickupTime: "" },
  ];

  const runs = app.driverRuns(riders);
  assert.deepEqual(Array.from(runs, (run) => run.label), [
    "TSU Zone · Run 1",
    "TSU Zone · Run 2",
    "Assigned pickups",
  ]);
  assert.deepEqual(Array.from(runs[1].riders, (rider) => rider.name), ["Aamiyah", "Elise"]);
  assert.equal(runs[1].departureTime, "12:15 PM");
  assert.equal(runs[2].riderCount, 1);
});

test("rider confirmation status defaults honestly to waiting", async () => {
  const app = await loadApp();
  assert.deepEqual(
    { ...app.riderConfirmationMeta({}) },
    { key: "waiting", label: "Waiting", detail: "Confirmation pending" },
  );
  assert.equal(app.riderConfirmationMeta({ confirmationStatus: "confirmed" }).label, "Ready");
  assert.equal(app.riderConfirmationMeta({ confirmationStatus: "declined" }).label, "Not coming");
});
```

- [ ] **Step 3: Run the new tests and verify RED**

Run:

```bash
node --test --test-name-pattern="driver runs|confirmation status" tests/admin_ui.test.mjs
```

Expected: FAIL because `driverRuns` and `riderConfirmationMeta` are not defined.

- [ ] **Step 4: Implement minimal grouping and status helpers**

Add after `firstPickupTime` in `index.html`:

```js
function driverRunLabel(stop = {}) {
  return String(stop.routeLabel || "").trim() || "Assigned pickups";
}

function driverRunKey(stop = {}) {
  return driverRunLabel(stop).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "assigned-pickups";
}

function driverRuns(riders = []) {
  const grouped = new Map();
  orderedStops(riders).forEach((rider) => {
    const key = driverRunKey(rider);
    if (!grouped.has(key)) grouped.set(key, { key, label: driverRunLabel(rider), riders: [] });
    grouped.get(key).riders.push(rider);
  });

  return Array.from(grouped.values())
    .map((run) => ({
      ...run,
      riderCount: run.riders.length,
      departureTime: firstPickupTime(run.riders),
      meetupLabel: run.riders.every((rider) => rider.address === run.riders[0]?.address)
        ? run.riders[0]?.area || run.riders[0]?.address || "Meetup pending"
        : "Multiple pickup points",
    }))
    .sort((a, b) => {
      const aFallback = a.label === "Assigned pickups";
      const bFallback = b.label === "Assigned pickups";
      if (aFallback !== bFallback) return aFallback ? 1 : -1;
      return String(a.departureTime || "99:99").localeCompare(String(b.departureTime || "99:99"))
        || a.label.localeCompare(b.label);
    });
}

function riderConfirmationMeta(rider = {}) {
  const status = String(rider.confirmationStatus || rider.confirmation_status || "").toLowerCase();
  if (["confirmed", "ready", "yes"].includes(status)) {
    return { key: "ready", label: "Ready", detail: rider.confirmationUpdatedAt ? `Confirmed ${rider.confirmationUpdatedAt}` : "Confirmed" };
  }
  if (["declined", "not-coming", "no"].includes(status)) {
    return { key: "declined", label: "Not coming", detail: "Cannot ride today" };
  }
  return { key: "waiting", label: "Waiting", detail: "Confirmation pending" };
}
```

- [ ] **Step 5: Run helper tests and the full suite**

Run:

```bash
node --test --test-name-pattern="driver runs|confirmation status" tests/admin_ui.test.mjs
node --test tests/admin_ui.test.mjs
```

Expected: helper tests PASS and the existing suite reports zero failures.

- [ ] **Step 6: Commit Task 1**

```bash
git add index.html tests/admin_ui.test.mjs
git commit -m "Add driver zone and run grouping"
```

---

### Task 2: Driver Overview Run Rows

**Files:**
- Modify: `index.html:1456-1750`
- Modify: `index.html:3960-4015`
- Modify: `index.html:9241-9305`
- Test: `tests/admin_ui.test.mjs:1640-1730`

**Interfaces:**
- Consumes: `driverRuns(state.route.riders)` from Task 1 and existing weather helpers.
- Produces: `driverRunRow(run) -> string` and an updated `driverHomeView()` with `[data-driver-run]` buttons.

- [ ] **Step 1: Write a failing driver-overview test**

Add to the existing driver dashboard test after route setup:

```js
app.state.route.riders[0].routeLabel = "Cypress Zone · Run 1";
app.state.route.riders[1].routeLabel = "Cypress Zone · Run 2";
const zoneHomeHtml = app.driverHomeView();
assert.match(zoneHomeHtml, /Good (?:morning|afternoon|evening|day), Joojo/);
assert.match(zoneHomeHtml, /2 riders/);
assert.match(zoneHomeHtml, /data-driver-run="cypress-zone-run-1"/);
assert.match(zoneHomeHtml, /Cypress Zone · Run 1/);
assert.match(zoneHomeHtml, /1 rider · Leave 11:00 AM/);
assert.match(zoneHomeHtml, /Cypress Zone · Run 2/);
assert.match(zoneHomeHtml, /Weather/);
assert.doesNotMatch(zoneHomeHtml, /View my rides/);
```

- [ ] **Step 2: Run the overview test and verify RED**

Run:

```bash
node --test --test-name-pattern="driver dashboard summarizes route" tests/admin_ui.test.mjs
```

Expected: FAIL because the overview has no `data-driver-run` rows and still shows `View my rides`.

- [ ] **Step 3: Add selected-run state**

Add beside `selectedRider` in `state`:

```js
selectedDriverRunKey: "",
```

Clear it in `setDriverHome()` and `openHome()`:

```js
state.selectedDriverRunKey = "";
```

- [ ] **Step 4: Add minimal run-row styling**

Add CSS beside the existing `.driver-overview-card` rules:

```css
.driver-run-list {
  display: grid;
  gap: 10px;
}

.driver-run-row {
  width: 100%;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 14px;
  align-items: center;
  min-height: 72px;
  padding: 14px 16px;
  border: 1px solid var(--line);
  border-radius: 8px;
  color: var(--ink);
  background: var(--card);
  text-align: left;
}

.driver-run-copy {
  display: grid;
  gap: 4px;
  min-width: 0;
}

.driver-run-copy span {
  color: var(--muted);
}
```

- [ ] **Step 5: Implement the run-row renderer and simplify `driverHomeView`**

Add:

```js
function driverRunRow(run) {
  const riderLabel = `${run.riderCount} ${run.riderCount === 1 ? "rider" : "riders"}`;
  const timing = run.departureTime ? ` · Leave ${run.departureTime}` : " · Time pending";
  return `
    <button class="driver-run-row" type="button" data-driver-run="${escapeHtml(run.key)}">
      <span class="driver-run-copy">
        <strong>${escapeHtml(run.label)}</strong>
        <span>${escapeHtml(riderLabel + timing)}</span>
      </span>
      <span aria-hidden="true">&rsaquo;</span>
    </button>`;
}
```

Update `driverHomeView()` so the existing intro, summary count, weather row, and route alerts remain, while the single route overview and `View my rides` action are replaced by:

```js
const runs = driverRuns(riders);
// ...existing intro, rider total, and weather content...
<section class="driver-run-list" aria-label="Assigned runs">
  ${runs.map(driverRunRow).join("")}
</section>
```

Use the existing `weatherSummaryText()`, `weatherDetailsText()`, and `toggleWeather` action unchanged.

- [ ] **Step 6: Run overview and full tests**

Run:

```bash
node --test --test-name-pattern="driver dashboard summarizes route|driver dashboard prefers secure route timing" tests/admin_ui.test.mjs
node --test tests/admin_ui.test.mjs
```

Expected: overview assertions PASS; any obsolete expectations for the removed single `Route overview` block are updated to assert run rows instead, while weather and secure timing tests remain meaningful.

- [ ] **Step 7: Commit Task 2**

```bash
git add index.html tests/admin_ui.test.mjs
git commit -m "Build driver run overview"
```

---

### Task 3: Filtered Run Details and Navigation

**Files:**
- Modify: `index.html:7415-7460`
- Modify: `index.html:9305-9425`
- Modify: `index.html:9450-9505`
- Modify: `index.html:9625-9695`
- Test: `tests/admin_ui.test.mjs:1640-1730`

**Interfaces:**
- Consumes: `state.selectedDriverRunKey`, `driverRuns(riders)`, and `riderConfirmationMeta(rider)`.
- Produces: `selectedDriverRun() -> run | null`, `openDriverRun(key)`, a filtered `ridesView()`, and status markup with `data-confirmation-status`.

- [ ] **Step 1: Expose navigation helpers for tests**

Add to `globalThis.__app`:

```js
selectedDriverRun: typeof selectedDriverRun === "function" ? selectedDriverRun : undefined,
openDriverRun: typeof openDriverRun === "function" ? openDriverRun : undefined,
```

- [ ] **Step 2: Write failing Run Details tests**

Add:

```js
test("driver opens one run and sees only that run's riders", async () => {
  const app = await loadApp();
  app.state.route = {
    plan: { date: "2026-09-20" },
    driver: { slug: "blu", displayName: "Blu", initials: "BLU" },
    destination: { label: "UH Hilton", address: "4450 University Dr, Houston, TX" },
    riders: [
      { stopOrder: 1, name: "Aamiyah", address: "TSU Library", area: "TSU", routeLabel: "TSU Zone · Run 1", pickupTime: "11:45 AM", confirmationStatus: "confirmed" },
      { stopOrder: 2, name: "Nya", address: "TSU Library", area: "TSU", routeLabel: "TSU Zone · Run 2", pickupTime: "12:15 PM" },
      { stopOrder: 3, name: "Raquel", address: "TSU Library", area: "TSU", routeLabel: "TSU Zone · Run 2", pickupTime: "12:15 PM", confirmationStatus: "declined" },
    ],
  };

  app.openDriverRun("tsu-zone-run-2");
  assert.equal(app.state.view, "rides");
  assert.equal(app.state.selectedDriverRunKey, "tsu-zone-run-2");
  const html = app.ridesView();
  assert.match(html, /TSU Zone · Run 2/);
  assert.match(html, /Nya/);
  assert.match(html, /Raquel/);
  assert.doesNotMatch(html, /Aamiyah/);
  assert.match(html, /data-confirmation-status="waiting"/);
  assert.match(html, /data-confirmation-status="declined"/);
  assert.match(html, /Not coming/);
});
```

- [ ] **Step 3: Run the Run Details test and verify RED**

Run:

```bash
node --test --test-name-pattern="opens one run" tests/admin_ui.test.mjs
```

Expected: FAIL because `openDriverRun` and selected-run filtering do not exist.

- [ ] **Step 4: Implement selected-run helpers**

Add:

```js
function selectedDriverRun() {
  return driverRuns(state.route?.riders || []).find((run) => run.key === state.selectedDriverRunKey) || null;
}

function openDriverRun(key) {
  const run = driverRuns(state.route?.riders || []).find((item) => item.key === key);
  if (!run) {
    setDriverHome();
    return;
  }
  state.selectedDriverRunKey = run.key;
  state.selectedRider = null;
  state.view = "rides";
  render();
}
```

In the screen click handler, before generic action handling, add:

```js
const driverRunButton = event.target.closest("[data-driver-run]");
if (driverRunButton) {
  openDriverRun(driverRunButton.dataset.driverRun);
  return;
}
```

- [ ] **Step 5: Add confirmation status to rider rows**

Inside `routeStopRow(rider)`:

```js
const confirmation = riderConfirmationMeta(rider);
```

Add the visible status after the rider's ready text:

```html
<span class="rider-confirmation ${escapeHtml(confirmation.key)}" data-confirmation-status="${escapeHtml(confirmation.key)}">
  <span class="confirmation-dot" aria-hidden="true"></span>
  ${escapeHtml(confirmation.label)}
</span>
```

Add CSS:

```css
.rider-confirmation {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-weight: 750;
}

.confirmation-dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: currentColor;
}

.rider-confirmation.ready { color: #16803a; }
.rider-confirmation.waiting { color: #9a6500; }
.rider-confirmation.declined { color: #b42318; }
```

Keep the visible words so status does not depend on color.

- [ ] **Step 6: Filter and relabel `ridesView()`**

At the start of `ridesView()`:

```js
const run = selectedDriverRun();
if (!run) {
  state.selectedDriverRunKey = "";
  return driverHomeView();
}
const riders = run.riders;
```

Change the title to `Run details`, show `run.label`, `run.meetupLabel`, rider count, and departure time, then keep the existing route-stop cards, destination card, picked-up behavior, and route-start link based on the filtered `riders`.

The back button continues to use `data-action="driverHome"`. Rider detail back continues to use `data-action="rides"`, preserving the selected run.

- [ ] **Step 7: Run Run Details and existing rider-detail tests**

Run:

```bash
node --test --test-name-pattern="opens one run|driver dashboard summarizes route" tests/admin_ui.test.mjs
node --test tests/admin_ui.test.mjs
```

Expected: filtered-run and existing detail/checkmark assertions PASS with zero suite failures.

- [ ] **Step 8: Commit Task 3**

```bash
git add index.html tests/admin_ui.test.mjs
git commit -m "Add filtered driver run details"
```

---

### Task 4: Local Integration and Responsive Verification

**Files:**
- Modify if verification finds a defect: `index.html`
- Modify if a regression assertion is missing: `tests/admin_ui.test.mjs`

**Interfaces:**
- Consumes: complete Phase 1 implementation from Tasks 1-3.
- Produces: locally verified driver login → overview → run details → rider details flow.

- [ ] **Step 1: Run all automated tests**

Run:

```bash
node --test tests/admin_ui.test.mjs
node --test tests/ai_organizer_core.test.mjs
git diff --check
```

Expected: all tests PASS and `git diff --check` prints nothing.

- [ ] **Step 2: Start or reuse the local preview**

Run:

```bash
python3 -m http.server 4173
```

Expected: local RIDELIST is available at `http://127.0.0.1:4173/index.html`.

- [ ] **Step 3: Verify the mobile driver flow at 390×844**

Use the local browser to confirm:

1. Choose a driver.
2. Enter the existing driver passcode.
3. Confirm date, weather, rider total, and run rows fit without overlap.
4. Open a run and confirm only that run's riders appear.
5. Confirm green Ready, yellow Waiting, and red Not coming use both a dot and text.
6. Open rider details and confirm address protection, maps, message, call, and picked-up controls remain usable.

- [ ] **Step 4: Verify desktop layout at 1280×800**

Confirm the same flow remains centered, readable, and free of overlapping text or unstable row heights.

- [ ] **Step 5: Check the final diff is scoped**

Run:

```bash
git status --short
git diff -- index.html tests/admin_ui.test.mjs
```

Expected: only the approved local Phase 1 implementation appears in the relevant diff. Existing unrelated untracked files and `supabase/.temp/` remain untouched.

- [ ] **Step 6: Commit verification fixes, if any**

If Step 3 or 4 required a code or test correction:

```bash
git add index.html tests/admin_ui.test.mjs
git commit -m "Polish driver zone and run flow"
```

If no correction was required, do not create an empty commit.

---

## Completion Gate

Phase 1 is complete only when:

- Driver passcode login still works.
- The overview shows date, weather, total riders, and zone/run rows.
- Run Details filters riders correctly.
- Missing labels remain visible in `Assigned pickups`.
- Status dots and words render honestly from stored data.
- Rider details, navigation links, pickup checkmarks, route timing, and alerts still work.
- All tests pass.
- Mobile and desktop browser checks pass.
- No live Supabase change and no push occurred.

# People Bank Cleanup Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build calm admin People Bank edit and merge tools without cluttering the People list or modifying live PeopleData outside an explicit admin confirmation.

**Architecture:** Keep the existing static single-file RIDELIST frontend and admin state model. Add People-specific admin views behind the existing People tab, route all save actions through review screens, and extend existing Supabase SQL source with real notes storage plus a protected merge/archive RPC. No new frontend framework, no service-role key in the browser, and no live Supabase deployment in this implementation pass.

**Tech Stack:** Static `index.html`, vanilla JavaScript render helpers, Supabase Postgres RPC SQL source, Node `node:test`.

## Global Constraints

- Keep RIDELIST mobile-first and visually consistent with the existing black/white admin UI.
- Preserve the existing People search and add-to-route behavior.
- Add a person detail screen so each People card does not carry too many buttons.
- Add edit and merge tools behind the person detail screen.
- Show a review screen before saving edits or merges.
- Do not auto-clean, bulk-update, or modify live Supabase records during implementation.
- Do not change driver flows, route timing, weather, Sunday reset, or admin login behavior.
- Browser code must continue using only the Supabase publishable key.
- Supabase RPC source that uses `security definer` must keep `set search_path to ''` and schema-qualify relations.

---

## File Structure

- Modify `index.html`
  - Add People-specific admin state fields.
  - Add helper functions for person lookup, duplicate detection, edit draft normalization, review summaries, and merge preview.
  - Add new admin views: person detail, person edit, person review, merge review.
  - Add event and submit handlers for opening people, editing, reviewing, confirming, and returning.
- Modify `tests/admin_ui.test.mjs`
  - Extend the app test export with new People helper/view functions.
  - Add UI behavior tests before implementation.
- Modify `supabase/admin_ride_control.sql`
  - Add `notes` to `rides_private.ride_people`.
  - Include notes in snapshot/upsert output.
  - Add `public.ride_admin_merge_people(...)`.
- Modify `supabase/sunday_reset.sql`
  - Mirror the `notes` field and `ride_admin_merge_people` RPC because this file contains deployable copies of the admin People functions.

---

### Task 1: Calm People List And Person Detail

**Files:**
- Modify: `tests/admin_ui.test.mjs`
- Modify: `index.html`

**Interfaces:**
- Consumes: existing `state.admin.people`, `adminPeopleView()`, `adminPeopleResultCard(person, options)`, `adminPeopleResultsHtml(options)`, `openAdminPersonEditor(personId)`.
- Produces:
  - `adminDuplicateCandidates(person): Person[]`
  - `adminPeopleStatus(person): string`
  - `openAdminPersonDetail(personId): void`
  - `adminPersonDetailView(): string`

- [ ] **Step 1: Write the failing People list/detail tests**

Add this test to `tests/admin_ui.test.mjs` near the existing PeopleData tests:

```js
test("people list stays calm and opens person details before edit or merge", async () => {
  const app = await loadApp();

  app.state.admin = {
    drivers: [{ slug: "dawson", displayName: "Dawson", initials: "DW" }],
    stops: [],
    people: [
      {
        id: "person-1",
        name: "Nicholas Montiel",
        campusAddress: "",
        homeAddress: "11525 Burdine St, Houston, TX 77035",
        phone: "(832) 794-2032",
        preferredAddressType: "home",
        preferredAddress: "11525 Burdine St, Houston, TX 77035",
        sourceLabel: "PeopleData",
        notes: "Confirmed home pickup address.",
      },
      {
        id: "person-2",
        name: "Nicholas",
        campusAddress: "",
        homeAddress: "Old address needs review",
        phone: "",
        preferredAddressType: "home",
        preferredAddress: "Old address needs review",
        sourceLabel: "PeopleData",
        notes: "Possible duplicate.",
      },
    ],
  };
  app.state.adminDraftStops = [];
  app.state.adminDeletedStopIds = [];
  app.state.adminActiveTab = "people";
  app.state.adminPeopleSearch = "nicholas";

  const listHtml = app.adminView();
  assert.match(listHtml, /Nicholas Montiel/);
  assert.match(listHtml, /data-admin-person-open="person-1"/);
  assert.match(listHtml, /Possible duplicate/);
  assert.doesNotMatch(listHtml, /data-admin-person-edit="person-1"/);
  assert.doesNotMatch(listHtml, /data-admin-person-merge="person-1"/);

  app.state.adminSelectedPersonId = "person-2";
  assert.equal(typeof app.adminPersonDetailView, "function");
  const detailHtml = app.adminPersonDetailView();
  assert.match(detailHtml, /People Bank/);
  assert.match(detailHtml, /Nicholas/);
  assert.match(detailHtml, /Possible duplicate found: Nicholas Montiel/);
  assert.match(detailHtml, /data-admin-add-person="person-2"/);
  assert.match(detailHtml, /data-admin-person-edit="person-2"/);
  assert.match(detailHtml, /data-admin-person-merge="person-1"/);
});
```

Update the `loadApp()` export object to expose:

```js
adminPersonDetailView: typeof adminPersonDetailView === "function" ? adminPersonDetailView : undefined,
adminDuplicateCandidates: typeof adminDuplicateCandidates === "function" ? adminDuplicateCandidates : undefined,
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/admin_ui.test.mjs`

Expected: FAIL because `adminPersonDetailView`, `adminDuplicateCandidates`, and the new list markup do not exist.

- [ ] **Step 3: Add People detail state**

In `index.html`, add these fields to `state` near the existing admin People fields:

```js
adminSelectedPersonId: null,
adminPersonDraft: null,
adminPersonReviewMode: "",
adminMergePrimaryId: "",
adminMergeDuplicateId: "",
adminMergeDraft: null,
```

- [ ] **Step 4: Add duplicate/status helpers**

Add helpers near `adminPersonById`:

```js
function adminPersonNameKey(person) {
  return String(person?.name || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function adminPersonFirstName(person) {
  return adminPersonNameKey(person).split(" ")[0] || "";
}

function adminDuplicateCandidates(person) {
  if (!person) return [];
  const nameKey = adminPersonNameKey(person);
  const firstName = adminPersonFirstName(person);
  const phoneDigits = digitsOnly(person.phone || "");
  const addressKey = preferredPersonAddress(person).trim().toLowerCase();

  return adminPeople().filter((candidate) => {
    if (!candidate || candidate.id === person.id) return false;
    const candidateNameKey = adminPersonNameKey(candidate);
    const candidateFirstName = adminPersonFirstName(candidate);
    const candidatePhoneDigits = digitsOnly(candidate.phone || "");
    const candidateAddressKey = preferredPersonAddress(candidate).trim().toLowerCase();

    return (
      (nameKey && candidateNameKey && (nameKey === candidateNameKey || firstName === candidateFirstName)) ||
      (phoneDigits && candidatePhoneDigits && phoneDigits === candidatePhoneDigits) ||
      (addressKey && candidateAddressKey && addressKey === candidateAddressKey)
    );
  });
}

function adminPeopleStatus(person) {
  if (adminDuplicateCandidates(person).length) return "Possible duplicate";
  if (!String(person.phone || "").trim() || !preferredPersonAddress(person)) return "Needs review";
  return "Ready";
}
```

- [ ] **Step 5: Add person detail open/view**

Add:

```js
function openAdminPersonDetail(personId) {
  const person = adminPersonById(personId);
  if (!person) return;
  state.adminSelectedPersonId = personId;
  state.adminPersonDraft = null;
  state.adminPersonReviewMode = "";
  state.adminMergePrimaryId = "";
  state.adminMergeDuplicateId = "";
  state.adminMergeDraft = null;
  state.adminError = "";
  state.adminMessage = "";
  state.view = "adminPersonDetail";
  render();
}

function adminPersonDetailView() {
  const person = adminPersonById(state.adminSelectedPersonId);
  if (!person) {
    return `<div class="stack"><button class="back-button" type="button" data-action="adminBack" aria-label="Back">&larr;</button><section class="empty-card"><p>Person not found.</p></section></div>`;
  }

  const duplicates = adminDuplicateCandidates(person);
  const duplicate = duplicates[0];
  const mapAddress = preferredPersonAddress(person);

  return `
    <div class="stack">
      <section class="intro-block compact">
        <div class="admin-top-row">
          <div>
            <p class="eyebrow">People Bank</p>
            <h1>${escapeHtml(person.name || "Person")}</h1>
            <p>Saved rider details</p>
          </div>
          <button class="admin-icon-button" type="button" data-action="adminBack" aria-label="Back to people">
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M15 6 9 12l6 6" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
        </div>
      </section>
      ${duplicate ? `<section class="admin-message">Possible duplicate found: ${escapeHtml(duplicate.name)}</section>` : ""}
      ${state.adminError ? `<section class="admin-message error">${escapeHtml(state.adminError)}</section>` : ""}
      <section class="admin-form-card">
        <div class="detail-row"><small>Phone</small><strong>${escapeHtml(person.phone || "No phone listed")}</strong></div>
        <div class="detail-row"><small>Home</small><strong>${escapeHtml(person.homeAddress || "No home address saved")}</strong></div>
        <div class="detail-row"><small>Campus</small><strong>${escapeHtml(person.campusAddress || "No campus address saved")}</strong></div>
        <div class="detail-row"><small>Primary</small><strong>${escapeHtml(person.preferredAddressType === "campus" ? "Campus address" : "Home address")}</strong></div>
        <div class="detail-row"><small>Notes</small><strong>${escapeHtml(person.notes || person.sourceLabel || "No notes saved")}</strong></div>
      </section>
      <div class="admin-form-actions">
        <button class="primary-action" type="button" data-admin-add-person="${escapeHtml(person.id)}">Add to route</button>
        <button class="secondary-action" type="button" data-admin-person-edit="${escapeHtml(person.id)}">Edit</button>
      </div>
      <div class="admin-actions">
        ${mapAddress ? `<a class="admin-chip-button" href="${googleMaps(mapAddress)}" target="_blank" rel="noreferrer">Map</a>` : ""}
        ${person.phone ? `<a class="admin-chip-button" href="${telHref(person.phone)}">Call</a>` : ""}
        ${duplicate ? `<button class="admin-chip-button" type="button" data-admin-person-merge="${escapeHtml(duplicate.id)}">Merge duplicate</button>` : ""}
      </div>
    </div>`;
}
```

- [ ] **Step 6: Simplify People result cards**

Change `adminPeopleResultCard` so normal People list cards show one open action and no edit/merge buttons:

```js
function adminPeopleResultCard(person, options = {}) {
  const preferredAddress = preferredPersonAddress(person);
  const status = adminPeopleStatus(person);
  return `
    <article class="admin-rider-card admin-person-card" data-admin-person-open="${escapeHtml(person.id)}">
      <div class="admin-rider-row">
        <div class="admin-rider-copy">
          <strong>${escapeHtml(person.name)}</strong>
          <span>${escapeHtml(preferredAddress || "No address listed")}</span>
          <span>${escapeHtml(person.phone || "No phone listed")}</span>
          ${options.showData ? `<span>${escapeHtml(person.notes || person.sourceLabel || "PeopleData")}</span>` : ""}
        </div>
        <span class="pill ${status === "Possible duplicate" ? "gray" : ""}">${escapeHtml(status)}</span>
      </div>
    </article>`;
}
```

- [ ] **Step 7: Wire render and click handler**

In `render()`, add:

```js
else if (state.view === "adminPersonDetail") screen.innerHTML = adminPersonDetailView();
```

In the click handler, add before `adminAddPersonButton`:

```js
const adminPersonOpenButton = event.target.closest("[data-admin-person-open]");
if (adminPersonOpenButton) {
  openAdminPersonDetail(adminPersonOpenButton.dataset.adminPersonOpen);
  return;
}
```

- [ ] **Step 8: Run test to verify pass**

Run: `node --test tests/admin_ui.test.mjs`

Expected: PASS for new and existing UI tests.

- [ ] **Step 9: Commit Task 1**

Run:

```bash
git add index.html tests/admin_ui.test.mjs
git commit -m "Add calm People Bank detail view"
```

---

### Task 2: Person Edit Draft And Review Before Save

**Files:**
- Modify: `tests/admin_ui.test.mjs`
- Modify: `index.html`

**Interfaces:**
- Consumes: `adminPersonById(personId)`, `adminAddressOptionsForPerson(person)`, `rpc(name, body, options)`, `adminRpcOptions()`.
- Produces:
  - `openAdminPersonEdit(personId): void`
  - `adminPersonEditView(): string`
  - `adminPersonReviewView(): string`
  - `adminPersonDraftFromForm(form): PersonDraft`
  - `saveAdminPersonDraft(): Promise<void>`

- [ ] **Step 1: Write the failing edit/review tests**

Add:

```js
test("person edit reviews changes before saving PeopleData", async () => {
  const calls = [];
  const app = await loadApp(async (url, options = {}) => {
    calls.push({ url, options });
    return {
      ok: true,
      json: async () => ({
        ok: true,
        plan: { date: "2026-08-09" },
        destination: { label: "UH Hilton", address: "4800 Calhoun Rd" },
        drivers: [],
        stops: [],
        people: [],
      }),
    };
  });

  app.state.adminCode = "admin-test";
  app.state.admin = {
    drivers: [],
    stops: [],
    people: [
      {
        id: "person-1",
        name: "Nora",
        campusAddress: "Guinan Hall, University of St. Thomas, Houston, TX",
        homeAddress: "10819 Tryon Dr, Houston, TX 77065",
        phone: "(281) 704-1697",
        preferredAddressType: "campus",
        preferredAddress: "Guinan Hall, University of St. Thomas, Houston, TX",
        sourceLabel: "PeopleData",
        notes: "Confirm every semester.",
      },
    ],
  };
  app.state.adminSelectedPersonId = "person-1";

  assert.equal(typeof app.adminPersonEditView, "function");
  const editHtml = app.adminPersonEditView();
  assert.match(editHtml, /Edit Person/);
  assert.match(editHtml, /name="name" value="Nora"/);
  assert.match(editHtml, /name="notes"/);
  assert.match(editHtml, /Review changes/);

  app.state.adminPersonDraft = {
    id: "person-1",
    name: "Nora Osei",
    phone: "(281) 704-1697",
    campusAddress: "Guinan Hall, University of St. Thomas, Houston, TX",
    homeAddress: "10819 Tryon Dr, Houston, TX 77065",
    preferredAddressType: "home",
    sourceLabel: "PeopleData",
    notes: "Confirmed home for Sunday pickup.",
  };
  app.state.adminPersonReviewMode = "edit";

  assert.equal(typeof app.adminPersonReviewView, "function");
  const reviewHtml = app.adminPersonReviewView();
  assert.match(reviewHtml, /Review Person/);
  assert.match(reviewHtml, /Nora to Nora Osei/);
  assert.match(reviewHtml, /Primary address changed to Home/);
  assert.match(reviewHtml, /Confirm save/);

  assert.equal(calls.some((call) => String(call.url).includes("ride_admin_upsert_people")), false);
});
```

Update `loadApp()` export object with:

```js
adminPersonEditView: typeof adminPersonEditView === "function" ? adminPersonEditView : undefined,
adminPersonReviewView: typeof adminPersonReviewView === "function" ? adminPersonReviewView : undefined,
adminPersonChangeList: typeof adminPersonChangeList === "function" ? adminPersonChangeList : undefined,
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/admin_ui.test.mjs`

Expected: FAIL because edit/review helpers do not exist.

- [ ] **Step 3: Implement edit draft helpers**

Add helpers:

```js
function adminPersonEditable(person) {
  return {
    id: person?.id || "",
    name: person?.name || "",
    phone: person?.phone || "",
    campusAddress: person?.campusAddress || "",
    homeAddress: person?.homeAddress || "",
    preferredAddressType: person?.preferredAddressType || "home",
    sourceLabel: person?.sourceLabel || "PeopleData",
    notes: person?.notes || "",
  };
}

function adminPersonDraftFromForm(form) {
  const formData = new FormData(form);
  const preferredAddressType = String(formData.get("preferredAddressType") || "home");
  return {
    id: String(formData.get("id") || ""),
    name: String(formData.get("name") || "").trim(),
    phone: String(formData.get("phone") || "").trim(),
    campusAddress: String(formData.get("campusAddress") || "").trim(),
    homeAddress: String(formData.get("homeAddress") || "").trim(),
    preferredAddressType: preferredAddressType === "campus" ? "campus" : "home",
    sourceLabel: String(formData.get("sourceLabel") || "PeopleData").trim() || "PeopleData",
    notes: String(formData.get("notes") || "").trim(),
  };
}
```

- [ ] **Step 4: Implement person edit view**

Add:

```js
function openAdminPersonEdit(personId) {
  const person = adminPersonById(personId);
  if (!person) return;
  state.adminSelectedPersonId = personId;
  state.adminPersonDraft = adminPersonEditable(person);
  state.adminPersonReviewMode = "";
  state.adminError = "";
  state.view = "adminPersonEdit";
  render();
}

function adminPersonEditView() {
  const person = adminPersonById(state.adminSelectedPersonId);
  const draft = state.adminPersonDraft || adminPersonEditable(person);
  if (!person) return `<div class="stack"><button class="back-button" type="button" data-action="adminBack" aria-label="Back">&larr;</button><section class="empty-card"><p>Person not found.</p></section></div>`;

  return `
    <form class="stack" data-admin-form="person">
      <section class="intro-block compact">
        <div class="admin-top-row">
          <div>
            <p class="eyebrow">People Bank</p>
            <h1>Edit Person</h1>
            <p>Review before saving</p>
          </div>
          <button class="admin-icon-button" type="button" data-action="adminPersonBack" aria-label="Back to person">
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M15 6 9 12l6 6" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
        </div>
      </section>
      ${state.adminError ? `<section class="admin-message error">${escapeHtml(state.adminError)}</section>` : ""}
      <section class="admin-form-card">
        <input type="hidden" name="id" value="${escapeHtml(draft.id)}">
        <label><span>Name</span><input name="name" value="${escapeHtml(draft.name)}" required></label>
        <label><span>Phone</span><input name="phone" value="${escapeHtml(draft.phone)}" inputmode="tel"></label>
        <label><span>Campus address</span><input name="campusAddress" value="${escapeHtml(draft.campusAddress)}"></label>
        <label><span>Home address</span><input name="homeAddress" value="${escapeHtml(draft.homeAddress)}"></label>
        <section class="admin-field-group">
          <span class="admin-field-label">Primary address</span>
          <div class="admin-address-options">
            ${["campus", "home"].map((type) => `
              <label class="admin-address-option">
                <input type="radio" name="preferredAddressType" value="${type}" ${draft.preferredAddressType === type ? "checked" : ""}>
                <span><strong>${type === "campus" ? "Campus address" : "Home address"}</strong><span>${type === "campus" ? "Use campus address first" : "Use home address first"}</span></span>
              </label>
            `).join("")}
          </div>
        </section>
        <label><span>Source</span><input name="sourceLabel" value="${escapeHtml(draft.sourceLabel)}"></label>
        <label><span>Notes</span><textarea name="notes">${escapeHtml(draft.notes)}</textarea></label>
      </section>
      <div class="admin-form-actions">
        <button class="secondary-action" type="button" data-action="adminPersonBack">Cancel</button>
        <button class="primary-action" type="submit">Review changes</button>
      </div>
    </form>`;
}
```

- [ ] **Step 5: Implement review diff helpers and view**

Add:

```js
function adminPersonChangeList() {
  const before = adminPersonEditable(adminPersonById(state.adminSelectedPersonId));
  const after = state.adminPersonDraft;
  if (!after) return [];
  const changes = [];
  if (before.name !== after.name) changes.push(`Name changed from ${before.name} to ${after.name}`);
  if (before.phone !== after.phone) changes.push("Phone updated");
  if (before.campusAddress !== after.campusAddress) changes.push("Campus address updated");
  if (before.homeAddress !== after.homeAddress) changes.push("Home address updated");
  if (before.preferredAddressType !== after.preferredAddressType) changes.push(`Primary address changed to ${after.preferredAddressType === "campus" ? "Campus" : "Home"}`);
  if (before.notes !== after.notes) changes.push("Notes updated");
  if (before.sourceLabel !== after.sourceLabel) changes.push("Source updated");
  return changes;
}

function adminPersonReviewView() {
  const draft = state.adminPersonDraft;
  const changes = adminPersonChangeList();
  if (!draft) return `<div class="stack"><button class="back-button" type="button" data-action="adminPersonBack" aria-label="Back">&larr;</button><section class="empty-card"><p>No person changes to review.</p></section></div>`;

  return `
    <div class="stack">
      <section class="intro-block compact">
        <div class="admin-top-row">
          <div>
            <p class="eyebrow">People Bank</p>
            <h1>Review Person</h1>
            <p>${changes.length ? `${changes.length} ${changes.length === 1 ? "change" : "changes"} waiting` : "No changes"}</p>
          </div>
          <button class="admin-icon-button" type="button" data-action="adminPersonEditBack" aria-label="Back to edit">
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M15 6 9 12l6 6" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
        </div>
      </section>
      ${state.adminError ? `<section class="admin-message error">${escapeHtml(state.adminError)}</section>` : ""}
      <section class="admin-change-list" aria-label="PeopleData changes">
        ${changes.length ? changes.map((change) => `<article class="admin-change-card"><span class="admin-change-badge">*</span><span class="admin-change-copy"><strong>${escapeHtml(change)}</strong><span>${escapeHtml(draft.name)}</span></span></article>`).join("") : `<section class="empty-card"><p>No changes to save.</p></section>`}
      </section>
      <section class="admin-form-card">
        <div class="detail-row"><small>Name</small><strong>${escapeHtml(draft.name)}</strong></div>
        <div class="detail-row"><small>Phone</small><strong>${escapeHtml(draft.phone || "No phone listed")}</strong></div>
        <div class="detail-row"><small>Campus</small><strong>${escapeHtml(draft.campusAddress || "No campus address saved")}</strong></div>
        <div class="detail-row"><small>Home</small><strong>${escapeHtml(draft.homeAddress || "No home address saved")}</strong></div>
        <div class="detail-row"><small>Notes</small><strong>${escapeHtml(draft.notes || "No notes saved")}</strong></div>
      </section>
      <div class="admin-form-actions">
        <button class="secondary-action" type="button" data-action="adminPersonEditBack">Back</button>
        <button class="primary-action" type="button" data-action="adminPersonConfirmSave" ${changes.length ? "" : "disabled"}>${state.adminLoading ? "Saving..." : "Confirm save"}</button>
      </div>
    </div>`;
}
```

- [ ] **Step 6: Wire render, submit, and save**

Add render branches:

```js
else if (state.view === "adminPersonEdit") screen.innerHTML = adminPersonEditView();
else if (state.view === "adminPersonReview") screen.innerHTML = adminPersonReviewView();
```

In submit handler:

```js
const personForm = event.target.closest("[data-admin-form='person']");
if (personForm) {
  event.preventDefault();
  const draft = adminPersonDraftFromForm(personForm);
  if (!draft.name || (!draft.phone && !draft.campusAddress && !draft.homeAddress)) {
    state.adminError = "Name and at least one phone or address are required.";
    state.adminPersonDraft = draft;
    render();
    return;
  }
  state.adminPersonDraft = draft;
  state.adminPersonReviewMode = "edit";
  state.adminError = "";
  state.view = "adminPersonReview";
  render();
  return;
}
```

Add save function:

```js
async function saveAdminPersonDraft() {
  if (!state.adminPersonDraft) return;
  state.adminLoading = true;
  state.adminError = "";
  render();
  try {
    const saved = await rpc("ride_admin_upsert_people", {
      p_admin_code: state.adminCode,
      p_people: [state.adminPersonDraft],
      p_source_label: state.adminPersonDraft.sourceLabel || "PeopleData",
    }, adminRpcOptions());
    if (!saved?.ok) throw new Error(saved?.error || "people_save_failed");
    await loadAdminSnapshot(state.adminCode);
    state.adminActiveTab = "people";
    state.adminPeopleSearch = state.adminPersonDraft.name;
    state.adminMessage = `${state.adminPersonDraft.name} saved.`;
  } catch (error) {
    state.adminError = "Could not save this person.";
    console.error(error);
  } finally {
    state.adminLoading = false;
    render();
  }
}
```

Add click actions:

```js
if (action === "adminPersonBack") {
  state.adminError = "";
  state.view = "adminPersonDetail";
  render();
}
if (action === "adminPersonEditBack") {
  state.adminError = "";
  state.view = "adminPersonEdit";
  render();
}
if (action === "adminPersonConfirmSave") saveAdminPersonDraft();
```

Add:

```js
const adminPersonEditButton = event.target.closest("[data-admin-person-edit]");
if (adminPersonEditButton) {
  openAdminPersonEdit(adminPersonEditButton.dataset.adminPersonEdit);
  return;
}
```

- [ ] **Step 7: Run tests**

Run: `node --test tests/admin_ui.test.mjs`

Expected: PASS.

- [ ] **Step 8: Commit Task 2**

Run:

```bash
git add index.html tests/admin_ui.test.mjs
git commit -m "Add People Bank edit review flow"
```

---

### Task 3: Merge Review Flow

**Files:**
- Modify: `tests/admin_ui.test.mjs`
- Modify: `index.html`

**Interfaces:**
- Consumes: `adminDuplicateCandidates(person)`, `adminPersonEditable(person)`, `adminPersonById(personId)`.
- Produces:
  - `openAdminPersonMerge(duplicateId): void`
  - `adminMergeDraft(): MergeDraft | null`
  - `adminPersonMergeView(): string`
  - `saveAdminPersonMerge(): Promise<void>`

- [ ] **Step 1: Write failing merge tests**

Add:

```js
test("person merge review keeps merge behind detail and requires primary confirmation", async () => {
  const app = await loadApp();

  app.state.adminCode = "admin-test";
  app.state.admin = {
    drivers: [],
    stops: [],
    people: [
      {
        id: "person-1",
        name: "Nicholas Montiel",
        campusAddress: "",
        homeAddress: "11525 Burdine St, Houston, TX 77035",
        phone: "(832) 794-2032",
        preferredAddressType: "home",
        preferredAddress: "11525 Burdine St, Houston, TX 77035",
        sourceLabel: "PeopleData",
        notes: "Confirmed home pickup address.",
      },
      {
        id: "person-2",
        name: "Nicholas",
        campusAddress: "",
        homeAddress: "Old address needs review",
        phone: "",
        preferredAddressType: "home",
        preferredAddress: "Old address needs review",
        sourceLabel: "PeopleData",
        notes: "Duplicate candidate.",
      },
    ],
  };
  app.state.adminSelectedPersonId = "person-2";
  app.state.adminMergePrimaryId = "person-1";
  app.state.adminMergeDuplicateId = "person-2";

  assert.equal(typeof app.adminPersonMergeView, "function");
  const mergeHtml = app.adminPersonMergeView();
  assert.match(mergeHtml, /Review Merge/);
  assert.match(mergeHtml, /Keep this person/);
  assert.match(mergeHtml, /Nicholas Montiel/);
  assert.match(mergeHtml, /Archive duplicate/);
  assert.match(mergeHtml, /Confirm merge/);
  assert.match(mergeHtml, /One active person/);

  app.state.adminMergePrimaryId = "";
  const invalidHtml = app.adminPersonMergeView();
  assert.match(invalidHtml, /Choose the primary person/);
  assert.match(invalidHtml, /Confirm merge" disabled/);
});
```

Update `loadApp()` export object with:

```js
adminPersonMergeView: typeof adminPersonMergeView === "function" ? adminPersonMergeView : undefined,
adminMergeDraft: typeof adminMergeDraft === "function" ? adminMergeDraft : undefined,
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/admin_ui.test.mjs`

Expected: FAIL because merge helpers do not exist.

- [ ] **Step 3: Implement merge draft helpers**

Add:

```js
function adminMergedPerson(primary, duplicate) {
  const primaryDraft = adminPersonEditable(primary);
  const duplicateDraft = adminPersonEditable(duplicate);
  return {
    ...primaryDraft,
    phone: primaryDraft.phone || duplicateDraft.phone,
    campusAddress: primaryDraft.campusAddress || duplicateDraft.campusAddress,
    homeAddress: primaryDraft.homeAddress || duplicateDraft.homeAddress,
    notes: [primaryDraft.notes, duplicateDraft.notes ? `Merged duplicate: ${duplicateDraft.notes}` : "Merged duplicate record."].filter(Boolean).join(" "),
  };
}

function adminMergeDraft() {
  const primary = adminPersonById(state.adminMergePrimaryId);
  const duplicate = adminPersonById(state.adminMergeDuplicateId);
  if (!primary || !duplicate || primary.id === duplicate.id) return null;
  return {
    primaryId: primary.id,
    duplicateId: duplicate.id,
    primary,
    duplicate,
    finalPerson: adminMergedPerson(primary, duplicate),
  };
}
```

- [ ] **Step 4: Implement merge open/view**

Add:

```js
function openAdminPersonMerge(duplicateId) {
  const selected = adminPersonById(state.adminSelectedPersonId);
  const duplicate = adminPersonById(duplicateId);
  if (!selected || !duplicate || selected.id === duplicate.id) return;
  const selectedHasMoreData = [selected.phone, selected.homeAddress, selected.campusAddress].filter(Boolean).length >= [duplicate.phone, duplicate.homeAddress, duplicate.campusAddress].filter(Boolean).length;
  state.adminMergePrimaryId = selectedHasMoreData ? selected.id : duplicate.id;
  state.adminMergeDuplicateId = selectedHasMoreData ? duplicate.id : selected.id;
  state.adminError = "";
  state.view = "adminPersonMerge";
  render();
}

function adminPersonMergeOption(person, role) {
  const selected = state.adminMergePrimaryId === person.id;
  return `
    <label class="admin-address-option">
      <input type="radio" name="mergePrimary" value="${escapeHtml(person.id)}" ${selected ? "checked" : ""}>
      <span>
        <strong>${escapeHtml(person.name)}</strong>
        <span>${escapeHtml(role)} · ${escapeHtml([person.phone, preferredPersonAddress(person)].filter(Boolean).join(" · ") || "No phone or address")}</span>
      </span>
    </label>`;
}

function adminPersonMergeView() {
  const selected = adminPersonById(state.adminSelectedPersonId);
  const duplicate = adminPersonById(state.adminMergeDuplicateId);
  const draft = adminMergeDraft();
  const primary = draft?.primary;
  const finalPerson = draft?.finalPerson;
  const invalid = !draft;

  return `
    <div class="stack">
      <section class="intro-block compact">
        <div class="admin-top-row">
          <div>
            <p class="eyebrow">People Bank</p>
            <h1>Review Merge</h1>
            <p>Confirm before saving</p>
          </div>
          <button class="admin-icon-button" type="button" data-action="adminPersonBack" aria-label="Back to person">
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M15 6 9 12l6 6" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
        </div>
      </section>
      ${invalid ? `<section class="admin-message error">Choose the primary person before merging.</section>` : ""}
      <section class="admin-form-card">
        <span class="admin-field-label">Keep this person</span>
        <div class="admin-address-options">
          ${selected ? adminPersonMergeOption(selected, selected.id === state.adminMergeDuplicateId ? "Archive duplicate" : "Current person") : ""}
          ${duplicate ? adminPersonMergeOption(duplicate, duplicate.id === state.adminMergeDuplicateId ? "Archive duplicate" : "Duplicate candidate") : ""}
        </div>
      </section>
      <section class="admin-form-card">
        <div class="detail-row"><small>Name</small><strong>${escapeHtml(finalPerson?.name || "No primary selected")}</strong></div>
        <div class="detail-row"><small>Phone</small><strong>${escapeHtml(finalPerson?.phone || "No phone listed")}</strong></div>
        <div class="detail-row"><small>Home</small><strong>${escapeHtml(finalPerson?.homeAddress || "No home address saved")}</strong></div>
        <div class="detail-row"><small>Result</small><strong>${primary ? `One active person. ${adminPersonById(state.adminMergeDuplicateId)?.name || "Duplicate"} hidden from People search.` : "Choose the primary person."}</strong></div>
      </section>
      <div class="admin-form-actions">
        <button class="secondary-action" type="button" data-action="adminPersonBack">Back</button>
        <button class="primary-action admin-danger-action" type="button" data-action="adminPersonConfirmMerge" ${invalid ? "disabled" : ""}>${state.adminLoading ? "Saving..." : "Confirm merge"}</button>
      </div>
    </div>`;
}
```

- [ ] **Step 5: Wire merge events and save**

Add render branch:

```js
else if (state.view === "adminPersonMerge") screen.innerHTML = adminPersonMergeView();
```

Add click handling:

```js
const adminPersonMergeButton = event.target.closest("[data-admin-person-merge]");
if (adminPersonMergeButton) {
  openAdminPersonMerge(adminPersonMergeButton.dataset.adminPersonMerge);
  return;
}

if (action === "adminPersonConfirmMerge") saveAdminPersonMerge();
```

Add input handling:

```js
const mergePrimaryInput = event.target.closest("input[name='mergePrimary']");
if (mergePrimaryInput) {
  state.adminMergePrimaryId = mergePrimaryInput.value;
  state.adminMergeDuplicateId = adminPeople()
    .filter((person) => [state.adminSelectedPersonId, state.adminMergeDuplicateId].includes(person.id))
    .find((person) => person.id !== state.adminMergePrimaryId)?.id || state.adminMergeDuplicateId;
  render();
  return;
}
```

Add save:

```js
async function saveAdminPersonMerge() {
  const draft = adminMergeDraft();
  if (!draft) {
    state.adminError = "Choose the primary person before merging.";
    render();
    return;
  }
  state.adminLoading = true;
  state.adminError = "";
  render();
  try {
    const merged = await rpc("ride_admin_merge_people", {
      p_admin_code: state.adminCode,
      p_primary_person_id: draft.primaryId,
      p_duplicate_person_id: draft.duplicateId,
      p_primary_person: draft.finalPerson,
    }, adminRpcOptions());
    if (!merged?.ok) throw new Error(merged?.error || "people_merge_failed");
    await loadAdminSnapshot(state.adminCode);
    state.adminActiveTab = "people";
    state.adminPeopleSearch = draft.finalPerson.name;
    state.adminMessage = `${draft.finalPerson.name} merged.`;
  } catch (error) {
    state.adminError = "Could not merge these people.";
    console.error(error);
  } finally {
    state.adminLoading = false;
    render();
  }
}
```

- [ ] **Step 6: Run tests**

Run: `node --test tests/admin_ui.test.mjs`

Expected: PASS.

- [ ] **Step 7: Commit Task 3**

Run:

```bash
git add index.html tests/admin_ui.test.mjs
git commit -m "Add People Bank merge review flow"
```

---

### Task 4: Supabase SQL Source For Notes And Merge RPC

**Files:**
- Modify: `tests/admin_ui.test.mjs`
- Modify: `supabase/admin_ride_control.sql`
- Modify: `supabase/sunday_reset.sql`

**Interfaces:**
- Consumes: existing `rides_private.ride_people`, `ride_admin_snapshot`, `ride_admin_upsert_people`.
- Produces:
  - `notes` in PeopleData JSON.
  - `public.ride_admin_merge_people(p_admin_code text, p_primary_person_id uuid, p_duplicate_person_id uuid, p_primary_person jsonb) returns jsonb`.

- [ ] **Step 1: Write failing SQL source test**

Add a small test in `tests/admin_ui.test.mjs`:

```js
test("SQL source supports PeopleData notes and protected merge RPC", async () => {
  const sql = await readFile(new URL("../supabase/admin_ride_control.sql", import.meta.url), "utf8");

  assert.match(sql, /notes text not null default ''/);
  assert.match(sql, /'notes', p\.notes/);
  assert.match(sql, /create or replace function public\.ride_admin_merge_people/);
  assert.match(sql, /p_primary_person_id uuid/);
  assert.match(sql, /p_duplicate_person_id uuid/);
  assert.match(sql, /security definer/);
  assert.match(sql, /set search_path to ''/);
  assert.match(sql, /set active = false/);
  assert.match(sql, /grant execute on function public\.ride_admin_merge_people/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/admin_ui.test.mjs`

Expected: FAIL because SQL source has no notes column or merge RPC yet.

- [ ] **Step 3: Add notes column to `ride_people`**

In `supabase/admin_ride_control.sql`, add:

```sql
  notes text not null default '',
```

inside `create table if not exists rides_private.ride_people`.

Also add a defensive migration line after table creation:

```sql
alter table rides_private.ride_people
add column if not exists notes text not null default '';
```

- [ ] **Step 4: Include notes in snapshot and upsert**

In both snapshot JSON build blocks, add:

```sql
'notes', p.notes,
```

In `ride_admin_upsert_people`, add `notes` to the insert column list, values, and update set:

```sql
notes,
...
btrim(coalesce(v_person->>'notes', '')),
...
notes = excluded.notes,
```

- [ ] **Step 5: Add merge RPC**

Add before grants:

```sql
create or replace function public.ride_admin_merge_people(
  p_admin_code text,
  p_primary_person_id uuid,
  p_duplicate_person_id uuid,
  p_primary_person jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path to ''
as $$
declare
  v_primary record;
  v_duplicate record;
  v_name text := btrim(coalesce(p_primary_person->>'name', ''));
  v_preferred text := lower(btrim(coalesce(p_primary_person->>'preferredAddressType', 'home')));
begin
  if not rides_private.is_ride_admin_code(p_admin_code) then
    return jsonb_build_object('ok', false, 'error', 'invalid_admin_code');
  end if;

  if p_primary_person_id is null or p_duplicate_person_id is null or p_primary_person_id = p_duplicate_person_id then
    return jsonb_build_object('ok', false, 'error', 'invalid_merge_people');
  end if;

  if v_name = '' then
    return jsonb_build_object('ok', false, 'error', 'person_name_required');
  end if;

  if v_preferred not in ('home', 'campus') then
    v_preferred := 'home';
  end if;

  select p.id into v_primary
  from rides_private.ride_people p
  where p.id = p_primary_person_id
    and p.active
  limit 1;

  select p.id into v_duplicate
  from rides_private.ride_people p
  where p.id = p_duplicate_person_id
    and p.active
  limit 1;

  if v_primary.id is null or v_duplicate.id is null then
    return jsonb_build_object('ok', false, 'error', 'person_not_found');
  end if;

  update rides_private.ride_people p
  set name = v_name,
      name_key = rides_private.ride_people_name_key(v_name),
      campus_address = btrim(coalesce(p_primary_person->>'campusAddress', '')),
      home_address = btrim(coalesce(p_primary_person->>'homeAddress', '')),
      phone = btrim(coalesce(p_primary_person->>'phone', '')),
      preferred_address_type = v_preferred,
      source_label = btrim(coalesce(p_primary_person->>'sourceLabel', 'PeopleData')),
      notes = btrim(coalesce(p_primary_person->>'notes', '')),
      active = true,
      updated_at = now()
  where p.id = p_primary_person_id;

  update rides_private.ride_people p
  set active = false,
      notes = btrim(concat_ws(' ', nullif(p.notes, ''), 'Merged into ' || v_name || '.')),
      updated_at = now()
  where p.id = p_duplicate_person_id;

  return jsonb_build_object('ok', true, 'primaryPersonId', p_primary_person_id::text, 'duplicatePersonId', p_duplicate_person_id::text);
end;
$$;
```

- [ ] **Step 6: Add grant**

Add:

```sql
grant execute on function public.ride_admin_merge_people(text, uuid, uuid, jsonb) to anon, authenticated;
```

- [ ] **Step 7: Mirror source in `supabase/sunday_reset.sql`**

Apply the same `notes` additions and `ride_admin_merge_people` function if `sunday_reset.sql` still contains deployable copies of PeopleData snapshot/admin functions. Keep signatures identical.

- [ ] **Step 8: Run tests**

Run: `node --test tests/admin_ui.test.mjs`

Expected: PASS.

- [ ] **Step 9: Commit Task 4**

Run:

```bash
git add supabase/admin_ride_control.sql supabase/sunday_reset.sql tests/admin_ui.test.mjs
git commit -m "Add PeopleData notes and merge RPC source"
```

---

### Task 5: Final Regression And No-Live-Data Verification

**Files:**
- Modify only if tests reveal a direct bug in touched files.

**Interfaces:**
- Consumes all prior tasks.
- Produces a verified local implementation with no live PeopleData mutation.

- [ ] **Step 1: Run full local tests**

Run:

```bash
node --test tests/admin_ui.test.mjs tests/route_timing_core.test.mjs
```

Expected: all tests PASS.

- [ ] **Step 2: Run diff hygiene**

Run:

```bash
git diff --check
```

Expected: no output.

- [ ] **Step 3: Confirm no live Supabase writes were run**

Run:

```bash
git status --short
```

Expected: clean or only intended docs/source changes. Do not run `tests/admin_rpc.test.mjs` for this task unless the user supplies admin credentials and explicitly approves a live mutation test.

- [ ] **Step 4: Commit any final fixes**

If Step 1 or Step 2 required fixes, commit:

```bash
git add index.html tests/admin_ui.test.mjs supabase/admin_ride_control.sql supabase/sunday_reset.sql
git commit -m "Stabilize People Bank cleanup tools"
```

Skip this commit if no final fixes were needed.

---

## Self-Review

- Spec coverage: covered calm People list, detail-first edit/merge, review before save, real notes field, protected merge RPC source, validation, error states, and non-mutation of live data.
- Placeholder scan: no placeholder steps; each task includes concrete files, code direction, commands, and expected results.
- Type consistency: People draft field names match existing snapshot camelCase names and SQL JSON keys.

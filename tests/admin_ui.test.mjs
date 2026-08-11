import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

async function loadApp(fetchImpl) {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
  assert.ok(script, "index.html should include the app script");
  const storage = new Map();

  const element = () => ({
    hidden: false,
    textContent: "",
    value: "",
    innerHTML: "",
    dataset: {},
    classList: {
      add() {},
      remove() {},
      contains() {
        return false;
      },
      toggle() {},
    },
    addEventListener() {},
    querySelector() {
      return element();
    },
  });

  const context = {
    console,
    encodeURIComponent,
    FormData: class {},
    localStorage: {
      getItem(key) {
        return storage.get(key) || null;
      },
      setItem(key, value) {
        storage.set(key, String(value));
      },
    },
    document: {
      querySelector() {
        return element();
      },
      querySelectorAll() {
        return [];
      },
    },
    fetch: fetchImpl || (async () => ({
      ok: true,
      json: async () => [],
    })),
  };

  vm.createContext(context);
  vm.runInContext(`${script}
    globalThis.__app = {
      state,
      adminView,
      adminReviewView: typeof adminReviewView === "function" ? adminReviewView : undefined,
      adminResetView: typeof adminResetView === "function" ? adminResetView : undefined,
      adminEditView,
      adminPersonDetailView: typeof adminPersonDetailView === "function" ? adminPersonDetailView : undefined,
      adminPersonEditView: typeof adminPersonEditView === "function" ? adminPersonEditView : undefined,
      adminPersonReviewView: typeof adminPersonReviewView === "function" ? adminPersonReviewView : undefined,
      adminPersonChangeList: typeof adminPersonChangeList === "function" ? adminPersonChangeList : undefined,
      adminPersonMergeView: typeof adminPersonMergeView === "function" ? adminPersonMergeView : undefined,
      adminMergeDraft: typeof adminMergeDraft === "function" ? adminMergeDraft : undefined,
      saveAdminPersonMerge: typeof saveAdminPersonMerge === "function" ? saveAdminPersonMerge : undefined,
      saveAdminPersonArchive: typeof saveAdminPersonArchive === "function" ? saveAdminPersonArchive : undefined,
      adminDuplicateCandidates: typeof adminDuplicateCandidates === "function" ? adminDuplicateCandidates : undefined,
      adminRiderNameSuggestions: typeof adminRiderNameSuggestions === "function" ? adminRiderNameSuggestions : undefined,
      adminAddressOptionsForPerson: typeof adminAddressOptionsForPerson === "function" ? adminAddressOptionsForPerson : undefined,
      returnToAdminPersonDetailFromAdd: typeof returnToAdminPersonDetailFromAdd === "function" ? returnToAdminPersonDetailFromAdd : undefined,
      driverProfileCard,
      driverHomeView,
      ridesView,
      detailView,
      driverRouteSummary,
      routeTimingForDriver: typeof routeTimingForDriver === "function" ? routeTimingForDriver : undefined,
      secureRouteTimingRequest: typeof secureRouteTimingRequest === "function" ? secureRouteTimingRequest : undefined,
      adminRouteWarnings: typeof adminRouteWarnings === "function" ? adminRouteWarnings : undefined,
      weatherSummaryText: typeof weatherSummaryText === "function" ? weatherSummaryText : undefined,
      adminChangedCount,
      adminChangeList: typeof adminChangeList === "function" ? adminChangeList : undefined,
      nextSundayDate: typeof nextSundayDate === "function" ? nextSundayDate : undefined,
      __storage: localStorage,
    };
  `, context);

  return context.__app;
}

test("app contains admin ride control entry points", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");

  assert.match(html, /data-action="admin"/);
  assert.match(html, /modalClose/);
  assert.match(html, /Admin passcode/);
  assert.doesNotMatch(html, /id="adminEmail"/);
  assert.doesNotMatch(html, /id="adminPassword"/);
  assert.doesNotMatch(html, /adminCodeFallback/);
  assert.doesNotMatch(html, /signInAdminWithPassword/);
  assert.match(html, /ride_app_context/);
  assert.match(html, /ride_admin_snapshot/);
  assert.match(html, /ride_admin_security_context/);
  assert.match(html, /ride_admin_activity/);
  assert.match(html, /ride_admin_publish_plan/);
  assert.match(html, /ride_admin_start_new_sunday/);
  assert.match(html, /const FALLBACK_PLAN_DATE = "2026-08-09"/);
  assert.match(html, /function adminView/);
  assert.match(html, /function adminResetView/);
  assert.match(html, /function adminEditView/);
});

test("SQL source supports PeopleData notes and protected merge RPC", async () => {
  const sql = await readFile(new URL("../supabase/admin_ride_control.sql", import.meta.url), "utf8");

  assert.match(sql, /notes text not null default ''/);
  assert.match(sql, /'notes', p\.notes/);
  assert.match(sql, /v_person_id uuid/);
  assert.match(sql, /where p\.id = v_person_id/);
  assert.match(sql, /create or replace function public\.ride_admin_merge_people/);
  assert.match(sql, /p_primary_person_id uuid/);
  assert.match(sql, /p_duplicate_person_id uuid/);
  assert.match(sql, /security definer/);
  assert.match(sql, /set search_path to ''/);
  assert.match(sql, /set active = false/);
  assert.match(sql, /grant execute on function public\.ride_admin_merge_people/);
  assert.match(sql, /create or replace function public\.ride_admin_archive_people/);
  assert.match(sql, /p_person_id uuid/);
  assert.match(sql, /where p\.id = p_person_id/);
  assert.match(sql, /grant execute on function public\.ride_admin_archive_people/);
  assert.doesNotMatch(sql, /Archived from People Bank/);
  assert.doesNotMatch(sql, /Merged into /);
});

test("driver route modal stays simple and admin login is passcode-only", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const driverModal = html.match(/async function openCodeModal[\s\S]*?function openAdminCodeModal/)?.[0] || "";
  const adminModal = html.match(/function openAdminCodeModal[\s\S]*?function closeCodeModal/)?.[0] || "";
  const submitCode = html.match(/async function submitCode[\s\S]*?if \(!state\.selectedDriver\)/)?.[0] || "";

  assert.match(driverModal, /document\.querySelector\("#modalTitle"\)\.textContent = "Passcode"/);
  assert.match(driverModal, /driverCode\.hidden = false/);
  assert.match(driverModal, /modalClose\.hidden = true/);
  assert.match(driverModal, /cancelCode\.hidden = false/);
  assert.match(driverModal, /codeForm\.classList\.remove\("admin-login-card"\)/);
  assert.match(adminModal, /state\.adminLoginMode = "code"/);
  assert.match(adminModal, /document\.querySelector\("#modalTitle"\)\.textContent = "Ride Control"/);
  assert.match(adminModal, /modalKicker\.hidden = false/);
  assert.match(adminModal, /modalDriver\.textContent = "Sunday · UH Hilton"/);
  assert.match(adminModal, /codeSubmit\.textContent = "Open Ride Control"/);
  assert.match(adminModal, /driverCode\.hidden = false/);
  assert.match(adminModal, /modalClose\.hidden = false/);
  assert.match(adminModal, /cancelCode\.hidden = true/);
  assert.doesNotMatch(adminModal, /adminAuthFields\.hidden = false/);
  assert.match(submitCode, /await loadAdminSnapshot\(driverCode\.value\)/);
  assert.doesNotMatch(submitCode, /signInAdminWithPassword/);
});

test("app exposes home screen icon metadata", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const manifest = JSON.parse(await readFile(new URL("../manifest.webmanifest", import.meta.url), "utf8"));

  assert.match(html, /<link rel="manifest" href="manifest\.webmanifest">/);
  assert.match(html, /<link rel="apple-touch-icon" sizes="180x180" href="assets\/apple-touch-icon\.png">/);
  assert.match(html, /<meta name="apple-mobile-web-app-title" content="RIDELIST">/);
  assert.equal(manifest.name, "RIDELIST");
  assert.equal(manifest.display, "standalone");
  assert.ok(manifest.icons.some((icon) => icon.src === "assets/app-icon-192.png" && icon.sizes === "192x192"));
  assert.ok(manifest.icons.some((icon) => icon.src === "assets/app-icon-512.png" && icon.sizes === "512x512"));
  await access(new URL("../assets/apple-touch-icon.png", import.meta.url));
  await access(new URL("../assets/app-icon-192.png", import.meta.url));
  await access(new URL("../assets/app-icon-512.png", import.meta.url));
});

test("driver profile cards show route areas instead of rider names", async () => {
  const app = await loadApp();

  const dannyHtml = app.driverProfileCard({
    slug: "danny",
    display_name: "Danny",
    initials: "DN",
    pickup_count: 2,
    subtitle: "Faith and Precious",
  });
  const preciousHtml = app.driverProfileCard({
    slug: "precious",
    display_name: "Precious",
    initials: "PR",
    pickup_count: 3,
    subtitle: "DaSilva, Emmanuel Mitch, and Christopher R",
  });
  const dawsonSummary = app.driverRouteSummary({
    slug: "dawson",
    subtitle: "Amanda and Sherese",
  });
  const dqSummary = app.driverRouteSummary({
    slug: "dq",
    subtitle: "A'lena and Christopher L",
  });
  const homeAreaHtml = app.driverProfileCard({
    slug: "unknown-driver",
    display_name: "Test Driver",
    initials: "TD",
    pickup_count: 1,
    route_label: "Home",
  });

  assert.match(dannyHtml, /Richmond Route/);
  assert.doesNotMatch(dannyHtml, /Faith and Precious/);
  assert.match(preciousHtml, /South Houston Route/);
  assert.doesNotMatch(preciousHtml, /DaSilva, Emmanuel Mitch, and Christopher R/);
  assert.equal(dawsonSummary.routeLabel, "West Houston Route");
  assert.equal(dqSummary.routeLabel, "South Houston Route");
  assert.doesNotMatch(homeAreaHtml, /Home Route/);
});

test("admin uses routes and people tabs with a review action for pending changes", async () => {
  const app = await loadApp();

  app.state.admin = {
    drivers: [
      { slug: "dawson", displayName: "Dawson", initials: "DW" },
      { slug: "naa", displayName: "Naa", initials: "NA" },
    ],
    stops: [
      {
        id: "stop-1",
        driverSlug: "dawson",
        stopOrder: 1,
        name: "Tinnie",
        phone: "713-000-0000",
        address: "3410 Wheeler Ave, Houston, TX",
        area: "UH",
        pickupTime: "12:25 PM",
        readyBy: "12:20 PM",
        routeLabel: "Ride 1",
        notes: "",
      },
      {
        id: "stop-2",
        driverSlug: "naa",
        stopOrder: 1,
        name: "Zay",
        phone: "",
        address: "5050 Sunflower St, Houston, TX 77033",
        area: "South Houston",
        pickupTime: "12:16 PM",
        readyBy: "12:11 PM",
        routeLabel: "Ride 1",
        notes: "",
      },
    ],
    people: [
      {
        id: "person-1",
        name: "Tinnie",
        campusAddress: "ICON Apartments TSU, 3410 Wheeler Ave, Houston, TX 77004",
        homeAddress: "",
        phone: "713-000-0000",
        preferredAddress: "ICON Apartments TSU, 3410 Wheeler Ave, Houston, TX 77004",
      },
      {
        id: "person-2",
        name: "Zay",
        campusAddress: "",
        homeAddress: "5050 Sunflower St, Houston, TX 77033",
        phone: "",
        preferredAddress: "5050 Sunflower St, Houston, TX 77033",
      },
    ],
  };
  app.state.adminDraftStops = app.state.admin.stops.map((stop) => ({ ...stop }));
  app.state.adminDeletedStopIds = [];

  const routesHtml = app.adminView();
  assert.match(routesHtml, /data-admin-tab="routes"/);
  assert.match(routesHtml, /data-admin-tab="people"/);
  assert.doesNotMatch(routesHtml, /data-admin-tab="riders"/);
  assert.doesNotMatch(routesHtml, /data-admin-tab="data"/);
  assert.doesNotMatch(routesHtml, /data-admin-tab="changes"/);
  assert.doesNotMatch(routesHtml, /Publish route changes/);

  app.state.adminActiveTab = "people";
  app.state.adminPeopleSearch = "tinnie";
  const peopleHtml = app.adminView();
  assert.match(peopleHtml, /PeopleData · 2 people stored/);
  assert.match(peopleHtml, /data-admin-people-search/);
  assert.match(peopleHtml, /Tinnie/);
  assert.match(peopleHtml, /data-admin-person-open="person-1"/);
  assert.doesNotMatch(peopleHtml, /Zay/);

  app.state.adminActiveTab = "routes";
  app.state.adminDraftStops.push({
    id: "temp-test",
    driverSlug: "naa",
    stopOrder: 2,
    name: "TEST New Rider",
    phone: "",
    address: "1 Test Way, Houston, TX",
    area: "Test",
    pickupTime: "",
    readyBy: "",
    routeLabel: "",
    notes: "",
  });
  const changes = app.adminChangeList();
  const routesWithChangeHtml = app.adminView();
  assert.equal(changes.length, 1);
  assert.match(routesWithChangeHtml, /1 change pending/);
  assert.match(routesWithChangeHtml, /data-action="adminReviewChanges"/);
  assert.doesNotMatch(routesWithChangeHtml, /Added TEST New Rider to Naa/);

  assert.equal(typeof app.adminReviewView, "function");
  const changesHtml = app.adminReviewView();
  assert.match(changesHtml, /Review Changes/);
  assert.match(changesHtml, /Added TEST New Rider to Naa/);
  assert.match(changesHtml, /Publish route changes \(1\)/);
});

test("admin routes collapse by driver and rider rows use move instead of remove", async () => {
  const app = await loadApp();

  app.state.admin = {
    drivers: [
      { slug: "dawson", displayName: "Dawson", initials: "DW" },
      { slug: "blue", displayName: "Blu", initials: "BLU" },
    ],
    stops: [
      {
        id: "stop-1",
        driverSlug: "dawson",
        stopOrder: 1,
        name: "Tinnie",
        phone: "713-000-0000",
        address: "3410 Wheeler Ave, Houston, TX",
        area: "UH",
        pickupTime: "12:25 PM",
        readyBy: "12:20 PM",
        routeLabel: "Ride 1",
        notes: "",
      },
    ],
    people: [],
  };
  app.state.adminDraftStops = app.state.admin.stops.map((stop) => ({ ...stop }));
  app.state.adminDeletedStopIds = [];
  app.state.adminActiveTab = "routes";
  app.state.adminExpandedDriverSlug = "";

  const collapsed = app.adminView();
  assert.match(collapsed, /data-admin-driver-toggle="dawson"/);
  assert.doesNotMatch(collapsed, /data-admin-edit="stop-1"/);
  assert.match(collapsed, /BLU/);

  app.state.adminExpandedDriverSlug = "dawson";
  const expanded = app.adminView();
  assert.match(expanded, /Tinnie/);
  assert.match(expanded, /data-admin-move="stop-1"/);
  assert.doesNotMatch(expanded, /data-admin-delete="stop-1"/);
});

test("admin routes page uses the target Ride Control chrome without extra cards", async () => {
  const app = await loadApp();

  app.state.admin = {
    drivers: [
      { slug: "john-mark", displayName: "John Mark", initials: "JM" },
      { slug: "dq", displayName: "DQ", initials: "DQ" },
      { slug: "dawson", displayName: "Dawson", initials: "DW" },
    ],
    stops: [
      {
        id: "stop-1",
        driverSlug: "john-mark",
        stopOrder: 1,
        name: "A'lena",
        phone: "",
        address: "",
        area: "",
        pickupTime: "",
        readyBy: "",
        routeLabel: "",
        notes: "",
      },
    ],
    people: [],
    security: { actor: { type: "code" } },
  };
  app.state.adminDraftStops = app.state.admin.stops.map((stop) => ({ ...stop }));
  app.state.adminActiveTab = "routes";

  const html = app.adminView();
  assert.match(html, /class="stack admin-control-screen"/);
  assert.match(html, /class="[^"]*admin-control-header[^"]*"/);
  assert.match(html, /class="[^"]*admin-close-button[^"]*"/);
  assert.match(html, /class="[^"]*admin-control-tabs[^"]*"/);
  assert.match(html, /class="[^"]*admin-control-stats[^"]*"/);
  assert.match(html, /class="secondary-action admin-reset-action" type="button" data-action="adminReset"/);
  assert.match(html, /data-detail-icon="calendar"/);
  assert.match(html, /class="primary-action admin-add-rider-action" type="button" data-action="adminNew"/);
  assert.match(html, /data-detail-icon="user-plus"/);
  assert.match(html, /0 Pickups/);
  assert.doesNotMatch(html, /admin-security-message/);
  assert.doesNotMatch(html, /Passcode fallback active/);
  assert.doesNotMatch(html, /No riders assigned[\s\S]*Add riders before final route timing/);
});

test("admin people tab keeps the icon Add rider action", async () => {
  const app = await loadApp();

  app.state.admin = {
    drivers: [{ slug: "john-mark", displayName: "John Mark", initials: "JM" }],
    stops: [],
    people: [{ id: "person-1", name: "Zarah", phone: "", homeAddress: "1221 Highland Row Ln, Houston, TX" }],
  };
  app.state.adminDraftStops = [];
  app.state.adminActiveTab = "people";

  const html = app.adminView();
  assert.match(html, /PeopleData · 1 people stored/);
  assert.match(html, /class="primary-action admin-add-rider-action" type="button" data-action="adminNew"/);
  assert.match(html, /data-detail-icon="user-plus"/);
});

test("people detail values use a softer text weight", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");

  const rule = html.match(/\.people-detail-copy strong\s*{[^}]*}/)?.[0] || "";
  assert.match(rule, /font-weight:\s*500;/);
  assert.doesNotMatch(rule, /font-weight:\s*900;/);
});

test("admin route headers summarize route area and first pickup timing", async () => {
  const app = await loadApp();

  app.state.admin = {
    drivers: [
      { slug: "joojo", displayName: "Joojo", initials: "JP" },
      { slug: "dawson", displayName: "Dawson", initials: "DW" },
    ],
    stops: [
      {
        id: "stop-1",
        driverSlug: "joojo",
        stopOrder: 1,
        name: "Nora",
        phone: "(281) 704-1697",
        address: "10819 Tryon Dr, Houston, TX",
        area: "Cypress",
        pickupTime: "11:00 AM",
        readyBy: "10:55 AM",
        routeLabel: "",
        notes: "",
      },
      {
        id: "stop-2",
        driverSlug: "joojo",
        stopOrder: 2,
        name: "Simi",
        phone: "",
        address: "17254 Cricketbriar Ct, Houston, TX",
        area: "Cypress",
        pickupTime: "Follow after Nora",
        readyBy: "",
        routeLabel: "",
        notes: "",
      },
    ],
    people: [],
  };
  app.state.adminDraftStops = app.state.admin.stops.map((stop) => ({ ...stop }));
  app.state.adminDeletedStopIds = [];
  app.state.adminActiveTab = "routes";
  app.state.adminExpandedDriverSlug = "joojo";

  const html = app.adminView();
  assert.match(html, /Cypress Route/);
  assert.match(html, /Starts 11:00 AM/);
  assert.match(html, /2 Pickups/);
  assert.match(html, /data-admin-edit="stop-1"/);
  assert.match(html, /data-admin-move="stop-1"/);
  assert.match(html, /href="tel:\+12817041697"/);
  assert.match(html, /target="_blank" rel="noreferrer">Map/);
});

test("driver dashboard summarizes route and unlocks UH route after all pickups", async () => {
  const app = await loadApp();

  app.state.planDate = "2026-08-09";
  app.state.route = {
    plan: { date: "2026-08-09" },
    driver: { slug: "joojo", displayName: "Joojo", initials: "JP" },
    destination: { label: "UH Hilton", address: "4800 Calhoun Rd, Houston, TX 77204" },
    riders: [
      {
        stopOrder: 1,
        name: "Nora",
        phone: "(281) 704-1697",
        address: "10819 Tryon Dr, Houston, TX",
        area: "Cypress",
        pickupTime: "11:00 AM",
        readyBy: "10:55 AM",
        routeLabel: "",
        notes: "",
      },
      {
        stopOrder: 2,
        name: "Simi",
        phone: "",
        address: "17254 Cricketbriar Ct, Houston, TX",
        area: "Cypress",
        pickupTime: "Follow after Nora",
        readyBy: "",
        routeLabel: "",
        notes: "",
      },
    ],
  };

  const homeHtml = app.driverHomeView();
  assert.match(homeHtml, /Route overview/);
  assert.match(homeHtml, /Cypress Route/);
  assert.match(homeHtml, /First pickup: 11:00 AM/);
  assert.match(homeHtml, /Total route/);
  assert.match(homeHtml, /1 hr 22 min to UH Hilton/);
  assert.match(homeHtml, /Ends at UH Hilton/);
  assert.match(homeHtml, /Weather/);
  assert.doesNotMatch(homeHtml, /<section class="destination-block">/);

  app.state.weatherOpen = true;
  app.state.weatherStatus = "ready";
  app.state.weatherForecast = {
    condition: "Partly cloudy",
    high: 92,
    low: 78,
    rainChance: 30,
    wind: 12,
  };
  const weatherHtml = app.driverHomeView();
  assert.match(weatherHtml, /Partly cloudy · 92° \/ 78° · Rain 30%/);
  assert.match(weatherHtml, /Wind 12 mph/);

  const pendingHtml = app.ridesView();
  assert.match(pendingHtml, /Start route to Nora/);
  assert.match(pendingHtml, /Ready by 10:55 AM/);
  assert.match(pendingHtml, /Details/);
  assert.match(pendingHtml, /aria-label="Open Nora pickup details"/);
  assert.doesNotMatch(pendingHtml, /10819 Tryon Dr/);
  assert.doesNotMatch(pendingHtml, /All pickups complete/);

  app.state.selectedRider = app.state.route.riders[0];
  const detailHtml = app.detailView();
  assert.match(detailHtml, /class="contact-actions"/);
  assert.match(detailHtml, /href="sms:\+12817041697"/);
  assert.match(detailHtml, />Message</);
  assert.match(detailHtml, />Call</);
  assert.doesNotMatch(detailHtml, /Call rider/);

  app.__storage.setItem("ride-picked-2026-08-09-joojo-1", "1");
  const partialHtml = app.ridesView();
  assert.match(partialHtml, /class="route-stop is-picked"[\s\S]*<span class="stop-number">✓<\/span>[\s\S]*<strong>Nora<\/strong>/);
  assert.doesNotMatch(partialHtml, /<span class="stop-number">1<\/span>[\s\S]*<strong>Nora<\/strong>/);
  assert.match(partialHtml, /<span class="stop-number">2<\/span>[\s\S]*<strong>Simi<\/strong>/);

  app.__storage.setItem("ride-picked-2026-08-09-joojo-2", "1");

  const completeHtml = app.ridesView();
  assert.match(completeHtml, /All pickups complete/);
  assert.match(completeHtml, /Start route to UH Hilton/);
});

test("driver dashboard prefers secure route timing when available", async () => {
  const app = await loadApp();

  app.state.planDate = "2026-08-09";
  app.state.route = {
    plan: { date: "2026-08-09" },
    driver: { slug: "joojo", displayName: "Joojo", initials: "JP" },
    destination: { label: "UH Hilton", address: "4800 Calhoun Rd, Houston, TX 77204" },
    riders: [
      {
        stopOrder: 1,
        name: "Nora",
        phone: "(281) 704-1697",
        address: "10819 Tryon Dr, Houston, TX",
        area: "Cypress",
        pickupTime: "11:00 AM",
        readyBy: "10:55 AM",
        routeLabel: "",
        notes: "",
      },
    ],
  };
  app.state.routeTimings = {
    joojo: {
      status: "ready",
      durationText: "42 min",
      etaText: "11:42 AM",
      distanceText: "22 mi",
    },
  };

  const html = app.driverHomeView();
  assert.match(html, /Total route: 42 min/);
  assert.match(html, /Estimated UH arrival: 11:42 AM/);
  assert.doesNotMatch(html, /1 hr 22 min to UH Hilton/);
});

test("admin route cards show route warnings and timing status", async () => {
  const app = await loadApp();

  app.state.admin = {
    drivers: [{ slug: "dq", displayName: "DQ", initials: "DQ" }],
    stops: [
      {
        id: "stop-1",
        driverSlug: "dq",
        stopOrder: 1,
        name: "A'lena",
        phone: "",
        address: "9425 Asheville Rd, Houston, TX",
        area: "South Houston",
        pickupTime: "",
        readyBy: "",
        routeLabel: "",
        notes: "",
      },
      {
        id: "stop-2",
        driverSlug: "dq",
        stopOrder: 2,
        name: "Christopher L",
        phone: "832-942-1381",
        address: "",
        area: "South Houston",
        pickupTime: "11:30 AM",
        readyBy: "",
        routeLabel: "",
        notes: "",
      },
    ],
    people: [],
  };
  app.state.adminDraftStops = app.state.admin.stops.map((stop) => ({ ...stop }));
  app.state.adminDeletedStopIds = [];
  app.state.adminActiveTab = "routes";
  app.state.adminExpandedDriverSlug = "dq";
  app.state.routeTimingStatus = "error";
  app.state.routeTimings = {};

  assert.equal(typeof app.adminRouteWarnings, "function");
  const warnings = app.adminRouteWarnings(app.state.admin.drivers[0], app.state.adminDraftStops, null);
  assert.equal(
    JSON.stringify(warnings.map((warning) => warning.label)),
    JSON.stringify(["Missing number", "Missing pickup time", "Missing address", "Route time unavailable"]),
  );

  const html = app.adminView();
  assert.match(html, /A&#39;lena: phone missing/);
  assert.match(html, /A&#39;lena: pickup time missing/);
  assert.match(html, /Christopher L: pickup address missing/);
  assert.match(html, /Route timing paused/);
});

test("admin route warnings summarize exact rider fixes", async () => {
  const app = await loadApp();

  app.state.admin = {
    drivers: [{ slug: "dq", displayName: "DQ", initials: "DQ" }],
    stops: [
      {
        id: "stop-1",
        driverSlug: "dq",
        stopOrder: 1,
        name: "A'lena",
        phone: "",
        address: "9425 Asheville Rd, Houston, TX",
        area: "South Houston",
        pickupTime: "",
        readyBy: "",
        routeLabel: "",
        notes: "",
      },
      {
        id: "stop-2",
        driverSlug: "dq",
        stopOrder: 2,
        name: "Christopher L",
        phone: "832-942-1381",
        address: "",
        area: "South Houston",
        pickupTime: "11:30 AM",
        readyBy: "",
        routeLabel: "",
        notes: "",
      },
    ],
    people: [],
  };
  app.state.adminDraftStops = app.state.admin.stops.map((stop) => ({ ...stop }));
  app.state.adminDeletedStopIds = [];
  app.state.adminActiveTab = "routes";
  app.state.adminExpandedDriverSlug = "dq";
  app.state.routeTimingStatus = "error";
  app.state.routeTimings = {};

  const html = app.adminView();
  assert.match(html, /4 things need attention/);
  assert.match(html, /Fix these before final route timing/);
  assert.match(html, /A&#39;lena: phone missing/);
  assert.match(html, /A&#39;lena: pickup time missing/);
  assert.match(html, /Christopher L: pickup address missing/);
  assert.match(html, /Route timing paused/);
  assert.match(html, /data-admin-edit="stop-1"[\s\S]*Fix rider/);
  assert.match(html, /data-admin-edit="stop-2"[\s\S]*Fix rider/);
});

test("secure route timing request calls Supabase Edge Function without Google keys", async () => {
  const calls = [];
  const app = await loadApp(async (url, options = {}) => {
    calls.push({ url, options });
    if (!String(url).includes("/functions/v1/ride-route-timing")) {
      return {
        ok: true,
        json: async () => String(url).includes("ride_app_context")
          ? { ok: true, plan: { date: "2026-08-09" }, destination: { label: "UH Hilton", address: "4800 Calhoun Rd" } }
          : [],
      };
    }
    return {
      ok: true,
      json: async () => ({ ok: true, timings: { joojo: { status: "ready", durationText: "40 min" } } }),
    };
  });

  assert.equal(typeof app.secureRouteTimingRequest, "function");
  const payload = await app.secureRouteTimingRequest("driver", {
    planDate: "2026-08-09",
    driverSlug: "joojo",
    accessCode: "rides123",
  });

  assert.equal(payload.ok, true);
  const timingCall = calls.find((call) => String(call.url).includes("/functions/v1/ride-route-timing"));
  assert.ok(timingCall, "route timing should call the Edge Function");
  assert.match(timingCall.url, /\/functions\/v1\/ride-route-timing$/);
  assert.equal(timingCall.options.method, "POST");
  assert.match(timingCall.options.headers.apikey, /^sb_publishable_/);
  assert.doesNotMatch(JSON.stringify(timingCall), /GOOGLE|AIza|Routes API/i);
});

test("people tab uses the PeopleData bank with full rider details", async () => {
  const app = await loadApp();

  app.state.admin = {
    drivers: [{ slug: "dawson", displayName: "Dawson", initials: "DW" }],
    stops: [],
    people: [
      {
        id: "person-1",
        name: "Siah",
        campusAddress: "2304 Sam Houston Ave, Huntsville, TX",
        homeAddress: "2304 Sam Houston Ave, Huntsville, TX",
        phone: "(301) 543-7407",
        preferredAddress: "2304 Sam Houston Ave, Huntsville, TX",
        sourceLabel: "7_06 PeopleData",
        notes: "",
      },
      {
        id: "person-2",
        name: "Nicholas",
        campusAddress: "",
        homeAddress: "11525 Burdine St, Houston, TX 77035",
        phone: "(832) 794-2032",
        preferredAddress: "11525 Burdine St, Houston, TX 77035",
      },
    ],
  };
  app.state.adminDraftStops = [];
  app.state.adminDeletedStopIds = [];

  app.state.adminActiveTab = "people";
  app.state.adminPeopleSearch = "siah";
  const siahHtml = app.adminView();
  assert.match(siahHtml, /PeopleData/);
  assert.match(siahHtml, /data-admin-people-search/);
  assert.match(siahHtml, /Siah/);
  assert.match(siahHtml, /data-admin-person-open="person-1"/);
  assert.doesNotMatch(siahHtml, /Ready/);
  assert.doesNotMatch(siahHtml, /7_06 PeopleData/);
  assert.doesNotMatch(siahHtml, /Nicholas/);

  app.state.adminPeopleSearch = "burdine";
  const nicholasHtml = app.adminView();
  assert.match(nicholasHtml, /PeopleData/);
  assert.match(nicholasHtml, /Nicholas/);
  assert.match(nicholasHtml, /11525 Burdine St/);
});

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

  assert.equal(typeof app.adminDuplicateCandidates, "function");
  assert.deepEqual(
    app.adminDuplicateCandidates(app.state.admin.people[1]).map((person) => person.id),
    ["person-1"],
  );

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

test("people detail matches the target icon-card action layout", async () => {
  const app = await loadApp();

  app.state.admin = {
    drivers: [{ slug: "dawson", displayName: "Dawson", initials: "DW" }],
    stops: [],
    people: [
      {
        id: "person-1",
        name: "a'Lena Brother",
        campusAddress: "",
        homeAddress: "9425 Asheville Dr, Houston, TX",
        phone: "",
        preferredAddressType: "home",
        preferredAddress: "9425 Asheville Dr, Houston, TX",
        sourceLabel: "07_26 PeopleData",
        notes: "",
      },
      {
        id: "person-2",
        name: "a'Lena",
        campusAddress: "",
        homeAddress: "9425 Asheville Dr, Houston, TX",
        phone: "",
        preferredAddressType: "home",
        preferredAddress: "9425 Asheville Dr, Houston, TX",
        sourceLabel: "07_26 PeopleData",
        notes: "",
      },
    ],
  };
  app.state.adminSelectedPersonId = "person-1";

  const detailHtml = app.adminPersonDetailView();
  assert.match(detailHtml, /people-detail-screen/);
  assert.match(detailHtml, /people-detail-back/);
  assert.match(detailHtml, /people-detail-warning/);
  assert.match(detailHtml, /Possible duplicate found: a&#39;Lena/);
  assert.match(detailHtml, /data-detail-icon="phone"/);
  assert.match(detailHtml, /data-detail-icon="home"/);
  assert.match(detailHtml, /data-detail-icon="campus"/);
  assert.match(detailHtml, /data-detail-icon="primary"/);
  assert.match(detailHtml, /data-detail-icon="notes"/);
  assert.match(detailHtml, /people-detail-primary-actions/);
  assert.match(detailHtml, /people-detail-action primary/);
  assert.match(detailHtml, /people-detail-action secondary/);
  assert.match(detailHtml, /people-detail-pill-row/);
  assert.match(detailHtml, /people-detail-pill/);
  assert.doesNotMatch(detailHtml, /07_26 PeopleData/);
});

test("people who share a home address are not automatically duplicates", async () => {
  const app = await loadApp();

  app.state.admin = {
    drivers: [],
    stops: [],
    people: [
      {
        id: "person-1",
        name: "Zarah",
        campusAddress: "",
        homeAddress: "1221 Highland Row Ln, Houston, TX",
        phone: "(936) 662-1716",
        preferredAddressType: "home",
        preferredAddress: "1221 Highland Row Ln, Houston, TX",
        sourceLabel: "PeopleData",
        notes: "",
      },
      {
        id: "person-2",
        name: "Daglyn",
        campusAddress: "",
        homeAddress: "1221 Highland Row Ln, Houston, TX",
        phone: "(936) 555-0101",
        preferredAddressType: "home",
        preferredAddress: "1221 Highland Row Ln, Houston, TX",
        sourceLabel: "PeopleData",
        notes: "",
      },
    ],
  };

  assert.equal(typeof app.adminDuplicateCandidates, "function");
  assert.equal(JSON.stringify(app.adminDuplicateCandidates(app.state.admin.people[0])), JSON.stringify([]));

  app.state.adminActiveTab = "people";
  app.state.adminPeopleSearch = "zarah";
  const listHtml = app.adminView();
  assert.match(listHtml, /Zarah/);
  assert.doesNotMatch(listHtml, /Possible duplicate/);

  app.state.adminSelectedPersonId = "person-1";
  const detailHtml = app.adminPersonDetailView();
  assert.match(detailHtml, /Zarah/);
  assert.match(detailHtml, /No notes saved/);
  assert.doesNotMatch(detailHtml, /PeopleData/);
  assert.doesNotMatch(detailHtml, /Possible duplicate found: Daglyn/);
  assert.doesNotMatch(detailHtml, /data-admin-person-merge="person-2"/);
});

test("person edit reviews changes before saving PeopleData", async () => {
  const calls = [];
  const app = await loadApp(async (url, options = {}) => {
    calls.push({ url, options });
    if (String(url).includes("ride_driver_directory")) {
      return {
        ok: true,
        json: async () => [],
      };
    }

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
  assert.doesNotMatch(editHtml, /name="sourceLabel"/);
  assert.doesNotMatch(editHtml, />Source</);
  assert.match(editHtml, /Archive from People Bank/);
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
  assert.equal(typeof app.adminPersonChangeList, "function");
  assert.equal(
    JSON.stringify(app.adminPersonChangeList()),
    JSON.stringify([
      "Name changed from Nora to Nora Osei",
      "Primary address changed to Home",
      "Notes updated",
    ]),
  );

  const reviewHtml = app.adminPersonReviewView();
  assert.match(reviewHtml, /Review Person/);
  assert.match(reviewHtml, /Nora to Nora Osei/);
  assert.match(reviewHtml, /Primary address changed to Home/);
  assert.match(reviewHtml, /Confirm save/);

  assert.equal(calls.some((call) => String(call.url).includes("ride_admin_upsert_people")), false);
});

test("person archive stays in edit and hides the person after confirmation", async () => {
  const calls = [];
  const app = await loadApp(async (url, options = {}) => {
    calls.push({ url, options });
    if (String(url).includes("ride_driver_directory")) {
      return {
        ok: true,
        json: async () => [],
      };
    }

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
        campusAddress: "",
        homeAddress: "10819 Tryon Dr, Houston, TX 77065",
        phone: "(281) 704-1697",
        preferredAddressType: "home",
        preferredAddress: "10819 Tryon Dr, Houston, TX 77065",
        sourceLabel: "7_06 PeopleData",
        notes: "",
      },
    ],
  };
  app.state.adminSelectedPersonId = "person-1";

  const detailHtml = app.adminPersonDetailView();
  assert.doesNotMatch(detailHtml, /Archive from People Bank/);

  const editHtml = app.adminPersonEditView();
  assert.match(editHtml, /data-action="adminPersonArchive"/);

  app.state.adminPersonReviewMode = "archive";
  const reviewHtml = app.adminPersonReviewView();
  assert.match(reviewHtml, /Review Archive/);
  assert.match(reviewHtml, /Nora will be hidden from normal People Bank search/);
  assert.match(reviewHtml, /Confirm archive/);

  assert.equal(typeof app.saveAdminPersonArchive, "function");
  await app.saveAdminPersonArchive();

  const archiveCall = calls.find((call) => String(call.url).includes("ride_admin_archive_people"));
  assert.ok(archiveCall, "archive should call the People Bank archive RPC");
  assert.match(JSON.stringify(archiveCall.options.body), /person-1/);
});

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
  assert.equal(typeof app.adminMergeDraft, "function");
  assert.equal(app.adminMergeDraft().finalPerson.name, "Nicholas Montiel");
  assert.equal(app.adminMergeDraft().finalPerson.notes, "Confirmed home pickup address. Duplicate candidate.");

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

test("merge failure explains when live Supabase merge support is missing", async () => {
  const app = await loadApp(async (url) => {
    if (String(url).includes("ride_admin_merge_people")) {
      return {
        ok: false,
        text: async () => JSON.stringify({
          code: "PGRST202",
          message: "Could not find the function public.ride_admin_merge_people in the schema cache",
        }),
      };
    }

    if (String(url).includes("ride_driver_directory")) {
      return {
        ok: true,
        json: async () => [],
      };
    }

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
        name: "Fabio",
        campusAddress: "North American University, 11801 S Gessner Dr, Houston, TX 77071",
        homeAddress: "",
        phone: "",
        preferredAddressType: "campus",
        preferredAddress: "North American University, 11801 S Gessner Dr, Houston, TX 77071",
        sourceLabel: "PeopleData",
        notes: "",
      },
      {
        id: "person-2",
        name: "Fabio Nhampossa",
        campusAddress: "North American University, 11801 S Gessner Dr, Houston, TX 77071",
        homeAddress: "",
        phone: "(281) 615-2502",
        preferredAddressType: "campus",
        preferredAddress: "North American University, 11801 S Gessner Dr, Houston, TX 77071",
        sourceLabel: "PeopleData",
        notes: "",
      },
    ],
  };
  app.state.adminSelectedPersonId = "person-1";
  app.state.adminMergePrimaryId = "person-2";
  app.state.adminMergeDuplicateId = "person-1";

  assert.equal(typeof app.saveAdminPersonMerge, "function");
  await app.saveAdminPersonMerge();

  assert.match(app.state.adminError, /People Bank merge needs the Supabase setup first/);
});

test("add rider form searches PeopleData and offers add-new fallback", async () => {
  const app = await loadApp();

  app.state.admin = {
    drivers: [{ slug: "dq", displayName: "DQ", initials: "DQ" }],
    stops: [],
    people: [
      {
        id: "person-1",
        name: "A'lena",
        campusAddress: "",
        homeAddress: "9425 Asheville Rd, Houston, TX",
        phone: "7139022393",
        preferredAddress: "9425 Asheville Rd, Houston, TX",
      },
      {
        id: "person-2",
        name: "Amanda",
        campusAddress: "",
        homeAddress: "9700 Leawood Blvd, Houston, TX",
        phone: "",
        preferredAddress: "9700 Leawood Blvd, Houston, TX",
      },
      {
        id: "person-3",
        name: "Siah",
        campusAddress: "",
        homeAddress: "2304 Sam Houston Ave, Huntsville, TX",
        phone: "",
        preferredAddress: "2304 Sam Houston Ave, Huntsville, TX",
      },
    ],
  };
  app.state.adminDraftStops = [];
  app.state.adminSelectedStopId = "new";
  app.state.adminPersonSeed = null;
  app.state.adminRiderQuery = "A";

  assert.equal(typeof app.adminRiderNameSuggestions, "function");
  const suggestions = app.adminRiderNameSuggestions();
  assert.deepEqual(suggestions.map((person) => person.name), ["A'lena", "Amanda"]);

  const html = app.adminEditView();
  assert.match(html, /data-admin-rider-name/);
  assert.match(html, /data-admin-person-suggestions/);
  assert.match(html, /data-admin-person-select="person-1"/);
  assert.match(html, /A&#39;lena/);
  assert.match(html, /Amanda/);
  assert.doesNotMatch(html, /Siah/);

  app.state.adminRiderQuery = "Zyx";
  const noMatchHtml = app.adminEditView();
  assert.match(noMatchHtml, /data-admin-new-rider/);
  assert.match(noMatchHtml, /Add new rider/);
  assert.match(noMatchHtml, /Zyx/);
});

test("selected PeopleData rider auto-fills phone and selectable pickup addresses", async () => {
  const app = await loadApp();

  app.state.admin = {
    drivers: [{ slug: "joojo", displayName: "Joojo", initials: "JP" }],
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
      },
    ],
  };
  app.state.adminDraftStops = [];
  app.state.adminSelectedStopId = "new";
  app.state.adminPersonSeed = app.state.admin.people[0];
  app.state.adminSelectedAddressType = "home";

  assert.equal(typeof app.adminAddressOptionsForPerson, "function");
  assert.deepEqual(Array.from(app.adminAddressOptionsForPerson(app.state.admin.people[0]).map((option) => option.type)), ["campus", "home"]);

  const html = app.adminEditView();
  assert.match(html, /name="personId" value="person-1"/);
  assert.match(html, /value="Nora"/);
  assert.match(html, /value="\(281\) 704-1697"/);
  assert.match(html, /Campus address/);
  assert.match(html, /Guinan Hall/);
  assert.match(html, /Home address/);
  assert.match(html, /10819 Tryon Dr/);
  assert.match(html, /name="addressChoice"/);
  assert.match(html, /value="10819 Tryon Dr, Houston, TX 77065" checked/);
});

test("adding a saved PeopleData rider can return to saved rider details", async () => {
  const app = await loadApp();
  const person = {
    id: "person-1",
    name: "Nora",
    campusAddress: "",
    homeAddress: "10819 Tryon Dr, Houston, TX 77065",
    phone: "(281) 704-1697",
    preferredAddressType: "home",
    preferredAddress: "10819 Tryon Dr, Houston, TX 77065",
  };

  app.state.admin = {
    drivers: [{ slug: "joojo", displayName: "Joojo", initials: "JP" }],
    stops: [],
    people: [person],
  };
  app.state.adminDraftStops = [];
  app.state.adminSelectedPersonId = "person-1";
  app.state.adminSelectedStopId = "new";
  app.state.adminPersonSeed = person;
  app.state.adminRiderQuery = "Nora";
  app.state.adminSelectedAddressType = "home";
  app.state.adminEditMode = "add";
  app.state.view = "adminEdit";

  assert.equal(typeof app.returnToAdminPersonDetailFromAdd, "function");

  const html = app.adminEditView();
  assert.match(html, /data-action="adminPersonAddBack" aria-label="Back to person"/);
  assert.match(html, /<button class="secondary-action" type="button" data-action="adminPersonAddBack">Cancel<\/button>/);

  assert.equal(app.returnToAdminPersonDetailFromAdd(), true);
  assert.equal(app.state.view, "adminPersonDetail");
  assert.equal(app.state.adminSelectedPersonId, "person-1");
  assert.equal(app.state.adminSelectedStopId, null);
  assert.equal(app.state.adminPersonSeed, null);
  assert.equal(app.state.adminEditMode, "edit");
});

test("edit screen contains the red remove control above form actions", async () => {
  const app = await loadApp();

  app.state.admin = {
    drivers: [{ slug: "dawson", displayName: "Dawson", initials: "DW" }],
    stops: [
      {
        id: "stop-1",
        driverSlug: "dawson",
        stopOrder: 1,
        name: "Tinnie",
        phone: "",
        address: "3410 Wheeler Ave, Houston, TX",
        area: "",
        pickupTime: "",
        readyBy: "",
        routeLabel: "",
        notes: "",
      },
    ],
    people: [],
  };
  app.state.adminDraftStops = app.state.admin.stops.map((stop) => ({ ...stop }));
  app.state.adminSelectedStopId = "stop-1";

  const html = app.adminEditView();
  assert.match(html, /Remove rider/);
  assert.match(html, /data-admin-delete="stop-1"/);
  assert.ok(html.indexOf("Remove rider") < html.indexOf("Cancel"), "remove should appear above Cancel");
});

test("admin Sunday reset screen keeps PeopleData and starts with selected blank drivers", async () => {
  const app = await loadApp();

  assert.equal(typeof app.adminResetView, "function");
  assert.equal(app.nextSundayDate("2026-08-09"), "2026-08-16");

  app.state.planDate = "2026-08-09";
  app.state.admin = {
    plan: { date: "2026-08-09", title: "Sunday Ride Plan" },
    drivers: [
      { slug: "joojo", displayName: "Joojo", initials: "JP", pickupCount: 5 },
      { slug: "annie", displayName: "Annie", initials: "AK", pickupCount: 4 },
      { slug: "dawson", displayName: "Dawson", initials: "DW", pickupCount: 1 },
    ],
    stops: [
      {
        id: "stop-1",
        driverSlug: "joojo",
        stopOrder: 1,
        name: "Faith",
        phone: "",
        address: "7539 Keystone Blossom Trl, Richmond, TX",
        area: "Richmond",
        pickupTime: "8:45 AM",
        readyBy: "8:40 AM",
        routeLabel: "",
        notes: "",
      },
    ],
    people: [{ id: "person-1", name: "Faith", preferredAddress: "7539 Keystone Blossom Trl, Richmond, TX" }],
  };
  app.state.adminResetDate = "2026-08-16";
  app.state.adminResetDriverSlugs = ["joojo", "annie"];

  const html = app.adminResetView();
  assert.match(html, /Create New Sunday/);
  assert.match(html, /2026-08-16/);
  assert.match(html, /Joojo/);
  assert.match(html, /Annie/);
  assert.match(html, /Dawson/);
  assert.match(html, /PeopleData stays saved/);
  assert.match(html, /0 pickups copied/);
  assert.match(html, /name="driverSlug" value="joojo" checked/);
  assert.match(html, /name="driverSlug" value="annie" checked/);
  assert.doesNotMatch(html, /Faith<\/strong>/);
});

import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

async function loadApp(fetchImpl, options = {}) {
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
    URLSearchParams,
    FormData: class {},
    location: {
      href: `https://example.test/${options.search || ""}`,
      search: options.search || "",
    },
    navigator: {},
    window: {
      isSecureContext: false,
    },
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
      preferredPersonAddress: typeof preferredPersonAddress === "function" ? preferredPersonAddress : undefined,
      adminPersonMergeView: typeof adminPersonMergeView === "function" ? adminPersonMergeView : undefined,
      adminMergeDraft: typeof adminMergeDraft === "function" ? adminMergeDraft : undefined,
      saveAdminPersonDraft: typeof saveAdminPersonDraft === "function" ? saveAdminPersonDraft : undefined,
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
      submitCode: typeof submitCode === "function" ? submitCode : undefined,
      loadDrivers: typeof loadDrivers === "function" ? loadDrivers : undefined,
      publishAdminDraft: typeof publishAdminDraft === "function" ? publishAdminDraft : undefined,
      saveAdminDriverAvailability: typeof saveAdminDriverAvailability === "function" ? saveAdminDriverAvailability : undefined,
      saveAdminNewDriver: typeof saveAdminNewDriver === "function" ? saveAdminNewDriver : undefined,
      adminDriverPool: typeof adminDriverPool === "function" ? adminDriverPool : undefined,
      sendAdminRouteNotifications: typeof sendAdminRouteNotifications === "function" ? sendAdminRouteNotifications : undefined,
      isRehearsalMode: typeof isRehearsalMode === "function" ? isRehearsalMode : undefined,
      openRehearsalDriverRoute: typeof openRehearsalDriverRoute === "function" ? openRehearsalDriverRoute : undefined,
      adminRouteWarnings: typeof adminRouteWarnings === "function" ? adminRouteWarnings : undefined,
      weatherSummaryText: typeof weatherSummaryText === "function" ? weatherSummaryText : undefined,
      adminChangedCount,
      adminChangeList: typeof adminChangeList === "function" ? adminChangeList : undefined,
      adminAffectedDriverSlugs: typeof adminAffectedDriverSlugs === "function" ? adminAffectedDriverSlugs : undefined,
      adminRouteAlertDraft: typeof adminRouteAlertDraft === "function" ? adminRouteAlertDraft : undefined,
      nextSundayDate: typeof nextSundayDate === "function" ? nextSundayDate : undefined,
      homeView: typeof homeView === "function" ? homeView : undefined,
      __driverCode: driverCode,
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
  assert.match(html, /const FALLBACK_PLAN_DATE = "2026-08-27"/);
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
  assert.match(sql, /v_total_route_updates integer := 0/);
  assert.match(sql, /rp\.plan_date = rides_private\.current_ride_plan_date\(\)/);
  assert.match(sql, /'routeStopsUpdated', v_total_route_updates/);
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

test("SQL source supports admin driver availability and add-driver RPCs", async () => {
  const sql = await readFile(new URL("../supabase/sunday_reset.sql", import.meta.url), "utf8");

  assert.match(sql, /'driverPool', v_driver_pool/);
  assert.match(sql, /create or replace function public\.ride_admin_update_plan_drivers/);
  assert.match(sql, /p_active_driver_slugs text\[\]/);
  assert.match(sql, /rides_private\.is_ride_admin_code\(p_admin_code\)/);
  assert.match(sql, /create or replace function public\.ride_admin_add_driver/);
  assert.match(sql, /p_driver jsonb/);
  assert.match(sql, /rides_private\.hash_driver_code/);
  assert.match(sql, /grant execute on function public\.ride_admin_update_plan_drivers/);
  assert.match(sql, /grant execute on function public\.ride_admin_add_driver/);
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

test("Coffee and Christ event branding updates home and admin cover copy", async () => {
  const app = await loadApp();
  await access(new URL("../assets/coffee-and-christ-cover.jpg", import.meta.url));

  app.state.loading = false;
  app.state.drivers = [
    { slug: "joojo", displayName: "Joojo", initials: "JJ", pickup_count: 2 },
  ];

  const homeHtml = app.homeView();
  assert.match(homeHtml, /aria-label="Coffee and Christ ride dashboard"/);
  assert.match(homeHtml, /Coffee and Christ Ride Plan/);
  assert.match(homeHtml, /assets\/coffee-and-christ-cover\.jpg/);
  assert.match(homeHtml, /Coffee and Christ cover/);
  assert.match(homeHtml, /1 drivers assigned/);
  assert.doesNotMatch(homeHtml, /Sunday Ride Plan/);

  app.state.admin = {
    drivers: [{ slug: "joojo", displayName: "Joojo", initials: "JJ" }],
    stops: [],
    people: [],
    security: { actor: { type: "code" } },
  };
  app.state.adminDraftStops = [];
  app.state.adminActiveTab = "riders";

  const adminHtml = app.adminView();
  assert.match(adminHtml, /<h1>Coffee and Christ Ride Plan<\/h1>/);
  assert.match(adminHtml, /Build Thursday(?:'|&#39;)s list/);
});

test("app includes a root push service worker", async () => {
  const sw = await readFile(new URL("../sw.js", import.meta.url), "utf8");

  assert.match(sw, /addEventListener\("push"/);
  assert.match(sw, /showNotification/);
  assert.match(sw, /addEventListener\("notificationclick"/);
  assert.match(sw, /clients\.openWindow/);
  assert.match(sw, /ridelist-route-update/);
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
  assert.match(preciousHtml, /UH Clear Lake Route/);
  assert.doesNotMatch(preciousHtml, /DaSilva, Emmanuel Mitch, and Christopher R/);
  assert.equal(dawsonSummary.routeLabel, "UH Clear Lake Route");
  assert.equal(dqSummary.routeLabel, "South / NAU Route");
  assert.doesNotMatch(homeAreaHtml, /Home Route/);
});

test("admin uses drivers sunday riders and changes tabs with rider assignment status", async () => {
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
        driverSlug: "",
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
  assert.doesNotMatch(routesHtml, /admin-control-tabs/);
  assert.match(routesHtml, /data-admin-tab="drivers"/);
  assert.match(routesHtml, /data-admin-tab="riders"/);
  assert.match(routesHtml, /data-admin-tab="changes"/);
  assert.match(routesHtml, /Coffee and Christ Ride Plan/);
  assert.match(routesHtml, /Build Thursday(?:'|&#39;)s list/);
  assert.match(routesHtml, /event riders/);
  assert.match(routesHtml, /changes today/);
  assert.doesNotMatch(routesHtml, /data-admin-tab="routes"/);
  assert.doesNotMatch(routesHtml, /data-admin-tab="data"/);
  assert.doesNotMatch(routesHtml, /data-admin-tab="people"/);
  assert.match(routesHtml, /class="primary-action admin-add-rider-action" type="button" data-action="adminNew"/);
  assert.doesNotMatch(routesHtml, /Start New Sunday/);
  assert.doesNotMatch(routesHtml, /Publish route changes/);

  app.state.adminActiveTab = "drivers";
  const driversHtml = app.adminView();
  assert.match(driversHtml, /Start New Sunday/);
  assert.match(driversHtml, /data-action="adminReset"/);
  assert.doesNotMatch(driversHtml, /Everyone coming/);

  app.state.adminActiveTab = "riders";
  app.state.adminSearch = "zay";
  const ridersHtml = app.adminView();
  assert.match(ridersHtml, /Everyone coming/);
  assert.match(ridersHtml, /Assigned and not assigned in one place/);
  assert.match(ridersHtml, /data-admin-search/);
  assert.match(ridersHtml, /Zay/);
  assert.match(ridersHtml, /South Houston · Ready 12:11 PM/);
  assert.match(ridersHtml, /Not assigned/);
  assert.match(ridersHtml, /data-admin-edit="stop-2"/);
  assert.match(ridersHtml, /class="primary-action admin-add-rider-action" type="button" data-action="adminNew"/);
  assert.doesNotMatch(ridersHtml, /Start New Sunday/);
  assert.doesNotMatch(ridersHtml, /Tinnie/);

  app.state.adminActiveTab = "drivers";
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
  app.state.adminActiveTab = "changes";
  const routesWithChangeHtml = app.adminView();
  assert.equal(changes.length, 1);
  assert.match(routesWithChangeHtml, /Review changes/);
  assert.match(routesWithChangeHtml, /Added TEST New Rider to Naa/);
  assert.match(routesWithChangeHtml, /Publish route changes \(1\)/);
  assert.doesNotMatch(routesWithChangeHtml, /Start New Sunday/);

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
  app.state.adminActiveTab = "drivers";
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
  app.state.adminActiveTab = "riders";

  const html = app.adminView();
  assert.match(html, /class="stack admin-control-screen"/);
  assert.match(html, /class="[^"]*admin-control-header[^"]*"/);
  assert.match(html, /class="[^"]*admin-close-button[^"]*"/);
  assert.doesNotMatch(html, /admin-control-tabs/);
  assert.match(html, /class="[^"]*admin-control-stats[^"]*"/);
  assert.match(html, /<p class="eyebrow">Today<\/p>/);
  assert.match(html, /<h1>Coffee and Christ Ride Plan<\/h1>/);
  assert.match(html, /Build Thursday(?:'|&#39;)s list/);
  assert.doesNotMatch(html, /admin-stat-icon/);
  assert.doesNotMatch(html, /admin-stat-svg/);
  assert.match(html, /<button class="admin-stat[^"]*" type="button" data-admin-tab="drivers"><strong>3<\/strong><span>drivers available<\/span>/);
  assert.match(html, /<button class="admin-stat[^"]*" type="button" data-admin-tab="riders"><strong>1<\/strong><span>event riders<\/span>/);
  assert.match(html, /<button class="admin-stat[^"]*" type="button" data-admin-tab="changes"><strong>0<\/strong><span>changes today<\/span>/);
  assert.match(html, /class="primary-action admin-add-rider-action" type="button" data-action="adminNew"/);
  assert.match(html, /data-detail-icon="user-plus"/);
  assert.doesNotMatch(html, /Start New Sunday/);
  assert.doesNotMatch(html, /data-action="adminReset"/);
  assert.match(html, /Everyone coming/);
  assert.match(html, /A&#39;lena/);
  assert.match(html, /Assigned to John Mark/);
  assert.doesNotMatch(html, /admin-security-message/);
  assert.doesNotMatch(html, /Passcode fallback active/);
  assert.doesNotMatch(html, /No riders assigned[\s\S]*Add riders before final route timing/);
});

test("admin changes stat uses the cleaned Figma pencil icon", async () => {
  const app = await loadApp();

  app.state.admin = {
    drivers: [],
    stops: [],
    people: [],
  };
  app.state.adminDraftStops = [];
  app.state.adminActiveTab = "riders";

  const html = app.adminView();
  assert.match(html, /data-admin-tab="changes"/);
  assert.match(html, /M5 19l3\.8-\.9L18\.8 8\.1/);
  assert.doesNotMatch(html, /M12 20h9/);
  assert.doesNotMatch(html, /m16\.5 3\.5 4 4L8 20H4v-4z/);
});

test("admin sunday riders tab keeps the icon Add rider action", async () => {
  const app = await loadApp();

  app.state.admin = {
    drivers: [{ slug: "john-mark", displayName: "John Mark", initials: "JM" }],
    stops: [
      {
        id: "stop-1",
        driverSlug: "john-mark",
        stopOrder: 1,
        name: "Zarah",
        phone: "",
        address: "1221 Highland Row Ln, Houston, TX",
        area: "Huntsville",
        pickupTime: "",
        readyBy: "",
        routeLabel: "",
        notes: "",
      },
    ],
    people: [{ id: "person-1", name: "Zarah", phone: "", homeAddress: "1221 Highland Row Ln, Houston, TX" }],
  };
  app.state.adminDraftStops = app.state.admin.stops.map((stop) => ({ ...stop }));
  app.state.adminActiveTab = "riders";

  const html = app.adminView();
  assert.match(html, /Everyone coming/);
  assert.match(html, /Zarah/);
  assert.match(html, /Assigned to John Mark/);
  assert.match(html, /class="primary-action admin-add-rider-action" type="button" data-action="adminNew"/);
  assert.match(html, /data-detail-icon="user-plus"/);
});

test("admin drivers tab shows saved driver availability with add driver action", async () => {
  const app = await loadApp();

  app.state.admin = {
    drivers: [
      { slug: "joojo", displayName: "Joojo", initials: "JJ", pickupCount: 2, sortOrder: 1 },
      { slug: "blue", displayName: "Blu", initials: "BLU", pickupCount: 1, sortOrder: 2 },
    ],
    driverPool: [
      { slug: "joojo", displayName: "Joojo", initials: "JJ", active: true, pickupCount: 2, sortOrder: 1 },
      { slug: "blue", displayName: "Blu", initials: "BLU", active: true, pickupCount: 1, sortOrder: 2 },
      { slug: "naa", displayName: "Naa", initials: "NA", active: false, pickupCount: 0, sortOrder: 3 },
      { slug: "lou", displayName: "Lou", initials: "LO", active: false, pickupCount: 0, sortOrder: 4 },
    ],
    stops: [],
    people: [],
  };
  app.state.adminDraftStops = [];
  app.state.adminActiveTab = "drivers";

  const html = app.adminView();

  assert.match(html, /Driver availability/);
  assert.match(html, /Check who can drive for this plan/);
  assert.match(html, /data-action="adminDriverAdd"/);
  assert.match(html, /aria-label="Add driver"/);
  assert.match(html, /name="driverSlug" value="joojo" checked disabled/);
  assert.match(html, /name="driverSlug" value="blue" checked disabled/);
  assert.match(html, /name="driverSlug" value="naa" data-admin-driver-activate/);
  assert.match(html, /Naa/);
  assert.match(html, /Lou/);
  assert.match(html, /Inactive/);
  assert.match(html, /Save availability/);
  assert.match(html, /Start New Sunday/);
  assert.doesNotMatch(html, /Everyone coming/);
});

test("saving driver availability activates inactive saved drivers locally", async () => {
  const app = await loadApp(undefined, { search: "?rehearsal=sheet" });

  app.state.admin = {
    drivers: [{ slug: "joojo", displayName: "Joojo", initials: "JJ", pickupCount: 0, sortOrder: 1 }],
    driverPool: [
      { slug: "joojo", displayName: "Joojo", initials: "JJ", active: true, pickupCount: 0, sortOrder: 1 },
      { slug: "naa", displayName: "Naa", initials: "NA", active: false, pickupCount: 0, sortOrder: 2 },
    ],
    stops: [],
    people: [],
  };
  app.state.adminDraftStops = [];
  app.state.drivers = app.state.admin.drivers.map((driver) => ({ ...driver }));

  assert.equal(typeof app.saveAdminDriverAvailability, "function");
  await app.saveAdminDriverAvailability(["naa"]);

  assert.equal(JSON.stringify(app.state.admin.drivers.map((driver) => driver.slug)), JSON.stringify(["joojo", "naa"]));
  assert.equal(JSON.stringify(app.state.drivers.map((driver) => driver.slug)), JSON.stringify(["joojo", "naa"]));
  assert.equal(app.state.admin.driverPool.find((driver) => driver.slug === "naa").active, true);
  assert.match(app.state.adminMessage, /Naa is active for this plan/);
});

test("admin add driver form defaults simple passcode and adds active driver locally", async () => {
  const app = await loadApp(undefined, { search: "?rehearsal=sheet" });

  app.state.admin = {
    drivers: [{ slug: "joojo", displayName: "Joojo", initials: "JJ", pickupCount: 0, sortOrder: 1 }],
    driverPool: [{ slug: "joojo", displayName: "Joojo", initials: "JJ", active: true, pickupCount: 0, sortOrder: 1 }],
    stops: [],
    people: [],
  };
  app.state.adminDraftStops = [];
  app.state.adminActiveTab = "drivers";
  app.state.adminDriverAddOpen = true;

  const html = app.adminView();
  assert.match(html, /Add driver/);
  assert.match(html, /name="driverName"[^>]*required/);
  assert.match(html, /name="driverInitials"[^>]*required/);
  assert.match(html, /name="driverPhone"/);
  assert.match(html, /name="driverPasscode"[^>]*value="rides123"/);
  assert.match(html, /data-action="adminDriverAddCancel"/);

  assert.equal(typeof app.saveAdminNewDriver, "function");
  await app.saveAdminNewDriver({
    driverName: "Lou",
    driverInitials: "LO",
    driverPhone: "",
    driverPasscode: "rides123",
  });

  assert.ok(app.state.admin.drivers.some((driver) => driver.slug === "lou" && driver.displayName === "Lou"));
  assert.ok(app.state.admin.driverPool.some((driver) => driver.slug === "lou" && driver.active === true));
  assert.equal(app.state.adminDriverAddOpen, false);
  assert.match(app.state.adminMessage, /Lou is active for this plan/);
});

test("new Sunday rider form defaults to not assigned and keeps driver optional", async () => {
  const app = await loadApp();

  app.state.admin = {
    drivers: [
      { slug: "john-mark", displayName: "John Mark", initials: "JM" },
      { slug: "dawson", displayName: "Dawson", initials: "DW" },
    ],
    stops: [],
    people: [],
  };
  app.state.adminDraftStops = [];
  app.state.adminSelectedStopId = "new";
  app.state.adminPersonSeed = null;
  app.state.adminRiderQuery = "";

  const html = app.adminEditView();
  assert.match(html, /<option value="" selected>Not assigned yet<\/option>/);
  assert.doesNotMatch(html, /<select name="driverSlug" required>/);
  assert.match(html, /<select name="driverSlug">/);
  assert.match(html, /<input name="name"[^>]*required/);
  assert.match(html, /<input name="address"[^>]*required/);
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
  app.state.adminActiveTab = "drivers";
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
  assert.match(homeHtml, /Total route time pending/);
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
  assert.match(pendingHtml, /Details<span aria-hidden="true">&rsaquo;<\/span>/);
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
      {
        stopOrder: 2,
        name: "Simi",
        phone: "(832) 406-1493",
        address: "17254 Cricketbriar Ct, Houston, TX",
        area: "Cypress",
        pickupTime: "Follow after Nora",
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
      optimizedStopOrder: ["Nora", "Simi"],
    },
  };

  const html = app.driverHomeView();
  assert.match(html, /Total route: 42 min/);
  assert.match(html, /Estimated UH arrival: 11:42 AM/);
  assert.match(html, /Suggested order: Nora, Simi/);
  assert.doesNotMatch(html, /1 hr 22 min to UH Hilton/);
});

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

  assert.deepEqual(Array.from(app.adminAffectedDriverSlugs()), ["dq", "annie", "joojo"]);
});

test("admin reviews driver notification before sending", async () => {
  const app = await loadApp();
  app.state.admin = {
    drivers: [
      { slug: "joojo", displayName: "Joojo", initials: "JJ" },
      { slug: "dq", displayName: "DQ", initials: "DQ" },
      { slug: "john-mark", displayName: "John Mark", initials: "JM" },
    ],
    stops: [],
    people: [],
  };
  app.state.adminNotifyDraft = {
    driverSlugs: ["joojo", "dq", "john-mark"],
    message: "Your RIDELIST route was updated. Open your route review before Sunday.",
    alerts: [
      {
        driverSlug: "joojo",
        detail: "a'Lena Lavallais added · route review needed",
        badge: "Route updated",
      },
      {
        driverSlug: "dq",
        detail: "Pickup time changed · 1 rider affected",
        badge: "Time changed",
        tone: "time",
      },
      {
        driverSlug: "john-mark",
        detail: "Rider moved off route · route review needed",
        badge: "Route updated",
      },
    ],
  };
  app.state.adminNotifyMode = "prompt";

  let html = app.adminView();
  assert.match(html, /3 drivers need alerts/);
  assert.match(html, /Generated from your latest route changes/);
  assert.match(html, /Alerts to send/);
  assert.match(html, /a&#39;Lena Lavallais added · route review needed/);
  assert.match(html, /Time changed/);
  assert.match(html, /data-action="adminNotifyReview"/);
  assert.match(html, /data-action="adminNotifySend"/);

  app.state.adminNotifyMode = "review";
  html = app.adminView();
  assert.match(html, /Review Alerts/);
  assert.match(html, /Confirm before sending/);
  assert.match(html, /Auto-generated/);
  assert.match(html, /Your RIDELIST route was updated/);
  assert.match(html, /DQ/);
  assert.match(html, /John Mark/);
  assert.match(html, /data-action="adminNotifySend"/);
});

test("admin generated route alerts summarize each affected driver", async () => {
  const app = await loadApp();
  app.state.admin = {
    drivers: [
      { slug: "joojo", displayName: "Joojo", initials: "JJ" },
      { slug: "dq", displayName: "DQ", initials: "DQ" },
      { slug: "john-mark", displayName: "John Mark", initials: "JM" },
    ],
    stops: [
      { id: "stop-1", driverSlug: "dq", stopOrder: 1, name: "Fabio", phone: "", address: "A", pickupTime: "9:00 AM", readyBy: "", routeLabel: "", notes: "" },
      { id: "stop-2", driverSlug: "john-mark", stopOrder: 1, name: "Mina", phone: "", address: "B", pickupTime: "", readyBy: "", routeLabel: "", notes: "" },
    ],
    people: [],
  };
  app.state.adminDraftStops = [
    { id: "temp-1", driverSlug: "joojo", stopOrder: 1, name: "a'Lena Lavallais", phone: "", address: "C", pickupTime: "", readyBy: "", routeLabel: "", notes: "" },
    { ...app.state.admin.stops[0], pickupTime: "9:20 AM" },
  ];
  app.state.adminDeletedStopIds = ["stop-2"];

  const draft = app.adminRouteAlertDraft(["joojo", "dq", "john-mark"]);

  assert.equal(draft.message, "Your RIDELIST route was updated. Open your route review before Sunday.");
  const alerts = JSON.parse(JSON.stringify(draft.alerts.map((alert) => ({
    driverSlug: alert.driverSlug,
    detail: alert.detail,
    badge: alert.badge,
    tone: alert.tone,
  }))));

  assert.deepEqual(alerts, [
    {
      driverSlug: "joojo",
      detail: "a'Lena Lavallais added · route review needed",
      badge: "Route updated",
      tone: "route",
    },
    {
      driverSlug: "dq",
      detail: "Pickup time changed · 1 rider affected",
      badge: "Time changed",
      tone: "time",
    },
    {
      driverSlug: "john-mark",
      detail: "Rider moved off route · route review needed",
      badge: "Route updated",
      tone: "route",
    },
  ]);
});

test("local Coffee and Christ rehearsal loads sheet riders without Supabase writes", async () => {
  const calls = [];
  const app = await loadApp(async (url, options = {}) => {
    calls.push({ url, options });
    return {
      ok: true,
      json: async () => ({ ok: true }),
    };
  }, { search: "?rehearsal=sheet" });

  assert.equal(typeof app.isRehearsalMode, "function");
  assert.equal(app.isRehearsalMode(), true);
  assert.equal(typeof app.loadDrivers, "function");
  await app.loadDrivers();

  assert.equal(calls.length, 0, "rehearsal mode must not call Supabase while loading");
  assert.equal(app.state.planDate, "2026-08-27");
  assert.equal(app.state.plan.title, "Coffee and Christ");
  assert.equal(app.state.destination.label, "UH Science & Engineering Classroom 102");
  assert.equal(app.state.drivers.length, 11);
  assert.ok(app.state.drivers.some((driver) => driver.slug === "naa" && driver.displayName === "Naa"));
  assert.ok(app.state.drivers.some((driver) => driver.slug === "joojo" && driver.displayName === "Joojo"));
  assert.ok(app.state.drivers.findIndex((driver) => driver.slug === "joojo") < app.state.drivers.findIndex((driver) => driver.slug === "blue"));
  assert.ok(app.state.drivers.findIndex((driver) => driver.slug === "naa") < app.state.drivers.findIndex((driver) => driver.slug === "blue"));
  assert.equal(app.state.adminDraftStops.length, 8);
  assert.equal(app.state.admin.people.length, 8);
  assert.equal(app.state.adminDraftStops.filter((stop) => stop.driverSlug === "naa").length, 2);
  assert.equal(app.state.adminDraftStops.filter((stop) => stop.driverSlug === "joojo").length, 2);
  assert.equal(app.state.adminDraftStops.filter((stop) => stop.driverSlug === "precious").length, 1);
  assert.equal(app.state.adminDraftStops.filter((stop) => stop.driverSlug === "dawson").length, 1);
  assert.equal(app.state.adminDraftStops.filter((stop) => stop.driverSlug === "annie").length, 1);
  assert.equal(app.state.adminDraftStops.filter((stop) => stop.driverSlug === "blue").length, 1);
  assert.equal(app.state.adminDraftStops.filter((stop) => !stop.driverSlug).length, 0);
  assert.equal(app.state.adminDraftStops.find((stop) => stop.name === "Owen").driverSlug, "naa");
  assert.equal(app.state.adminDraftStops.find((stop) => stop.name === "Fabio").driverSlug, "naa");
  assert.match(app.state.adminDraftStops.find((stop) => stop.name === "Fabio").address, /North American University/);
  assert.equal(app.state.adminDraftStops.find((stop) => stop.name === "Zarah").driverSlug, "joojo");
  assert.match(app.state.adminDraftStops.find((stop) => stop.name === "Zarah").phone, /936/);
  assert.equal(app.state.adminDraftStops.find((stop) => stop.name === "Emanuel").driverSlug, "joojo");
  assert.match(app.state.adminDraftStops.find((stop) => stop.name === "Emanuel").address, /1805 Valentine St/);
  assert.equal(app.state.adminDraftStops.find((stop) => stop.name === "Ashton group - Precious car").driverSlug, "precious");
  assert.match(app.state.adminDraftStops.find((stop) => stop.name === "Ashton group - Precious car").notes, /Sito, Chyna, Monae/);
  assert.equal(app.state.adminDraftStops.find((stop) => stop.name === "Ashton group - Dawson car").driverSlug, "dawson");
  assert.match(app.state.adminDraftStops.find((stop) => stop.name === "Ashton group - Dawson car").notes, /Makayla/);
  assert.equal(app.state.adminDraftStops.find((stop) => stop.name === "William Andrews").driverSlug, "blue");
  assert.match(app.state.adminDraftStops.find((stop) => stop.name === "William Andrews").address, /3221 Oakdale Street/);
  assert.equal(app.state.adminDraftStops.find((stop) => stop.name === "Kadie").driverSlug, "annie");
  assert.match(app.state.adminDraftStops.find((stop) => stop.name === "Kadie").notes, /Need pickup address/);
  assert.equal(
    JSON.stringify(app.state.adminDraftStops.filter((stop) => stop.driverSlug === "naa").map((stop) => stop.name)),
    JSON.stringify(["Owen", "Fabio"])
  );

  const html = app.adminView();
  assert.match(html, /Local rehearsal/);
  assert.match(html, /8<\/strong><span>event riders/);
  assert.match(html, /8 changes pending/);
  assert.match(html, /William Andrews/);
  assert.match(html, /Assigned to Blu/);
  assert.match(html, /Kadie/);
  assert.match(html, /Assigned to Annie/);
  assert.match(html, /Ashton group - Precious car/);
  assert.match(html, /Ashton group - Dawson car/);
  assert.match(html, /data-action="adminReviewChanges"/);
  assert.match(app.adminReviewView(), /Publish route changes \(8\)/);

  app.state.adminActiveTab = "people";
  const peopleHtml = app.adminView();
  assert.match(peopleHtml, /PeopleData · 8 people stored/);
  assert.match(peopleHtml, /Zarah/);
  assert.match(peopleHtml, /Owen/);
  assert.match(peopleHtml, /Fabio/);
  assert.match(peopleHtml, /Emanuel/);
  assert.match(peopleHtml, /William Andrews/);
  assert.match(peopleHtml, /Kadie/);
});

test("local Coffee and Christ rehearsal shows route cards and simulates driver alerts", async () => {
  const calls = [];
  const app = await loadApp(async (url, options = {}) => {
    calls.push({ url, options });
    return {
      ok: true,
      json: async () => ({ ok: true }),
    };
  }, { search: "?rehearsal=sheet" });
  await app.loadDrivers();

  const owen = app.state.admin.people.find((person) => person.name === "Owen");
  const fabio = app.state.admin.people.find((person) => person.name === "Fabio");
  assert.equal(app.adminDuplicateCandidates(owen).length, 0);
  assert.equal(app.adminDuplicateCandidates(fabio).length, 0);

  app.state.adminActiveTab = "drivers";
  app.state.adminExpandedDriverSlug = "naa";
  const naaHtml = app.adminView();
  assert.match(naaHtml, /Naa/);
  assert.match(naaHtml, /Owen/);
  assert.match(naaHtml, /Fabio/);
  assert.match(naaHtml, /North American University/);
  assert.match(naaHtml, /Owen: phone missing/);
  assert.doesNotMatch(naaHtml, /Route time unavailable/);

  app.state.adminExpandedDriverSlug = "joojo";
  const joojoHtml = app.adminView();
  assert.match(joojoHtml, /Joojo/);
  assert.match(joojoHtml, /Zarah/);
  assert.match(joojoHtml, /Emanuel/);
  assert.match(joojoHtml, /1221 Highland Row/);
  assert.doesNotMatch(joojoHtml, /Zarah: phone missing/);

  app.state.adminExpandedDriverSlug = "dawson";
  const dawsonHtml = app.adminView();
  assert.match(dawsonHtml, /Dawson/);
  assert.match(dawsonHtml, /Ashton group - Dawson car/);
  assert.match(dawsonHtml, /UH Clear Lake/);
  assert.match(dawsonHtml, /635 Bayou Rd E/);

  app.state.adminExpandedDriverSlug = "precious";
  const preciousHtml = app.adminView();
  assert.match(preciousHtml, /Precious/);
  assert.match(preciousHtml, /Ashton group - Precious car/);
  assert.match(preciousHtml, /Sito, Chyna, Monae/);
  assert.equal(app.routeTimingForDriver("precious").status, "ready");

  app.state.adminExpandedDriverSlug = "blue";
  const blueHtml = app.adminView();
  assert.match(blueHtml, /Blu/);
  assert.match(blueHtml, /William Andrews/);
  assert.match(blueHtml, /3221 Oakdale Street/);
  assert.equal(app.routeTimingForDriver("blue").status, "ready");

  app.state.adminExpandedDriverSlug = "annie";
  const annieHtml = app.adminView();
  assert.match(annieHtml, /Annie/);
  assert.match(annieHtml, /Kadie/);
  assert.match(annieHtml, /Kadie: pickup address missing/);

  assert.equal(typeof app.openRehearsalDriverRoute, "function");
  app.openRehearsalDriverRoute("joojo");
  const driverHtml = app.driverHomeView();
  assert.match(driverHtml, /Total route: /);
  assert.match(driverHtml, /Suggested order: Zarah, Emanuel/);
  assert.doesNotMatch(driverHtml, /Live timing unavailable/);

  assert.equal(typeof app.publishAdminDraft, "function");
  await app.publishAdminDraft();
  assert.equal(calls.length, 0, "local publish must not call Supabase");
  assert.equal(app.state.adminNotifyDraft.driverSlugs.length, 6);
  assert.match(app.adminView(), /6 drivers need alerts/);

  assert.equal(typeof app.sendAdminRouteNotifications, "function");
  await app.sendAdminRouteNotifications();
  assert.equal(calls.length, 0, "local alert send must not call the notification function");
  assert.match(app.state.adminMessage, /Rehearsal alerts marked sent/);
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

test("admin route timing unavailable stays a normal timing notice when pickup times are complete", async () => {
  const app = await loadApp();

  app.state.admin = {
    drivers: [{ slug: "dq", displayName: "DQ", initials: "DQ" }],
    stops: [
      {
        id: "stop-1",
        driverSlug: "dq",
        stopOrder: 1,
        name: "Sherese",
        phone: "(832) 935-9593",
        address: "3416 Benfield Dr, Houston, TX",
        area: "West Houston",
        pickupTime: "11:35 AM",
        readyBy: "11:25 AM",
        routeLabel: "DQ route",
        notes: "",
      },
      {
        id: "stop-2",
        driverSlug: "dq",
        stopOrder: 2,
        name: "Vera",
        phone: "(832) 517-8929",
        address: "4971 Martin Luther King Blvd, Houston, TX 77021",
        area: "Southeast Houston",
        pickupTime: "11:40 AM",
        readyBy: "11:30 AM",
        routeLabel: "DQ route",
        notes: "",
      },
    ],
    people: [],
  };
  app.state.adminDraftStops = app.state.admin.stops.map((stop) => ({ ...stop }));

  const warnings = app.adminRouteWarnings(app.state.admin.drivers[0], app.state.adminDraftStops, {
    status: "error",
    warning: "Route time unavailable",
  });

  assert.equal(JSON.stringify(warnings), JSON.stringify([
    {
      key: "route-time-unavailable",
      label: "Route time unavailable",
      level: "normal",
      title: "Route timing paused",
      detail: "Route time will update after rider data is fixed or live timing is available.",
      stopId: "",
      actionLabel: "",
    },
  ]));
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

test("driver login sends the typed passcode to live route timing", async () => {
  const timingRequests = [];
  const app = await loadApp(async (url, options = {}) => {
    const body = JSON.parse(options.body || "{}");

    if (String(url).includes("api.open-meteo.com")) {
      return {
        ok: true,
        json: async () => ({
          daily: {
            time: ["2026-08-16"],
            weather_code: [3],
            temperature_2m_max: [93],
            temperature_2m_min: [76],
            precipitation_probability_max: [0],
            wind_speed_10m_max: [8],
          },
        }),
      };
    }

    if (String(url).includes("/functions/v1/ride-route-timing")) {
      timingRequests.push(body);
      return {
        ok: true,
        json: async () => ({
          ok: true,
          timings: {
            "john-mark": {
              status: "ready",
              durationText: "1 hr 46 min",
              distanceText: "74 mi",
              etaText: "1:06 PM",
            },
          },
        }),
      };
    }

    if (String(url).includes("ride_driver_route")) {
      return {
        ok: true,
        json: async () => ({
          ok: true,
          plan: { date: "2026-08-16" },
          driver: { slug: "john-mark", displayName: "John Mark", initials: "JM" },
          riders: [
            {
              stopOrder: 1,
              name: "Terrance",
              phone: "(346) 628-1165",
              address: "1615 Sycamore Avenue, Huntsville, TX",
              area: "Huntsville",
              pickupTime: "11:20 AM",
              readyBy: "11:10 AM",
            },
          ],
          destination: { label: "UH Hilton", address: "University of Houston Hilton" },
        }),
      };
    }

    if (String(url).includes("ride_app_context")) {
      return {
        ok: true,
        json: async () => ({
          ok: true,
          plan: { date: "2026-08-16" },
          destination: { label: "UH Hilton", address: "University of Houston Hilton" },
        }),
      };
    }

    return { ok: true, json: async () => [] };
  });

  app.state.planDate = "2026-08-16";
  app.state.selectedDriver = { slug: "john-mark" };
  app.state.codeMode = "driver";
  app.__driverCode.value = "rides123";

  await app.submitCode({ preventDefault() {} });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(timingRequests.length, 1);
  assert.equal(timingRequests[0].accessCode, "rides123");
  assert.equal(app.routeTimingForDriver("john-mark").durationText, "1 hr 46 min");
  assert.match(app.driverHomeView(), /Total route: 1 hr 46 min/);
  assert.doesNotMatch(app.driverHomeView(), /Total route time pending/);
});

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

test("saving a PeopleData primary address updates matching ride stops", async () => {
  const app = await loadApp(undefined, { search: "?rehearsal=sheet" });
  const nora = {
    id: "person-1",
    name: "Nora",
    campusAddress: "Guinan Hall, University of St. Thomas, Houston, TX",
    homeAddress: "10819 Tryon Dr, Houston, TX 77065",
    phone: "(281) 704-1697",
    preferredAddress: "10819 Tryon Dr, Houston, TX 77065",
    preferredAddressType: "home",
    sourceLabel: "PeopleData",
    notes: "",
    active: true,
  };

  app.state.admin = {
    drivers: [
      { slug: "blue", displayName: "Blu", initials: "BLU", pickupCount: 1, pickup_count: 1 },
      { slug: "albert", displayName: "Albert", initials: "AL", pickupCount: 0, pickup_count: 0 },
      { slug: "dolapo", displayName: "Dolapo", initials: "DO", pickupCount: 2, pickup_count: 2 },
    ],
    stops: [
      {
        id: "stop-1",
        driverSlug: "blue",
        stopOrder: 1,
        name: "Nora",
        phone: "(281) 704-1697",
        address: "10819 Tryon Dr, Houston, TX 77065",
        area: "Home",
        pickupTime: "",
        readyBy: "",
        routeLabel: "Blu route",
        notes: "",
      },
    ],
    people: [nora],
  };
  app.state.adminDraftStops = app.state.admin.stops.map((stop) => ({ ...stop }));
  app.state.adminSelectedPersonId = "person-1";
  app.state.adminPersonDraft = {
    ...nora,
    preferredAddressType: "campus",
    preferredAddress: "10819 Tryon Dr, Houston, TX 77065",
  };

  assert.equal(typeof app.preferredPersonAddress, "function");
  assert.equal(typeof app.saveAdminPersonDraft, "function");
  assert.equal(app.preferredPersonAddress(app.state.adminPersonDraft), "Guinan Hall, University of St. Thomas, Houston, TX");

  await app.saveAdminPersonDraft();

  const savedPerson = app.state.admin.people.find((person) => person.id === "person-1");
  const updatedStop = app.state.adminDraftStops.find((stop) => stop.id === "stop-1");
  assert.equal(savedPerson.preferredAddressType, "campus");
  assert.equal(savedPerson.preferredAddress, "Guinan Hall, University of St. Thomas, Houston, TX");
  assert.equal(updatedStop.address, "Guinan Hall, University of St. Thomas, Houston, TX");
  assert.equal(updatedStop.area, "Campus");
  assert.equal(app.state.admin.drivers[0].slug, "blue");
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

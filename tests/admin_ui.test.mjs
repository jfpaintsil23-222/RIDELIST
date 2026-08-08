import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

async function loadApp() {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
  assert.ok(script, "index.html should include the app script");

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
      getItem() {
        return null;
      },
      setItem() {},
    },
    document: {
      querySelector() {
        return element();
      },
      querySelectorAll() {
        return [];
      },
    },
    fetch: async () => ({
      ok: true,
      json: async () => [],
    }),
  };

  vm.createContext(context);
  vm.runInContext(`${script}
    globalThis.__app = {
      state,
      adminView,
      adminEditView,
      driverProfileCard,
      driverRouteSummary,
      adminChangedCount,
      adminChangeList: typeof adminChangeList === "function" ? adminChangeList : undefined,
    };
  `, context);

  return context.__app;
}

test("app contains admin ride control entry points", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");

  assert.match(html, /data-action="admin"/);
  assert.match(html, /ride_admin_snapshot/);
  assert.match(html, /ride_admin_publish_plan/);
  assert.match(html, /const PLAN_DATE = "2026-08-09"/);
  assert.match(html, /function adminView/);
  assert.match(html, /function adminEditView/);
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

  assert.match(dannyHtml, /Richmond Route/);
  assert.doesNotMatch(dannyHtml, /Faith and Precious/);
  assert.match(preciousHtml, /South Houston Route/);
  assert.doesNotMatch(preciousHtml, /DaSilva, Emmanuel Mitch, and Christopher R/);
  assert.equal(dawsonSummary.routeLabel, "West Houston Route");
});

test("admin tabs render functional riders search and changes review screens", async () => {
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
        address: "2906 Paige St, Houston, TX",
        area: "Third Ward",
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
        homeAddress: "2906 Paige St, Houston, TX",
        phone: "",
        preferredAddress: "2906 Paige St, Houston, TX",
      },
    ],
  };
  app.state.adminDraftStops = app.state.admin.stops.map((stop) => ({ ...stop }));
  app.state.adminDeletedStopIds = [];

  const routesHtml = app.adminView();
  assert.match(routesHtml, /data-admin-tab="routes"/);
  assert.match(routesHtml, /data-admin-tab="riders"/);
  assert.match(routesHtml, /data-admin-tab="changes"/);

  app.state.adminActiveTab = "riders";
  app.state.adminPeopleSearch = "tinnie";
  const ridersHtml = app.adminView();
  assert.match(ridersHtml, /data-admin-people-search/);
  assert.match(ridersHtml, /Tinnie/);
  assert.match(ridersHtml, /data-admin-add-person="person-1"/);
  assert.doesNotMatch(ridersHtml, /Zay/);

  app.state.adminActiveTab = "changes";
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
  const changesHtml = app.adminView();
  assert.equal(changes.length, 1);
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

test("riders and data tabs use the PeopleData bank", async () => {
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

  app.state.adminActiveTab = "riders";
  app.state.adminPeopleSearch = "siah";
  const ridersHtml = app.adminView();
  assert.match(ridersHtml, /data-admin-people-search/);
  assert.match(ridersHtml, /Siah/);
  assert.match(ridersHtml, /data-admin-add-person="person-1"/);
  assert.doesNotMatch(ridersHtml, /Nicholas/);

  app.state.adminActiveTab = "data";
  app.state.adminPeopleSearch = "burdine";
  const dataHtml = app.adminView();
  assert.match(dataHtml, /PeopleData/);
  assert.match(dataHtml, /Nicholas/);
  assert.match(dataHtml, /11525 Burdine St/);
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

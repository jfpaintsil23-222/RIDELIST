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
  assert.match(html, /function adminView/);
  assert.match(html, /function adminEditView/);
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
  };
  app.state.adminDraftStops = app.state.admin.stops.map((stop) => ({ ...stop }));
  app.state.adminDeletedStopIds = [];

  const routesHtml = app.adminView();
  assert.match(routesHtml, /data-admin-tab="routes"/);
  assert.match(routesHtml, /data-admin-tab="riders"/);
  assert.match(routesHtml, /data-admin-tab="changes"/);

  app.state.adminActiveTab = "riders";
  app.state.adminSearch = "tinnie";
  const ridersHtml = app.adminView();
  assert.match(ridersHtml, /data-admin-search/);
  assert.match(ridersHtml, /Tinnie/);
  assert.match(ridersHtml, /Dawson/);
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

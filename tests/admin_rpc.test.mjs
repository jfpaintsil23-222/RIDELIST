import assert from "node:assert/strict";
import test from "node:test";

const SUPABASE_URL = "https://cpkimtrribpvqxbywfry.supabase.co";
const SUPABASE_KEY = "sb_publishable_qegP80qyqPq3qjqm6J3DIg_M4eNbRaZ";
const PLAN_DATE = "2026-08-09";
const RESET_TEST_DATE = "2099-01-04";
const ADMIN_CODE = process.env.RIDES_ADMIN_CODE;

if (!ADMIN_CODE) {
  throw new Error("RIDES_ADMIN_CODE is required for admin RPC tests.");
}

async function rpc(name, body) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_KEY,
      authorization: `Bearer ${SUPABASE_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const text = await response.text();
  assert.equal(response.ok, true, `${name} failed: ${response.status} ${text}`);
  return JSON.parse(text);
}

test("active ride context exposes the current public Sunday plan", async () => {
  const context = await rpc("ride_app_context", {});

  assert.equal(context.ok, true);
  assert.equal(context.plan.date, PLAN_DATE);
  assert.equal(context.destination.label, "UH Hilton");
});

test("admin snapshot rejects wrong passcodes and accepts the admin passcode", async () => {
  const rejected = await rpc("ride_admin_snapshot", {
    p_admin_code: "wrong-code",
    p_plan_date: PLAN_DATE,
  });

  assert.equal(rejected.ok, false);
  assert.equal(rejected.error, "invalid_admin_code");

  const snapshot = await rpc("ride_admin_snapshot", {
    p_admin_code: ADMIN_CODE,
    p_plan_date: PLAN_DATE,
  });

  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.plan.date, PLAN_DATE);
  assert.equal(snapshot.drivers.length, 7);
  assert.deepEqual(
    snapshot.drivers.map((driver) => driver.slug),
    ["danny", "john-mark", "dq", "annie", "dawson", "precious", "joojo"],
  );
  assert.equal(snapshot.stops.length, 19);
});

test("admin snapshot includes protected PeopleData", async () => {
  const snapshot = await rpc("ride_admin_snapshot", {
    p_admin_code: ADMIN_CODE,
    p_plan_date: PLAN_DATE,
  });

  assert.equal(snapshot.ok, true);
  assert.ok(Array.isArray(snapshot.people), "people bank should be returned to admins");
  assert.ok(snapshot.people.length >= 80, "PeopleData seed should include the uploaded names");
  assert.ok(snapshot.people.some((person) => person.name === "Siah"));
  assert.ok(snapshot.people.some((person) => person.name === "Nicholas" && /Burdine/i.test(person.homeAddress)));
});

test("August 9 route assignments match the approved Sunday plan", async () => {
  const snapshot = await rpc("ride_admin_snapshot", {
    p_admin_code: ADMIN_CODE,
    p_plan_date: PLAN_DATE,
  });

  const byDriver = Object.fromEntries(snapshot.drivers.map((driver) => [driver.slug, []]));
  for (const stop of snapshot.stops) {
    byDriver[stop.driverSlug].push(`${stop.name}|${stop.pickupTime || ""}`);
  }

  assert.deepEqual(byDriver.danny, ["Faith|8:45 AM", "Zoe|"]);
  assert.deepEqual(byDriver["john-mark"], [
    "Siah|9:10 AM",
    "Nehemiah|10:35 AM",
  ]);
  assert.deepEqual(byDriver.dq, [
    "A'lena|11:30 AM",
    "Christopher L|11:30 AM",
  ]);
  assert.deepEqual(byDriver.annie, [
    "Nicholas Montiel|11:15 AM",
    "Vera|11:40 AM",
    "Zay|11:50 AM",
    "Amanda|12:00 PM",
  ]);
  assert.equal(
    snapshot.stops.find((stop) => stop.name === "Zay")?.address,
    "5050 Sunflower St, Houston, TX 77033",
  );
  assert.equal(
    snapshot.stops.find((stop) => stop.name === "Amanda")?.driverSlug,
    "annie",
  );
  assert.deepEqual(byDriver.dawson, ["Sherese|11:45 AM"]);
  assert.deepEqual(byDriver.precious, [
    "DaSilva|10:50 AM",
    "Emmanuel Mitch|11:15 AM",
    "Christopher R|11:25 AM",
  ]);
  assert.deepEqual(byDriver.joojo, [
    "Kayla Williams|",
    "Simi|11:15 AM",
    "Simi's brother|11:15 AM",
    "Elmer|12:00 PM",
    "Vicky|12:15 PM",
  ]);
  assert.deepEqual(
    snapshot.stops
      .filter((stop) => ["Elmer", "Vicky"].includes(stop.name) && stop.driverSlug === "joojo")
      .map((stop) => [stop.name, stop.phone, stop.address]),
    [
      ["Elmer", "737-864-5126", "1722 Rice Boulevard, Houston, TX"],
      ["Vicky", "+1 (934) 233-4260", "2111 Holly Hall St, Houston, TX 77054"],
    ],
  );
});

test("admin can start a new blank Sunday from selected drivers without deleting PeopleData", async () => {
  const beforeContext = await rpc("ride_app_context", {});

  const rejected = await rpc("ride_admin_start_new_sunday", {
    p_admin_code: "wrong-code",
    p_plan_date: RESET_TEST_DATE,
    p_driver_slugs: ["joojo", "annie"],
    p_source_plan_date: PLAN_DATE,
    p_make_active: false,
  });

  assert.equal(rejected.ok, false);
  assert.equal(rejected.error, "invalid_admin_code");

  const created = await rpc("ride_admin_start_new_sunday", {
    p_admin_code: ADMIN_CODE,
    p_plan_date: RESET_TEST_DATE,
    p_driver_slugs: ["joojo", "annie"],
    p_source_plan_date: PLAN_DATE,
    p_make_active: false,
  });

  assert.equal(created.ok, true);
  assert.equal(created.plan.date, RESET_TEST_DATE);
  assert.equal(created.drivers.length, 2);
  assert.deepEqual(
    created.drivers.map((driver) => driver.slug),
    ["joojo", "annie"],
  );
  assert.equal(created.stops.length, 0);
  assert.ok(created.people.length >= 80, "PeopleData should remain available after reset");
  assert.ok(created.people.some((person) => person.name === "Faith"));

  const afterContext = await rpc("ride_app_context", {});
  assert.equal(afterContext.plan.date, beforeContext.plan.date);
});

test("admin can add, move, update, and delete a rider through publish", async () => {
  const testName = `TEST Admin Rider ${Date.now()}`;

  const added = await rpc("ride_admin_publish_plan", {
    p_admin_code: ADMIN_CODE,
    p_plan_date: PLAN_DATE,
    p_stops: [
      {
        id: null,
        driverSlug: "precious",
        stopOrder: 99,
        name: testName,
        phone: "(555) 010-0000",
        address: "100 Test Church Rd, Houston, TX",
        area: "Test Area",
        pickupTime: "1:23 PM",
        readyBy: "1:18 PM",
        routeLabel: "Test",
        notes: "Temporary automated admin test rider.",
      },
    ],
    p_deleted_stop_ids: [],
  });

  assert.equal(added.ok, true);
  const created = added.stops.find((stop) => stop.name === testName);
  assert.ok(created?.id, "temporary rider was created");
  assert.equal(created.driverSlug, "precious");

  const moved = await rpc("ride_admin_publish_plan", {
    p_admin_code: ADMIN_CODE,
    p_plan_date: PLAN_DATE,
    p_stops: [
      {
        ...created,
        driverSlug: "dawson",
        stopOrder: 99,
        phone: "(555) 010-1111",
        notes: "Temporary automated admin test rider moved.",
      },
    ],
    p_deleted_stop_ids: [],
  });

  assert.equal(moved.ok, true);
  const updated = moved.stops.find((stop) => stop.id === created.id);
  assert.equal(updated.driverSlug, "dawson");
  assert.equal(updated.phone, "(555) 010-1111");

  const deleted = await rpc("ride_admin_publish_plan", {
    p_admin_code: ADMIN_CODE,
    p_plan_date: PLAN_DATE,
    p_stops: [],
    p_deleted_stop_ids: [created.id],
  });

  assert.equal(deleted.ok, true);
  assert.equal(deleted.stops.some((stop) => stop.id === created.id), false);
});

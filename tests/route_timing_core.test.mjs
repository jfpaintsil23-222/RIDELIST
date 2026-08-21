import assert from "node:assert/strict";
import test from "node:test";

import {
  GOOGLE_ROUTE_FIELD_MASK,
  buildGoogleRouteBody,
  buildRouteWarnings,
  routeTimingFromGoogleRoute,
  stopsForDriver,
} from "../supabase/functions/ride-route-timing/route-timing-core.js";

const destination = {
  label: "UH Hilton",
  address: "4450 University Drive, Houston, TX 77204",
};

test("buildGoogleRouteBody uses first pickup as origin and remaining pickups as intermediates", () => {
  const body = buildGoogleRouteBody([
    { stopOrder: 2, name: "Second", address: "200 Second St, Houston, TX" },
    { stopOrder: 1, name: "First", address: "100 First St, Houston, TX" },
    { stopOrder: 3, name: "Third", address: "300 Third St, Houston, TX" },
  ], destination);

  assert.equal(body.origin.address, "100 First St, Houston, TX");
  assert.deepEqual(
    body.intermediates.map((waypoint) => waypoint.address),
    ["200 Second St, Houston, TX", "300 Third St, Houston, TX"],
  );
  assert.equal(body.destination.address, destination.address);
  assert.equal(body.travelMode, "DRIVE");
  assert.equal(body.routingPreference, "TRAFFIC_AWARE");
  assert.equal(body.optimizeWaypointOrder, true);
  assert.match(GOOGLE_ROUTE_FIELD_MASK, /routes\.optimizedIntermediateWaypointIndex/);
});

test("stopsForDriver keeps unscoped stops for single-driver routes", () => {
  const stops = [
    { name: "Nora", address: "100 First St" },
    { name: "Simi", driverSlug: "joojo", address: "200 Second St" },
    { name: "Faith", driverSlug: "danny", address: "300 Third St" },
  ];

  assert.deepEqual(
    stopsForDriver([{ slug: "joojo" }], stops, "joojo").map((stop) => stop.name),
    ["Nora", "Simi"],
  );
  assert.deepEqual(
    stopsForDriver([{ slug: "joojo" }, { slug: "danny" }], stops, "joojo").map((stop) => stop.name),
    ["Simi"],
  );
});

test("routeTimingFromGoogleRoute formats duration distance and estimated UH arrival", () => {
  const timing = routeTimingFromGoogleRoute({
    driverSlug: "joojo",
    planDate: "2026-08-09",
    stops: [{ stopOrder: 1, pickupTime: "11:00 AM", address: "100 First St" }],
    googleRoute: {
      duration: "2520s",
      distanceMeters: 35405,
    },
  });

  assert.deepEqual(timing, {
    status: "ready",
    totalMinutes: 42,
    durationText: "42 min",
    distanceText: "22 mi",
    etaText: "11:42 AM",
  });
});

test("routeTimingFromGoogleRoute formats hour-long routes", () => {
  const timing = routeTimingFromGoogleRoute({
    driverSlug: "danny",
    planDate: "2026-08-09",
    stops: [{ stopOrder: 1, pickupTime: "8:45 AM", address: "100 First St" }],
    googleRoute: {
      duration: "3720s",
      distanceMeters: 80467,
    },
  });

  assert.equal(timing.durationText, "1 hr 2 min");
  assert.equal(timing.distanceText, "50 mi");
  assert.equal(timing.etaText, "9:47 AM");
});

test("routeTimingFromGoogleRoute returns Google optimized pickup order", () => {
  const timing = routeTimingFromGoogleRoute({
    stops: [
      { stopOrder: 1, name: "Nora", pickupTime: "10:00 AM", address: "10819 Tryon Dr, Cypress, TX" },
      { stopOrder: 2, name: "Simi + 2", pickupTime: "10:10 AM", address: "17254 Cricketbriar Ct, Houston, TX" },
      { stopOrder: 3, name: "Kayla Williams", pickupTime: "10:20 AM", address: "2926 Barker Cypress Rd, Houston, TX" },
    ],
    googleRoute: {
      duration: "3600s",
      distanceMeters: 48280,
      optimizedIntermediateWaypointIndex: [1, 0],
    },
  });

  assert.deepEqual(timing.optimizedStopOrder, ["Nora", "Kayla Williams", "Simi + 2"]);
});

test("buildRouteWarnings deduplicates missing route data", () => {
  const warnings = buildRouteWarnings([
    { name: "A'lena", phone: "", pickupTime: "", address: "9425 Asheville Rd" },
    { name: "Christopher L", phone: "832-942-1381", pickupTime: "11:30 AM", address: "" },
  ], { status: "error" });

  assert.deepEqual(warnings, [
    { key: "missing-phone", label: "Missing number", level: "urgent" },
    { key: "missing-pickup-time", label: "Missing pickup time", level: "urgent" },
    { key: "missing-address", label: "Missing address", level: "urgent" },
    { key: "route-time-unavailable", label: "Route time unavailable", level: "normal" },
  ]);
});

test("buildRouteWarnings does not duplicate matching timing warnings", () => {
  const warnings = buildRouteWarnings([], { status: "empty", warning: "No riders assigned" });

  assert.deepEqual(warnings, [
    { key: "no-riders", label: "No riders assigned", level: "normal" },
  ]);
});

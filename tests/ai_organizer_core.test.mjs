import assert from "node:assert/strict";
import test from "node:test";

import {
  AI_ORGANIZER_SCHEMA,
  buildOrganizerPrompt,
  normalizeOrganizerResult,
  safeStopsForAi,
} from "../supabase/functions/ride-ai-organizer/organizer-core.js";

test("safeStopsForAi keeps only rider details needed for route planning", () => {
  const stops = safeStopsForAi([
    {
      id: "stop-1",
      driverSlug: "david-b",
      stopOrder: 2,
      name: "Owen",
      phone: "+1 555 111 2222",
      address: "100 First St, Houston, TX",
      area: "HCU",
      pickupTime: "10:20 AM",
      readyBy: "10:15 AM",
      routeLabel: "Early pickup",
      notes: "Use side gate",
      privateExtra: "do not send",
    },
  ]);

  assert.deepEqual(stops, [
    {
      id: "stop-1",
      driverSlug: "david-b",
      stopOrder: 2,
      name: "Owen",
      address: "100 First St, Houston, TX",
      area: "HCU",
      pickupTime: "10:20 AM",
      readyBy: "10:15 AM",
      routeLabel: "Early pickup",
      notes: "Use side gate",
    },
  ]);
});

test("buildOrganizerPrompt includes the admin instructions and current ride context", () => {
  const prompt = buildOrganizerPrompt({
    adminPrompt: "HCU by 12. David B can do two rides.",
    destination: { label: "Church", address: "4450 University Dr, Houston, TX" },
    drivers: [{ slug: "david-b", displayName: "David B.", initials: "DB" }],
    stops: [{ id: "stop-1", name: "Owen", phone: "+1 555 111 2222", address: "100 First St", area: "HCU", privateExtra: "do not send" }],
  });

  assert.match(prompt, /HCU by 12\. David B can do two rides\./);
  assert.match(prompt, /David B\./);
  assert.match(prompt, /Owen/);
  assert.match(prompt, /4450 University Dr/);
  assert.doesNotMatch(prompt, /\+1 555 111 2222|privateExtra|do not send/);
});

test("normalizeOrganizerResult keeps assignments for known riders and flags unknown names", () => {
  const result = normalizeOrganizerResult({
    summary: "Built draft.",
    routes: [
      {
        driverSlug: "david-b",
        driverName: "David B.",
        initials: "DB",
        summary: "1 ride",
        rides: [
          {
            label: "Ride 1",
            names: ["Owen", "Unknown Rider"],
            detail: "Arrive by 10:50",
          },
        ],
        why: "Closest group.",
      },
    ],
    assignments: [
      { riderName: "Owen", driverSlug: "david-b", rideLabel: "Ride 1", pickupTime: "10:20 AM", reason: "Early pickup." },
      { riderName: "Unknown Rider", driverSlug: "david-b", rideLabel: "Ride 1", pickupTime: "", reason: "" },
    ],
    warnings: ["One route is tight."],
  }, {
    drivers: [{ slug: "david-b" }],
    stops: [{ id: "stop-1", name: "Owen" }],
  });

  assert.deepEqual(result.assignments, [
    { stopId: "stop-1", riderName: "Owen", driverSlug: "david-b", rideLabel: "Ride 1", pickupTime: "10:20 AM", reason: "Early pickup." },
  ]);
  assert.deepEqual(result.warnings, [
    "One route is tight.",
    "Unknown Rider is not in this ride list yet.",
  ]);
});

test("AI_ORGANIZER_SCHEMA requires reviewable routes assignments and warnings", () => {
  assert.deepEqual(AI_ORGANIZER_SCHEMA.required, ["summary", "routes", "assignments", "warnings"]);
  assert.equal(AI_ORGANIZER_SCHEMA.additionalProperties, false);
  assert.equal(AI_ORGANIZER_SCHEMA.properties.routes.items.additionalProperties, false);
});

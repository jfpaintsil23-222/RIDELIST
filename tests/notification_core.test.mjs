import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRouteUpdatePayload,
  isExpiredSubscriptionStatus,
  normalizeDriverSlugs,
  summarizeSendResults,
} from "../supabase/functions/ride-driver-notifications/notification-core.js";

test("normalizeDriverSlugs lowercases trims and deduplicates drivers", () => {
  assert.deepEqual(
    normalizeDriverSlugs([" Joojo ", "dq", "JOOJO", "", null, "john-mark"]),
    ["joojo", "dq", "john-mark"],
  );
});

test("buildRouteUpdatePayload keeps the first route message plain", () => {
  assert.deepEqual(
    buildRouteUpdatePayload({ message: "Your pickup list was updated. Open your route review.", url: "./?route=review" }),
    {
      title: "RIDELIST",
      body: "Your pickup list was updated. Open your route review.",
      url: "./?route=review",
      tag: "ridelist-route-update",
    },
  );
});

test("expired subscription status only flags gone endpoints", () => {
  assert.equal(isExpiredSubscriptionStatus(404), true);
  assert.equal(isExpiredSubscriptionStatus(410), true);
  assert.equal(isExpiredSubscriptionStatus(201), false);
  assert.equal(isExpiredSubscriptionStatus(500), false);
});

test("summarizeSendResults returns partial success counts", () => {
  assert.deepEqual(
    summarizeSendResults([
      { driverSlug: "joojo", ok: true },
      { driverSlug: "dq", ok: false, error: "Gone" },
      { driverSlug: "dq", ok: true },
    ]),
    { sent: 2, failed: 1, driverSlugs: ["joojo", "dq"] },
  );
});

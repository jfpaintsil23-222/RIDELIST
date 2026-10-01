import assert from "node:assert/strict";
import test from "node:test";
import {
  comparableDraftStop,
  draftTimestamp,
  newestAdminDraft,
  normalizeDraftBackup,
  normalizedDraftSnapshot,
  recoveryCandidates,
} from "../src/admin-draft-core.js";

test("normalizes a draft backup without mutating the original stop list", () => {
  const raw = {
    source: "server",
    planDate: "2026-09-06",
    savedAt: "2026-09-04T15:00:00.000Z",
    reason: "rider-saved",
    stops: [{
      id: "stop-2",
      driverSlug: "Blu",
      stopOrder: "2",
      name: " Jasmine ",
      phone: "123",
      address: "Jackson-Shaver Hall",
      ignored: "nope",
    }],
    deleted_stop_ids: [" stop-1 ", "", null],
  };

  const normalized = normalizeDraftBackup(raw, { planDate: "2026-09-06" });

  assert.deepEqual(normalized.deletedStopIds, ["stop-1"]);
  assert.equal(normalized.source, "server");
  assert.equal(normalized.stops[0].driverSlug, "blu");
  assert.equal(normalized.stops[0].name, "Jasmine");
  assert.equal(normalized.stops[0].stopOrder, 2);
  assert.equal(normalized.stops[0].ignored, undefined);
  assert.equal(raw.stops[0].name, " Jasmine ");
});

test('recovery_keeps_all_candidates without choosing by saved time', () => {
  const candidates = recoveryCandidates([
    { source:'server', actorId:'profile:alpha', planDate:'2099-01-04', savedAt:'2099-01-04T00:00:00Z', stops:[{name:'First'}] },
    { source:'device', actorId:'profile:alpha', planDate:'2099-01-04', savedAt:'2099-01-05T00:00:00Z', stops:[{name:'Second'}] },
  ], { actorId:'profile:alpha', planDate:'2099-01-04' });
  assert.equal(candidates.length,2);
  assert.deepEqual(candidates.map(c=>c.stops[0].name),['First','Second']);
});

test('account_switch_cannot_read_other_backup or unclaimed contents', () => {
  const candidates = recoveryCandidates([
    { actorId:'profile:alpha', planDate:'2099-01-04', stops:[{name:'Alpha secret'}] },
    { planDate:'2099-01-04', stops:[{name:'Unclaimed secret'}] },
  ], { actorId:'profile:beta', planDate:'2099-01-04' });
  assert.equal(candidates.length,1);
  assert.equal(candidates[0].ownerReviewRequired,true);
  assert.equal(JSON.stringify(candidates).includes('secret'),false);
});

test("rejects draft backups for the wrong plan date", () => {
  assert.equal(
    normalizeDraftBackup({
      planDate: "2026-09-06",
      stops: [],
    }, { planDate: "2026-09-13" }),
    null
  );
});

test("builds stable draft snapshots for comparison", () => {
  const snapshot = normalizedDraftSnapshot([
    { id: "b", driverSlug: "blue", name: "Destiny", address: "910 Bearkat Blvd" },
    { id: "a", driverSlug: "jose", name: "Adrian", address: "" },
  ], ["stop-2", "stop-1", "stop-2"]);

  assert.deepEqual(snapshot.deletedStopIds, ["stop-1", "stop-2"]);
  assert.deepEqual(snapshot.stops.map((stop) => stop.id), ["a", "b"]);
  assert.deepEqual(comparableDraftStop({ name: " Tae ", driverSlug: "Jose" }), {
    id: "",
    driverSlug: "jose",
    stopOrder: 1,
    name: "Tae",
    phone: "",
    address: "",
    area: "",
    pickupTime: "",
    readyBy: "",
    routeLabel: "",
    notes: "",
    personId: "",
    personVersion: null,
    addressType: "",
  });
});

test("picks the newest local or server draft by savedAt timestamp", () => {
  const older = { source: "local", savedAt: "2026-09-04T14:00:00.000Z", stops: [] };
  const newer = { source: "server", savedAt: "2026-09-04T14:05:00.000Z", stops: [] };

  assert.equal(newestAdminDraft(older, newer), newer);
  assert.equal(newestAdminDraft(newer, older), newer);
  assert.equal(draftTimestamp({ savedAt: "bad-date" }), 0);
});

test('draft recovery preserves the explicit master dependency version', () => {
  const backup=normalizeDraftBackup({planDate:'2099-01-04',stops:[{id:'rider',name:'Synthetic',personId:'00000000-0000-0000-0000-000000000001',personVersion:3}]});
  assert.equal(backup.stops[0].personVersion,3);
  assert.notDeepEqual(normalizedDraftSnapshot(backup.stops),normalizedDraftSnapshot([{...backup.stops[0],personVersion:4}]));
});

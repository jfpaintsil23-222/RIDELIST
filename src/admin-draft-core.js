export function comparableDraftStop(stop = {}) {
  return {
    id: String(stop.id || "").trim(),
    driverSlug: String(stop.driverSlug || stop.driver_slug || "").trim().toLowerCase(),
    stopOrder: Number(stop.stopOrder || stop.stop_order || 1),
    name: String(stop.name || "").trim(),
    phone: String(stop.phone || "").trim(),
    address: String(stop.address || "").trim(),
    area: String(stop.area || "").trim(),
    pickupTime: String(stop.pickupTime || stop.pickup_time || "").trim(),
    readyBy: String(stop.readyBy || stop.ready_by || "").trim(),
    routeLabel: String(stop.routeLabel || stop.route_label || "").trim(),
    notes: String(stop.notes || "").trim(),
    personId: String(stop.personId || stop.person_id || "").trim(),
    addressType: String(stop.addressType || stop.address_type || "").trim(),
  };
}

export function normalizedDeletedStopIds(deletedStopIds = []) {
  return Array.from(new Set(
    (Array.isArray(deletedStopIds) ? deletedStopIds : [])
      .map((id) => String(id || "").trim())
      .filter(Boolean)
  )).sort();
}

export function normalizedDraftSnapshot(stops = [], deletedStopIds = []) {
  const sortedStops = (Array.isArray(stops) ? stops : [])
    .map(comparableDraftStop)
    .sort((a, b) => (
      a.id.localeCompare(b.id)
      || a.driverSlug.localeCompare(b.driverSlug)
      || a.name.localeCompare(b.name)
      || a.address.localeCompare(b.address)
    ));

  return {
    stops: sortedStops,
    deletedStopIds: normalizedDeletedStopIds(deletedStopIds),
  };
}

export function normalizeDraftBackup(raw, { source = "local", planDate = "" } = {}) {
  if (!raw || !Array.isArray(raw.stops)) return null;
  const expectedPlanDate = String(planDate || "").trim();
  const rawPlanDate = String(raw.planDate || raw.plan_date || expectedPlanDate).trim();
  if (expectedPlanDate && rawPlanDate !== expectedPlanDate) return null;

  const deletedStopIds = raw.deletedStopIds || raw.deleted_stop_ids || [];
  return {
    version: 1,
    source: String(raw.source || source),
    planDate: rawPlanDate,
    savedAt: String(raw.savedAt || raw.saved_at || ""),
    reason: String(raw.reason || ""),
    stops: (raw.stops || []).map(comparableDraftStop),
    deletedStopIds: normalizedDeletedStopIds(deletedStopIds),
  };
}

export function draftTimestamp(backup) {
  const timestamp = Date.parse(backup?.savedAt || "");
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export function newestAdminDraft(localDraft, serverDraft) {
  return [localDraft, serverDraft]
    .filter(Boolean)
    .sort((a, b) => draftTimestamp(a) - draftTimestamp(b))
    .at(-1) || null;
}

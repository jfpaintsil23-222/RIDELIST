export const AI_ORGANIZER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "routes", "assignments", "warnings"],
  properties: {
    summary: { type: "string" },
    routes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["driverSlug", "driverName", "initials", "summary", "rides", "why"],
        properties: {
          driverSlug: { type: "string" },
          driverName: { type: "string" },
          initials: { type: "string" },
          summary: { type: "string" },
          rides: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["label", "names", "detail"],
              properties: {
                label: { type: "string" },
                names: { type: "array", items: { type: "string" } },
                detail: { type: "string" },
              },
            },
          },
          why: { type: "string" },
        },
      },
    },
    assignments: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["riderName", "driverSlug", "rideLabel", "pickupTime", "reason"],
        properties: {
          riderName: { type: "string" },
          driverSlug: { type: "string" },
          rideLabel: { type: "string" },
          pickupTime: { type: "string" },
          reason: { type: "string" },
        },
      },
    },
    warnings: {
      type: "array",
      items: { type: "string" },
    },
  },
};

function text(value) {
  return String(value ?? "").trim();
}

function riderKey(value) {
  return text(value).toLowerCase().replace(/\s+/g, " ");
}

function driverName(driver) {
  return text(driver?.displayName || driver?.display_name || driver?.fullName || driver?.full_name || driver?.slug || "Driver");
}

export function safeDriversForAi(drivers = []) {
  return drivers.map((driver) => ({
    slug: text(driver?.slug),
    displayName: driverName(driver),
    initials: text(driver?.initials || driverName(driver).slice(0, 2).toUpperCase()),
    pickupCount: Number(driver?.pickupCount ?? driver?.pickup_count ?? 0) || 0,
    routeLabel: text(driver?.routeLabel || driver?.route_label),
    routeNotes: text(driver?.routeNotes || driver?.route_notes),
  })).filter((driver) => driver.slug && driver.displayName);
}

export function safeStopsForAi(stops = []) {
  return stops.map((stop) => ({
    id: text(stop?.id),
    driverSlug: text(stop?.driverSlug || stop?.driver_slug),
    stopOrder: Number(stop?.stopOrder ?? stop?.stop_order ?? 0) || 0,
    name: text(stop?.name),
    address: text(stop?.address),
    area: text(stop?.area),
    pickupTime: text(stop?.pickupTime || stop?.pickup_time),
    readyBy: text(stop?.readyBy || stop?.ready_by),
    routeLabel: text(stop?.routeLabel || stop?.route_label),
    notes: text(stop?.notes),
  })).filter((stop) => stop.id || stop.name);
}

export function buildOrganizerPrompt({ adminPrompt = "", destination = {}, drivers = [], stops = [] } = {}) {
  const driverLines = safeDriversForAi(drivers).map((driver) => (
    `- ${driver.displayName} (${driver.slug})${driver.routeLabel ? `: ${driver.routeLabel}` : ""}${driver.routeNotes ? `; ${driver.routeNotes}` : ""}`
  ));
  const stopLines = safeStopsForAi(stops).map((stop) => (
    `- ${stop.name} [${stop.id || "no-id"}]${stop.driverSlug ? ` assigned:${stop.driverSlug}` : " unassigned"}; area:${stop.area || "pending"}; address:${stop.address || "missing"}; pickup:${stop.pickupTime || "pending"}; ready:${stop.readyBy || "pending"}; route:${stop.routeLabel || "pending"}; notes:${stop.notes || "none"}`
  ));

  return [
    "You are RIDELIST Admin AI for a church ride list.",
    "Create practical driver route suggestions using only the drivers and riders provided.",
    "Do not invent riders, drivers, phone numbers, addresses, or publish anything.",
    "Prefer nearby clusters, time deadlines, must-stay groups, and multi-ride driver constraints from the admin instructions.",
    "Return route cards and assignment rows. Put uncertainty in warnings.",
    "",
    `Destination: ${text(destination?.label || "Church")} - ${text(destination?.address || "No address provided")}`,
    "",
    "Admin instructions:",
    text(adminPrompt) || "No extra admin notes.",
    "",
    "Drivers:",
    driverLines.length ? driverLines.join("\n") : "- No drivers provided",
    "",
    "Current riders:",
    stopLines.length ? stopLines.join("\n") : "- No riders provided",
  ].join("\n");
}

function normalizeRoute(route = {}, driverBySlug = new Map()) {
  const driverSlug = text(route.driverSlug);
  const driver = driverBySlug.get(driverSlug);
  const driverDisplayName = text(route.driverName) || driver?.displayName || driverSlug || "Driver";
  return {
    driverSlug,
    driverName: driverDisplayName,
    initials: text(route.initials || driver?.initials || driverDisplayName.slice(0, 2).toUpperCase()),
    summary: text(route.summary),
    rides: Array.isArray(route.rides)
      ? route.rides.map((ride) => ({
        label: text(ride?.label),
        names: Array.isArray(ride?.names) ? ride.names.map(text).filter(Boolean) : [],
        detail: text(ride?.detail),
      })).filter((ride) => ride.label || ride.names.length || ride.detail)
      : [],
    why: text(route.why),
  };
}

export function normalizeOrganizerResult(raw = {}, context = {}) {
  const drivers = safeDriversForAi(context.drivers || []);
  const stops = safeStopsForAi(context.stops || []);
  const driverBySlug = new Map(drivers.map((driver) => [driver.slug, driver]));
  const stopByKey = new Map(stops.map((stop) => [riderKey(stop.name), stop]));
  const warnings = Array.isArray(raw?.warnings) ? raw.warnings.map(text).filter(Boolean) : [];
  const seenWarnings = new Set(warnings.map((warning) => warning.toLowerCase()));
  const addWarning = (warning) => {
    const copy = text(warning);
    const key = copy.toLowerCase();
    if (copy && !seenWarnings.has(key)) {
      warnings.push(copy);
      seenWarnings.add(key);
    }
  };

  const assignments = [];
  (Array.isArray(raw?.assignments) ? raw.assignments : []).forEach((assignment) => {
    const riderName = text(assignment?.riderName);
    const stop = stopByKey.get(riderKey(riderName));
    const driverSlug = text(assignment?.driverSlug);
    if (!stop) {
      addWarning(`${riderName || "A rider"} is not in this ride list yet.`);
      return;
    }
    if (!driverBySlug.has(driverSlug)) {
      addWarning(`${riderName} was assigned to an unknown driver.`);
      return;
    }
    assignments.push({
      stopId: stop.id,
      riderName: stop.name,
      driverSlug,
      rideLabel: text(assignment?.rideLabel),
      pickupTime: text(assignment?.pickupTime),
      reason: text(assignment?.reason),
    });
  });

  return {
    ok: true,
    summary: text(raw?.summary) || "AI route ideas ready.",
    routes: (Array.isArray(raw?.routes) ? raw.routes : [])
      .map((route) => normalizeRoute(route, driverBySlug))
      .filter((route) => route.driverSlug || route.rides.length),
    assignments,
    warnings,
  };
}

export function parseOpenAiJson(payload = {}) {
  const outputText = text(payload.output_text);
  if (outputText) return JSON.parse(outputText);

  const output = Array.isArray(payload.output) ? payload.output : [];
  for (const item of output) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const part of content) {
      const value = text(part?.text || part?.content);
      if (value) return JSON.parse(value);
    }
  }

  throw new Error("missing_ai_output");
}

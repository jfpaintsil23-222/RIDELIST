export const GOOGLE_ROUTE_FIELD_MASK = "routes.duration,routes.distanceMeters,routes.legs.duration,routes.legs.distanceMeters";

export function orderedStops(stops = []) {
  return stops
    .slice()
    .sort((a, b) => Number(a.stopOrder ?? a.stop_order ?? 0) - Number(b.stopOrder ?? b.stop_order ?? 0) || String(a.name || "").localeCompare(String(b.name || "")));
}

export function stopsForDriver(drivers = [], stops = [], slug = "") {
  const isSingleDriverRoute = drivers.length === 1;
  return stops.filter((stop) => {
    const stopSlug = stop.driverSlug ?? stop.driver_slug ?? "";
    if (isSingleDriverRoute && !stopSlug) return true;
    return stopSlug === slug;
  });
}

export function buildGoogleRouteBody(stops = [], destination = {}) {
  const usableStops = orderedStops(stops).filter((stop) => String(stop.address || "").trim());
  const destinationAddress = String(destination.address || "").trim();
  if (!usableStops.length || !destinationAddress) return null;

  const [origin, ...intermediates] = usableStops;
  return {
    origin: { address: origin.address },
    destination: { address: destinationAddress },
    intermediates: intermediates.map((stop) => ({ address: stop.address })),
    travelMode: "DRIVE",
    routingPreference: "TRAFFIC_AWARE",
    computeAlternativeRoutes: false,
    units: "IMPERIAL",
  };
}

export function parseDurationMinutes(duration = "") {
  const match = String(duration).match(/^(\d+(?:\.\d+)?)s$/);
  if (!match) return null;
  return Math.max(1, Math.round(Number(match[1]) / 60));
}

export function formatDuration(minutes) {
  const total = Number(minutes || 0);
  if (!Number.isFinite(total) || total <= 0) return "";
  if (total < 60) return `${total} min`;
  const hours = Math.floor(total / 60);
  const remainder = total % 60;
  return remainder ? `${hours} hr ${remainder} min` : `${hours} hr`;
}

export function formatDistanceMiles(distanceMeters) {
  const meters = Number(distanceMeters || 0);
  if (!Number.isFinite(meters) || meters <= 0) return "";
  return `${Math.max(1, Math.round(meters / 1609.344))} mi`;
}

export function parsePickupMinutes(pickupTime = "") {
  const match = String(pickupTime).trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)$/i);
  if (!match) return null;

  let hours = Number(match[1]);
  const minutes = Number(match[2] || 0);
  const meridiem = match[3].toUpperCase();
  if (hours === 12) hours = 0;
  if (meridiem === "PM") hours += 12;
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return hours * 60 + minutes;
}

export function formatClockMinutes(minutesFromMidnight) {
  const total = ((Number(minutesFromMidnight || 0) % 1440) + 1440) % 1440;
  const hours24 = Math.floor(total / 60);
  const minutes = total % 60;
  const meridiem = hours24 >= 12 ? "PM" : "AM";
  const hours12 = hours24 % 12 || 12;
  return `${hours12}:${String(minutes).padStart(2, "0")} ${meridiem}`;
}

export function firstPickupTime(stops = []) {
  return orderedStops(stops).find((stop) => stop.pickupTime && !/follow|after|next/i.test(stop.pickupTime))?.pickupTime || "";
}

export function routeTimingFromGoogleRoute({ stops = [], googleRoute = {} }) {
  const totalMinutes = parseDurationMinutes(googleRoute.duration);
  if (!totalMinutes) {
    return { status: "error", warning: "Route time unavailable" };
  }

  const firstPickup = parsePickupMinutes(firstPickupTime(stops));
  return {
    status: "ready",
    totalMinutes,
    durationText: formatDuration(totalMinutes),
    distanceText: formatDistanceMiles(googleRoute.distanceMeters),
    etaText: firstPickup === null ? "" : formatClockMinutes(firstPickup + totalMinutes),
  };
}

export function buildRouteWarnings(stops = [], timing = null) {
  const warnings = [];
  const add = (key, label, level = "normal") => {
    if (!warnings.some((warning) => warning.key === key || warning.label === label)) warnings.push({ key, label, level });
  };

  if (!stops.length) add("no-riders", "No riders assigned");

  stops.forEach((stop) => {
    if (!String(stop.phone || "").trim()) add("missing-phone", "Missing phone", "urgent");
    if (!String(stop.pickupTime || "").trim()) add("missing-pickup-time", "Missing pickup time", "urgent");
    if (!String(stop.address || "").trim()) add("missing-address", "Missing address", "urgent");
  });

  if (timing?.status === "error") add("route-time-unavailable", "Route time unavailable");
  if (timing?.status === "loading") add("route-time-loading", "Checking route time");
  if (timing?.warning) add("route-warning", timing.warning, "urgent");

  return warnings;
}

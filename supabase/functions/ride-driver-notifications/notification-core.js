export function normalizeDriverSlugs(slugs = []) {
  const seen = new Set();
  return slugs
    .map((slug) => String(slug || "").trim().toLowerCase())
    .filter((slug) => {
      if (!slug || seen.has(slug)) return false;
      seen.add(slug);
      return true;
    });
}

export function buildRouteUpdatePayload({ message = "", url = "./" } = {}) {
  return {
    title: "RIDELIST",
    body: String(message || "Your pickup list was updated. Open your route review.").trim(),
    url: String(url || "./"),
    tag: "ridelist-route-update",
  };
}

export function isExpiredSubscriptionStatus(status) {
  return Number(status) === 404 || Number(status) === 410;
}

export function summarizeSendResults(results = []) {
  const driverSlugs = normalizeDriverSlugs(results.map((result) => result.driverSlug));
  return {
    sent: results.filter((result) => result.ok).length,
    failed: results.filter((result) => !result.ok).length,
    driverSlugs,
  };
}

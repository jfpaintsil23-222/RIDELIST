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

export function buildReturnReleasePayload(releaseId) {
  return {
    title: "RIDELIST",
    body: "Your rides home are ready. Open the app to view your list.",
    url: "./",
    tag: "ridelist-return-" + String(releaseId),
  };
}

export async function dispatchReturnJobs(jobs, {send, finish}) {
  const summary = {sent: 0, failed: 0, unknown: 0, noDevice: 0};
  for (const job of jobs) {
    let status = "no_device", error = "";
    if (job.active) {
      try { await send(job); status = "sent"; }
      catch (cause) {
        const code = Number(cause?.statusCode || cause?.status || 0);
        status = code ? "failed" : "unknown";
        error = code ? "Push service returned " + code : "Delivery result not confirmed";
      }
    }
    // A persistence failure must not turn an accepted send into a retryable send.
    await finish(job, status, error);
    summary[status === "no_device" ? "noDevice" : status]++;
  }
  return summary;
}

# Admin-controlled Rides Home release

Status: proposed design for user review. No product code, database, deployment, or notifications changed.

## Intent and agreed scope

The admin prepares the user's supplied return roster privately. Drivers continue seeing outbound pickups until the admin releases all regular return rides together. After release, each authenticated driver sees their own Rides Home list. Drivers with alerts enabled receive a notification. The user selected release-everyone-together rather than per-driver release on November 8, 2026 (America/Chicago).

Use the latest supplied Rides Home list as the return roster; preserve the separately reviewed pickup draft. Do not copy pickup assignments over return assignments. Do not include real rider details in this document, code, fixtures, screenshots intended for publication, or public artifacts.

## Approaches

1. Selected: one admin release for the entire regular return plan. This matches the user's chosen event-wide transition and gives one clear driver-facing state.
2. Considered: release one driver at a time. This allows staggered dispatch but adds per-driver states and controls the user did not select.
3. Rejected: hide return cards only in the browser. Drivers could still receive hidden data from the route API and different devices could disagree about release state.

## Current implementation and evidence

- The existing driver route RPC returns all stored stops for an authenticated driver. There is no release phase in the inspected plan/settings tables.
- Existing Web Push code handles opt-in, private subscription storage, admin sending, and service-worker notification taps.
- The November 8 live plan currently contains 60 return stops and zero newly drafted pickup stops. These existing returns are not currently behind an admin-only release gate.
- There are six active subscriptions across dates and zero attached to November 8. These are registrations, not evidence of delivery or reading. Do not claim all drivers can receive alerts.
- PR #9 is still open and unmerged. It separates pickup/return display, labels, and completion behavior, but does not implement private staging or release.
- Admin editing includes collaborative draft/revision handling. Integrate with that flow rather than creating a second independent roster editor.

## Admin experience

Add an admin-only Rides Home tab. Show grouped return assignments, unsaved changes, and a clear Not released / Released status. Editing return assignments does not notify anyone or expose them to drivers before release.

A Release Rides Home button opens a concise review showing the event date, number of return drivers/riders, and alert readiness. Its confirmation atomically publishes the reviewed return revision and switches this event to return mode. No stale or unsaved revision can silently replace newer work from another admin.

After completion show the release time and separate counts for notification sends accepted, failed, and drivers without alerts. A delivery problem does not roll back the published return list or show the release itself as failed. Refreshing the page or repeating the same request cannot release twice or enqueue duplicate sends.

Builder proposal: later corrections use the existing reviewed publication flow while preserving the released phase. They do not trigger another all-driver release or automatic broadcast. A retry control retries eligible failed notifications without changing routes.

## Driver experience

Before release, authenticated driver reads return only outbound pickup data, totals, headings, and destination details. Hidden return riders, addresses, counts, and timing are not supplied by driver-facing endpoints.

After release, the driver's default screen becomes Rides Home and shows only that driver's assigned regular return runs with drop-off wording and rider destinations. Pickup records and pickup completion are preserved separately; they must never mark return riders complete.

Re-fetch on driver login and foreground/focus. While an authenticated route is visible and online, check for a release/version change periodically (proposed 30 seconds). Clear stale route details when switching phase. A driver without a return assignment sees a clear no-return-assignment message, not another driver's route. Going offline must not falsely claim a freshly released list is current.

Notification copy: title RIDELIST, body Your rides home are ready. Open the app to view your list. Do not include rider names, phone numbers, or addresses on the lock screen. Tapping still requires the existing driver's authentication; no privileged access in the notification URL.

## Data and authorization

Persist direction as explicit validated metadata (pickup, regular return, later return) and release state scoped to a plan date. Exact table/column names are left to the implementation plan after reading current deployed definitions. Keep any new metadata in private storage protected by existing admin authorization, not by a client-only flag.

Make a release an authenticated, transactional, revision-checked operation with a unique operation ID, release timestamp/actor, and an auditable outcome. Enqueue notification work only after the approved return revision is committed; a durable delivery record permits safe status inspection and retry. Use existing subscription and Edge Function infrastructure where possible.

Cover all driver-facing data paths: route response, driver directory summaries, shared app context, timing/map inputs, and any caches. Audit their use before changing behavior. Admin reads retain access to both directions. Public and driver roles cannot release or fetch unreleased return data, even through direct calls or an older UI.

Do not move subscriptions from a prior Sunday to a different driver merely because a slug matches. An already opted-in device may refresh its registration for the current plan after that driver successfully authenticates on that device. Drivers without a supported, authorized subscription still see released routes when they open the app.

## Later drop-offs and roster gaps

Builder proposal: retain 6:00 PM drop-offs in a separate admin section, excluded from the regular release and its notification recipients. Their unassigned driver placeholder must not be treated as an authenticated real driver. No automatic 6:00 PM schedule is requested by this feature.

The newly added pickup riders without return assignments remain a visible admin review item; do not invent assignments or silently omit the warning. These gaps do not prevent reviewing the supplied return roster.

## Rollout and boundaries

Build and verify locally with synthetic passengers. Use an isolated checkout based on current main and reconcile PR #9 rather than deploying a conflicting second display implementation. Do not merge held PR #4 or unrelated PR #1.

A schema rollout must preserve legacy behavior until an event explicitly opts into the phase workflow. Because today's live plan is currently return-only and its pickup draft has not been published, do not enable the gate for November 8 before the reviewed outbound plan is installed and verified. Migration/backfill must preserve IDs, route assignments, contact data, historical plans, and existing completion state where compatible. Preserve the original approved return assignments while establishing direction.

No live deployment, roster publication, release, or actual push send occurs during design or local tests. The user's standing instruction to review before posting remains in force. No SMS, WhatsApp, new driver account scheme, or People Bank changes are included.

## Required verification

- Direct API reads cannot reveal regular return data before release, including via stale clients and summary/timing paths.
- Invalid driver/admin authentication cannot view or release data; cross-driver access remains denied.
- Release is atomic, revision-safe, date-scoped, and idempotent under double clicks, concurrent admins, and lost responses.
- Driver views correctly transition after release/login/focus, including drivers who have no push subscription or no return assignment.
- Partial push failure, no registered devices, and delivery timeouts are reported accurately without undoing or duplicating release.
- Pickup and return completion are independent, and the last return stop does not direct the driver back to the venue.
- Later drop-offs remain excluded; historical plans and unrelated live settings remain unchanged.
- Verify admin and driver screens on narrow and desktop layouts using synthetic data, then repeat essential checks against the approved deployment before any real release.

## Size

A moderate feature spanning admin controls, server-side visibility, driver refresh, and notification handling. Existing push infrastructure and the pending display work can be reused, but an instant frontend-only patch would not satisfy the requested privacy and release behavior. Give a tighter implementation estimate after the plan resolves live migration and notification integration details.

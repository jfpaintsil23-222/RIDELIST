# Zone and Run Driver Experience

## Goal

Make RIDELIST easier to operate as rider volume grows by grouping a driver's pickups into named zones and runs. Preserve the existing driver sign-in, weather, rider details, navigation actions, and simple mobile-first design.

This design is for a local first build. It does not publish code, change the live Supabase project, send SMS messages, or modify live PeopleData.

## Approved Driver Story

1. The driver chooses their name from the existing dropdown and enters their existing passcode.
2. Successful sign-in opens a driver overview instead of immediately showing one flat pickup list.
3. The overview shows:
   - Service date
   - Weather
   - Greeting with the driver's display name
   - Total assigned riders
   - One row per assigned zone and run
4. A run row uses plain language such as `TSU Zone · Run 1` or `TSU Zone · Run 2`.
5. Each row also shows rider count and departure time.
6. Tapping a run opens Run Details.
7. Run Details shows:
   - Zone and run name
   - Meetup location
   - Departure and destination-arrival times
   - Capacity usage
   - Riders in that run
   - Confirmation status
   - Message and Start Run actions
8. Tapping a rider continues to the existing rider detail workflow with protected address, Google Maps, Apple Maps, message, and call actions.

Drivers see only their own runs and riders. Admins retain access to the complete plan.

## Zone and Run Model

The first build reuses fields already present on ride stops:

- `area` supplies the zone or meetup area.
- `routeLabel` supplies the complete run label.
- `pickupTime` supplies the rider or run timing.
- `stopOrder` preserves order within a run.

Run identity is initially normalized from `routeLabel`. For example, all stops labeled `TSU Zone · Run 2` belong to one run. This avoids a live schema migration during the first UI iteration.

The grouping logic must be isolated behind helper functions so a future explicit `zone_id` and `run_id` schema can replace label-based grouping without rewriting the driver views.

## Driver Overview

The overview keeps the existing RIDELIST shell and hamburger menu. It displays:

- `Sunday · Sep 20`
- `Good morning, Blu`
- `7 riders`
- Existing weather summary
- Run rows ordered by earliest departure, then run label

The overview does not repeat phrases such as "assigned runs." The zone and run rows communicate the assignment directly.

If a driver has no riders, the existing no-pickups state remains available. If stops do not yet have a usable route label, they appear in a fallback `Assigned pickups` run instead of disappearing.

## Run Details

Run Details is a filtered version of the driver's assigned route. It shows only stops belonging to the selected run.

The screen calculates:

- Rider count from stops in the run
- Capacity from the driver's saved capacity when available
- Departure time from the earliest meaningful run timing
- Arrival time from secure route timing when available
- Meetup location from the shared address or area label

If riders in one run do not share a meetup location, the screen labels the run `Multiple pickup points` and preserves the existing ordered-stop experience.

## Confirmation Status

The visual system uses a colored dot plus text so color is never the only signal:

- Green dot, `Ready`: rider has confirmed
- Yellow dot, `Waiting`: confirmation is pending or no reply has been received
- Red dot, `Not coming`: rider declined or an administrator marked a real problem

The first local build must not pretend statuses are live. Until an inbound messaging integration exists, stops without confirmation data show `Waiting`. Test fixtures may demonstrate all three states, but production UI must reflect only stored data.

The status mapping is isolated behind a helper so Twilio can later update the same UI without redesigning it.

## Messaging Boundary

Twilio is intentionally outside the first implementation. The UI may retain the existing Message action and make space for confirmation status.

A later Twilio phase can:

1. Send a morning confirmation SMS.
2. Receive `YES` or `NO` through a Supabase Edge Function webhook.
3. Validate the Twilio signature.
4. Match the normalized sender phone number to the rider's active stop.
5. Store the confirmation state and timestamp.
6. Update the existing Ready, Waiting, or Not coming status.

Twilio credentials must remain in Supabase secrets and must never be included in frontend code. The webhook must be idempotent and must reject unsigned requests.

## Admin Compatibility

The first build does not redesign the admin workflow. Existing route labels remain editable and become the source of zone/run grouping.

Admin validation should warn when:

- A rider has no driver
- A rider has no usable run label
- A run exceeds known driver capacity
- A run has conflicting timing

These warnings should remain draft-time guidance. Existing publish blockers and draft backups must continue to protect work.

## Error and Fallback Behavior

- Missing weather does not block the dashboard.
- Missing route timing displays the saved departure time and the existing timing-unavailable notice.
- Missing capacity displays rider count without claiming the car is full.
- Missing run labels place riders in `Assigned pickups`.
- A stale or invalid run selection returns the driver to their overview.
- No run or status change publishes automatically.

## Testing

Automated tests must cover:

- Existing driver passcode login still works.
- Stops group into the correct zone and run.
- Run rows are ordered predictably.
- Driver overview shows date, weather, rider total, and only that driver's runs.
- Run Details shows only riders from the selected run.
- Missing route labels use the fallback run.
- Ready, Waiting, and Not coming include both dot styling and visible text.
- Driver detail actions and picked-up checkmarks still work.
- Existing admin publish reliability tests remain green.

The local UI must also be checked at mobile and desktop widths for text fit, status clarity, and navigation between overview and run details.

## Delivery Phases

### Phase 1: Local Zone and Run UI

- Add grouping helpers.
- Add driver overview run rows.
- Add filtered Run Details.
- Add honest stored-status rendering with Waiting as the default.
- Preserve all current rider detail actions.

### Phase 2: Admin Zone and Run Controls

- Replace free-form route-label dependence with simple zone and run selectors.
- Add capacity and timing warnings.
- Keep existing draft backup and publish safeguards.

### Phase 3: Twilio Confirmation

- Add outbound morning messages.
- Add the signed inbound webhook.
- Store reply status and timestamp.
- Refresh driver and admin status views.

Each phase requires separate verification and explicit approval before any live deployment or live database change.

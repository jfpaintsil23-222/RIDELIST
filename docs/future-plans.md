# RIDELIST Future Plans

Use this as the running parking lot for improvements we want to remember, but are not building yet.

## Push Notifications Live Enablement

- Admin-to-driver push notification code is built locally.
- Apply the Supabase SQL source to project `cpkimtrribpvqxbywfry` when approved.
- Set Edge Function secrets: `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, and `VAPID_SUBJECT`.
- Deploy `ride-driver-notifications` with `verify_jwt = false`, matching the app's custom admin/driver-code authorization.
- Push the GitHub Pages source after final approval.

## People Bank And Route Capacity

- Add a simple seat-count option when adding or editing a rider on a Sunday route.
- Keep this on the route pickup, not as permanent People Bank data.
- Default should be `1` rider.
- Simple choices should be `1`, `+1`, and `+2`.
- Route cards and driver views should only show the extra count when needed, such as `Fabio +1`.
- Route totals should count seats, such as `4 pickups · 6 seats`, so admins know how much car space is needed.

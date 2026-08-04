# Admin Ride Control Design

## Goal

Add a mobile admin area to the existing ride app so trusted coordinators can make last-minute route changes without editing Supabase by hand.

## Scope

- Add an admin button on the main ride plan screen.
- Protect admin tools with a shared admin passcode stored only as a database hash.
- Show all drivers, rider counts, and all assigned riders in one admin view.
- Split admin ride control into working `Routes`, `Riders`, and `Changes` tabs.
- Let admins add a rider, edit rider details, move a rider to another driver, change pickup/ready times, and delete a rider.
- Keep changes as an admin draft in the browser until the admin presses a publish/save action.
- After publishing, driver route screens read the updated route from Supabase the next time they open or refresh.
- Remember for later: People Bank bulk upload/search and driver text notifications are follow-up features, not required for this first admin build.

## Data Model

The current database has `rides_private.ride_plans`, `rides_private.ride_drivers`, and `rides_private.ride_stops`. This build adds one private table for admin passcodes and public RPC functions that validate the passcode before returning or changing data. Existing ride tables stay private with RLS enabled.

## Admin RPCs

- `ride_admin_snapshot(p_admin_code, p_plan_date)` returns the plan, destination, all drivers, all assigned stops, and summary counts.
- `ride_admin_publish_plan(p_admin_code, p_plan_date, p_stops, p_deleted_stop_ids)` inserts, updates, moves, or deletes stops after validating the admin code.

The admin code is never embedded in the page or committed to the public repo. The page sends whatever the admin typed; Supabase compares its hash against the private admin table.

## UI Flow

1. Admin taps the top-right admin control.
2. Admin enters the passcode.
3. Ride Control opens on `Routes`, where drivers are grouped with their assigned riders.
4. Admin can switch to `Riders` to search every assigned rider by name, driver, phone, address, area, or time.
5. Admin edits a rider, creates a new rider, or removes a rider.
6. The browser opens `Changes`, showing the unpublished draft before anything goes live.
7. Admin presses publish/save.
8. Supabase updates the plan and the admin view refreshes.

## Error Handling

- Wrong passcode shows an admin login error.
- Failed publish keeps the draft visible and shows a save error.
- Required fields: rider name, pickup address, and assigned driver.
- Invalid or blank times are saved as blank times.

## Verification

- Automated checks cover admin RPC login, snapshot loading, add/move/edit/delete of a temporary rider, functional admin tab rendering, rider search, and changes review.
- Manual browser verification covers admin login, rider search, adding a temporary rider, reviewing the pending change, publishing, removing the temporary rider, and confirming cleanup.

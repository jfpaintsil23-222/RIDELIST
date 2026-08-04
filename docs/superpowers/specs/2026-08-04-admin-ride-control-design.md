# Admin Ride Control Design

## Goal

Add a mobile admin area to the existing ride app so trusted coordinators can make last-minute route changes without editing Supabase by hand.

## Scope

- Add an admin button on the main ride plan screen.
- Protect admin tools with a shared admin passcode stored only as a database hash.
- Show all drivers, rider counts, and assigned riders in compact driver dropdowns.
- Split admin ride control into working `Routes`, `Riders`, `Data`, and `Changes` tabs.
- Let admins add a rider, edit rider details, move a rider to another driver, change pickup/ready times, and delete a rider.
- Let admins search PeopleData, add an existing saved person to a route, map them, or call them.
- Keep the full PeopleData bank visible in a searchable `Data` tab.
- Keep changes as an admin draft in the browser until the admin presses a publish/save action.
- After publishing, driver route screens read the updated route from Supabase the next time they open or refresh.
- Remember for later: driver text notifications are a follow-up feature, not required for this first admin build.

## Data Model

The current database has `rides_private.ride_plans`, `rides_private.ride_drivers`, and `rides_private.ride_stops`. This build adds private tables for admin passcodes and PeopleData, plus public RPC functions that validate the passcode before returning or changing protected data. Existing ride tables stay private with RLS enabled.

## Admin RPCs

- `ride_admin_snapshot(p_admin_code, p_plan_date)` returns the plan, destination, all drivers, all assigned stops, summary counts, and PeopleData.
- `ride_admin_publish_plan(p_admin_code, p_plan_date, p_stops, p_deleted_stop_ids)` inserts, updates, moves, or deletes stops after validating the admin code.
- `ride_admin_upsert_people(p_admin_code, p_people)` inserts or updates private PeopleData rows after validating the admin code.

The admin code is never embedded in the page or committed to the public repo. The page sends whatever the admin typed; Supabase compares its hash against the private admin table.

## UI Flow

1. Admin taps the top-right admin control.
2. Admin enters the passcode.
3. Ride Control opens on `Routes`, where each driver is a collapsed row; tapping the row opens their pickup list.
4. In an open driver route, each rider can be edited, mapped, called, or moved to another driver.
5. Remove is only inside the edit screen, above the cancel/save controls, so it is harder to tap by accident.
6. Admin can switch to `Riders` to search PeopleData and add saved people to routes.
7. Admin can switch to `Data` to inspect the full PeopleData bank, including campus/home addresses and phone numbers.
8. The browser opens `Changes`, showing the unpublished draft before anything goes live.
9. Admin presses publish/save.
10. Supabase updates the plan and the admin view refreshes.

## Error Handling

- Wrong passcode shows an admin login error.
- Failed publish keeps the draft visible and shows a save error.
- Required fields: rider name, pickup address, and assigned driver.
- Invalid or blank times are saved as blank times.

## Verification

- Automated checks cover admin RPC login, snapshot loading, protected PeopleData loading, add/move/edit/delete of a temporary rider, functional admin tab rendering, PeopleData search, route dropdowns, move controls, edit-screen removal, and changes review.
- Manual browser verification covers admin login, PeopleData search, adding a saved person as a draft, opening a driver dropdown, and moving a rider into the edit screen.

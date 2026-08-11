# People Bank Cleanup Tools Design

## Goal

Add calm admin tools for reviewing, editing, and merging PeopleData records without changing live PeopleData until an admin explicitly confirms a specific save.

## Scope

- Keep RIDELIST mobile-first and visually consistent with the existing black/white admin UI.
- Preserve the existing People search and add-to-route behavior.
- Add a person detail screen so each People card does not carry too many buttons.
- Add edit and merge tools behind the person detail screen.
- Show a review screen before saving edits or merges.
- Do not auto-clean, bulk-update, or modify live Supabase records during implementation.
- Do not change driver flows, route timing, weather, Sunday reset, or admin login behavior.

## UX Direction

The People tab stays simple. Search results show each person as a compact card with name, best address, phone summary, status, and one open affordance. The list should not show a merge button on every row.

Opening a person shows the detail screen. This screen gives admins the normal actions they need most often: add to route, edit, map, call, and, only when relevant, merge duplicate. Duplicate cleanup is treated as a careful secondary workflow, not a primary action.

Editing a person opens a form for name, phone, campus address, home address, preferred address type, and notes/source detail. The first submit goes to review, not directly to Supabase.

Merging starts from a person detail screen or duplicate warning. Admin chooses which record is primary, reviews the final saved record, sees which duplicate will be hidden, and confirms before saving.

## Data Model

Existing PeopleData fields remain the foundation:

- `id`
- `name`
- `campusAddress`
- `homeAddress`
- `phone`
- `preferredAddressType`
- `preferredAddress`
- `sourceLabel`
- `active`
- `notes`

Add `notes text not null default ''` to `rides_private.ride_people` in the SQL source so notes are real PeopleData fields, not client-only draft text. The first implementation updates repository SQL only; live schema changes require a separate user-approved Supabase action.

## Supabase Behavior

Use admin-protected RPCs only. The browser must continue using the publishable key and must never expose service-role keys.

The existing `ride_admin_upsert_people` RPC can support simple edits by upserting a single person, but merge needs a safer dedicated RPC so the duplicate can be deactivated only after admin confirmation.

Planned RPC behavior:

- `ride_admin_upsert_people` remains for insert/update of active people.
- Add a dedicated `ride_admin_merge_people` RPC in SQL source for merge/archive behavior.
- Merge should update the primary record and set the duplicate record inactive.
- Saved responses should return a fresh admin snapshot so the People list immediately reflects the change.

## Validation And Safety

- Name is required.
- At least one address or phone should be present before saving.
- Preferred address type must be `home` or `campus`.
- Merge requires two different person IDs.
- Merge requires a selected primary record.
- Admin sees the final record preview before confirming.
- Duplicate records are hidden from normal People search only after confirmation.
- Existing route assignments are not automatically rewritten during this first pass.

## Error Handling

- If PeopleData cannot save, keep the admin on the review screen and show a clear error.
- If the selected person disappears after refresh, return to the People tab with a not-found message.
- If merge candidates are invalid, block confirm and explain what is missing.
- If the admin session/code is not accepted, reuse the existing admin error path.

## Testing

Automated tests should cover:

- People list stays uncluttered and does not show merge buttons on every card.
- Person detail exposes add/edit/map/call and shows duplicate merge only when relevant.
- Edit form reviews changes before save.
- Merge review shows the selected primary, duplicate archive target, and final record.
- Invalid merge state cannot confirm.
- Existing People search/autofill/add-to-route behavior remains intact.
- SQL source contains the admin-protected merge/archive RPC if implementation adds one.

Live Supabase RPC tests require admin credentials and must not be run in a way that cleans or mutates real PeopleData records until the user explicitly approves a specific live change.

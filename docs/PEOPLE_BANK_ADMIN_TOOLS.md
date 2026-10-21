# People Bank areas and admin connections

People Bank now groups saved contacts into TSU, HCU, UH, Off Campus and Sam Houston
State. Saved area metadata takes priority; explicit campus names provide suggestions
when no label is saved. Unknown areas, missing contact details and uncertain addresses
appear under Needs review. Street names are not used to guess university affiliation.

Address review compares the current route with saved home/campus addresses only when
both normalized name and phone match. A different pickup is a review prompt, not proof
that the saved home address is wrong. Formatting-only Street/St, Road/Rd, Avenue/Ave,
Drive/Dr and punctuation differences are ignored. No automatic address replacements,
contact merges or route publications are introduced.

## Installation

1. Apply `supabase/migrations/20261021152038_people_bank_admin_areas.sql` to the intended
   RIDELIST project. It adds one metadata column and two RPCs using existing admin
   authorization. It does not alter the legacy contact upsert or shared-admin mode.
2. Deploy `ride-place-autocomplete` and `ride-ai-organizer` with their local dependencies.
   Both authenticate inside the handler through `ride_admin_snapshot`; preserve this
   validation when configuring the Edge gateway for profile-code sessions.
3. Serve the updated `index.html`. Missing area RPCs produce an unavailable/reload state
   rather than breaking the rest of Ride Control.

Google Places uses `GOOGLE_PLACES_API_KEY`, falling back to `GOOGLE_ROUTES_API_KEY`.
The Google project must have active billing and the corresponding Places/Routes APIs.
Restoring a billing account is an account-owner action, not a code deployment.

AI Organizer requires `OPENAI_API_KEY` in Supabase Edge Function secrets. Optionally set
`OPENAI_MODEL`; the existing default remains unchanged. Enter keys in the provider
dashboard, never in frontend files, notes, commits or chat. The OpenAI key stays on the
server; the request uses Responses with `store: false`, omits rider phone numbers, and
returns suggestions for admin review. It does not publish routes or correct addresses.
See [OpenAI response storage](https://developers.openai.com/api/docs/guides/conversation-state).

## Verification

`node --test tests/admin_ui.test.mjs tests/admin_edge_connections.test.mjs`
checks grouping, search, address comparisons, area-save isolation, stale responses,
logout, provider authorization and configured/unconfigured AI behavior.

`RIDELIST_TEST_CONTAINER=<disposable-container> node --test tests/*.test.mjs`
also checks the area migration against PostgreSQL. Follow `tests/PUBLISH_TESTS.md`:
the container must have no network, published ports or persistent volume. Never use
production credentials for fixtures. Eight pre-existing integration tests remain
credential-gated; passing mocked provider tests does not verify paid API access.

`node tests/browser/people-bank-preview.mjs` serves a local synthetic-only UI on
127.0.0.1:4177. Outbound requests are blocked. Changes there affect fictional data only.

Rollback the frontend/function code to its previous version if needed. The additive
metadata column can remain; do not drop saved labels as part of a routine rollback.

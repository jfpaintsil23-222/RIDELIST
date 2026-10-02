# Local publish transaction tests

These tests execute the actual `ride_admin_publish_plan` definition from each
SQL setup file in PostgreSQL. Both definitions must remain safe because applying
`sunday_reset.sql` replaces the definition from `admin_ride_control.sql`.

The database contains only synthetic riders. The fixture supplies a minimal
schema, synthetic authorization and snapshot functions, and a minimal synthetic
audit trigger. The shared harness below additionally loads the production audit
functions to validate attribution and no-op behavior.
The production time parser, summary helper and publish function are loaded from
source. This verifies publishing writes and rollback semantics, not deployed
Supabase schema, RLS, authentication or browser behavior.

## Run

Use a disposable container only: the tests recreate the `rides_private` schema.
No remote database URL is accepted. The container name must start with
`ridelist-publish-test-`.

```sh
docker pull postgres:17
docker run --detach --name ridelist-publish-test-local --network none \
  --tmpfs /var/lib/postgresql/data \
  -e POSTGRES_HOST_AUTH_METHOD=trust postgres:17
docker exec ridelist-publish-test-local pg_isready -U postgres
RIDELIST_TEST_CONTAINER=ridelist-publish-test-local node --test tests/publish_atomicity.test.mjs
RIDELIST_TEST_CONTAINER=ridelist-publish-test-local node --test tests/*.test.mjs
docker rm --force ridelist-publish-test-local
```

Wait for `pg_isready` to report accepting connections before running tests.
There are no exposed host ports, network access or persistent database volumes.
Without `RIDELIST_TEST_CONTAINER`, transaction tests explicitly skip. The existing
credential-gated Supabase integration tests also skip unless their credentials
are supplied; do not supply production credentials for this local test run.

## Regression evidence, October 1, 2026

Base: `9dc40f1c2adf9698478312cd07e3406bc2704e03`.
Official PostgreSQL 17 image digest:
`sha256:d74eeac9a635390a49bc21bd49fccd973de707e2a53a76ac49b552b8712ec46f`.

- Before the fix: 14 transaction tests, 6 passed, 8 failed, none skipped.
  Both definitions committed an earlier update/deletion and audit effects when
  a later rider had a missing driver, unknown driver or missing name. Both also
  accepted malformed stop payloads and committed deletions.
- After the fix: all 14 transaction tests passed. The complete suite passed
  135 tests with zero failures and 8 existing credential-gated tests skipped.
- Successful updates/inserts/deletions and driver summaries still commit.
  Unauthorized requests leave state unchanged. Unexpected constraint errors
  remain database errors and roll back preceding changes.

The fix uses a PostgreSQL exception subtransaction around all publish writes.
Validation raises a dedicated SQLSTATE; the handler returns the existing error
payload only after PostgreSQL has rolled back the block. Other errors propagate.
UI source is unchanged; existing frontend draft-retention/error tests pass.

Deployment is separate: verify the target schema/version, review the function
patch, and apply the updated function through the approved database deployment
workflow. Nothing in these tests deploys or calls production.

## Shared admin schema tests

`tests/shared_admin_db.test.mjs` uses the same disposable container and creates
its own `ridelist_shared_admin_test` database. Publish tests continue to recreate
their schema in `postgres`, so both files can run in the complete Node suite.
The new harness verifies PostgreSQL major version 17, network mode `none`, no
published ports, and a tmpfs data directory before loading any fixture.

```sh
RIDELIST_TEST_CONTAINER=ridelist-publish-test-local node --test tests/shared_admin_db.test.mjs
RIDELIST_TEST_CONTAINER=ridelist-publish-test-local node --test tests/*.test.mjs
```

The shared fixture contains synthetic profiles, sessions, JWT membership, and
unrelated church objects. It loads the actual profile-session actor helper from
`admin_security.sql` and the complete additive `collaborative_ride_control.sql`.
It also loads the real legacy code authorization helpers, verifying that a valid
legacy shared code remains accepted there and is denied by the shared RPCs.
Its lightweight `auth.uid()`/`auth.jwt()` fixtures model gateway-provided claims;
they do not test JWT signature verification. The published snapshot adapter is
a synthetic envelope; existing publish transaction tests cover live rollback.

Coverage includes stable profile identity across token refresh, expiry/revocation,
disabled profiles/admin membership, active JWT session/expiry, driver/forged
identity denial, table and helper privileges, deny-by-default RLS even after an
accidental read grant, three-admin shared snapshots, ordered minimal events,
legacy-mode read-only behavior, and safe schema reapplication. It never changes
real profiles, passwords or access grants. Missing `RIDELIST_TEST_CONTAINER`
explicitly skips database cases; do not supply production integration credentials.

Schema preparation does not initialize a workspace or enable shared writers.
Shared cutover must wait for mutation/publication and legacy compatibility fences,
recovery review, and separately authorized rollout.

## Versioned mutations and shared publication (Task 2)

The shared harness now loads the actual canonical publication helper, legacy
writer definitions and ACLs from the SQL sources. Its explicit `initialize()`
helper enables shared mode only for synthetic fixtures. Reads and applying the
schema still never initialize or cut over a production workspace.

Every mutation/publication locks the plan then workspace. Concurrency cases use
independent `psql` connections: the first transaction retains its locks, the
second is observed waiting in `pg_stat_activity`, then the first commits. Tests
assert rider/group/workspace versions, event counts and hashes of published rows
and audit effects. Coverage includes independent edits, entity/group conflicts,
move/remove/reorder races, duplicate IDs, changed bodies, refreshed tokens, actor
isolation, retained expired IDs, both save/publish orderings, competing publishers,
first-publication UUID preservation, cross-plan UUID collision prevention,
validation rollback and unexpected-error rollback over existing published rows.

Activation accepts server-known driver slugs. Shared driver JSON contains only
public metadata; candidate publication copies access hashes directly between
server rows. Empty driver arrays are valid. Unassigned riders are retained with
`unassigned: true`, and actual canonical publication validation rejects them.

Legacy whole-draft save/clear/publish and plan-driver writers reject `shared` and
`paused` plans before effects. Global People Bank/settings/import writers reject
while any plan is shared or paused; this is transitional fencing until the
versioned master/settings wrappers and frontend paths are installed in Task 4.
These fences affect only the relevant Rides RPCs. Existing unrelated church
objects and published driver data are preserved.

The original fourteen publication tests still run both public legacy wrappers
and their actual private canonical helper. A fifteenth source check verifies the
identical canonical helper and matching wrapper behavior while preserving the
existing setup-specific default dates. Private helper execution is denied to
PUBLIC, anon and authenticated; no client-controlled GUC authorizes publication.

Task 2 complete-suite evidence: 169 tests, 161 passed, zero failures, eight
existing credential-gated integration skips. The disposable database cannot
verify the deployed Supabase schema, gateway signatures, production audit
triggers, browser wiring or rollout. No production calls or credentials are used.


### Task 2 review correction

Shared fixtures now enforce the immediate production `UNIQUE(driver_id,stop_order)`
and `ON DELETE CASCADE` driver FK. They load the actual `ride_admin_actor`,
`log_ride_admin_event` and `log_ride_stop_admin_change` functions and audit-log
schema from `admin_security.sql`; the initial minimal audit replacement is gone.
Rollback hashes include the actual audit table.

Publication preserves surviving rows, their creation times and unchanged-row
update times. Genuine deletes are limited to absent/tombstoned draft riders.
Route swaps/moves temporarily park changed rows above current/intended orders to
honor immediate uniqueness, then write final positions. The actual audit trigger
buffers these intermediate writes only while an engine-owned private ledger
result contains the current transaction's `auditTransaction` marker. The engine
sets the validated profile audit context before any write, emits actual existing
audit events once per semantic final difference, and replaces the marker before
returning. The marker is not a public result, cannot be created by a client body
or GUC, and rolls back on errors. Install the updated audit function together
with both canonical helper definitions and the shared engine before cutover.

Regression checks cover unchanged republish preserving complete stop rows and
producing no audit events; accurate profile attribution for genuine insertion,
update and deletion; route reorder/cross-driver swaps under immediate uniqueness;
publication retry audit exactly once; public-input/GUC spoof attempts and direct
private-marker write denial; legacy audit after publication; validation/database
failure rollback of marker and actual audit effects. Entity conflicts now contain
`conflict.current` with current rider values, authoritative ID/version/assignment,
`deleted`, `unassigned` and `lastActorKey`, including deleted riders and stable
retry results.

Review-correction full-suite evidence: 175 tests, 167 passed, zero failures,
eight existing credential-gated integration skips. Focused actual database and
canonical publication suite: 46 passed, zero failures/skips. These results include
all original fourteen publication regressions and all 31 shared database cases.

## Integrated rollout rehearsal (Task 7)

The shared harness now installs the actual output of
`node tools/build-collaborative-rollout.mjs`. This offline generator emits only the
allowlisted canonical audit functions/trigger, publication helper, fenced legacy
writers and additive shared schema in one transaction. It excludes setup seeds,
identity/auth redefinition and activation. Deployed NULL/current-plan defaults are
preserved using the Sunday wrappers. Guard tests reject missing/duplicate function
boundaries, unexpected signatures/delimiters, trigger drift and divergent canonical
helpers. Read and follow `docs/COLLABORATIVE_ROLLOUT.md` before any installation.

New real PostgreSQL scenarios:

- `three_admin_end_to_end`: three separate synthetic sessions, independent concurrent
  saves, same-rider stale conflict, deliberate fresh save, lost-result lookup scoped
  to the original actor, competing publishers, identical final snapshots and events.
- `old_client_cutover_denied`: preparation cannot activate directly; legacy writes
  are blocked after freeze, activation and operator rollback/pause without effects.
- `migration_retains_candidates`: all three server drafts plus changed server and
  known/unknown-baseline device candidates survive reapply and explicit draft import.
- `rollback_preserves_latest_baseline`: two publications followed by pause/resume
  retain baseline 2, latest published rows, shared draft/events/operations/recovery;
  an old reviewed publication conflicts. Tests execute the runbook's actual SQL.
- `revocation_clears_private_access`: revoked third profile loses context, snapshot,
  secondary, recovery, operation status, import, mutation and publish access; the
  other actors remain authorized, retained candidates are not deleted.
- The bundle reapply check compares full-row hashes of existing profiles, sessions,
  app settings, driver catalog, shared state, published data and unrelated function.
- Actual `pg_dump -Fc` / `pg_restore --exit-on-error` into a separate disposable
  database retains latest publication, shared history/recovery, private ACLs and
  forced RLS. The active test database is unchanged; the restored copy is removed.

Two sync-controller regressions cover pause/resume with unchanged revisions and
an uncertain operation, plus revocation during result lookup stopping private reads.

Fresh local browser coverage:

```sh
node tests/browser/shared-admin-preview.mjs
PLAYWRIGHT_BROWSERS_PATH=/Users/joojo/Documents/Codex/2026-10-01/task-2/browser-qa-tooling/browsers node tests/browser/shared-admin-rollout-qa.mjs
```

Restart the preview before each script: fixture state is deliberately shared and
mutable. The new script uses three isolated contexts (390, 430, 1363px), normal UI
recovery review/import/publish/editor controls, and test-only local operator pause/
revocation controls. It verifies actor-scoped recovery, unknown-baseline denial,
import remaining unpublished, explicit publication, pause preserving latest live
state and personal input, resume retaining baseline, and revocation clearing private
DOM/state while keeping actor-scoped device recovery. No external fetch is proxied;
CSP and browser routing block external requests. This transport fixture does not
replace PostgreSQL authorization evidence. Existing Task 6 browser evidence covers
same-rider comparison, moves, offline/focus recovery, lost responses and measured
2455ms normal visibility; those approved results are retained, not represented as
new Task 7 executions.

Final Task 7 command:
`RIDELIST_TEST_CONTAINER=ridelist-publish-test-shared-task1 node --test tests/*.test.mjs`
— **279 PASS, 0 FAIL, 8 existing credential-gated SKIP, 287 total**, 57.1 seconds.
All new database cases ran. Actual Chromium rollout script — **PASS**, zero page
errors and external requests. Synthetic backup restore — **PASS**. Physical-phone,
installed PWA/background behavior, production backup restore, live latency,
production migration/activation/push/deployment and real third-account grant —
**NOT RUN**. No production rider/contact values were fetched or edited.

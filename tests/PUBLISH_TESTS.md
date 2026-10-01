# Local publish transaction tests

These tests execute the actual `ride_admin_publish_plan` definition from each
SQL setup file in PostgreSQL. Both definitions must remain safe because applying
`sunday_reset.sql` replaces the definition from `admin_ride_control.sql`.

The database contains only synthetic riders. The fixture supplies a minimal
schema, synthetic authorization and snapshot functions, and a real audit trigger.
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

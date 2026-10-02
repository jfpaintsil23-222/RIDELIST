# Collaborative Ride Control — operator rollout

Candidate: `feature/collaborative-ride-control`, core Tasks 1–7. This document is
an executable rehearsal and Main01 handoff, not evidence of production deployment.
The user authorized tested push/deployment and the subsequent driver phase.
Complete independent whole-branch review and the action-time checks below; do not
ask for generic push permission again. Account creation, identity binding, password
reset and actual mode transitions require the operator's explicit target, plan,
identity and maintenance-window decision. No real third account was created here.

## Target and release record

- Canonical repository: `https://github.com/jfpaintsil23-222/RIDELIST.git`, branch
  `main`; site `https://jfpaintsil23-222.github.io/RIDELIST/`.
- This worktree's `origin` is a **local mirror**, not GitHub. Main01 must inspect
  `git remote -v`, fetch the canonical repository explicitly, compare its current
  main with the reviewed candidate, resolve any divergence, then use the agreed
  integration workflow. Do not blindly push `origin` or force-push.
- Database: Supabase `cpkimtrribpvqxbywfry`, shared Area1EventManagement project.
  Task 7 read-only inspection on 2026-10-02 found PostgreSQL **17.6**, **11 plans**,
  **2 active admin profiles**, **0 shared relations**. This is current pre-install
  evidence, not confirmation of migration readiness or approval of a third account.
- The live stop trigger is `ride_admin_audit_stops`, enabled `O`, AFTER INSERT OR
  DELETE OR UPDATE, FOR EACH ROW, no predicate, calling
  `rides_private.log_ride_stop_admin_change()`. The function needs the candidate's
  new audit-buffer implementation before shared publication.
- Record final reviewed commit, asset hashes, additive SQL SHA256, migration ID,
  target ref, chosen plan, operator, backup location/hash, pre/post function/ACL
  manifests, browser evidence and physical-device result in the release record.
  Do not record contact values, tokens, passwords, or credential hashes.

Observed pre-install `md5(pg_get_functiondef(oid))` (metadata only):

| Function | Definition MD5 |
| --- | --- |
| public.ride_admin_publish_plan | ecf3abf7d85ca5b3987dc5025e21ffbd |
| public.ride_admin_save_draft | f926324ebed125b8d6db4ab1aabba69b |
| public.ride_admin_clear_draft | dd80e25b1bd33a8fd317717c15584eb5 |
| public.ride_admin_update_event_setup | de6d143ffacac7e69c4806063bebbea7 |
| public.ride_admin_update_plan_drivers | cee635ee704520adf40d99125d0335f0 |
| public.ride_admin_upsert_people | b9be3ee2eb44496bbfa82dfc9296ef51 |
| public.ride_admin_start_new_sunday | ee95713b8c03c58a2712c429bf907c15 |
| public.ride_admin_add_driver | 4840438a0cf94e58d5d0710dbea99df3 |
| rides_private.ride_admin_profile_session_actor | e9dfa73d677d117af460df1d41e8f4db |
| rides_private.ride_admin_actor | 8aadf4faad31b99405d335cf744cb2ed |
| rides_private.log_ride_admin_event | aa5f65426d016c0859e91aab62657a7d |
| rides_private.log_ride_stop_admin_change | 2d68f8a4c4733c3ce6692acbf6e7898e |

Latest migration remains `20261001071224` (`atomic_ride_publish_validation_rollback`).
Project status is ACTIVE_HEALTHY in us-east-1. Live stop FK is ON DELETE CASCADE
and stop ordering uses immediate UNIQUE(driver_id,stop_order).

All inspected functions are SECURITY DEFINER with empty search_path. Existing
public writer ACLs grant anon/authenticated/service_role; save/clear revoke PUBLIC,
other inspected legacy writers still grant PUBLIC. Private helper ACLs are null
(default function privileges); the private schema grants USAGE only to postgres
(`{postgres=UC/postgres}`), excluding anon/authenticated direct helper access.
`ride_publish_plan_internal` is absent before installation. Compare live definitions
and signatures to the reviewed patch; hashes above are drift detectors, not future
expected hashes. Stop if the target, shape, constraints, ACLs or source drift.

## Read-only preflight and backup

Use the authorized connection to that exact project. Never run the disposable
fixture SQL against it. Metadata queries may return function names, signatures,
MD5s, ACLs, RLS flags, trigger/constraint definitions and counts. Do not select
rider/contact rows, profile password/session fields or driver access hashes into
chat, CI or public artifacts. Capture all query results in one JSON object if the
connector returns only its last statement.

```sql
select n.nspname, p.proname, pg_get_function_identity_arguments(p.oid) as signature,
       md5(pg_get_functiondef(p.oid)) as definition_md5, p.prosecdef,
       p.proconfig, p.proacl
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname in ('public','rides_private')
  and (p.proname like 'ride_admin_%' or p.proname like 'ride_shared_%'
       or p.proname in ('ride_publish_plan_internal','log_ride_stop_admin_change','log_ride_admin_event'))
order by 1,2,3;
select n.nspname,c.relname,c.relrowsecurity,c.relforcerowsecurity,c.relacl
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where n.nspname='rides_private' and c.relkind='r' order by 2;
select tgname,tgenabled,pg_get_triggerdef(oid)
from pg_trigger where tgrelid='rides_private.ride_stops'::regclass and not tgisinternal;
select conname,pg_get_constraintdef(oid) from pg_constraint
where conrelid in ('rides_private.ride_stops'::regclass,'rides_private.ride_drivers'::regclass);
```

Confirm immediate UNIQUE(driver_id,stop_order), FK driver deletion behavior,
existing individual-session helper and current auth.sessions shape. Capture
unrelated-app schema/function/ACL hashes before and after. Run security advisors,
triage candidate-introduced findings separately from existing unrelated-app
findings; do not “fix” the other application as part of this rollout. Task 7's
read-only advisor baseline returned 14 INFO deny-by-default RLS/no-policy notices
and 31 WARN exposed SECURITY DEFINER notices for each of anon and authenticated;
these precede the candidate and include the other application. Review expected
RPC authentication separately from unprotected functions using the
[anon function guidance](https://supabase.com/docs/guides/database/database-linter?lint=0028_anon_security_definer_function_executable),
[authenticated function guidance](https://supabase.com/docs/guides/database/database-linter?lint=0029_authenticated_security_definer_function_executable), and
[RLS no-policy guidance](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy).

Before installation, take an encrypted operator-controlled full database backup
and a schema/function/ACL manifest using the established backup system. Restore
it into an isolated, access-restricted recovery database and verify counts/hashes,
constraints and functions. Keep its location and digest in the private release
record. A chat export is not a backup. Before freeze and after each publication,
retain a new consistent checkpoint of published plans/drivers/stops, audit log,
legacy drafts, all shared tables and driver catalog. Include shared operation
results, tombstones, settings/person versions, recovery candidates and credentials
in the secured backup; exclude their values from rollout logs.

The disposable test rehearses preserving full shared/history/recovery state and
the latest publication under pause/resume. It also performs an actual pg_dump/
pg_restore into a separate ephemeral database and checks row hashes, ACLs and RLS. An actual production backup restore
and point-in-time recovery are **NOT RUN** here and are operator readiness gates.
Never restore a pre-cutover database over newer published rows. Disaster recovery
must first recover the latest consistent checkpoint into a separate database,
reconcile any later publications/operations there, and obtain an explicit operator
restore decision. Routine frontend rollback requires no database restore.

## Additive installation order

Do **not** replay entire `admin_security.sql`, `admin_ride_control.sql` or
`sunday_reset.sql`: those are setup files with unrelated setup/seed behavior.
Generate the additive patch with the following offline command, review its exact bytes,
and rehearse on a restored staging schema before the production migration.

```sh
node tools/build-collaborative-rollout.mjs > /tmp/collaborative-install.sql
shasum -a 256 /tmp/collaborative-install.sql
```

The generator reads explicit named functions, verifies function/trigger boundaries
and matching canonical helpers, includes source SHA256s, fails on missing existing
function prerequisites, and emits no connection/deployment action. The real database
harness installs this exact bundle before tests. Preserve its hash for Main01.
It selects the `sunday_reset.sql` legacy wrappers, preserving the observed live
NULL plan defaults and current-plan fallback. Shared UI callers send explicit dates.

Install in one transaction while existing plans remain legacy:

1. Existing prerequisites must already exist: profile/session membership and audit
   tables, People Bank, plans/drivers/stops, legacy drafts, app settings and the
   established auth/hash helpers. Stop if absent; no guessed seed or account setup.
2. Replace only the canonical `rides_private.ride_admin_actor`,
   `rides_private.log_ride_admin_event`, and
   `rides_private.log_ride_stop_admin_change` functions from `admin_security.sql`.
   Keep the existing profile-session helper/identities intact. Recreate exactly
   the canonical `ride_admin_audit_stops` trigger from that file inside this same
   transaction (AFTER INSERT/UPDATE/DELETE, each row, no predicate/column filter).
3. Replace `rides_private.ride_publish_plan_internal(text,date,jsonb,text[],boolean)`
   from `admin_ride_control.sql`, including its REVOKE from PUBLIC, anon and
   authenticated. Both setup files contain the same canonical helper. Keep its
   exception/subtransaction rollback semantics and genuine-difference audit logic.
4. Replace the fenced existing public functions: `ride_admin_publish_plan`,
   `ride_admin_save_draft`, `ride_admin_clear_draft`, `ride_admin_update_event_setup`,
   `ride_admin_merge_people`, `ride_admin_archive_people` from `sunday_reset.sql`;
   `ride_admin_upsert_people` from `admin_ride_control.sql`; `ride_admin_start_new_sunday`,
   `ride_admin_update_plan_drivers`, `ride_admin_add_driver` from `sunday_reset.sql`.
   Preserve exact signatures/defaults, compare duplicate definitions, and preserve
   existing grants and deployed NULL plan defaults. Public wrapper publication must call the private canonical
   helper; no client setting may bypass the fence.
5. Apply `collaborative_ride_control.sql`'s body in the same transaction (omit its
   nested outer BEGIN/COMMIT when bundling). This creates additive tables, backfills
   the private driver catalog, installs RPCs, RLS, explicit ACLs, and the activation
   guard. It neither creates a shared workspace nor changes write mode.
6. Commit only after function/trigger/ACL checks. Re-read metadata, confirm no
   workspace/mode enabled, deny anon/authenticated direct private access, and
   confirm unrelated-app manifests match. Reload API schema through the approved
   Supabase deployment workflow if needed. Do not grant direct private-table access.

[Supabase function security guidance](https://supabase.com/docs/guides/database/functions)
requires explicit attention to SECURITY DEFINER search paths and default function
EXECUTE privileges; the patch uses authenticated RPC boundaries and private ACLs.

## Prepare, explicit freeze, then activation

Choose exactly one existing plan date. Three intended admins must authenticate
individually and verify three distinct server actor keys. Display names and shared
codes are insufficient. There are currently two active production profiles;
provisioning/binding the incoming third identity needs its own explicit operator
security decision, never fixture credentials. Existing profile tokens remain valid
under the server's existing expiry/revocation rules.

Use a privileged operator connection, not a browser RPC. Configure these values
once per connection using the chosen real date/operator. The following date is
synthetic and must not be pasted unchanged into production:

```sql
set ridelist.rollout_plan = '2099-01-04';
set ridelist.rollout_operator = 'Named operator / approved release ticket';
```

Preparation is safe staging while legacy edits continue:

```sql
select rides_private.ride_shared_prepare(
  current_setting('ridelist.rollout_plan')::date,
  current_setting('ridelist.rollout_operator'));
```

Require `ok:true`, `code:prepared`, `writeMode:legacy`. It copies current published
rows and preserves server recovery candidates by actor; it does not choose the
newest personal draft or stop old clients. `already_prepared` means inspect the
existing workspace, not delete/recreate it. Preparation is **not** freeze permission.

At the explicitly selected maintenance window, collect pending device saves,
warn admins through the established operator channel, verify backup completion,
and separately approve the brief write pause. Then:

```sql
select rides_private.ride_shared_freeze(
  current_setting('ridelist.rollout_plan')::date,
  current_setting('ridelist.rollout_operator'));
```

Require `ok:true`, `code:paused`. Freeze locks the plan/workspace, recaptures later
legacy candidates, rebases from the latest published rows, advances the baseline
if those rows changed, and sets paused. Shared/legacy writes are now blocked;
driver reads retain the latest published plan. Global People Bank, branding and
Sunday setup legacy writes are also fenced while *any* plan is shared or paused;
coordinate that temporary effect across the Rides admins. Unrelated apps do not
use these functions.

Before activation, inspect actor-scoped recovery candidates with the updated UI
in paused mode, compare current publication and each personal source, and agree
which candidate/edits to import after activation. Unknown baseline/owner candidates
remain retained; do not invent ownership or promote them by timestamp. The legacy
plan-only localStorage keys remain on the original device. An owner may explicitly
claim/upload a candidate through `ride_admin_shared_save_recovery`, with actor,
plan, source key and known baseline; do not bulk upload across accounts. The current
UI exposes server candidates and same-scope device personal forms, not an automatic
legacy-local ownership claiming wizard.

Activate only after fences, audit helpers, identity mapping, backups and reviewed
candidate are verified. The SQL below is also used to resume an already-shared
workspace after a pause. It rejects direct legacy→shared promotion.

<!-- rehearsal:activate -->
```sql
begin;
do $$
declare v_date date := current_setting('ridelist.rollout_plan')::date;
        v_operator text := nullif(btrim(current_setting('ridelist.rollout_operator')),'');
begin
  if v_operator is null then raise exception 'operator label required'; end if;
  perform 1 from rides_private.ride_plans where plan_date=v_date for update;
  if not found then raise exception 'plan not found'; end if;
  perform 1 from rides_private.ride_shared_workspaces where plan_date=v_date for update;
  if not found then raise exception 'workspace not prepared'; end if;
  perform 1 from rides_private.ride_shared_write_modes
    where plan_date=v_date and write_mode='paused' for update;
  if not found then raise exception 'activation requires explicitly paused plan'; end if;
  update rides_private.ride_shared_write_modes
    set write_mode='shared',changed_by='operator:' || v_operator,updated_at=now()
    where plan_date=v_date;
  insert into rides_private.ride_admin_audit_log(action,plan_date,actor_type,actor_label,payload)
    values('shared_activate',v_date,'operator',v_operator,'{}');
end $$;
commit;
```

Expose the reviewed frontend after the server fence. Review/import explicitly
through `ride_admin_shared_import(text,date,uuid,bigint,bigint,uuid)`, using the
candidate ID and freshly reviewed draft/baseline versions. Import replaces the
shared draft, leaves the source intact, and never publishes. A conflict means
compare again; a changed request requires a new operation UUID. Retrying a lost
reply uses the same UUID/body under the same actor, including after token refresh.
Unknown or different baselines remain available but are blocked from import; the
operator and owner must reconcile their intent manually against current data.
Only explicit fresh review and atomic Publish may change driver-visible routes.

## Pause, frontend rollback and safe resumption

Stop criteria: incorrect actor attribution, any cross-account private disclosure,
unpublished driver-visible edits, lost recovery, unexplained baseline drift,
audit inconsistency, repeated failed/unconfirmed saves, stale publication accepted,
or unexpected unrelated-app impact. Pause immediately and preserve evidence.

The following acquires the same plan→workspace locks as writers, allowing any
in-flight publication to finish before the fence. It changes only write mode and
adds an operator audit entry; latest published data, shared rows, revisions,
operation history and recovery candidates remain intact.

<!-- rehearsal:pause -->
```sql
begin;
do $$
declare v_date date := current_setting('ridelist.rollout_plan')::date;
        v_operator text := nullif(btrim(current_setting('ridelist.rollout_operator')),'');
begin
  if v_operator is null then raise exception 'operator label required'; end if;
  perform 1 from rides_private.ride_plans where plan_date=v_date for update;
  if not found then raise exception 'plan not found'; end if;
  perform 1 from rides_private.ride_shared_workspaces where plan_date=v_date for update;
  if not found then raise exception 'workspace not prepared'; end if;
  perform 1 from rides_private.ride_shared_write_modes
    where plan_date=v_date and write_mode in ('shared','paused') for update;
  if not found then raise exception 'pause requires shared or paused plan'; end if;
  update rides_private.ride_shared_write_modes
    set write_mode='paused',changed_by='operator:' || v_operator,updated_at=now()
    where plan_date=v_date;
  insert into rides_private.ride_admin_audit_log(action,plan_date,actor_type,actor_label,payload)
    values('shared_pause',v_date,'operator',v_operator,'{}');
end $$;
commit;
```

Recheck latest published and shared/history/recovery hashes and take a new secured
backup. If UI rollback is required, restore the last reviewed frontend artifact
while keeping these database functions and `paused` mode. Old cached/admin clients
must receive `update_required` on writes. Do not set legacy mode, drop tables,
reinstall old unfenced SQL, clear browser storage, reset revisions or replace
published state from an earlier backup. Existing driver views continue reading
the latest publication. Admin editing can remain unavailable until corrected.

Resume with the activation block only after the cause is resolved and the operator
explicitly approves that plan. It keeps the current workspace/baseline. Reopen the
updated UI, resolve uncertain operations by ID and re-review the latest revision.
Previously reviewed or baseline-stale publishes must conflict. A permanent return
to legacy writing needs a separate data reconciliation design; it is not this
frontend rollback.

## Evidence, monitoring and remaining release gates

Run the commands and read the detailed coverage in `tests/PUBLISH_TESTS.md`.
Task 7 final suite: **279 passed, 0 failed, 8 existing credential-gated skips**
(287 total, 57.1s). Fresh three-context Chromium recovery/import/publication,
pause/resume and revocation rehearsal: **PASS**, no page errors/external requests.
Generated SQL SHA256: `43d7c49500a1c3142971c8b3da9cd98e7bc4767946deb1287b977665302b8acf`.
Regenerate and compare at action time; changed source bytes require new review.
Task 7 adds `three_admin_end_to_end`, `old_client_cutover_denied`,
`migration_retains_candidates`, `rollback_preserves_latest_baseline`, and
`revocation_clears_private_access` using three independent synthetic identities,
real PostgreSQL transactions, and the exact activation/pause blocks above.
Earlier approved tests cover move/remove/reorder and master/publish races; Task 6
actual Chromium evidence covers three contexts, private input/focus, ≤5-second
normal synchronization (measured 2455ms), conflict/reapply, offline/reconnect,
lost responses and all three responsive sizes. These remain separate from actual
production connectivity and physical-device claims.

Monitor metadata only: time, release ID, plan, pseudonymous actor key, operation ID,
RPC name, result code, latency, revision/cursor, counts of conflicts/unconfirmed
operations and authentication failures. Never log operation payloads, personal
forms, contact strings, tokens or passcodes. Expected conflicts require comparison,
not auto-retry with fresh versions. Repeated transport errors require investigation;
pause if correctness/private access is uncertain. A five-second visibility target
is a usability goal; server version checks remain the correctness boundary.

**NOT RUN:** production migration/activation/push/deploy, real third account grant,
production backup restore, live three-admin network latency, physical phone
keyboard/touch/safe-area and installed PWA/background/resume. Browser viewport
emulation does not satisfy those phone gates. Main01 must record the release
operator's physical QA result or explicit decision about that outstanding limit.
Whole-branch independent review is the controller's next gate. The approved driver
account/session phase follows the core gate and remains part of the intended work.

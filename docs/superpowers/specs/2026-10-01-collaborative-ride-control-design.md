# Collaborative Ride Control design

Status: proposed architecture for written-spec review. No implementation or deployment is approved by this document.
Source baseline: `679b3cdf83140cf8f4e8f4a34ff9960db63af540`.

## Intent and approved direction

Three admins use one shared workspace with separate identities. The two existing
admins keep their identities; an incoming third admin has full functional access:
editing, publishing, driver approvals and bounded session extensions. Account
contact verification and action-time access-grant approval are separate from this
design. This document uses role placeholders and contains no personal contact data.

Saved changes appear for the other admins; simultaneous edits cannot silently
overwrite each other. Publishing is visible to everyone. Keep the existing driver
workflow and published assignments intact while introducing collaboration.
Desktop administration is a responsive view of this same app, with phone support.
No separate desktop app, duplicate portal or new project/chat is required.
Laptops are the normal admin workspace; phones serve on-the-go access. The visual
layout remains preliminary until the user inspects current desktop/phone screens
and discusses the simpler Uber-inspired direction with the design chat.

## Current facts

- Frontend is primarily `index.html`; shared helpers live in `src/`.
- `ride_admin_save_draft` stores whole snapshots per `(plan_date, actor_key)`.
  It is a recovery mechanism, not a shared draft with concurrent-edit protection.
- Local backups are keyed by plan date, so account switching can mix recovery state.
- Draft saves run asynchronously and have no expected revision or request id.
- Driver availability and People Bank actions can immediately change live data
  and reload admin state. Some such reloads replace unpublished work.
- Activity is loaded on entry and selected actions; there is no continuous sync.
- Current admin profile passwords create expiring backend profile sessions.
  Supabase Auth admin-user support also exists, but profile tokens are not Auth JWTs.
- The live publish function now rolls back validation failures atomically. Preserve
  that protection; concurrency checks must be added inside the same transaction.
- The push service worker has no page/data caching fetch handler.

## Options and recommendation

1. One exclusive editor: easiest but creates waiting and abandoned-lock recovery.
2. Shared versioned draft plus authenticated refresh: compatible with existing
   admin sessions, fewer moving parts, other screens update within a few seconds.
3. The same versioned model plus private realtime signals: faster, but requires
   proper realtime authentication and authorization; profile tokens alone do not
   establish Supabase Realtime access.

Recommend option 2 for the first safe release, then option 3 as an additive delivery
upgrade. Database correctness does not depend on event delivery. Proposed refresh:
every 3 seconds while the admin workspace is visible, immediately on focus/reconnect,
and with backoff when offline. Request revision metadata first and fetch details only
when needed. Do not claim this is instantaneous synchronization.

**Review decision:** approve this compatibility-first release, or require managed
Supabase Auth/private realtime in the first release. The latter includes explicit
existing-admin account linking and a credential transition; never reset credentials
or convert profile sessions to Auth tokens silently. This choice is unresolved until
the written-spec review. No public realtime channel is an acceptable shortcut.

## Authoritative state and mutation contract

One workspace per plan has a shared draft, monotonically increasing draft revision,
published revision, baseline published revision and status. Stable draft rider IDs
are independent of route order. Route groups and driver assignments have their own
versions so unrelated edits can succeed without a global stale-form conflict.
The server derives the actor from validated identity; a submitted display name or
profile slug never authorizes access.

Save small operations: add/update/move/remove rider, change route order, activate a
driver for this plan. Each carries expected entity/group versions and a random
operation id. In one transaction, authenticate, check versions/invariants, apply
the operation, increment revisions, record its result and append an attributed
change event. Return the authoritative result. Persist operation-id results long
enough to cover reconnect retries; a duplicate returns the same outcome and does
not write twice. Never treat a changed request body under the same id as a retry.

Different rider updates succeed independently. Competing changes to the same rider
are rejected with current values and actor attribution. Moves/removals/reorders
check all affected group versions together. No automatic last-writer-wins merge.
Do not save keystrokes to shared state: a form is personal until Save to shared draft.

Draft route changes remain invisible to drivers until publish. Additions to the
saved driver catalog may be saved immediately, but plan activation/assignment is a
draft operation. Publication creates/removes plan driver rows as needed in its
transaction, validates the candidate plan, and preserves stable account mapping.

People Bank stays a separate shared master record with its own version. Saving a
person is clearly labeled as changing saved contact details. A proposed change to
an assigned pickup is staged in the shared ride draft and reviewed before publish;
do not silently update published ride stops. A master change after route review
invalidates that review when it affects candidate rider details. Conflicting master
edits use the same explicit comparison flow.

Event settings have explicit Apply controls and version checks; route-affecting
destination/timing changes are staged with the ride draft. Branding-only changes
can remain immediate and labeled. Saving secondary settings must not replace
unpublished rider forms or the shared draft with a returned published snapshot.

## Publishing

Review displays the exact draft revision, changes since the published baseline,
blockers and the last contributor. The publish request includes expected draft
revision, baseline published revision and operation id.

The server locks the workspace/plan row, then checks revisions and validation while
holding that lock. All save operations use the same locking discipline. Publish
atomically applies the candidate drivers/stops, route ordering, summaries, baseline
and published revision, operation result and one attributed publication event.
Unexpected errors roll back all effects. No notifications are sent for a transaction
that did not commit. A stale review returns a conflict before publication.

After success, the shared draft becomes the new published baseline. Other admins
see Published by <admin>, at <time>. Their personal unsaved forms remain intact;
the next save must compare against the new baseline rather than silently replay.
Simultaneous publish requests cannot both publish the same old revision.

## Desktop and phone experience

Provisional organization: Drivers / Riders / Changes with secondary tools in the
menu. A three-pane desktop layout (navigation, assignments, details) is a candidate,
not an approved visual redesign. Inspect current desktop and phone screens before
deciding which sections/actions to combine, retain or add. On phones, use the same
data and actions as sequential screens; exact layout requires visual review.
Use content-driven breakpoints; avoid horizontal page scrolling. Support keyboard
navigation, visible focus, labels, comfortable touch targets and accessible notices.

Keep a small shared-draft status: Saved / Saving / Unsaved on this device / Reconnecting.
Show unpublished change count and one Review & Publish action. Presence indicators
are optional later; they must never serve as edit locks or correctness guarantees.
No cursor sharing or typing indicators in the first release.
Twilio evaluation belongs to a separate discussion of concrete communication needs;
this spec authorizes no account setup, SMS, charges or integration. Existing Main,
Figma/design and review chats retain their roles; do not create duplicate chats.

An incoming change refreshes lists without moving focus, closing a form or replacing
typed input. On same-record conflict, show Your unsaved values and Latest saved values
with attribution. The user can reload or deliberately reapply after reviewing.
No hidden overwrite button and no silent field merging in the first release.

## Reconnect, lost responses and notifications

Use a durable revision/event sequence; timestamps are for display, not ordering.
On reconnect/focus, compare server revision and event cursor, fetch a fresh snapshot
if events were missed, and reconcile each pending operation. Never replay a whole
offline snapshot. A timed-out save remains Unconfirmed until its operation-id result
is checked. Offline editing is local recovery only, not a promise that changes will
eventually be accepted. Publishing requires a current online review.

Backend authorizes every refresh/mutation. Events contain only plan/revision/actor
identifiers and event type; fetch rider/contact data through the protected API.
In-app publication notices are delivered now or on the next authenticated refresh.
Closed-app push/email/SMS notifications are outside this release.

Later realtime uses private channels restricted to approved admins, with minimal
server-originated invalidation signals. Client messages cannot impersonate a saved
change/publication. Disconnection falls back to polling. Revoked identities lose
API access immediately and realtime connections are invalidated/reauthorized.

## Identities, privacy and recovery

Preserve both existing admins' stable identity and audit attribution. Link the new
admin only after verifying the intended account and the required access-grant approval.
Full functional access does not imply permission to silently provision other accounts.
Do not introduce a shared admin password, put service credentials in frontend code,
or expose private tables directly to anonymous clients.

Owner/admin role authorization is server-maintained and never user-editable metadata.
Expired/revoked sessions cannot mutate, fetch private workspace data or subscribe.
Clear rendered private data on sign-out; isolate local backups by plan, identity and
baseline revision. Mark device-only recovery clearly; do not transmit recovered
data until the authenticated user chooses to review/import it. Audit meaningful
mutations and publications without secrets or unnecessary contact-data copies.

## Migration of existing drafts

Inventory per-actor server drafts and discover local backups when each admin signs
in. Preserve them as read-only recovery candidates with actor, saved time and known
baseline; an unknown baseline is explicitly marked. Never choose the newest draft
as the winner merely by timestamp and never delete competing drafts automatically.

Start shared state from the current published plan. Show recovery candidates and
their differences. An approved admin reviews one import at a time; import applies
versioned operations to the shared draft, with conflicts resolved explicitly. Record
the import and retain the original recovery candidate. Local backups from another
identity require explicit ownership review; never expose them to the new account.
Migration cannot publish changes or alter driver assignments by itself.

Only one write mode may operate per plan. Server feature flags reject legacy whole-
snapshot writes/publication for an enabled shared workspace. Old clients receive
Update required, with their local unsaved work preserved for recovery. Additive schema
does not make concurrent legacy and new publication safe.

## Rollout and rollback

Prepare schema/APIs and compatibility guards in a disposable test environment.
Inspect deployed function definitions and preserve rollback SQL before production.
Review identity/access changes separately at action time. Roll out one plan only
after resolving recovery candidates and validating three independent admin sessions.
Verify other church apps sharing the database are unaffected.

Enable server write-mode fencing before exposing the new editor. Keep drivers on
the published snapshot; no driver-account rollout is required for draft collaboration.
Monitor save/publish errors, unconfirmed operations and version conflicts without
logging sensitive payloads. Define an operator-controlled pause of admin writes.

Rollback pauses writes, preserves shared draft/revision/history and exports recovery
state. Restore old behavior only against the latest published baseline and after
reviewing unpublished shared changes. Never drop the new state or restore an old
published plan automatically. Realtime can be disabled independently; polling and
version checks remain. A UI rollback alone must not reopen unsafe legacy writers.

## Adjacent driver identity/session phase

Separate driver registration, identity-verified admin approval and private six-digit
PIN setup from pre-ride login. Pending applicants see no driver directory/rider data.
Approved accounts map to stable identities across plan-specific driver rows.
Sessions survive Calls, Maps, screen lock and reopening the installed app, within
server-enforced expiry/revocation. Drivers sign in from the browser/home-screen icon
they use; do not promise shared storage across those contexts.

Approved timing direction: Sunday 9 p.m. America/Chicago cutoff, with an explicit
admin extension until midnight for late runs. Saturday-night or Sunday-morning login
must cover the complete ride window. No Saturday 6 p.m. opening time was approved.
A bounded maximum lifetime, special-service rules and secure persistent-session
transport still require that phase's final design review. No indefinite renewal,
plaintext PIN persistence, silent legacy-code privilege expansion or automatic
approval. Driver-auth infrastructure does not block the initial shared admin draft.

## Acceptance evidence required before release

- Three distinct admin sessions open the same plan; a saved change appears within
  five seconds on visible online screens, with clear stale/offline state otherwise.
- Different-rider edits both survive; same-rider and move/delete/reorder conflicts
  cannot overwrite. Unsaved inputs/focus survive incoming changes and publication.
- Stale review is rejected. Save-versus-publish and simultaneous publish races leave
  exactly one coherent published baseline; failed validation rolls back all effects.
- Lost save/publish responses and duplicate retries do not double-apply operations;
  reconnect after missed events converges to authoritative state without data loss.
- Driver availability, People Bank, event settings and secondary dialogs cannot
  bypass versions or clobber shared/personal unsaved work.
- Multiple legacy drafts/local backups are preserved; import conflicts are explicit;
  old clients cannot write after shared mode activates.
- Incoming-admin functional permissions are tested with verified test identities;
  drivers, pending applicants, expired/revoked admins and forged actors are denied.
- Private channels deny unauthorized users; injected client events cannot fake state.
  Realtime-off polling, token expiry and revocation retain correct behavior.
- Phone, desktop and installed-app tests cover keyboard/touch, app updates, focus,
  offline warnings and independent storage contexts. No production mutation tests.
- Rollback rehearsal preserves latest published data and unpublished recovery state.

## Review gate

First settle the authenticated refresh versus first-release realtime decision and
review this written spec. Complete visual review before committing a new desktop or
phone layout. Then create and review an implementation plan and choose
its execution method. Only after those approvals may implementation begin. Deployment
and security-sensitive account grants require their own applicable approvals.

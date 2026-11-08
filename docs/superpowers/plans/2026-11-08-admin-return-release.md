# Rides Home Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish the approved pickup roster and privately prepare returns, with an admin button that releases all regular returns and requests opted-in driver alerts.

**Architecture:** Private per-plan phase metadata gates driver-facing RPCs. Explicit stop direction is assigned on insertion and preserved independently of later label edits, with initial backfill from existing return labels. Existing admin editing remains the source of truth; the new return tab reviews saved return assignments and releases a revision-checked plan. A durable notification outbox separates successful publication from alert delivery.

**Tech Stack:** Static JavaScript/HTML, Supabase PostgreSQL functions, existing TypeScript Web Push Edge Function, Node tests and disposable PostgreSQL 17.

**Spec:** docs/superpowers/specs/2026-11-08-admin-return-release-design.md

## Global Constraints
- Release everyone together. Only admins see unreleased regular return data.
- Keep pickup, return and later-drop-off data separate. No guessing assignments or contact numbers.
- The user authorized publishing on this turn; do not press the actual return release button or send live test alerts.
- Do not change historical plans or master People Bank records.
- Keep real rider data in authorized app records and transient tool state, never in code or public artifacts.
- Preserve the approved pickup draft and latest supplied return roster. Later drop-offs stay unreleased separately.
- PR #9 has now merged after 243 passing tests; incorporate it without duplicating PR #4.

## Review Focus
- Stale clients/direct RPCs must never expose hidden return names through directory summaries or driver notes.
- Lost responses and double clicks must not release twice or duplicate notification jobs.
- An existing prior-week push subscription must not silently receive another driver's current routes.
- Users with no alerts, no return assignment, or a failed connection must receive accurate route/status UI.
- Roster edits racing release must invalidate the reviewed revision without losing either admin's changes.

### Task 1: Private phase, API visibility and durable release
**Files:** Create supabase/return_release.sql, tests/return_release_db.test.mjs, tests/fixtures/return-release-schema.sql.
**Interfaces:** public.ride_admin_return_state(p_admin_code text,p_plan_date date) returns {ok,enabled,phase,revision,releasedAt,releaseId,drivers,riders,alertSummary,laterRiders}; public.ride_admin_release_returns(p_admin_code text,p_plan_date date,p_expected_revision text,p_operation_id uuid) returns release state or structured error. Notification claim/finish RPCs are authenticated and lease-token checked. Existing driver RPC signatures remain unchanged.
- [ ] Write database tests proving unreleased data is absent from route/directory/context, invalid credentials fail, revision conflicts do not release, repeated requests are idempotent, later records stay hidden, and driver assignment boundaries persist after release.
- [ ] Run tests against unmodified fixture and observe expected behavior failures.
- [ ] Implement additive private schema and direction metadata, current-plan opt-in, phase-specific notes, concurrency guards, RPC wrappers, release/outbox APIs and least-privilege grants. Leave all plans in legacy mode until explicit roster cutover.
- [ ] Run PostgreSQL tests and inspect function grants; all assertions must pass.
- [ ] Commit only synthetic tests and implementation.

### Task 2: Admin release, driver refresh and alert delivery
**Files:** Modify index.html, sw.js, supabase/functions/ride-driver-notifications/index.ts and notification-core.js; add/extend tests/admin_ui.test.mjs and tests/notification_core.test.mjs.
**Interfaces:** Admin return tab consumes Task 1 state; release confirms expected revision then calls send-return-release. Edge mode claims durable jobs, sends generic return-ready payload, and records per-device success/failure/unknown. Driver refresh uses existing authenticated ride_driver_route and phase/releaseVersion metadata.
- [ ] Add failing tests for admin-only tab, release review, stale revision errors, failed alerts after successful release, return-only driver headings/empty state, independent completion, phase change on refresh, and outbox send results.
- [ ] Run tests to observe missing behavior.
- [ ] Implement the admin tab with saved roster grouped by driver, a reviewed all-driver release action, and honest alert counts/retry. Keep general edit/draft workflows intact and prevent release while draft changes are unsaved.
- [ ] Implement foreground/focus/30-second authenticated refresh, invalidation of stale selection/timings on phase changes, and re-registration of an already-authorized push device after successful current-plan driver authentication.
- [ ] Extend the existing Edge Function with durable claim/send/finish logic and a return-specific notification tag/body. Never send rider PII or claim device delivery equals a read.
- [ ] Run complete Node and database suites plus desktop/narrow browser checks with synthetic data. Commit implementation.

### Task 3: Review, deploy, publish roster and produce WhatsApp text
**Files:** Deployment documentation only; actual rider changes stay in transient tools and authorized database records.
**Interfaces:** Uses preReleaseLiveBaseline, pickupPayload and pendingContactUpdates transient state. Cutover transaction validates unchanged rows and historical counts/hashes, preserves return stop IDs, inserts pickup stops with unique orders, adds private unassigned later records if supported, opts November 8 into pickup phase and reconciles cached admin drafts without discarding edits.
- [ ] Obtain independent whole-change review, fix important findings with regression tests, and run the relevant full suites.
- [ ] Re-fetch current main/PR status and live roster; stop stale overwrites by explicit concurrency guards.
- [ ] Apply additive SQL and Edge deployment, publish reviewed frontend and verify deployed asset content. No actual release or push send.
- [ ] Atomically publish the approved pickups/contact corrections while retaining return assignments and historical data. Gate returns server-side in the same transaction as installing pickups.
- [ ] Verify API-visible pickup counts/labels and admin-only return state without exposing credentials. Verify phone corrections and exact times by aggregate/targeted reads.
- [ ] Prepare three WhatsApp-ready texts from the verified published plan: driver pickups with leave/pickup times, return assignments including the separately labeled 6 PM section, and names grouped by ready time. Mark estimates and unassigned return seats accurately. Do not send messages to WhatsApp.

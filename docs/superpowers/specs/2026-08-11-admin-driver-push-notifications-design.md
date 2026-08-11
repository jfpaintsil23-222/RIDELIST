# Admin Driver Push Notifications Design

## Goal

Add simple push notifications so admins can tell drivers when their RIDELIST route changes, without notifying riders yet and without putting push secrets in the frontend.

## Scope

- Admin-to-driver notifications only.
- Drivers opt in from their driver route experience.
- Admins review recipients and message text before sending.
- Notifications are for route updates after admin saves changes.
- Keep the UI mobile-first, black/white, and calm.
- Do not add chat, rider notifications, church-wide announcements, or automatic alerts while admins are still editing.

## UX Direction

Drivers see a small **Route alerts** card after opening their route. If notifications are supported, the card offers **Turn on alerts**. After permission is granted, it changes to **Route alerts on** and confirms that this phone will receive updates for that driver route.

Admins continue editing routes normally. After saving route changes, RIDELIST shows **Notify drivers?** with the number of affected drivers. Admin can review the recipient list and exact message before tapping **Send**.

The first notification message should stay plain:

> Your pickup list was updated. Open your route review.

Tapping the notification should open RIDELIST. If that browser still has the driver's route unlocked, go back to route review. If not, show the driver selection/passcode path instead of bypassing access.

## Architecture

Use standard Web Push:

- A root service worker handles incoming push events and notification clicks.
- The browser creates a push subscription after the driver taps **Turn on alerts**.
- Supabase stores subscriptions by driver slug, plan date, endpoint, and device metadata.
- A Supabase Edge Function sends notifications with server-side push secrets.
- The frontend may use a public VAPID key to subscribe, but never stores private push secrets.

## Data Model

Add a private Supabase table for driver notification subscriptions. Each row should store:

- driver slug
- plan date
- push endpoint
- subscription keys
- permission/source metadata
- active flag
- created/updated timestamps

Subscriptions should be replaced or deactivated when the same endpoint is registered again.

## Sending Rules

- Only drivers whose route changed should be offered as recipients.
- Affected drivers come from the saved admin changes: added stops, removed stops, moved riders, timing edits, address edits, or phone/name edits on that driver's route.
- Admin must explicitly confirm before sending.
- If a driver has multiple active devices, send to each active subscription.
- If a push endpoint fails because it expired or is gone, mark that subscription inactive.
- A failed send to one driver should not block successful sends to others.

## iPhone Behavior

On iPhone/iPad, web push generally requires the app to be added to the Home Screen on iOS/iPadOS 16.4 or newer. If the browser does not support push from the current context, show a short helper message instead of a broken button.

## Security

- No service-role key or push private key in `index.html`.
- Use Supabase Edge Function secrets for VAPID/private push credentials.
- Use existing driver passcode/admin passcode patterns for authorization.
- Driver subscription registration should only attach to the driver route the user unlocked.
- Admin send should require the existing admin access path.

## Error Handling

- If push is unsupported, show a quiet unavailable message.
- If permission is denied, show **Alerts are off for this browser**.
- If subscription save fails, keep the route usable and ask the driver to try again.
- If send fails, show admins which drivers were notified and which were not.

## Verification

- UI tests cover driver alert card states, admin review/send UI, unsupported browser copy, and no push secrets in frontend.
- Service worker tests or static checks cover push event and notification click handlers.
- Supabase SQL source includes protected subscription storage.
- Edge Function tests cover message payloads, expired subscription cleanup, and partial send failures.
- Manual verification checks one driver opt-in, one admin send, and notification tap behavior.

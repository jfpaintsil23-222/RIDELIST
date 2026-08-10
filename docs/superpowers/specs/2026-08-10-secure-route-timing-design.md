# Secure Route Timing Design

## Goal

Add real route timing to RIDELIST without exposing a Google Maps API key in the public GitHub Pages app, and show admin warnings when a route has missing data or timing problems.

## Scope

- Add a Supabase Edge Function named `ride-route-timing`.
- Keep the Google Routes API key server-side as `GOOGLE_ROUTES_API_KEY`.
- Let drivers see a small route timing line after they unlock their route with the shared driver passcode.
- Let admins see route warnings in the existing driver dropdowns.
- Keep existing manual route labels as a fallback when live timing is unavailable.
- Keep the app simple: timing is a text line, warnings are small chips/messages.

## Architecture

The browser never calls Google directly. It calls the Supabase Edge Function with either a driver request or an admin request. The function validates access by calling the existing Supabase RPCs, builds ordered pickup waypoints, calls Google Routes API `computeRoutes`, and returns only duration, distance, ETA, and warnings.

## Data Flow

1. Driver opens a route with `rides123`.
2. The app loads the current route through `ride_driver_route`.
3. The app calls `/functions/v1/ride-route-timing` with the driver slug, plan date, and typed driver passcode.
4. The Edge Function validates the passcode by calling `ride_driver_route`.
5. The Edge Function calls Google Routes API using the stored secret key.
6. The driver dashboard shows total route timing and estimated UH arrival.

Admin timing uses the same function with `mode: "admin"`. The admin sends the current draft drivers/stops, so warnings reflect unpublished last-minute edits too.

## Warnings

Admin warnings should cover:

- No riders assigned.
- Missing pickup address.
- Missing pickup time.
- Missing phone number.
- Route timing unavailable.
- Estimated arrival looks late when a route has a target arrival note.

Warnings should not block publishing yet. They are guidance, not hard validation.

## Error Handling

- If the Edge Function is missing or has no Google key, the UI says route timing is unavailable and keeps the manual fallback.
- If a driver/admin code is wrong, the function returns an unauthorized response without timing data.
- If Google cannot route one address, the function returns warnings and no live duration for that route.
- If the browser cannot reach the function, the app remains usable.

## Security

- No Google API key is committed to the repo or exposed in `index.html`.
- The Edge Function uses Supabase server-side secrets and existing ride RPCs for authorization.
- Driver timing returns only the driver’s own route.
- Admin timing requires the existing admin passcode/session path.

## Verification

- Node UI tests cover timing fallback, live timing display, function request payloads, and admin warnings.
- Edge Function helper tests cover warning generation, Google response parsing, and request authorization branches where possible.
- Manual verification checks driver route opening, admin route warnings, and graceful fallback when the function is unavailable.

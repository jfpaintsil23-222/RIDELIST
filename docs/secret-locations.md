# RIDELIST Secret Locations

Do not save real secret values in this repo.

## Google Routes API key

- Google Cloud: create the key in the church rides Google Cloud project.
- Google API: enable the Routes API for the project.
- Google key restrictions: restrict the key to the Routes API.
- Supabase: save the key as the Edge Function secret `GOOGLE_ROUTES_API_KEY` for project `cpkimtrribpvqxbywfry`.
- Password manager: save the same key in the owner's password manager as `RIDELIST Google Routes API Key`.

After the new key is saved in Supabase, test live route timing before deleting or disabling any old Google key.

## Supabase Edge Function

- Function: `ride-route-timing`
- The frontend must never contain the Google API key.
- The function reads `GOOGLE_ROUTES_API_KEY` from Supabase secrets.

## Rotation Checklist

1. Create a new restricted Google Routes API key in Google Cloud.
2. Save the new key in the password manager.
3. Save the new key in Supabase as `GOOGLE_ROUTES_API_KEY`.
4. Verify `ride-route-timing` returns real durations and UH arrival times.
5. Disable the old Google key.
6. Re-test route timing.
7. Delete the old key only after the app still works.

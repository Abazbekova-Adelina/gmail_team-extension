# Gmail Team Chat

The Chrome extension adds a shared chat below open Gmail threads. Anyone signed in can read the same history and post. The extension sends the comments you type to Supabase.

## Set up Supabase and Google

1. Create a dedicated Supabase project and apply `supabase/migrations/20261121180323_create_team_messages.sql` in the SQL Editor. If you use the CLI, run `supabase init`, `supabase link --project-ref <project-ref>`, and `supabase db push`.
2. In Google Cloud, create a Web application OAuth client. Add `https://<project-ref>.supabase.co/auth/v1/callback` as an authorized redirect URI. The Google provider settings in Supabase show the exact URL to use. If the Google OAuth app is in testing mode, add the Google accounts that will test it.
3. Enable the Google provider in Supabase Auth and enter the Google client ID and secret there.
4. In Supabase Auth URL Configuration, add `https://ehlcjjpfplfhiaefiljbfehibbialjeh.chromiumapp.org/supabase-auth` to Redirect URLs. The Chrome manifest contains the public key that keeps the unpacked extension ID consistent across installs.
5. Copy `.env.example` to `.env` and set `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` from the project. Vercel needs the same two values at build time. Keep the Google client secret in Supabase.

## Build and load in Chrome

Run `npm ci` and `npm run build` with Node.js 22 or newer. Open `chrome://extensions`, enable Developer mode, click **Load unpacked**, and select `dist`. Open or refresh Gmail, open a thread, and sign in with Google.

## Deploy the install page to Vercel

The Vercel build runs `npm run build:site` and serves `site-dist`. A configured build includes the downloadable Chrome extension. Add the Supabase variables to the Vercel project before deploying the download.

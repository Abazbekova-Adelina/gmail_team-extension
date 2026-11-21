# Gmail Team Chat

The Chrome extension adds private team discussions below Gmail threads. Only members of the selected workspace can read or post to that workspace. Each thread has its own discussion. The extension sends your comments and local thread identifiers to Supabase; it does not upload email bodies or subjects.

## Set up Supabase and Google

1. Create a dedicated Supabase project and apply all SQL files in `supabase/migrations/` in filename order in the SQL Editor. Existing installations only need the migrations they have not applied yet. If you use the CLI, run `supabase init`, `supabase link --project-ref <project-ref>`, and `supabase db push`.
2. In Google Cloud, create a Web application OAuth client. Add `https://<project-ref>.supabase.co/auth/v1/callback` as an authorized redirect URI. The Google provider settings in Supabase show the exact URL to use. If the Google OAuth app is in testing mode, add the Google accounts that will test it.
3. Enable the Google provider in Supabase Auth and enter the Google client ID and secret there.
4. In Supabase Auth URL Configuration, add `https://ehlcjjpfplfhiaefiljbfehibbialjeh.chromiumapp.org/supabase-auth` to Redirect URLs. The Chrome manifest contains the public key that keeps the unpacked extension ID consistent across installs.
5. Copy `.env.example` to `.env` and set `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` from the project. Vercel needs the same two values at build time. Keep the Google client secret in Supabase.

## Build and load in Chrome

Run `npm ci` and `npm run build` with Node.js 22 or newer. Open `chrome://extensions`, enable Developer mode, click **Load unpacked**, and select `dist`. Open or refresh Gmail, open a thread, and sign in with Google.

## Private teams and thread discussions

For an existing installation, apply `supabase/migrations/20261121193000_add_author_avatars.sql` if needed, then `supabase/migrations/20261121203000_private_workspaces_and_threads.sql`. Rebuild and reload the extension after applying the migrations. The new frontend refuses to open the old global chat when the private-workspace schema is missing. Privacy restrictions take effect on the server only when the migration is applied.

1. Sign in with Google. Open **Manage team**, enter a workspace name, and choose **Create**. Your account becomes its owner.
2. Owners invite teammates by their Google sign-in email. Invitations appear in the recipient’s **Manage team** section after they sign in and choose **Refresh**. Choose **Accept** to join. Invitations expire after 7 days and are bound to the recipient’s verified email. This version creates in-app invitations; it does not send email.
3. Use the workspace menu to switch teams. Each workspace has its own history for each Gmail thread. Owners can revoke pending invitations and remove members. Access is enforced with database row-level security. Removing membership blocks new database reads and writes immediately; already-rendered history is cleared at the next membership refresh (every 30 seconds while visible, or when returning to the panel).
4. Gmail’s local conversation IDs can differ between accounts. If teammates see separate discussions for the same email, expand **Connect a teammate’s copy of this email**. One teammate copies the discussion code, and the other pastes it into **Connect to code** in the same workspace. This links their local email thread to that discussion. It does not merge or delete existing history. A discussion code never grants workspace membership.

Google account photos appear beside messages, with initials if a photo is missing or unavailable. The avatar migration also backfills existing messages from sign-in metadata. No additional Google API permissions are required.

The privacy migration preserves old global messages with no workspace/thread assignment, but hides them from all normal app accounts. It does not guess which private team should inherit those messages. A database administrator can review them separately.

## Validate changes

Run `npm test`, `npm run build`, and `npm run build:site`. Database tests use a local in-memory Postgres instance (PGlite) with simulated Supabase auth roles; no production database or real accounts are used. They cover workspace isolation, per-thread history, email-bound invitations, expired/revoked invitations, member removal, spoofed authors, cross-workspace references, and inaccessible legacy messages. Browser previews with sample accounts are separate from live Google OAuth/Realtime testing.

## Deploy the install page to Vercel

The Vercel build runs `npm run build:site` and serves `site-dist`. A configured build includes the downloadable Chrome extension. Add the Supabase variables to the Vercel project before deploying the download.

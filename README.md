# Gmail Team Chat

The Chrome extension adds private team discussions below Gmail threads. Only members of the selected workspace can read or post to that workspace. Each thread has its own discussion. The extension sends your comments and local thread identifiers to Supabase; it does not upload email bodies or subjects.

## Set up Supabase and Google

1. Create a dedicated Supabase project and apply all SQL files in `supabase/migrations/` in filename order in the SQL Editor. Existing installations only need the migrations they have not applied yet. If you use the CLI, run `supabase init`, `supabase link --project-ref <project-ref>`, and `supabase db push`.
2. In Google Cloud, create a Web application OAuth client. Add `https://<project-ref>.supabase.co/auth/v1/callback` as an authorized redirect URI. The Google provider settings in Supabase show the exact URL to use. If the Google OAuth app is in testing mode, add the Google accounts that will test it.
3. Enable the Google provider in Supabase Auth and enter the Google client ID and secret there.
4. In Supabase Auth URL Configuration, add `https://ehlcjjpfplfhiaefiljbfehibbialjeh.chromiumapp.org/supabase-auth` to Redirect URLs. The Chrome manifest contains the public key that keeps the unpacked extension ID consistent across installs.
5. Copy `.env.example` to `.env` and set `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` from the project. Vercel needs the same two values at build time. Keep the Google client secret in Supabase.

## Build and load in Chrome

Run `npm ci` and `npm run build` with Node.js 22 or newer. Open `chrome://extensions`, enable Developer mode, click **Load unpacked**, and select `dist`. Click the extension icon and sign in with Google. Open or refresh Gmail and open a thread.

Authentication is stored in `chrome.storage.local`, shared between settings and Gmail's embedded chat. Open panels update on sign-in, token refresh, and sign-out without reloading Gmail. After updating from an older build, reload the extension in `chrome://extensions`, refresh Gmail, and sign in once again; browser-local sessions are not reused.

## Private teams and thread discussions

For an existing installation, apply `supabase/migrations/20261121193000_add_author_avatars.sql` if needed, then `supabase/migrations/20261121203000_private_workspaces_and_threads.sql`. Rebuild and reload the extension after applying the migrations. The new frontend refuses to open the old global chat when the private-workspace schema is missing. Privacy restrictions take effect on the server only when the migration is applied.

1. Click the **Gmail Team Chat** toolbar icon to open the settings popup. Right-click the icon and choose **Options** to open the same settings in a tab. Google sign-in opens in a separate tab. After signing in, enter a workspace name and choose **Create**. Your account becomes its owner.
2. Owners invite teammates by their Google sign-in email. Recipients can choose **Accept** in **Workspace settings** after signing in. Choose **Refresh** to check for new invitations. Invitations expire after 7 days and are bound to the recipient’s verified email. The extension lists invitations in Workspace settings.
3. Open an email and choose a workspace in the Threadly bar below it, then press **Connect Threadly**. The chat opens under the email. Only emails connected this way become team discussions, and opening an email never creates one. With automatic matching on, teammates in that workspace see the chat when they open the same email. Each workspace has its own history for each Gmail thread. If you connect one email to several workspaces, a menu in the chat header switches between them. Owners can revoke pending invitations and remove members. Access is enforced with database row-level security. Removing membership blocks new database reads and writes immediately; already-rendered history is cleared at the next membership refresh (every 30 seconds while visible, or when returning to the panel).
4. If teammates see separate discussions for the same email, or automatic matching is off, both open the email and open the toolbar popup. Expand **Connect an email discussion** and pick the email. The teammate who connected it copies the discussion code, and the other pastes it into **Join a teammate's discussion** in the same workspace. Existing messages stay in the previous discussion. A discussion code never grants workspace membership.

Google account photos appear beside messages, with initials if a photo is missing or unavailable. The avatar migration also backfills existing messages from sign-in metadata.

## Match threads, share invites, and track replies

Apply `supabase/migrations/20261122200000_thread_matching_and_activity.sql` before using Activity or automatic matching. Rebuild the extension and install page after applying the migration.

- For automatic matching, enable Gmail API in Google Cloud and create a separate **Chrome Extension** OAuth client for `ehlcjjpfplfhiaefiljbfehibbialjeh`. Set its client ID as `GMAIL_OAUTH_CLIENT_ID` at build time and authorize `https://www.googleapis.com/auth/gmail.metadata` on the consent screen. This restricted scope can require Google verification when publishing publicly. Each teammate can choose **Connect Gmail for automatic matching** in settings. The extension reads the oldest message’s RFC `Message-ID` and sends only its SHA-256 hash to Supabase. Matching is scoped to the workspace and preserves existing discussion bindings. Use a discussion code when metadata is unavailable or the copies have different IDs.
- After inviting a teammate, copy the link under **Pending invitations**. The link opens the install page, then takes an installed extension to the specific invitation. Acceptance still requires the recipient’s verified Google email. Publish the updated install page at `https://gmail-team-chat.vercel.app` to enable this handoff.
- Type `@` in the message box to see teammates. Click a name or use the arrow keys and Enter. The composer confirms who will be mentioned, and sent mentions use an accent color. **Activity** in the popup shows unread messages and mentions. **Open in Gmail** is available after your mailbox has linked a local thread to the discussion. Viewing the latest messages clears the unread count.

Apply `supabase/migrations/20261123090000_shared_thread_lookup.sql` so the chat finds emails a teammate already connected. Without it, each teammate presses **Connect Threadly** themselves.

Apply `supabase/migrations/20261122210000_message_reactions.sql` to enable reactions. Click **Add reaction** on a message to pick an emoji. Click your reaction again to remove it. Changes from teammates appear when the chat refreshes.

The privacy migration preserves old global messages with no workspace/thread assignment, but hides them from all normal app accounts. It does not guess which private team should inherit those messages. A database administrator can review them separately.

## Validate changes

Run `npm test`, `npm run build`, and `npm run build:site`. Database tests use a local in-memory Postgres instance (PGlite) with simulated Supabase auth roles; no production database or real accounts are used. They cover workspace isolation, per-thread history, email-bound invitations, expired/revoked invitations, member removal, spoofed authors, cross-workspace references, and inaccessible legacy messages. Browser previews with sample accounts are separate from live Google OAuth/Realtime testing.

## Deploy the install page to Vercel

The Vercel build runs `npm run build:site` and serves `site-dist`. A configured build includes the downloadable Chrome extension. Add the Supabase variables to the Vercel project before deploying the download.

Google sign-in runs in an extension-owned window. The extension captures the returned Supabase PKCE code and closes the window before the Site URL can display the install page, including when Supabase falls back to its configured Site URL. This does not require a website deployment. Reload the rebuilt extension to apply sign-in changes.

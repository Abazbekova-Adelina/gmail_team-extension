# Gmail Team Chat

The Chrome extension adds private team discussions below Gmail threads. Members of the same workspace automatically share the discussion for the same email conversation. Unrelated email conversations and different workspaces remain separate. The extension sends comments, local thread identifiers, and a hash of the email conversation identity to Supabase; it does not upload email bodies, subjects, or raw headers.

## Set up Supabase and Google

1. Create a dedicated Supabase project and apply all SQL files in `supabase/migrations/` in filename order in the SQL Editor. Existing installations only need the migrations they have not applied yet. If you use the CLI, run `supabase init`, `supabase link --project-ref <project-ref>`, and `supabase db push`.
2. In Google Cloud, create a Web application OAuth client. Add `https://<project-ref>.supabase.co/auth/v1/callback` as an authorized redirect URI. The Google provider settings in Supabase show the exact URL to use. If the Google OAuth app is in testing mode, add the Google accounts that will test it.
3. Enable the Google provider in Supabase Auth and enter the Google client ID and secret there.
4. In Supabase Auth URL Configuration, add `https://ehlcjjpfplfhiaefiljbfehibbialjeh.chromiumapp.org/supabase-auth` to Redirect URLs. The Chrome manifest contains the public key that keeps the unpacked extension ID consistent across installs.
5. Copy `.env.example` to `.env` and set `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` from the project. Vercel needs the same two values at build time. Keep the Google client secret in Supabase.

## Build and load in Chrome

Run `npm ci` and `npm run build` with Node.js 22 or newer. Open `chrome://extensions`, enable Developer mode, click **Load unpacked**, and select `dist`. Click the extension icon and sign in with Google. Open or refresh Gmail and open a thread.

Authentication is stored in `chrome.storage.local`, shared between settings and Gmail's embedded chat. Open panels update on sign-in, token refresh, and sign-out without reloading Gmail. After updating from an older build, reload the extension in `chrome://extensions`, refresh Gmail, and sign in once again; browser-local sessions are not reused.

## Load in Firefox

After `npm run build`, open `about:debugging#/runtime/this-firefox`, choose **Load Temporary Add-on**, and select `dist/manifest.json`. Temporary installations are removed when Firefox closes. The shared manifest uses a service worker in Chrome and a background script in Firefox; Firefox does not support extension background service workers.

Google sign-in and Gmail matching target Chrome. Firefox authentication and Gmail matching have not been verified.

## Private teams and thread discussions

For an existing installation, apply `supabase/migrations/20261121193000_add_author_avatars.sql` if needed, then `supabase/migrations/20261121203000_private_workspaces_and_threads.sql`. Rebuild and reload the extension after applying the migrations. The new frontend refuses to open the old global chat when the private-workspace schema is missing. Privacy restrictions take effect on the server only when the migration is applied.

1. Click the **Gmail Team Chat** toolbar icon to open the settings popup. Right-click the icon and choose **Options** to open the same settings in a tab. Google sign-in opens in a separate tab. After signing in, enter a workspace name and choose **Create**. Your account becomes its owner.
2. Owners invite teammates by their Google sign-in email. Recipients can choose **Accept** in **Workspace settings** after signing in. Choose **Refresh** to check for new invitations. Invitations expire after 7 days and are bound to the recipient’s verified email. The extension lists invitations in Workspace settings.
3. Open an email. Its discussion opens automatically in your selected workspace, including messages from teammates who opened the same email in their own Gmail accounts. No connect button, discussion codes, Gmail API setup, or additional OAuth consent is required. If you belong to several workspaces, switch using the chat header menu; each workspace has independent history.
4. Owners can revoke pending invitations and remove members. Access is enforced with database row-level security. Removing membership blocks new database reads and writes immediately; already-rendered history is cleared at the next membership refresh (every 30 seconds while visible, or when returning to the panel).

Google account photos appear beside messages, with initials if a photo is missing or unavailable. The avatar migration also backfills existing messages from sign-in metadata.

Your messages appear on the right. Consecutive messages from the same sender show their name and avatar once per day. Press Enter to send, or Shift+Enter for a new line; Enter selects a teammate while mention suggestions are open. The Send button sits inside the message box.

## Match threads, share invites, and track replies

Apply all SQL migrations in filename order, including `supabase/migrations/20261123100000_automatic_thread_discussion.sql`, before loading the updated extension. This is an administrator deployment step, not per-user configuration. The automatic discussion RPC is required; older installations never fall back to creating disconnected per-user chats. Reload the extension and Gmail after deployment; old builds use retired manual-link RPCs.

- The Gmail content script identifies the message and asks the extension background to read its original headers through the current signed-in mailbox. The background includes Gmail cookies and follows Download Original's redirect to `mail-attachment.googleusercontent.com`, using explicit host permission rather than a cross-origin content-script request. It hashes the root `References` Message-ID, or `In-Reply-To`, or the message’s own `Message-ID`, then cancels the download after the headers. Only the SHA-256 hash and safe failure details return to the content script; raw headers and signed download URLs never enter the chat frame or Supabase. The same email conversation resolves to one discussion per workspace regardless of account-specific Gmail IDs. Navigating away cancels the background request. Gmail’s original-message web endpoint is not a public API; if Gmail changes it or headers are unavailable, the panel reports a matching error instead of creating a separate chat. Choose **Retry email matching** without reloading Gmail; report the displayed reason for unresolved failures.
  Matching supports legacy hexadecimal message IDs and Gmail's current `msg-f:` / `msg-a:` IDs through Download Original. It reuses the current account's `ik` session key from Gmail links or resource URLs; the key is used only by the content script and extension background, never the chat frame or Supabase. If Gmail exposes the key after the panel mounts, matching restarts automatically. Message selection reads the first ID-bearing element, including collapsed messages. After installing the redirect fix, reload the extension, approve the Gmail attachment-host permission if prompted, and refresh Gmail.
- After inviting a teammate, copy the link under **Pending invitations**. The link opens the install page, then takes an installed extension to the specific invitation. Acceptance still requires the recipient’s verified Google email. Publish the updated install page at `https://gmail-team-chat.vercel.app` to enable this handoff.
- Type `@` in the message box to see teammates. Click a name or use the arrow keys and Enter. The composer confirms who will be mentioned, and sent mentions use an accent color. **Activity** in the popup shows unread messages and mentions. **Open in Gmail** is available after your mailbox has linked a local thread to the discussion. Viewing the latest messages clears the unread count.

Existing account-specific discussions are reconciled automatically when the email is identified, preserving messages and reactions when the old history can safely be attributed to that email. Ambiguous legacy manual links are not used to merge unrelated email histories.

Supabase Realtime delivers new messages in the shared discussion. Reconnecting, returning to the tab, and visible-chat checks every eight seconds recover missed messages without dropping loaded history.

Apply `supabase/migrations/20261122210000_message_reactions.sql` to enable reactions. Click **Add reaction** at the bottom right of a message to pick an emoji. Click your reaction again to remove it. Changes from teammates appear when the chat refreshes.

The privacy migration preserves old global messages with no workspace/thread assignment, but hides them from all normal app accounts. It does not guess which private team should inherit those messages. A database administrator can review them separately.

## Validate changes

Run `npm test`, `npm run build`, and `npm run build:site`. Database tests use a local in-memory Postgres instance (PGlite) with simulated Supabase auth roles; no production database or real accounts are used. They cover workspace isolation, per-thread history, email-bound invitations, expired/revoked invitations, member removal, spoofed authors, cross-workspace references, and inaccessible legacy messages. Browser previews with sample accounts are separate from live Google OAuth/Realtime testing.

## Deploy the install page to Vercel

The Vercel build runs `npm run build:site` and serves `site-dist`. A configured build includes the downloadable Chrome extension. Add the Supabase variables to the Vercel project before deploying the download.

Google sign-in runs in an extension-owned window. The extension captures the returned Supabase PKCE code and closes the window before the Site URL can display the install page, including when Supabase falls back to its configured Site URL. This does not require a website deployment. Reload the rebuilt extension to apply sign-in changes.

## Gemini discussion assistant

Open **Gemini assistant** above the chat history and select **Summarize & draft reply**. The assistant returns a summary, confirmed decisions, open questions, and an editable email reply. **Copy reply** copies the edited draft; it never sends email or posts to the team chat. Tone choices are Professional, Friendly, and Concise.

Email inclusion is off by default. **Include the visible email** reads only rendered Gmail message text into a preview you can edit before generating. It excludes attachments and collapsed/hidden messages, and is capped at 20,000 characters. Nothing is sent to Gemini until Generate is clicked. Gemini receives private discussion data, so use it only for content your team is comfortable sharing with Google under your project's API terms.

The server fetches the newest stored messages with the signed-in caller's JWT and existing RLS policies, rather than trusting messages supplied by the extension. It includes up to 500 messages within a 90,000-character context budget, in chronological order, and explicitly labels truncated histories. Decisions require supporting message IDs; the model is instructed to distinguish suggestions from agreements and to keep private team debate out of the external reply. Output is plain text, never executable HTML. Summaries/drafts are not persisted in the database and are cleared when changing accounts or discussions. New messages mark a draft as out of date. AI can still get facts or judgments wrong; review drafts before using them.

### Server setup

1. Apply `supabase/migrations/20261123110000_assistant_usage.sql`. This adds a database-backed limit of 20 generation attempts per signed-in user per rolling one-hour window, shared across all workspaces.
2. Add `GEMINI_API_KEY` in **Supabase Dashboard → Edge Functions → Secrets**. Use a key from Google AI Studio. Never paste it into the frontend `.env`, source code, a browser settings field in this extension, or Git. `supabase/functions/.env.example` lists optional server configuration.
3. Deploy with `supabase functions deploy thread-assistant --project-ref <project-ref>`. The included function config keeps the existing legacy gateway JWT check enabled. The handler also verifies the bearer token against Supabase Auth and uses the caller's JWT on every database query. There is no service-role client. If your project uses asymmetric JWT signing keys and the gateway rejects them, that requires an explicit administrator decision about gateway authentication before live use.
4. Optional secrets: `GEMINI_MODEL` (defaults to `gemini-3.5-flash-lite`) and `EXTENSION_ORIGIN` (defaults to this project's stable Chrome extension origin). Supabase injects its URL and publishable/anon keys; `THREADLY_PUBLISHABLE_KEY` is an optional override. Use project/API quotas in Google AI Studio to manage aggregate spend; the app's per-user limit is not a global spending cap.
5. Rebuild, reload the extension, and refresh Gmail. Verify with a test discussion before using sensitive content. Missing deployment, missing secrets, denied access, quota limits, and provider errors produce recoverable setup/error messages.

For local function development, put server secrets in the ignored `supabase/functions/.env` and run `supabase functions serve thread-assistant --env-file supabase/functions/.env`. Tests use mocked Google responses and local Postgres, never a real key or production conversations.

References: [Gemini content generation](https://ai.google.dev/api/generate-content), [structured outputs](https://ai.google.dev/gemini-api/docs/structured-output), and [Supabase function secrets](https://supabase.com/docs/guides/functions/secrets).

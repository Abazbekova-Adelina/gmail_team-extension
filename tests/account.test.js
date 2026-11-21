import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { build } from 'esbuild';

// Real Supabase clients, separate JS worlds, and no shared localStorage or
// BroadcastChannel: the same boundary as settings and an embedded Gmail panel.
test('sign-in, token updates, reopened chat, and sign-out share extension storage', async (t) => {
  const { outputFiles } = await build({
    stdin: {
      contents: `import { supabase, sessionStorageKey } from './backend.js';
        import { watchAccount } from './account.js';
        globalThis.app = { supabase, sessionStorageKey, watchAccount };`,
      resolveDir: process.cwd(),
    },
    bundle: true, write: false, format: 'iife', platform: 'browser',
    define: {
      SUPABASE_URL: JSON.stringify('https://project.supabase.co'),
      SUPABASE_PUBLISHABLE_KEY: JSON.stringify('sb_publishable_test'),
    },
  });
  const values = {};
  const listeners = [];
  const user = { id: 'test-user', email: 'teammate@example.com', user_metadata: {} };
  function notify(key, oldValue, newValue) {
    for (const listener of listeners) listener({ [key]: { oldValue, newValue } }, 'local');
  }
  function createPage() {
    const context = vm.createContext({
      console, URL, URLSearchParams, Headers, Request, Response, AbortController, WebSocket,
      TextEncoder, TextDecoder, setTimeout, clearTimeout, setInterval, clearInterval,
      crypto: webcrypto,
      fetch: async (url) => {
        if (String(url).includes('/auth/v1/user')) return Response.json(user);
        if (String(url).includes('/auth/v1/logout')) return new Response(null, { status: 204 });
        throw new Error(`Unexpected request: ${url}`);
      },
      chrome: { storage: {
        local: {
          async get(key) { return { [key]: values[key] }; },
          async set(entries) {
            for (const [key, value] of Object.entries(entries)) {
              const oldValue = values[key];
              values[key] = value;
              if (oldValue !== value) notify(key, oldValue, value);
            }
          },
          async remove(key) {
            const oldValue = values[key];
            delete values[key];
            if (oldValue !== undefined) notify(key, oldValue, undefined);
          },
        },
        onChanged: { addListener(listener) { listeners.push(listener); } },
      } },
    });
    vm.runInContext(outputFiles[0].text, context);
    const app = context.app;
    t.after(() => app.supabase.auth.stopAutoRefresh());
    const observed = [];
    const pending = [];
    app.watchAccount((account) => {
      observed.push(account?.id ?? null);
      for (const resolve of pending.splice(0)) resolve();
    });
    async function expectAccount(id) {
      let timedOut = false;
      const deadline = setTimeout(() => {
        timedOut = true;
        for (const resolve of pending.splice(0)) resolve();
      }, 2000);
      while (observed.at(-1) !== id && !timedOut) {
        await new Promise((resolve) => pending.push(resolve));
      }
      clearTimeout(deadline);
      assert.equal(observed.at(-1), id);
    }
    return { ...app, expectAccount };
  }
  const settings = createPage();
  const chat = createPage();
  await chat.expectAccount(null);
  const token = (suffix) => `${Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url')}.${Buffer.from(JSON.stringify({ sub: user.id, exp: Math.floor(Date.now() / 1000) + 3600, suffix })).toString('base64url')}.c2lnbmF0dXJl`;
  const firstToken = token('first');
  const signedIn = await settings.supabase.auth.setSession({ access_token: firstToken, refresh_token: 'refresh-first' });
  assert.equal(signedIn.error, null);
  await chat.expectAccount(user.id);
  assert.equal((await chat.supabase.auth.getSession()).data.session.access_token, firstToken);
  const reopened = createPage();
  await reopened.expectAccount(user.id);
  const nextToken = token('next');
  assert.equal((await settings.supabase.auth.setSession({ access_token: nextToken, refresh_token: 'refresh-next' })).error, null);
  assert.equal((await chat.supabase.auth.getSession()).data.session.access_token, nextToken);
  assert.equal((await settings.supabase.auth.signOut({ scope: 'local' })).error, null);
  await chat.expectAccount(null);
  await reopened.expectAccount(null);
  assert.equal(values[settings.sessionStorageKey], undefined);
});

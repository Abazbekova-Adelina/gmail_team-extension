import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runGoogleSignIn } from '../google-sign-in.js';

function event() {
  const listeners = new Set();
  return {
    addListener(fn) { listeners.add(fn); },
    removeListener(fn) { listeners.delete(fn); },
    fire(value) { for (const fn of [...listeners]) fn(value); },
  };
}

function flow(t, navigate, exchangeError = null) {
  const previous = globalThis.chrome;
  const before = event();
  const committed = event();
  const removed = event();
  const closed = [];
  const exchanged = [];
  globalThis.chrome = {
    identity: { getRedirectURL: () => 'https://extension.chromiumapp.org/supabase-auth' },
    windows: {
      async create() { return { id: 5, tabs: [{ id: 8 }] }; },
      async remove(id) { closed.push(id); removed.fire(id); },
      onRemoved: removed,
    },
    tabs: { async update() { navigate({ before, committed, removed }); } },
    webNavigation: { onBeforeNavigate: before, onCommitted: committed },
  };
  t.after(() => { globalThis.chrome = previous; });
  const auth = {
    async signInWithOAuth() { return { data: { url: 'https://project.supabase.co/auth/v1/authorize?provider=google' }, error: null }; },
    async exchangeCodeForSession(code) {
      exchanged.push(code);
      assert.deepEqual(closed, [5], 'close the auth window before exchanging the session');
      return { error: exchangeError };
    },
  };
  return { result: runGoogleSignIn(auth), exchanged, closed };
}
const navigation = (url, extra = {}) => ({ tabId: 8, frameId: 0, url, ...extra });

test('captures Site URL fallback inside the extension without loading website callback scripts', async (t) => {
  const f = flow(t, ({ before, committed }) => {
    before.fire(navigation('https://project.supabase.co/auth/v1/callback?code=google-code'));
    before.fire(navigation('https://install.example/?code=other-tab', { tabId: 99 }));
    before.fire(navigation('https://install.example/?code=subframe', { frameId: 1 }));
    assert.deepEqual(f.exchanged, []);
    committed.fire(navigation('https://install.example/?code=supabase-pkce-code'));
  });
  await f.result;
  assert.deepEqual(f.exchanged, ['supabase-pkce-code']);
});

test('captures normal Chrome callback and only exchanges it once', async (t) => {
  const f = flow(t, ({ before, committed }) => {
    const callback = navigation('https://extension.chromiumapp.org/supabase-auth?code=pkce');
    before.fire(callback);
    committed.fire(callback);
  });
  await f.result;
  assert.deepEqual(f.exchanged, ['pkce']);
});

test('closing sign-in rejects instead of waiting forever', async (t) => {
  const f = flow(t, ({ removed }) => removed.fire(5));
  await assert.rejects(f.result, /cancelled/);
  assert.deepEqual(f.exchanged, []);
});

test('provider errors close sign-in without exchanging a session', async (t) => {
  const f = flow(t, ({ committed }) => committed.fire(navigation('https://install.example/#error=access_denied')));
  await assert.rejects(f.result, /declined or failed/);
  assert.deepEqual(f.exchanged, []);
  assert.deepEqual(f.closed, [5]);
});

test('invalid PKCE results cannot sign in the user', async (t) => {
  const f = flow(t, ({ committed }) => committed.fire(navigation('https://install.example/?code=wrong-flow')), new Error('PKCE mismatch'));
  await assert.rejects(f.result, /PKCE mismatch/);
});

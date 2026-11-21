import { avatarElement, profileDetails } from './avatars.js';
import { supabase } from './backend.js';

async function signInWithGoogle() {
  await navigator.locks.request('gmail-team-chat-google-sign-in', { ifAvailable: true }, async (lock) => {
    if (!lock) throw new Error('Finish signing in from the other extension window.');

    const redirectTo = chrome.identity.getRedirectURL('supabase-auth');
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo, skipBrowserRedirect: true },
    });
    if (error) throw error;

    const callback = new URL(await chrome.identity.launchWebAuthFlow({ url: data.url, interactive: true }));
    const expected = new URL(redirectTo);
    const code = callback.searchParams.get('code');
    if (callback.origin !== expected.origin || callback.pathname !== expected.pathname || !code) {
      throw new Error('Google sign-in did not return a session.');
    }

    const { error: sessionError } = await supabase.auth.exchangeCodeForSession(code);
    if (sessionError) throw sessionError;
  });
}

function renderAccount(accountProfile, profile) {
  const name = document.createElement('span');
  name.className = 'account-name';
  name.textContent = profile.name;
  accountProfile.replaceChildren(avatarElement(profile.name, profile.avatar), name);
}

export function watchAccount(onAccountChange) {
  supabase?.auth.onAuthStateChange((_event, session) => {
    setTimeout(() => onAccountChange(session?.user), 0);
  });
}

export function mountAccount(onAccountChange, { isPopup, startSignIn }) {
  const signInView = document.querySelector('#sign-in-view');
  const signInButton = document.querySelector('#sign-in');
  const signOutButton = document.querySelector('#sign-out');
  const authStatus = document.querySelector('#auth-status');
  const accountProfile = document.querySelector('#account-profile');

  if (!supabase) {
    authStatus.textContent = 'This build needs a Supabase project to sign in.';
    return;
  }

  let startOnLoad = startSignIn;

  function showAccount(user) {
    signInView.hidden = Boolean(user);
    signInButton.hidden = Boolean(user);
    signOutButton.hidden = !user;
    accountProfile.hidden = !user;
    authStatus.textContent = '';
    signOutButton.textContent = 'Sign out';
    accountProfile.replaceChildren();
    if (user) renderAccount(accountProfile, profileDetails(user));
    onAccountChange(user);
    if (startOnLoad) {
      startOnLoad = false;
      if (!user) void signIn();
    }
  }

  watchAccount(showAccount);

  async function signIn() {
    signInButton.disabled = true;
    authStatus.textContent = 'Waiting for Google sign-in…';
    try {
      if (isPopup) await chrome.tabs.create({ url: chrome.runtime.getURL('settings.html?sign-in=1') });
      else await signInWithGoogle();
    } catch {
      authStatus.textContent = 'Sign-in did not finish. Try again.';
    } finally {
      signInButton.disabled = false;
    }
  }

  signInButton.addEventListener('click', signIn);

  signOutButton.addEventListener('click', async () => {
    signOutButton.disabled = true;
    try {
      const { error } = await supabase.auth.signOut({ scope: 'local' });
      if (error) throw error;
      showAccount();
    } catch {
      signOutButton.textContent = 'Retry sign-out';
    } finally {
      signOutButton.disabled = false;
    }
  });
}

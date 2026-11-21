import { avatarElement, profileDetails } from './avatars.js';
import { sessionStorageKey, supabase } from './backend.js';
import { runGoogleSignIn } from './google-sign-in.js';

async function signInWithGoogle() {
  await navigator.locks.request('gmail-team-chat-google-sign-in', { ifAvailable: true }, async (lock) => {
    if (!lock) throw new Error('Finish signing in from the other extension window.');

    await runGoogleSignIn(supabase.auth);
  });
}

function renderAccount(accountProfile, profile) {
  const name = document.createElement('span');
  name.className = 'account-name';
  name.textContent = profile.name;
  accountProfile.replaceChildren(avatarElement(profile.name, profile.avatar), name);
}

export function watchAccount(onAccountChange) {
  if (!supabase) return;
  let version = 0;
  function refreshAccount() {
    const request = ++version;
    // Auth callbacks run under the auth client's lock; read after they finish.
    setTimeout(async () => {
      const { data, error } = await supabase.auth.getSession();
      if (error || request !== version) return;
      // Storage changes do not emit Supabase auth events across partitions.
      void supabase.realtime.setAuth(data.session?.access_token);
      onAccountChange(data.session?.user);
    }, 0);
  }
  supabase.auth.onAuthStateChange(refreshAccount);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && Object.hasOwn(changes, sessionStorageKey)) refreshAccount();
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

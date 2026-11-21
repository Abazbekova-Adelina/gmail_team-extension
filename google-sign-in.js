export async function runGoogleSignIn(auth) {
  const redirectTo = chrome.identity.getRedirectURL('supabase-auth');
  const { data, error } = await auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo, skipBrowserRedirect: true },
  });
  if (error) throw error;
  const authOrigin = new URL(data.url).origin;

  // Own the window so a Supabase Site URL fallback cannot strand the user on
  // the install website. Start blank to register listeners before navigation.
  const popup = await chrome.windows.create({ url: 'about:blank', type: 'popup', width: 520, height: 700 });
  const tabId = popup.tabs[0].id;
  const code = await new Promise((resolve, reject) => {
    let finished = false;
    function finish(error, code) {
      if (finished) return;
      finished = true;
      chrome.webNavigation.onBeforeNavigate.removeListener(onNavigate);
      chrome.webNavigation.onCommitted.removeListener(onNavigate);
      chrome.windows.onRemoved.removeListener(onClosed);
      void chrome.windows.remove(popup.id).catch(() => {});
      if (error) reject(error);
      else resolve(code);
    }
    function onClosed(id) {
      if (id === popup.id) finish(new Error('Google sign-in was cancelled. Try again.'));
    }
    function onNavigate(details) {
      if (details.tabId !== tabId || details.frameId !== 0) return;
      const url = new URL(details.url);
      // Google's code at the Supabase callback is NOT the Supabase PKCE code.
      if (url.origin === authOrigin || url.hostname === 'accounts.google.com') return;
      if (url.searchParams.has('error') || new URLSearchParams(url.hash.slice(1)).has('error')) {
        finish(new Error('Google sign-in was declined or failed. Try again.'));
      } else if (url.searchParams.get('code')) {
        // Only this flow's PKCE verifier can exchange the returned code. The
        // destination may be chromiumapp.org or Supabase's configured Site URL.
        finish(null, url.searchParams.get('code'));
      }
    }
    chrome.webNavigation.onBeforeNavigate.addListener(onNavigate);
    chrome.webNavigation.onCommitted.addListener(onNavigate);
    chrome.windows.onRemoved.addListener(onClosed);
    void chrome.tabs.update(tabId, { url: data.url }).catch((error) => finish(error));
  });
  const { error: sessionError } = await auth.exchangeCodeForSession(code);
  if (sessionError) throw sessionError;
}

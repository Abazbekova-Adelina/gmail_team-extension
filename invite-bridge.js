import { validDiscussionCode } from './thread-context.js';
import { installEmailIdentityBridge } from './email-identity-bridge.js';

installEmailIdentityBridge();

chrome.runtime.onMessageExternal.addListener((message, sender, respond) => {
  if (sender.origin !== 'https://gmail-team-chat.vercel.app' || message?.type !== 'open-invite'
    || !validDiscussionCode(message.id)) return;
  const url = new URL(chrome.runtime.getURL('settings.html'));
  url.searchParams.set('invite', message.id);
  chrome.tabs.create({ url: url.href }).then(() => respond(true), () => respond(false));
  return true;
});

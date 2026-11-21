import { gmailThreadKey } from './thread-context.js';
import { EmailIdentityError, gmailMailboxPath, gmailSessionKey, oldestMessageId } from './email-identity.js';
import { requestEmailIdentity } from './email-identity-bridge.js';
import { visibleEmailContext } from './email-context.js';

const threadSelector = '[role="main"] :is(.a98.iY, .if, .PeIF1d, table.Bs > tbody > tr)';
const messageSelector = '.adn, [data-message-id], [data-legacy-message-id]';
let frame;
let scheduled = false;
let matching;
let lastMessageContext;

function findAnchor() {
  for (const thread of document.querySelectorAll(threadSelector)) {
    const message = thread.querySelector(messageSelector);
    if (!message || !thread.checkVisibility()) continue;
    const list = message.closest('[role="list"]');
    if (list && thread.contains(list)) return list;
    return thread.matches('tr') ? thread.closest('table') : thread;
  }
  return null;
}

function threadContext(anchor) {
  const source = anchor?.querySelector('[data-legacy-thread-id], [data-thread-id]');
  const legacyId = source?.getAttribute('data-legacy-thread-id');
  const threadId = source?.getAttribute('data-thread-id');
  const mailbox = gmailMailboxPath(location.pathname);
  return {
    gmailKey: anchor && gmailThreadKey(location.hash, legacyId, threadId),
    mailbox,
    sessionKey: gmailSessionKey(mailbox, [
      ...[...document.querySelectorAll('a[href*="ik="]')].map((link) => link.href),
      ...(globalThis.performance?.getEntriesByType('resource') ?? []).map((entry) => entry.name),
    ]),
    messageId: anchor && oldestMessageId(anchor),
  };
}

function contextKey(context) {
  return JSON.stringify([context.gmailKey, context.mailbox, context.messageId, context.sessionKey]);
}

function updateFrame(anchor, context) {
  const url = new URL(chrome.runtime.getURL('chat.html'));
  url.searchParams.set('thread', context.gmailKey);
  if (context.mailbox) url.searchParams.set('mailbox', context.mailbox);
  url.searchParams.set('match-state', matching.state);
  if (matching.error) url.searchParams.set('match-error', matching.error);
  if (matching.messageKey) url.searchParams.set('message-key', matching.messageKey);
  // A new URL clears the previous conversation's history and draft immediately.
  if (frame.src !== url.href) frame.src = url.href;
  if (anchor.nextElementSibling !== frame) anchor.after(frame);
}

function mountChat() {
  scheduled = false;
  const anchor = findAnchor();
  const context = threadContext(anchor);
  if (!anchor || !context.gmailKey) {
    matching?.controller.abort();
    matching = undefined;
    frame?.remove();
    frame = undefined;
    return;
  }

  if (!frame) {
    frame = document.createElement('iframe');
    frame.id = 'gmail-team-chat';
    frame.title = 'Team discussion';
  }

  const key = contextKey(context);
  if (matching?.key === key) {
    updateFrame(anchor, context);
    return;
  }
  matching?.controller.abort();
  // Hash navigation can precede Gmail replacing its message DOM. Never resolve
  // the previous conversation's message under the newly opened thread's route.
  const staleMessage = lastMessageContext
    && lastMessageContext.mailbox === context.mailbox
    && lastMessageContext.gmailKey !== context.gmailKey
    && lastMessageContext.messageId === context.messageId;
  const canMatch = context.mailbox && context.messageId && !staleMessage;
  const request = matching = {
    key, controller: new AbortController(), state: canMatch ? 'pending' : 'failed',
    error: !context.mailbox ? 'Gmail account path is unavailable'
      : !context.messageId ? 'Gmail has not exposed a message ID'
      : staleMessage ? 'Waiting for Gmail to load the opened email' : undefined,
  };
  updateFrame(anchor, context);
  if (!canMatch) return;
  lastMessageContext = context;
  const isCurrent = () => matching === request
    && contextKey(threadContext(findAnchor())) === request.key;
  requestEmailIdentity(context.mailbox, context.messageId, {
    signal: request.controller.signal, sessionKey: context.sessionKey,
  })
    .then((messageKey) => {
      if (!isCurrent()) return;
      request.messageKey = messageKey;
      request.state = 'ready';
      updateFrame(findAnchor(), context);
    })
    .catch((error) => {
      if (!isCurrent()) return;
      request.state = 'failed';
      request.error = error instanceof EmailIdentityError ? error.message
        : error?.name === 'TimeoutError' ? 'Gmail original-message request timed out'
        : 'Gmail original-message request failed (network, redirect, or browser restriction)';
      updateFrame(findAnchor(), context);
    });
}

function scheduleMount() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(mountChat);
}

new MutationObserver(scheduleMount).observe(document.body, {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ['class', 'style', 'hidden', 'aria-hidden', 'data-legacy-message-id', 'data-message-id', 'data-legacy-thread-id', 'data-thread-id'],
});
window.addEventListener('hashchange', scheduleMount);
// Gmail can expose its session key in a request after the message first mounts.
if (globalThis.PerformanceObserver) {
  new PerformanceObserver(scheduleMount).observe({ type: 'resource', buffered: true });
}
window.addEventListener('message', (event) => {
  if (!frame || event.source !== frame.contentWindow) return;
  if (event.data?.type === 'threadly-retry-match') {
    if (matching?.state !== 'failed') return;
    matching.controller.abort();
    matching = undefined;
    scheduleMount();
    return;
  }
  if (event.data?.type === 'threadly-email-context-request') {
    const extensionOrigin = chrome.runtime.getURL('').replace(/\/$/, '');
    if (event.origin !== extensionOrigin || typeof event.data.requestId !== 'string' || event.data.requestId.length > 80) return;
    const anchor = findAnchor();
    const current = threadContext(anchor);
    const requested = event.data.threadKey;
    const framed = new URL(frame.src).searchParams.get('thread');
    if (!anchor || current.gmailKey !== requested || framed !== requested || matching?.state !== 'ready') return;
    const context = visibleEmailContext(anchor, document.querySelector('[role="main"] h2.hP')?.textContent.trim());
    frame.contentWindow.postMessage({type:'threadly-email-context-result',requestId:event.data.requestId,
      threadKey:requested,...context,error:!context.text},extensionOrigin);
    return;
  }
  if (event.data?.type !== 'threadly-height') return;
  const height = Number(event.data.height);
  if (Number.isFinite(height)) frame.style.height = `${Math.min(Math.max(Math.ceil(height), 60), 560)}px`;
});
// After an extension reload, the popup injects a fresh copy of this script.
// The previous copy loses its runtime, so its frame has to go.
for (const stale of document.querySelectorAll('#gmail-team-chat')) stale.remove();
scheduleMount();

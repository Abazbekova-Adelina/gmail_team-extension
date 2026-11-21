import { gmailThreadKey } from './thread-context.js';
import { gmailMailboxPath, oldestLegacyMessageId, resolveEmailIdentity } from './email-identity.js';

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
  return {
    gmailKey: anchor && gmailThreadKey(location.hash, legacyId, threadId),
    mailbox: gmailMailboxPath(location.pathname),
    messageId: anchor && oldestLegacyMessageId(anchor),
  };
}

function contextKey(context) {
  return JSON.stringify([context.gmailKey, context.mailbox, context.messageId]);
}

function updateFrame(anchor, context) {
  const url = new URL(chrome.runtime.getURL('chat.html'));
  url.searchParams.set('thread', context.gmailKey);
  if (context.mailbox) url.searchParams.set('mailbox', context.mailbox);
  url.searchParams.set('match-state', matching.state);
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
  };
  updateFrame(anchor, context);
  if (!canMatch) return;
  lastMessageContext = context;
  const isCurrent = () => matching === request
    && contextKey(threadContext(findAnchor())) === request.key;
  resolveEmailIdentity(context.mailbox, context.messageId, { signal: request.controller.signal })
    .then((messageKey) => {
      if (!isCurrent()) return;
      request.messageKey = messageKey;
      request.state = 'ready';
      updateFrame(findAnchor(), context);
    })
    .catch(() => {
      if (!isCurrent()) return;
      request.state = 'failed';
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
window.addEventListener('message', (event) => {
  if (!frame || event.source !== frame.contentWindow || event.data?.type !== 'threadly-height') return;
  const height = Number(event.data.height);
  if (Number.isFinite(height)) frame.style.height = `${Math.min(Math.max(Math.ceil(height), 60), 560)}px`;
});
// After an extension reload, the popup injects a fresh copy of this script.
// The previous copy loses its runtime, so its frame has to go.
for (const stale of document.querySelectorAll('#gmail-team-chat')) stale.remove();
scheduleMount();

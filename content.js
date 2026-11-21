import { gmailThreadKey } from './thread-context.js';

const threadSelector = '[role="main"] :is(.a98.iY, .if, .PeIF1d, table.Bs > tbody > tr)';
const messageSelector = '.adn, [data-message-id], [data-legacy-message-id]';
let frame;
let scheduled = false;

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

function mountChat() {
  scheduled = false;
  const anchor = findAnchor();
  const source = anchor?.querySelector('[data-legacy-thread-id], [data-thread-id]');
  const threadKey = anchor && gmailThreadKey(location.hash,
    source?.getAttribute('data-legacy-thread-id'), source?.getAttribute('data-thread-id'));
  if (!anchor || !threadKey) {
    frame?.remove();
    frame = undefined;
    return;
  }

  if (!frame) {
    frame = document.createElement('iframe');
    frame.id = 'gmail-team-chat';
    frame.title = 'Team discussion';
  }

  const url = new URL(chrome.runtime.getURL('chat.html'));
  url.searchParams.set('thread', threadKey);
  // Changing threads creates a fresh frame, clearing the old history and draft.
  if (frame.src !== url.href) frame.src = url.href;
  if (anchor.nextElementSibling !== frame) anchor.after(frame);
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
  attributeFilter: ['class', 'style', 'hidden', 'aria-hidden'],
});
window.addEventListener('hashchange', scheduleMount);
scheduleMount();

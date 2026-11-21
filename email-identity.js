const MAX_HEADER_BYTES = 64 * 1024;
const LEGACY_MESSAGE_ID = /^[a-f0-9]{16,32}$/i;
const ATOM = "[!#$%&'*+\\-/=?^_`{|}~A-Za-z0-9]+";
const DOT_ATOM = `${ATOM}(?:\\.${ATOM})*`;
const MESSAGE_ID = new RegExp(`<${DOT_ATOM}@(?:${DOT_ATOM}|\\[[^\\[\\]\\s<>\\\\]+\\])>`, 'g');

export function gmailMailboxPath(pathname) {
  return /^\/mail\/u\/\d+\//.exec(pathname ?? '')?.[0] ?? null;
}

export function oldestLegacyMessageId(anchor) {
  // Gmail lays out the conversation chronologically, including collapsed messages.
  // Do not substitute a thread ID or pick a newer message when the first is unknown.
  const first = [...anchor.querySelectorAll('.adn, [data-message-id], [data-legacy-message-id]')]
    .find((message) => message.checkVisibility());
  const id = first?.getAttribute('data-legacy-message-id')
    ?? first?.querySelector('[data-legacy-message-id]')?.getAttribute('data-legacy-message-id');
  return LEGACY_MESSAGE_ID.test(id ?? '') ? id.toLowerCase() : null;
}

function messageIds(value) {
  const ids = value.match(MESSAGE_ID);
  if (!ids?.length || value.replace(MESSAGE_ID, '').trim()) {
    throw new Error('Invalid email identity header');
  }
  // Only folding whitespace may separate IDs; never normalize the IDs themselves.
  if (value.replace(MESSAGE_ID, '').replace(/[\t ]/g, '')) {
    throw new Error('Invalid email identity header');
  }
  return ids;
}

export function conversationMessageId(headers) {
  const fields = new Map();
  let name;
  for (const line of headers.replace(/\r\n/g, '\n').split('\n')) {
    if (/^[\t ]/.test(line)) {
      if (!name) throw new Error('Invalid email headers');
      if (fields.has(name)) fields.set(name, `${fields.get(name)} ${line.trim()}`);
      continue;
    }
    const match = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+):[\t ]*([^\r\n]*)$/.exec(line);
    if (!match) throw new Error('Invalid email headers');
    name = match[1].toLowerCase();
    if (!['message-id', 'references', 'in-reply-to'].includes(name)) continue;
    if (fields.has(name)) throw new Error('Duplicate email identity header');
    fields.set(name, match[2].trim());
  }
  const own = messageIds(fields.get('message-id') ?? '');
  if (own.length !== 1) throw new Error('Ambiguous Message-ID');
  const references = fields.has('references') ? messageIds(fields.get('references')) : null;
  const parent = fields.has('in-reply-to') ? messageIds(fields.get('in-reply-to')) : null;
  if (parent && parent.length !== 1) throw new Error('Ambiguous In-Reply-To');
  // References is ordered root first. This also matches a recipient who has only
  // a reply to the original message. Without ancestry, use the message itself.
  return references?.[0] ?? parent?.[0] ?? own[0];
}

export async function readMessageHeaders(response) {
  if (!response.ok || !response.body || response.redirected
      || /(?:text\/html|application\/xhtml\+xml)/i.test(response.headers.get('content-type') ?? '')) {
    await response.body?.cancel();
    throw new Error('Gmail original message is unavailable');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let headers = '';
  let size = 0;
  let previous = 0;
  let preceding = 0;
  let beforePreceding = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) throw new Error('Incomplete email headers');
      // Find the boundary in bytes before decoding, retaining, or parsing any body.
      for (let index = 0; index < value.length; index++) {
        const byte = value[index];
        if (++size > MAX_HEADER_BYTES) throw new Error('Email headers exceed the limit');
        if (byte === 10 && (previous === 10
            || (previous === 13 && preceding === 10 && beforePreceding === 13))) {
          headers += decoder.decode(value.subarray(0, index + 1));
          return headers.replace(/\r?\n\r?\n$/, '');
        }
        beforePreceding = preceding;
        preceding = previous;
        previous = byte;
      }
      headers += decoder.decode(value, { stream: true });
    }
  } finally {
    try { await reader.cancel(); } finally { reader.releaseLock(); }
  }
}

export async function resolveEmailIdentity(mailbox, legacyMessageId, { signal } = {}) {
  if (!mailbox || gmailMailboxPath(mailbox) !== mailbox || !LEGACY_MESSAGE_ID.test(legacyMessageId ?? '')) {
    throw new Error('Gmail message identity is unavailable');
  }
  // Gmail.js uses this same-origin Download Original endpoint for legacy message
  // IDs: https://github.com/KartikTalwar/gmail.js/blob/master/src/gmail.js#L3367-L3380
  // Unlike view=om's HTML wrapper, it allows cancelling at the RFC header boundary.
  const url = new URL(mailbox, 'https://mail.google.com');
  url.search = new URLSearchParams({
    view: 'att', th: legacyMessageId, attid: '0', disp: 'comp', safe: '1', zw: '',
  }).toString();
  const requestSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(10000)])
    : AbortSignal.timeout(10000);
  const response = await fetch(url, {
    credentials: 'same-origin', redirect: 'error', cache: 'no-store', signal: requestSignal,
  });
  const headers = await readMessageHeaders(response);
  requestSignal.throwIfAborted();
  const identity = conversationMessageId(headers);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity));
  requestSignal.throwIfAborted();
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

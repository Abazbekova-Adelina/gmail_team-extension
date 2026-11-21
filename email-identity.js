const MAX_HEADER_BYTES = 64 * 1024;
const LEGACY_MESSAGE_ID = /^[a-f0-9]{16,32}$/i;
const MESSAGE_KEY = /^#?(msg-[af]:\d+)$/;
const ATOM = "[!#$%&'*+\\-/=?^_`{|}~A-Za-z0-9]+";
const DOT_ATOM = `${ATOM}(?:\\.${ATOM})*`;
const MESSAGE_ID = new RegExp(`<${DOT_ATOM}@(?:${DOT_ATOM}|\\[[^\\[\\]\\s<>\\\\]+\\])>`, 'g');

// Only these application-authored messages are safe to show outside this module.
export class EmailIdentityError extends Error {}

export function gmailMailboxPath(pathname) {
  return /^\/mail\/u\/\d+\//.exec(pathname ?? '')?.[0] ?? null;
}

export function gmailSessionKey(mailbox, urls) {
  for (const value of urls) {
    let url;
    try { url = new URL(value); } catch { continue; }
    if (url.origin !== 'https://mail.google.com' || gmailMailboxPath(url.pathname) !== mailbox) continue;
    const key = url.searchParams.get('ik');
    if (/^[a-z0-9]+$/i.test(key ?? '')) return key;
  }
  return null;
}

export function oldestMessageId(anchor) {
  // The thread is already visible. Collapsed messages still carry usable IDs;
  // layout wrappers (.adn) need not carry IDs or have a visible CSS box.
  const first = anchor.querySelector('[data-legacy-message-id], [data-message-id]');
  const legacy = first?.getAttribute('data-legacy-message-id');
  if (LEGACY_MESSAGE_ID.test(legacy ?? '')) return legacy.toLowerCase();
  const current = first?.getAttribute('data-message-id');
  return MESSAGE_KEY.exec(current ?? '')?.[1] ?? null;
}

function messageIds(value) {
  const ids = value.match(MESSAGE_ID);
  if (!ids?.length || value.replace(MESSAGE_ID, '').trim()) {
    throw new EmailIdentityError('Missing or malformed Message-ID or reply headers');
  }
  // Only folding whitespace may separate IDs; never normalize the IDs themselves.
  if (value.replace(MESSAGE_ID, '').replace(/[\t ]/g, '')) {
    throw new EmailIdentityError('Invalid email identity header');
  }
  return ids;
}

export function conversationMessageId(headers) {
  const fields = new Map();
  let name;
  for (const line of headers.replace(/\r\n/g, '\n').split('\n')) {
    if (/^[\t ]/.test(line)) {
      if (!name) throw new EmailIdentityError('Invalid email headers');
      if (fields.has(name)) fields.set(name, `${fields.get(name)} ${line.trim()}`);
      continue;
    }
    const match = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+):[\t ]*([^\r\n]*)$/.exec(line);
    if (!match) throw new EmailIdentityError('Invalid email headers');
    name = match[1].toLowerCase();
    if (!['message-id', 'references', 'in-reply-to'].includes(name)) continue;
    if (fields.has(name)) throw new EmailIdentityError('Duplicate email identity header');
    fields.set(name, match[2].trim());
  }
  const own = messageIds(fields.get('message-id') ?? '');
  if (own.length !== 1) throw new EmailIdentityError('Ambiguous Message-ID');
  const references = fields.has('references') ? messageIds(fields.get('references')) : null;
  const parent = fields.has('in-reply-to') ? messageIds(fields.get('in-reply-to')) : null;
  if (parent && parent.length !== 1) throw new EmailIdentityError('Ambiguous In-Reply-To');
  // References is ordered root first. This also matches a recipient who has only
  // a reply to the original message. Without ancestry, use the message itself.
  return references?.[0] ?? parent?.[0] ?? own[0];
}

export async function readMessageHeaders(response) {
  const html = /(?:text\/html|application\/xhtml\+xml)/i.test(response.headers.get('content-type') ?? '');
  if (!response.ok || !response.body || html) {
    await response.body?.cancel();
    const reason = !response.ok ? `Gmail returned HTTP ${response.status}`
      : html ? 'Gmail returned a web page instead of original-message headers'
      : 'Gmail returned no original-message content';
    throw new EmailIdentityError(reason);
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
      if (done) throw new EmailIdentityError('Incomplete email headers');
      // Find the boundary in bytes before decoding, retaining, or parsing any body.
      for (let index = 0; index < value.length; index++) {
        const byte = value[index];
        if (++size > MAX_HEADER_BYTES) throw new EmailIdentityError('Email headers exceed the limit');
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

export async function resolveEmailIdentity(mailbox, messageId, { signal, sessionKey } = {}) {
  const legacy = LEGACY_MESSAGE_ID.test(messageId ?? '');
  const current = MESSAGE_KEY.exec(messageId ?? '')?.[1];
  if (!mailbox || gmailMailboxPath(mailbox) !== mailbox || (!legacy && !current)) {
    throw new EmailIdentityError('Gmail message identity is unavailable');
  }
  // Run in the extension background: Gmail redirects Download Original to its
  // attachment host. Stop after headers rather than downloading the email body.
  const url = new URL(mailbox, 'https://mail.google.com');
  url.search = new URLSearchParams({
    view: 'att', ...(legacy ? { th: messageId } : { permmsgid: current }),
    attid: '0', disp: 'comp', safe: '1', zw: '',
  }).toString();
  if (sessionKey) url.searchParams.set('ik', sessionKey);
  const requestSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(10000)])
    : AbortSignal.timeout(10000);
  const response = await fetch(url, {
    credentials: 'include', redirect: 'follow', cache: 'no-store', signal: requestSignal,
  });
  const headers = await readMessageHeaders(response);
  requestSignal.throwIfAborted();
  const identity = conversationMessageId(headers);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity));
  requestSignal.throwIfAborted();
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  conversationMessageId, gmailMailboxPath, gmailSessionKey, oldestMessageId,
  readMessageHeaders, resolveEmailIdentity,
} from '../email-identity.js';

const legacyId = '19aa123456789abc';
const hash = (id) => createHash('sha256').update(id).digest('hex');
const encode = (text) => new TextEncoder().encode(text);

function streamed(chunks, options = {}) {
  let reads = 0;
  let cancelled = false;
  const response = new Response(new ReadableStream({
    pull(controller) {
      reads++;
      if (chunks.length) controller.enqueue(encode(chunks.shift()));
      else controller.close();
    },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 }), options);
  return { response, get reads() { return reads; }, get cancelled() { return cancelled; } };
}

test('identity uses case-preserving Message-ID, not presentation headers', () => {
  assert.equal(conversationMessageId('Subject: Shared subject\r\nFrom: sender@example.com\r\nMessage-ID: <AbC+tag@Example.COM>'), '<AbC+tag@Example.COM>');
  assert.notEqual(conversationMessageId('Message-ID: <ABC@example.com>'), conversationMessageId('Message-ID: <abc@example.com>'));
});

test('folded References identifies the root, then a single In-Reply-To, then self', () => {
  assert.equal(conversationMessageId('Message-ID: <reply@example.com>\r\nReferences: <Root@example.com>\r\n\t<parent@example.com>\r\nIn-Reply-To: <parent@example.com>'), '<Root@example.com>');
  assert.equal(conversationMessageId('Message-ID: <reply@example.com>\nIn-Reply-To: <Root@example.com>'), '<Root@example.com>');
  assert.equal(conversationMessageId('message-id:\t<Root@example.com>'), '<Root@example.com>');
});

test('missing, malformed and ambiguous identity headers fail closed', () => {
  for (const headers of [
    '', 'Subject: Identical subject', 'Message-ID: missing@example.com',
    'Message-ID: <bad id@example.com>', 'Message-ID: <a@@example.com>',
    'Message-ID: <..a@example.com>', 'Message-ID: <a@example.com> garbage',
    'Message-ID: <a@example.com>\nMessage-ID: <a@example.com>',
    'Message-ID: <a@example.com> <b@example.com>',
    'Message-ID: <a@example.com>\nReferences: invalid',
    'Message-ID: <a@example.com>\nReferences:',
    'Message-ID: <a@example.com>\nIn-Reply-To: <b@example.com> <c@example.com>',
    'Message-ID: <a@example.com>\nReferences: <b@example.com>, <c@example.com>',
    '\tMessage-ID: <a@example.com>',
    'Message-ID: <a@example.com>\n\nMessage-ID: <body@example.com>',
  ]) assert.throws(() => conversationMessageId(headers), undefined, headers);
});

test('the account path is explicit and never defaults to another signed-in account', () => {
  assert.equal(gmailMailboxPath('/mail/u/3/'), '/mail/u/3/');
  assert.equal(gmailMailboxPath('/mail/u/12/something'), '/mail/u/12/');
  for (const path of [undefined, '/mail/', '/mail/u/not-an-account/', '/mail/u/3', '/elsewhere/mail/u/0/']) {
    assert.equal(gmailMailboxPath(path), null);
  }
});

test('the first message ID is usable even when collapsed, without selecting layout wrappers', () => {
  const message = (legacy, current = null) => ({
    getAttribute: (name) => name === 'data-legacy-message-id' ? legacy : current,
  });
  const anchor = (first) => ({
    querySelector: () => first,
  });
  assert.equal(oldestMessageId(anchor(message(legacyId.toUpperCase()))), legacyId);
  assert.equal(oldestMessageId(anchor(message(null, '#msg-f:1882481198916350244'))), 'msg-f:1882481198916350244');
  assert.equal(oldestMessageId(anchor(message(null, 'msg-a:123456789'))), 'msg-a:123456789');
  assert.equal(oldestMessageId(anchor(message(null, 'thread-f:12345678912345'))), null);
  assert.equal(oldestMessageId(anchor(null)), null);
});

test('session discovery stays in the current Gmail account', () => {
  const urls = [
    'https://example.com/mail/u/2/?ik=wrongorigin',
    'https://mail.google.com/mail/u/0/?ik=wrongaccount',
    'not a URL',
    'https://mail.google.com/mail/u/2/?view=att&ik=abc123',
  ];
  assert.equal(gmailSessionKey('/mail/u/2/', urls), 'abc123');
  assert.equal(gmailSessionKey('/mail/u/3/', urls), null);
});

test('original download includes the discovered Gmail session key', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url) => {
    assert.equal(new URL(url).searchParams.get('ik'), 'abc123');
    return streamed(['Message-ID: <Root@example.com>\r\n\r\n']).response;
  });
  assert.equal(await resolveEmailIdentity('/mail/u/2/', legacyId, { sessionKey: 'abc123' }), hash('<Root@example.com>'));
});

test('streaming stops at a split CRLF header boundary and cancels before body reads', async () => {
  const stream = streamed(['Message-ID: <Root@example.com>\r', '\nSubject: Hello\r\n\r', '\n', 'SECRET BODY']);
  assert.equal(await readMessageHeaders(stream.response), 'Message-ID: <Root@example.com>\r\nSubject: Hello');
  assert.equal(stream.reads, 3);
  assert.equal(stream.cancelled, true);
});

test('body bytes already in the boundary chunk are not decoded or returned', async () => {
  let cancelled = false;
  const prefix = encode('Message-ID: <root@example.com>\n\n');
  const bytes = new Uint8Array(prefix.length + 1);
  bytes.set(prefix);
  bytes[prefix.length] = 255; // Invalid UTF-8 must not be decoded as a header.
  const response = new Response(new ReadableStream({
    start(controller) { controller.enqueue(bytes); },
    cancel() { cancelled = true; },
  }));
  assert.equal(await readMessageHeaders(response), 'Message-ID: <root@example.com>');
  assert.equal(cancelled, true);
});

test('incomplete, oversized, HTML and HTTP-error responses fail and cancel', async () => {
  for (const [chunks, options] of [
    [['Message-ID: <root@example.com>'], {}],
    [['X-Large: ' + 'x'.repeat(65536)], {}],
    [['<html>Sign in</html>'], { headers: { 'content-type': 'text/html; charset=utf-8' } }],
    [['Forbidden'], { status: 403 }],
  ]) {
    const stream = streamed(chunks, options);
    await assert.rejects(readMessageHeaders(stream.response));
    // Cancelling an already exhausted stream is a no-op; the others must cancel.
    if (stream.reads < 2) assert.equal(stream.cancelled, true);
  }
});

test('unavailable originals distinguish Gmail HTTP errors from HTML responses', async () => {
  await assert.rejects(readMessageHeaders(new Response('Forbidden', { status: 403 })), /Gmail returned HTTP 403/);
  await assert.rejects(readMessageHeaders(new Response('<html>Sign in</html>', {
    headers: { 'content-type': 'text/html' },
  })), /web page instead of original-message headers/);
});

test('two mailbox copies match; unrelated same-subject emails and case-distinct IDs do not', async (t) => {
  const ids = ['<Root@Example.com>', '<Root@Example.com>', '<other@Example.com>', '<root@Example.com>'];
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url: new URL(url), options });
    return streamed([`Subject: Same subject\r\nMessage-ID: ${ids.shift()}\r\n\r\n`, 'PRIVATE BODY']).response;
  });
  const first = await resolveEmailIdentity('/mail/u/0/', legacyId);
  const second = await resolveEmailIdentity('/mail/u/3/', '1111111111111111');
  const unrelated = await resolveEmailIdentity('/mail/u/3/', '2222222222222222');
  const caseDistinct = await resolveEmailIdentity('/mail/u/3/', '3333333333333333');
  assert.equal(first, hash('<Root@Example.com>'));
  assert.equal(first, second);
  assert.notEqual(first, unrelated);
  assert.notEqual(first, caseDistinct);
  assert.equal(requests[1].url.pathname, '/mail/u/3/');
  assert.equal(requests[0].url.origin, 'https://mail.google.com');
  assert.equal(requests[0].url.searchParams.get('th'), legacyId);
  assert.equal(requests[0].url.searchParams.get('view'), 'att');
  assert.equal(requests[0].url.searchParams.get('attid'), '0');
  assert.equal(requests[0].url.searchParams.get('disp'), 'comp');
  assert.equal(requests[0].options.credentials, 'include');
  assert.equal(requests[0].options.redirect, 'follow');
  assert.equal(requests[0].options.cache, 'no-store');
  assert.equal(requests[0].options.body, undefined);
});

test('original and reply-only copies share the References root hash', async (t) => {
  const headers = [
    'Message-ID: <Root@example.com>',
    'Message-ID: <reply@example.com>\r\nReferences: <Root@example.com> <parent@example.com>',
    'Message-ID: <first-reply@example.com>\r\nIn-Reply-To: <Root@example.com>',
  ];
  t.mock.method(globalThis, 'fetch', async () => streamed([`${headers.shift()}\r\n\r\n`]).response);
  const keys = await Promise.all([0, 1, 2].map((account) => resolveEmailIdentity(`/mail/u/${account}/`, legacyId)));
  assert.deepEqual(keys, Array(3).fill(hash('<Root@example.com>')));
});

test('current Gmail IDs resolve through permmsgid to the same shared identity', async (t) => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    requests.push(new URL(url));
    return streamed(['Message-ID: <Root@example.com>\r\n\r\n']).response;
  });
  const expected = await resolveEmailIdentity('/mail/u/0/', legacyId);
  for (const id of ['msg-f:1882481198916350244', '#msg-a:123456789']) {
    assert.equal(await resolveEmailIdentity('/mail/u/2/', id), expected);
    assert.equal(requests.at(-1).searchParams.get('permmsgid'), id.replace(/^#/, ''));
    assert.equal(requests.at(-1).searchParams.has('th'), false);
  }
});

test('invalid context never fetches; network, malformed headers and abort never fabricate a key', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('offline'); });
  await assert.rejects(resolveEmailIdentity('/mail/u/0/', 'invalid'));
  await assert.rejects(resolveEmailIdentity('/mail/', legacyId));
  await assert.rejects(resolveEmailIdentity(null, legacyId));
  assert.equal(fetchMock.mock.calls.length, 0);
  await assert.rejects(resolveEmailIdentity('/mail/u/0/', legacyId));
  fetchMock.mock.mockImplementation(async () => streamed(['Subject: no identity\r\n\r\n']).response);
  await assert.rejects(resolveEmailIdentity('/mail/u/0/', legacyId));
  fetchMock.mock.mockImplementation(async () => streamed(['Message-ID: <a@example.com>\r\n\r\n']).response);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(resolveEmailIdentity('/mail/u/0/', legacyId, { signal: controller.signal }));
});

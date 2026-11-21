import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { gmailThreadKey, validDiscussionCode } from '../thread-context.js';
import { EmailIdentityError, gmailMailboxPath, gmailSessionKey, oldestMessageId } from '../email-identity.js';

const threadA = 'FMfcgzQjgzrDFxPDQLFtLphhCPxjqRXv';
const threadB = 'FMfcgzQjgzrDFxPDQLFtLphhCPxjqAAA';
test('labels and searches preserve local thread identity; different threads differ', () => {
  const key = gmailThreadKey(`#inbox/${threadA}`);
  assert.equal(gmailThreadKey(`#label/Work/${threadA}`), key);
  assert.equal(gmailThreadKey(`#search/team%40example.com/${threadA}`), key);
  assert.notEqual(gmailThreadKey(`#inbox/${threadB}`), key);
  assert.equal(gmailThreadKey('#inbox'), null);
  assert.equal(gmailThreadKey('#search/test'), null);
  assert.equal(gmailThreadKey('#inbox', '1a1feaad35c2b124'), 'gmail:1a1feaad35c2b124');
  assert.equal(gmailThreadKey('#inbox', null, 'thread-f:1882481198916350244'), 'gmail:1a1feaad35c2b124');
  assert.equal(gmailThreadKey('#inbox', 'invalid'), null);
});
test('discussion codes reject filters, URLs, and malformed IDs', () => {
  assert.equal(validDiscussionCode('a00b0000-0000-4000-8000-000000000001'), true);
  for (const code of ['', 'https://example.com', 'x,workspace_id=eq.123', 'a00b0000']) assert.equal(validDiscussionCode(code),false);
});
const contentSource = (await readFile(new URL('../content.js', import.meta.url), 'utf8'))
  .replace(/^import .*;\r?\n/gm, '');

function contentHarness() {
  let visible = true;
  let messageId = '1111111111111111';
  const resources = [];
  const frames = [];
  const requests = [];
  const listeners = {};
  const location = { hash: `#inbox/${threadA}`, pathname: '/mail/u/2/' };
  const classList = () => {
    const values = new Set();
    return { add: (value) => values.add(value), remove: (value) => values.delete(value), contains: (value) => values.has(value) };
  };
  const message = {
    checkVisibility: () => visible,
    getAttribute: () => messageId,
    querySelector: () => null,
    closest: () => null,
  };
  const anchor = {
    classList: classList(),
    parentElement: { classList: classList() },
    nextElementSibling: null,
    querySelector(selector) { return selector.includes('data-legacy-thread-id') ? null : message; },
    querySelectorAll() { return [message]; },
    contains() { return false; },
    matches() { return false; },
    closest() { return null; },
    checkVisibility() { return visible; },
    after(frame) { this.nextElementSibling = frame; },
  };
  const context = {
    visibleEmailContext:()=>({text:'Visible email',truncated:false}),
    EmailIdentityError, gmailThreadKey, gmailMailboxPath, gmailSessionKey, oldestMessageId, location, URL, AbortController,
    performance: { getEntriesByType: () => resources },
    requestEmailIdentity(mailbox, id, { signal, sessionKey }) {
      return new Promise((resolve, reject) => requests.push({ mailbox, id, signal, sessionKey, resolve, reject }));
    },
    requestAnimationFrame(fn) { fn(); },
    MutationObserver: class { observe() {} },
    window: { addEventListener(type, handler) { listeners[type] = handler; } },
    chrome: { runtime: { getURL: (path) => `chrome-extension://test/${path}` } },
    document: {
      body: {}, querySelector() {return null;}, querySelectorAll(selector) { return selector.startsWith('[role="main"]') ? [anchor] : []; },
      createElement() {
        const frame = { src: '', replies:[], remove() { anchor.nextElementSibling = null; } };
        frame.contentWindow = {postMessage(data,origin){frame.replies.push({data,origin});}};
        frames.push(frame);
        return frame;
      },
    },
  };
  vm.createContext(context);
  vm.runInContext(contentSource, context);
  return {
    frames, requests, location, anchor, listeners, resources,
    mount() { vm.runInContext('mountChat()', context); },
    setVisible(value) { visible = value; },
    setMessage(value) { messageId = value; },
    params() { return new URL(frames.at(-1).src).searchParams; },
  };
}

const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

test('matching starts automatically in the current mailbox and passes only the hash to the frame', async () => {
  const harness = contentHarness();
  assert.equal(harness.params().get('thread'), `gmail:${threadA}`);
  assert.equal(harness.params().get('mailbox'), '/mail/u/2/');
  assert.equal(harness.params().get('match-state'), 'pending');
  assert.equal(harness.params().has('message-key'), false);
  assert.equal(harness.requests.length, 1);
  assert.equal(harness.requests[0].mailbox, '/mail/u/2/');
  assert.equal(harness.requests[0].id, '1111111111111111');
  harness.requests[0].resolve('a'.repeat(64));
  await flush();
  assert.equal(harness.params().get('match-state'), 'ready');
  assert.equal(harness.params().get('message-key'), 'a'.repeat(64));
  assert.equal(harness.params().has('api-thread'), false);
  harness.mount();
  assert.equal(harness.requests.length, 1);
});

test('Gmail navigation clears old history and drafts, cancels stale matching, and hides chat in inbox', async () => {
  const harness = contentHarness();
  harness.location.hash = `#inbox/${threadB}`;
  harness.setMessage('2222222222222222');
  harness.listeners.hashchange();
  assert.equal(harness.requests[0].signal.aborted, true);
  assert.equal(harness.params().get('thread'), `gmail:${threadB}`);
  assert.equal(harness.params().get('match-state'), 'pending');
  harness.requests[0].resolve('a'.repeat(64));
  await flush();
  assert.equal(harness.params().has('message-key'), false);
  harness.requests[1].resolve('b'.repeat(64));
  await flush();
  assert.equal(harness.params().get('message-key'), 'b'.repeat(64));
  harness.setVisible(false);
  harness.location.hash = '#inbox';
  harness.mount();
  assert.equal(harness.anchor.nextElementSibling, null);
  harness.setVisible(true);
  harness.location.hash = `#inbox/${threadB}`;
  harness.mount();
  assert.equal(harness.frames.length, 2);
  assert.equal(harness.params().get('match-state'), 'pending');
});

test('a changed route cannot borrow the previous conversation DOM or its asynchronous result', async () => {
  const harness = contentHarness();
  // The route changes before Gmail replaces the old message elements.
  harness.location.hash = `#inbox/${threadB}`;
  harness.requests[0].resolve('a'.repeat(64));
  await flush();
  assert.equal(harness.params().has('message-key'), false);
  harness.mount();
  assert.equal(harness.requests.length, 1);
  assert.equal(harness.params().get('match-state'), 'failed');
  harness.setMessage('2222222222222222');
  harness.mount();
  assert.equal(harness.requests.length, 2);
  harness.requests[1].resolve('b'.repeat(64));
  await flush();
  assert.equal(harness.params().get('message-key'), 'b'.repeat(64));
});

test('changing signed-in accounts cancels and resolves using the new account path', async () => {
  const harness = contentHarness();
  harness.location.pathname = '/mail/u/4/';
  harness.mount();
  assert.equal(harness.requests[0].signal.aborted, true);
  assert.equal(harness.requests[1].mailbox, '/mail/u/4/');
  harness.requests[0].resolve('a'.repeat(64));
  await flush();
  assert.equal(harness.params().has('message-key'), false);
  harness.requests[1].resolve('b'.repeat(64));
  await flush();
  assert.equal(harness.params().get('mailbox'), '/mail/u/4/');
  assert.equal(harness.params().get('message-key'), 'b'.repeat(64));
});

test('failure or unavailable message/account identity cannot create a local-only chat', async () => {
  const harness = contentHarness();
  harness.requests[0].reject(new Error('Gmail unavailable'));
  await flush();
  assert.equal(harness.params().get('match-state'), 'failed');
  assert.equal(harness.params().has('message-key'), false);
  harness.mount();
  assert.equal(harness.requests.length, 1);
  harness.setMessage(null);
  harness.mount();
  assert.equal(harness.params().get('match-state'), 'failed');
  assert.equal(harness.requests.length, 1);
  harness.setMessage('2222222222222222');
  harness.location.pathname = '/mail/';
  harness.mount();
  assert.equal(harness.params().get('match-state'), 'failed');
  assert.equal(harness.params().has('mailbox'), false);
  assert.equal(harness.requests.length, 1);
});

test('a late Gmail session key recovers identification without a page reload', async () => {
  const harness = contentHarness();
  harness.requests[0].reject(new Error('Session key required'));
  await flush();
  assert.equal(harness.params().get('match-state'), 'failed');
  harness.resources.push({ name: 'https://mail.google.com/mail/u/2/?ik=abc123&view=att' });
  harness.mount();
  assert.equal(harness.requests[1].sessionKey, 'abc123');
  harness.requests[1].resolve('a'.repeat(64));
  await flush();
  assert.equal(harness.params().get('match-state'), 'ready');
  assert.equal(harness.params().has('ik'), false);
  assert.equal(harness.params().has('sessionKey'), false);
});

test('a failed email match reports a safe reason and retries only from its own chat frame', async () => {
  const harness = contentHarness();
  harness.requests[0].reject(new EmailIdentityError('Gmail returned HTTP 403'));
  await flush();
  assert.equal(harness.params().get('match-error'), 'Gmail returned HTTP 403');
  const retry = { data: { type: 'threadly-retry-match' }, source: {} };
  harness.listeners.message(retry);
  assert.equal(harness.requests.length, 1);
  retry.source = harness.frames[0].contentWindow;
  harness.listeners.message(retry);
  assert.equal(harness.params().get('match-state'), 'pending');
  assert.equal(harness.params().has('match-error'), false);
  harness.listeners.message(retry);
  assert.equal(harness.requests.length, 2);
  harness.requests[1].resolve('b'.repeat(64));
  await flush();
  assert.equal(harness.params().get('match-state'), 'ready');
  assert.equal(harness.params().get('message-key'), 'b'.repeat(64));
});

test('untrusted transport errors never leak request URLs or session keys into the frame', async () => {
  const harness = contentHarness();
  harness.requests[0].reject(new Error('https://mail.google.com/mail/u/2/?ik=SECRET'));
  await flush();
  assert.match(harness.params().get('match-error'), /request failed/);
  assert.equal(harness.frames[0].src.includes('SECRET'), false);
});


test('email context bridge accepts only its own extension frame for the current thread', async () => {
  const h=contentHarness();h.requests[0].resolve('a'.repeat(64));await flush();
  const frame=h.frames[0];
  const data={type:'threadly-email-context-request',requestId:'one',threadKey:`gmail:${threadA}`};
  const send=(source,origin,body=data)=>h.listeners.message({source,origin,data:body});
  send({},'chrome-extension://test');
  send(frame.contentWindow,'https://evil.example');
  send(frame.contentWindow,'chrome-extension://test',{...data,threadKey:`gmail:${threadB}`});
  assert.equal(frame.replies.length,0);
  send(frame.contentWindow,'chrome-extension://test');
  assert.equal(frame.replies.length,1);
  assert.equal(frame.replies[0].data.text,'Visible email');
  assert.equal(frame.replies[0].origin,'chrome-extension://test');
  h.location.hash=`#inbox/${threadB}`;
  send(frame.contentWindow,'chrome-extension://test');
  assert.equal(frame.replies.length,1);
});

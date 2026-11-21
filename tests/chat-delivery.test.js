import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

// Execute the chat controller with isolated DOM and transport boundaries.
async function controller(key = 'a'.repeat(64), localKey = 'gmail:local', reason = '') {
  const elements = new Map();
  function element() {
    return {
      value: '', hidden: false, children: [], handlers: {}, scrollHeight: 0, scrollTop: 0, clientHeight: 100,
      classList: { toggle() {}, add() {} },
      addEventListener(type, handler) { this.handlers[type] = handler; },
      append(...children) { this.children.push(...children); },
      replaceChildren(...children) { this.children = children; },
      getBoundingClientRect() { return { height: 100 }; },
      querySelector() { return this.button ??= element(); },
    };
  }
  const document = {
    hidden: false, body: element(), addEventListener() {}, createElement: element,
    querySelector(selector) {
      if (!elements.has(selector)) elements.set(selector, element());
      return elements.get(selector);
    },
  };
  const state = { rows: [], calls: [], reads: [], posted: [] };
  const supabase = {
    removeChannel() {},
    channel() {
      const channel = { on() { return channel; }, subscribe() { return channel; } };
      return channel;
    },
    from(table) {
      const filters = [];
      let ascending = true;
      const query = {
        select() { return query; },
        eq(field, value) { filters.push((row) => row[field] === value); return query; },
        in() { return query; },
        not() { return query; },
        range() { return query; },
        gt(field, value) { filters.push((row) => row[field] > value); state.reads.push(value); return query; },
        order(field, options = {}) { ascending = options.ascending !== false; return query; },
        async limit(size) {
          return { data: state.rows.filter((row) => filters.every((f) => f(row)))
            .sort((a, b) => ascending ? a.id - b.id : b.id - a.id).slice(0, size) };
        },
        then(resolve, reject) {
          return Promise.resolve({ data: [] }).then(resolve, reject);
        },
      };
      return query;
    },
  };
  const context = vm.createContext({
    document, URL, location: { href: `https://example.com/chat.html?thread=${localKey}&message-key=${key}&match-state=failed&match-error=${encodeURIComponent(reason)}` },
    parent: { postMessage(data, origin) { state.posted.push({ data, origin }); } }, window: { addEventListener() {} },
    ResizeObserver: class { observe() {} }, IntersectionObserver: class { observe() {} },
    setInterval() {}, supabase,
    crypto: webcrypto, localStorage: { setItem() {} },
    Option: class { constructor(text, value) { this.text = text; this.value = value; } },
    profileDetails: () => ({ name: 'Me', avatar: '' }),
    fetchWorkspaces: async () => [{ id: 'team', name: 'Team' }],
    preferredWorkspace: () => 'team',
    watchAccount() {}, mountMentions: () => () => {},
    mountAssistant: () => ({reset() {}, update() {}}),
    rpc: async (name, args) => {
      state.calls.push({ name, args });
      return 'shared';
    },
    avatarElement: element, reactionControls: element,
    mentionToken: /@\{([a-f0-9-]+)\}/g,
    localDay: (date) => date.toISOString().slice(0, 10), dayLabel: () => 'Today', timeLabel: () => '12:00',
  });
  const source = (await readFile(new URL('../chat.js', import.meta.url), 'utf8')).replace(/^import .*;\n/gm, '');
  vm.runInContext(`${source}\nglobalThis.controller = { messageRows, catchUpMessages, receiveMessage, automaticDiscussion, refreshWorkspaces, activate(chat) { activeChat = chat; currentUser = {id: 'me'}; } };`, context);
  return { ...context.controller, state, elements };
}

function messageText(element) {
  if (element.className === 'message-body') return element.children.join('');
  return (element.children ?? []).map((child) => typeof child === 'object' ? messageText(child) : '').join('');
}

const message = (id) => ({
  id, workspace_id: 'team', discussion_id: 'discussion', author_id: 'teammate', author_name: 'Teammate',
  body: `Reply ${id}`, created_at: '2026-11-21T12:00:00Z',
});
const chat = () => ({
  workspaceId: 'team', discussionId: 'discussion', messages: new Map([[1, message(1)]]),
  loaded: true, catchUpThrough: 1, members: new Map(), olderThan: 1,
});

test('missed teammate replies recover across pages even after a newer realtime reply arrives', async () => {
  const app = await controller();
  const current = chat();
  app.activate(current);
  app.state.rows = Array.from({ length: 252 }, (_, i) => message(i + 2));
  app.state.rows.push({ ...message(254), discussion_id: 'other-discussion' });
  app.receiveMessage(current, 253, message(253));
  await app.catchUpMessages(current);
  assert.equal(current.messages.size, 253);
  assert.deepEqual(app.state.reads, [1, 101, 201]);
  assert.equal(current.messages.get(2).body, 'Reply 2');
  assert.equal(current.messages.has(254), false);
  assert.equal(current.olderThan, 1); // Previously loaded history remains pageable.
  const rendered = app.elements.get('#messages').children;
  assert.equal(messageText(rendered[2]), 'Reply 2');
});

test('catch-up does not apply an old discussion response after switching discussions', async () => {
  const app = await controller();
  const previous = chat();
  app.state.rows = [message(2)];
  app.activate(previous);
  const pending = app.catchUpMessages(previous);
  const next = chat();
  app.activate(next);
  await pending;
  assert.equal(previous.messages.has(2), false);
  assert.equal(next.messages.has(2), false);
});

test('different mailbox copies automatically open the shared history without connecting or linking', async () => {
  for (const localKey of ['gmail:owner-copy', 'gmail:member-copy']) {
    const app = await controller('a'.repeat(64), localKey);
    app.state.rows = [{ ...message(2), discussion_id: 'shared' }];
    app.activate(chat());
    await app.refreshWorkspaces();
    await new Promise(setImmediate);
    assert.equal(app.elements.get('#conversation').hidden, false);
    const rendered = app.elements.get('#messages').children;
    assert.equal(messageText(rendered[1]), 'Reply 2');
    assert.equal(app.elements.get('#chat-description').textContent, 'Private discussion · Team');
  }
});

test('missing email identity never creates a disconnected local discussion', async () => {
  const app = await controller('');
  app.activate(chat());
  await app.refreshWorkspaces();
  assert.equal(app.state.calls.length, 0);
  assert.equal(app.elements.get('#conversation').hidden, true);
  assert.match(app.elements.get('#workspace-status').textContent, /Could not identify this email/);
});

test('failed identification shows its reason and allows retry without creating a disconnected chat', async () => {
  const app = await controller('', 'gmail:local', 'Gmail returned HTTP 403');
  app.activate(chat());
  await app.refreshWorkspaces();
  assert.match(app.elements.get('#workspace-status').textContent, /Gmail returned HTTP 403/);
  const retry = app.elements.get('#retry-match');
  assert.equal(retry.hidden, false);
  retry.handlers.click();
  assert.equal(app.state.posted.at(-1).data.type, 'threadly-retry-match');
  assert.equal(app.state.posted.at(-1).origin, 'https://mail.google.com');
  assert.equal(app.state.calls.length, 0);
});

test('consecutive senders group names, but sender changes and day boundaries restart the group', async () => {
  const app = await controller();
  const current = { ...chat(), userId: 'me', profile: { name: 'Me', avatar: '' } };
  const rows = app.messageRows([
    message(1), message(2),
    { ...message(3), author_id: 'me' },
    message(4),
    { ...message(5), created_at: '2026-11-22T12:00:00Z' },
  ], current).filter((row) => row.className !== 'date-divider');
  assert.deepEqual(Array.from(rows, (row) => row.className), [
    'message', 'message message-continuation', 'message message-own', 'message', 'message',
  ]);
});

test('Enter sends unless composing, adding a newline, or accepting a mention', async () => {
  const app = await controller();
  const input = app.elements.get('#message-input');
  const form = app.elements.get('#compose');
  let submits = 0;
  form.requestSubmit = () => { submits++; };
  const key = (options = {}) => {
    const event = { key: 'Enter', preventDefault() { this.defaultPrevented = true; }, ...options };
    input.handlers.keydown(event);
    return event;
  };
  assert.equal(key().defaultPrevented, true);
  assert.equal(submits, 1);
  key({ shiftKey: true });
  key({ isComposing: true });
  key({ defaultPrevented: true });
  assert.equal(submits, 1);
});

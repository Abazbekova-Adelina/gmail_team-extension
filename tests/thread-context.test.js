import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { gmailThreadKey, validDiscussionCode } from '../thread-context.js';

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
test('Gmail navigation clears old frame history and drafts and hides chat in inbox', async () => {
  let visible = true;
  const frames = [];
  const location = {hash:`#inbox/${threadA}`};
  const anchor = {
    nextElementSibling: null,
    querySelector() { return {closest() {return null;}, getAttribute() {return null;}}; },
    contains() {return false;},
    matches() {return false;},
    checkVisibility() {return visible;},
    after(frame) {this.nextElementSibling = frame;},
  };
  const context = {
    gmailThreadKey, location, URL,
    requestAnimationFrame(fn) {fn();},
    MutationObserver: class {observe(){}},
    window: {addEventListener(){}},
    chrome: {runtime:{getURL:(path) => `chrome-extension://test/${path}`, onMessage:{addListener(){}}}},
    document: {
      body:{}, querySelectorAll() {return [anchor];},
      createElement() {
        const frame = {src:'', remove(){anchor.nextElementSibling=null;}};
        frames.push(frame);
        return frame;
      },
    },
  };
  vm.createContext(context);
  const source = (await readFile(new URL('../content.js', import.meta.url),'utf8')).replace(/^import .*;\r?\n/, '');
  vm.runInContext(source,context);
  const first = frames[0];
  assert.equal(new URL(first.src).searchParams.get('thread'), `gmail:${threadA}`);
  location.hash = `#inbox/${threadB}`;
  vm.runInContext('mountChat()',context);
  assert.equal(new URL(first.src).searchParams.get('thread'), `gmail:${threadB}`);
  visible = false;
  vm.runInContext('mountChat()',context);
  assert.equal(anchor.nextElementSibling,null);
  visible = true;
  vm.runInContext('mountChat()',context);
  assert.equal(frames.length,2);
});

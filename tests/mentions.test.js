import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encodeMentions, mentionQuery } from '../mentions.js';

test('inline mentions match teammate names without changing email addresses or ambiguous names', () => {
  const members = new Map([
    ['author', 'Egor Kh'],
    ['one', 'Adelina Albert'],
    ['two', 'Alex One'],
    ['three', 'Alex Two'],
    ['four', 'Zoë (QA)'],
  ]);
  const text = 'Hi @adelina, @Alex and @Alex Two. @Zoë (QA), email me at contact@Adelina.org. @Egor';
  assert.equal(encodeMentions(text, members, 'author'),
    'Hi @{one}, @Alex and @{three}. @{four}, email me at contact@Adelina.org. @Egor');
});

test('mention suggestions follow the cursor and ignore email addresses', () => {
  assert.deepEqual(mentionQuery('Hi @Ade tail', 7), { start: 3, query: 'ade' });
  assert.deepEqual(mentionQuery('@', 1), { start: 0, query: '' });
  assert.equal(mentionQuery('team@exam', 9), null);
});

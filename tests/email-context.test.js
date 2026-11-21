import {test} from 'node:test';
import assert from 'node:assert/strict';
import {visibleEmailContext,MAX_EMAIL_CONTEXT} from '../email-context.js';
test('email preview excludes hidden bodies and limits what may be sent to Gemini',()=>{
  const root={querySelectorAll:()=>[
    {checkVisibility:()=>false,innerText:'hidden secret'},
    {checkVisibility:()=>true,innerText:'Visible email text'},
    {checkVisibility:()=>true,innerText:'x'.repeat(30000)},
  ]};
  const context=visibleEmailContext(root,'Subject');
  assert.ok(!context.text.includes('hidden secret'));
  assert.ok(context.text.startsWith('Subject: Subject\n\nVisible email text'));
  assert.ok(context.text.length<=MAX_EMAIL_CONTEXT);
  assert.equal(context.truncated,true);
});

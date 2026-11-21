import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mountAssistant} from '../assistant.js';
function element() {
  return {value:'',textContent:'',checked:false,hidden:true,disabled:false,children:[],handlers:{},
    classList:{toggle(){}},setAttribute(){},focus(){},select(){},
    addEventListener(name,fn){this.handlers[name]=fn;},replaceChildren(...items){this.children=items;}};
}
const result={summary:'Summary',decisions:[],open_questions:[],reply:'Hello, Monday works.',message_count:2,generated_through:2,email_included:false};
function setup(invoke) {
  const nodes=new Map();
  globalThis.document={querySelector(s){if(!nodes.has(s))nodes.set(s,element());return nodes.get(s);},createElement:element};
  let chat={workspaceId:'team',discussionId:'thread',messages:new Map([[2,{}]])};
  let calls=0;
  const api=mountAssistant({supabase:{functions:{invoke:async(...args)=>{calls++;return invoke(...args);}}},getChat:()=>chat,gmailKey:'gmail:one'});
  document.querySelector('#assistant-tone').value='professional';
  const node=(s)=>document.querySelector(s);
  return {api,node,getChat:()=>chat,setChat(value){chat=value;},calls:()=>calls,submit:()=>node('#assistant-form').handlers.submit({preventDefault(){}})};
}
test('summary is rendered as text, reply stays editable, and new messages mark it stale',async()=>{
  const app=setup(async()=>({data:{...result,summary:'<img src=x onerror=alert(1)>'}}));
  await app.submit();
  assert.equal(app.node('#assistant-summary').textContent,'<img src=x onerror=alert(1)>');
  assert.equal(app.node('#assistant-reply').value,result.reply);
  app.getChat().messages.set(3,{});
  app.api.update(app.getChat());
  assert.equal(app.node('#assistant-stale').hidden,false);
  assert.equal(app.node('#assistant-result').hidden,false);
  app.api.reset();
  assert.equal(app.node('#assistant-result').hidden,true);
  assert.equal(app.node('#assistant-reply').value,'');
});
test('switching discussions discards a late result and clears email context',async()=>{
  let finish;
  const app=setup(()=>new Promise(resolve=>{finish=resolve;}));
  const pending=app.submit();
  app.node('#assistant-email').value='private email';
  app.setChat({workspaceId:'other',discussionId:'other',messages:new Map()});
  app.api.reset();
  finish({data:result});await pending;
  assert.equal(app.node('#assistant-result').hidden,true);
  assert.equal(app.node('#assistant-email').value,'');
  assert.equal(app.node('#assistant-summary').textContent,'');
});
test('failed regeneration preserves the edited draft and prevents double generation',async()=>{
  let fail=false;
  const app=setup(async()=>fail?{error:{context:Response.json({error:'Try again later.'})}}:{data:result});
  await app.submit();app.node('#assistant-reply').value='My edited reply';fail=true;
  const pending=app.submit();await app.submit();await pending;
  assert.equal(app.calls(),2);
  assert.equal(app.node('#assistant-reply').value,'My edited reply');
  assert.equal(app.node('#assistant-status').textContent,'Try again later.');
});
test('checked email inclusion requires nonempty reviewed text',async()=>{
  const app=setup(async()=>({data:result}));
  app.node('#assistant-include-email').checked=true;
  await app.submit();assert.equal(app.calls(),0);
});

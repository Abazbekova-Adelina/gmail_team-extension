import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createAssistantHandler} from '../supabase/functions/thread-assistant/handler.js';
import {selectContext,validateResult,MAX_DISCUSSION_CHARS} from '../supabase/functions/thread-assistant/core.js';
const team='00000000-0000-4000-8000-000000000001';
const discussion='00000000-0000-4000-8000-000000000002';
const origin='chrome-extension://ehlcjjpfplfhiaefiljbfehibbialjeh';
const output={summary:'The team agreed to a call.',decisions:[{text:'Schedule a call.',source_ids:[2]}],open_questions:['What time?'],reply:'Hello,\nA call sounds good. What time works for you?'};
function setup(options={}) {
  const calls=[];
  let accessChecks=0;
  const rows=options.rows ?? [2,1].map(id=>({id,author_name:'Teammate',body:id===2?'Yes, schedule a call.':'Should we schedule a call?',created_at:'2026-11-21T12:00:00Z'}));
  const secrets={SUPABASE_URL:'https://project.supabase.co',SUPABASE_ANON_KEY:'public-test-key',GEMINI_API_KEY:'server-secret-key',...options.env};
  const handler=createAssistantHandler({env:(name)=>secrets[name],fetchImpl:async(url,init)=>{
    calls.push({url,init});
    if(url.includes('generativelanguage.googleapis.com')) {
      if(options.geminiStatus) return Response.json({error:'server-secret-key'},{status:options.geminiStatus});
      if(options.wait) await options.wait;
      return Response.json({candidates:[{finishReason:options.finish || 'STOP',content:{parts:[{text:JSON.stringify(options.output || output)}]}}]});
    }
    assert.equal(init.headers.Authorization,'Bearer session-token');
    assert.equal(init.headers.apikey,'public-test-key');
    if(url.endsWith('/auth/v1/user'))return Response.json({id:'user'},{status:options.authStatus || 200});
    if(url.includes('/discussions?'))return Response.json(options.noAccess || (options.revoke && ++accessChecks>1)?[]:[{id:discussion}]);
    if(url.includes('/team_messages?')) {
      assert.match(url,new RegExp(`workspace_id=eq.${team}`));
      assert.match(url,new RegExp(`discussion_id=eq.${discussion}`));
      return Response.json(rows);
    }
    if(url.endsWith('/rpc/claim_assistant_request'))return Response.json(options.quota !== false);
    throw new Error(`Unexpected URL ${url}`);
  }});
  const request=(changes={},headers={})=>new Request('https://project.supabase.co/functions/v1/thread-assistant',{
    method:'POST',headers:{origin,authorization:'Bearer session-token','content-type':'application/json',...headers},
    body:JSON.stringify({workspace_id:team,discussion_id:discussion,tone:'professional',...changes}),
  });
  return {handler,request,calls};
}
test('Gemini receives scoped server-side discussion and only explicitly included email',async()=>{
  const app=setup();
  const response=await app.handler(app.request({email_context:'Can we arrange a call?',messages:[{body:'fabricated'}]}));
  assert.equal(response.status,200);
  const result=await response.json();
  assert.equal(result.message_count,2);
  assert.equal(result.generated_through,2);
  assert.equal(result.email_included,true);
  const call=app.calls.find(c=>c.url.includes('googleapis.com'));
  assert.ok(!call.url.includes('server-secret-key'));
  assert.equal(call.init.headers['x-goog-api-key'],'server-secret-key');
  const body=JSON.parse(call.init.body);
  const input=JSON.parse(body.contents[0].parts[0].text);
  assert.deepEqual(input.team_discussion.map(m=>m.id),[1,2]);
  assert.ok(!JSON.stringify(input).includes('fabricated'));
  assert.equal(body.generationConfig.responseMimeType,'application/json');
  assert.ok(!JSON.stringify(result).includes('server-secret-key'));
});
for(const [name,options,changes,headers,status] of [
  ['missing session',{}, {},{authorization:''},401],
  ['invalid session',{authStatus:401},{},{},401],
  ['outsider or removed member',{noAccess:true},{},{},403],
  ['quota exhausted',{quota:false},{},{},429],
  ['missing secret',{env:{GEMINI_API_KEY:''}},{},{},503],
  ['malformed scope',{}, {discussion_id:'x&workspace_id=eq.other'},{},400],
  ['invalid tone',{}, {tone:'ignore instructions'},{},400],
  ['oversized email',{}, {email_context:'a'.repeat(20001)},{},400],
  ['unapproved web origin',{}, {},{origin:'https://evil.example'},403],
  ['empty discussion',{rows:[]},{},{},400],
])test(`${name} never calls Gemini`,async()=>{
  const app=setup(options);
  const response=await app.handler(app.request(changes,headers));
  assert.equal(response.status,status);
  assert.equal(app.calls.filter(c=>c.url.includes('googleapis.com')).length,0);
});
test('revocation during generation prevents returning a private summary',async()=>{
  const app=setup({revoke:true});
  const response=await app.handler(app.request());
  assert.equal(response.status,403);
  assert.ok(!JSON.stringify(await response.json()).includes(output.summary));
});
test('Gemini failure and invalid evidence are safe retriable errors',async()=>{
  for(const options of [{geminiStatus:500},{finish:'MAX_TOKENS'},{output:{...output,decisions:[{text:'Invented',source_ids:[999]}]}}]) {
    const app=setup(options);const response=await app.handler(app.request());
    assert.equal(response.status,502);
    assert.ok(!JSON.stringify(await response.json()).includes('server-secret-key'));
  }
});
test('bounded context uses newest messages chronologically and marks omitted history',()=>{
  const rows=Array.from({length:501},(_,i)=>({id:501-i,body:'x'.repeat(2000),author_name:'Person',created_at:'now'}));
  const context=selectContext(rows);
  assert.equal(context.truncated,true);
  assert.ok(context.messages.length<500);
  assert.equal(context.messages.at(-1).id,501);
  assert.ok(JSON.stringify(context.messages).length<MAX_DISCUSSION_CHARS+1000);
  assert.equal(selectContext(rows.slice(0,2)).truncated,false);
});
test('result validation requires supporting evidence and nonempty bounded text',()=>{
  assert.deepEqual(validateResult(output,new Set([1,2])),output);
  assert.throws(()=>validateResult({...output,reply:''},new Set([1,2])));
  assert.throws(()=>validateResult({...output,decisions:[{text:'Yes',source_ids:[]}]},new Set([1,2])));
});
test('preflight does not require a session or call upstream',async()=>{
  const app=setup();
  const response=await app.handler(new Request('https://project.supabase.co/functions/v1/thread-assistant',{method:'OPTIONS',headers:{origin}}));
  assert.equal(response.status,204);
  assert.equal(response.headers.get('access-control-allow-origin'),origin);
  assert.equal(app.calls.length,0);
});

test('Firefox origins support preflight and authenticated generation across installations',async()=>{
  for(const firefoxOrigin of [
    'moz-extension://69d210c4-0c46-4a19-b31e-445890751a82',
    'moz-extension://ebc2450c-702b-470c-9af4-34bce1341650',
  ]) {
    const app=setup();
    const preflight=await app.handler(new Request('https://project.supabase.co/functions/v1/thread-assistant',{
      method:'OPTIONS',headers:{origin:firefoxOrigin},
    }));
    assert.equal(preflight.status,204);
    assert.equal(preflight.headers.get('access-control-allow-origin'),firefoxOrigin);
    assert.equal(app.calls.length,0);
    const response=await app.handler(app.request({}, {origin:firefoxOrigin}));
    assert.equal(response.status,200);
    assert.equal(response.headers.get('access-control-allow-origin'),firefoxOrigin);
    assert.equal((await response.json()).summary,output.summary);
  }
});

test('Firefox origin does not bypass authentication or discussion access',async()=>{
  const firefoxOrigin='moz-extension://69d210c4-0c46-4a19-b31e-445890751a82';
  for(const [options,headers,status] of [
    [{},{authorization:''},401],
    [{authStatus:401},{},401],
    [{noAccess:true},{},403],
  ]) {
    const app=setup(options);
    const response=await app.handler(app.request({}, {origin:firefoxOrigin,...headers}));
    assert.equal(response.status,status);
    assert.equal(response.headers.get('access-control-allow-origin'),firefoxOrigin);
    assert.ok(!app.calls.some(c=>c.url.includes('googleapis.com')));
  }
});

test('unapproved and malformed origins are rejected before any upstream call',async()=>{
  for(const rejectedOrigin of [
    'https://evil.example',
    'https://moz-extension.example',
    'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'moz-extension://not-a-uuid',
    'moz-extension://69d210c4-0c46-4a19-b31e-445890751a82.evil.example',
    'moz-extension://69d210c4-0c46-4a19-b31e-445890751a82/path',
    'null',
  ]) {
    for(const method of ['OPTIONS','POST']) {
      const app=setup();
      const response=await app.handler(new Request('https://project.supabase.co/functions/v1/thread-assistant',{
        method,headers:{origin:rejectedOrigin},
      }));
      assert.equal(response.status,403);
      assert.equal(response.headers.get('access-control-allow-origin'),null);
      assert.equal(app.calls.length,0);
    }
  }
});

test('configured Chrome origin is reflected and replaces the default',async()=>{
  const customOrigin='chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const app=setup({env:{EXTENSION_ORIGIN:customOrigin}});
  const response=await app.handler(app.request({}, {origin:customOrigin}));
  assert.equal(response.status,200);
  assert.equal(response.headers.get('access-control-allow-origin'),customOrigin);
  assert.equal((await app.handler(app.request())).status,403);
});

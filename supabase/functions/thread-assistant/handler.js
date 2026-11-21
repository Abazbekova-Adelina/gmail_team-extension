import { UUID, MAX_MESSAGES, MAX_EMAIL_CHARS, DEFAULT_MODEL, RESULT_SCHEMA, SYSTEM_PROMPT, selectContext, validateResult } from './core.js';

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
async function boundedText(body, max) {
  if (!body) return '';
  const reader = body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const {value, done} = await reader.read();
      if (done) break;
      size += value.length;
      if (size > max) throw new HttpError(413, 'Request is too large. Shorten the email context.');
      chunks.push(value);
    }
  } finally { await reader.cancel(); reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder().decode(bytes);
}
export function createAssistantHandler({ env, fetchImpl = fetch }) {
  return async (request) => {
    const allowedOrigin = env('EXTENSION_ORIGIN') || 'chrome-extension://ehlcjjpfplfhiaefiljbfehibbialjeh';
    const origin = request.headers.get('origin');
    // Firefox assigns a different extension UUID per installation.
    // Origin checks are not authorization: every POST still verifies the caller JWT and RLS.
    const originAllowed = !origin || origin === allowedOrigin
      || /^moz-extension:\/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(origin);
    const headers = {
      'Content-Type': 'application/json', 'Cache-Control': 'no-store', Vary: 'Origin',
      ...(originAllowed ? {'Access-Control-Allow-Origin': origin || allowedOrigin} : {}),
      'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
    };
    const reply = (status, body) => new Response(JSON.stringify(body), {status, headers});
    if (!originAllowed) return reply(403, {error:'This origin is not allowed.'});
    if (request.method === 'OPTIONS') return new Response(null, {status:204, headers});
    if (request.method !== 'POST') return reply(405, {error:'Use POST.'});
    try {
      const authorization = request.headers.get('authorization');
      if (!/^Bearer [^\s]+$/.test(authorization || '')) throw new HttpError(401, 'Sign in to Threadly first.');
      const project = env('SUPABASE_URL');
      let publicKeys = {};
      try { publicKeys = JSON.parse(env('SUPABASE_PUBLISHABLE_KEYS') || '{}'); } catch {}
      const publicKey = env('THREADLY_PUBLISHABLE_KEY')
        || Object.values(publicKeys).find((key) => typeof key === 'string' && key.startsWith('sb_publishable_'))
        || env('SUPABASE_ANON_KEY');
      const geminiKey = env('GEMINI_API_KEY');
      const model = env('GEMINI_MODEL') || DEFAULT_MODEL;
      if (!project || !publicKey || !geminiKey || !/^[a-z0-9.-]+$/.test(model)) {
        throw new HttpError(503, 'The assistant is not configured yet. Ask the app owner to finish Gemini setup.');
      }
      const dbHeaders = { apikey:publicKey, Authorization:authorization };
      const call = async (path, options = {}) => {
        return fetchImpl(`${project}${path}`, { ...options, headers:{...dbHeaders,...options.headers}, signal:AbortSignal.timeout(10000) });
      };
      const auth = await call('/auth/v1/user');
      if (!auth.ok || !(await auth.json())?.id) throw new HttpError(401, 'Your session expired. Sign in again.');
      let input;
      try { input = JSON.parse(await boundedText(request.body, 100000)); }
      catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(400,'Invalid request.'); }
      if (!input || !UUID.test(input.discussion_id ?? '') || !UUID.test(input.workspace_id ?? '')
          || (input.email_context !== undefined && (typeof input.email_context !== 'string' || input.email_context.length > MAX_EMAIL_CHARS))
          || !['professional','friendly','concise'].includes(input.tone ?? 'professional')) {
        throw new HttpError(400,'Choose a valid discussion and reply tone. Email context must be under 20,000 characters.');
      }
      const discussionId = input.discussion_id;
      const workspaceId = input.workspace_id;
      // All database reads use the caller JWT and public key: RLS remains active.
      const discussion = await call(`/rest/v1/discussions?id=eq.${discussionId}&workspace_id=eq.${workspaceId}&select=id&limit=1`);
      if (!discussion.ok) throw new HttpError(503,'Could not verify discussion access. Try again.');
      if (!(await discussion.json()).length) throw new HttpError(403,'You no longer have access to this discussion.');
      const response = await call(`/rest/v1/team_messages?discussion_id=eq.${discussionId}&workspace_id=eq.${workspaceId}&select=id,author_name,body,created_at&order=id.desc&limit=${MAX_MESSAGES+1}`);
      if (!response.ok) throw new HttpError(503,'Could not load the team discussion. Try again.');
      const rows = await response.json();
      if (!rows.length) throw new HttpError(400,'Add some team discussion messages before generating a summary.');
      const context = selectContext(rows);
      const quota = await call('/rest/v1/rpc/claim_assistant_request', {
        method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({p_discussion_id:discussionId}),
      });
      if (!quota.ok) throw new HttpError(503,'The assistant needs its database migration or your membership changed. Refresh and try again.');
      if (await quota.json() !== true) throw new HttpError(429,'You have reached 20 assistant requests this hour. Try again later.');
      const email = input.email_context?.trim() || '';
      const generated = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method:'POST', headers:{'Content-Type':'application/json','x-goog-api-key':geminiKey},
        signal:AbortSignal.timeout(45000),
        body:JSON.stringify({
          systemInstruction:{parts:[{text:SYSTEM_PROMPT}]},
          contents:[{role:'user',parts:[{text:JSON.stringify({team_discussion:context.messages,history_truncated:context.truncated,email_context:email || null,tone:input.tone || 'professional'})}]}],
          generationConfig:{responseMimeType:'application/json',responseJsonSchema:RESULT_SCHEMA,maxOutputTokens:8192},
        }),
      });
      if (!generated.ok) {
        // Never forward upstream error bodies, which may contain request details.
        throw new HttpError(generated.status === 429 ? 429 : 502, generated.status === 429
          ? 'Gemini is at its usage limit. Try again later.' : 'Gemini could not generate a reply. Try again.');
      }
      let result;
      try {
        const payload = JSON.parse(await boundedText(generated.body, 200000));
        const candidate = payload.candidates?.[0];
        if (candidate?.finishReason !== 'STOP') throw new Error('Incomplete or blocked response');
        const text = candidate.content?.parts?.filter((p) => !p.thought && typeof p.text === 'string').map((p) => p.text).join('');
        result = validateResult(JSON.parse(text), new Set(context.messages.map((m) => m.id)));
      } catch { throw new HttpError(502,'Gemini returned an incomplete response. Try again.'); }
      // Do not return newly-generated private context to someone removed mid-call.
      const recheck = await call(`/rest/v1/discussions?id=eq.${discussionId}&workspace_id=eq.${workspaceId}&select=id&limit=1`);
      if (!recheck.ok || !(await recheck.json()).length) throw new HttpError(403,'Your access to this discussion changed.');
      return reply(200,{...result, model, message_count:context.messages.length,
        truncated:context.truncated, generated_through:rows[0].id, email_included:Boolean(email)});
    } catch (error) {
      if (error instanceof HttpError) return reply(error.status,{error:error.message});
      if (['TimeoutError','AbortError'].includes(error?.name)) return reply(504,{error:'The assistant timed out. Try again.'});
      return reply(500,{error:'The assistant could not finish. Try again.'});
    }
  };
}

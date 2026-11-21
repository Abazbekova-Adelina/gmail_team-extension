export const MAX_EMAIL_CONTEXT = 20000;

// Read only the rendered messages on explicit user request. No attachments,
// hidden collapsed messages, mail API requests, or background uploads.
export function visibleEmailContext(anchor, subject = '') {
  const sections = [];
  if (subject) sections.push(`Subject: ${subject.slice(0, 500)}`);
  let length = sections.join('\n\n').length;
  let truncated = false;
  for (const body of anchor.querySelectorAll('.a3s')) {
    if (!body.checkVisibility()) continue;
    const text = body.innerText.trim();
    if (!text) continue;
    const available = MAX_EMAIL_CONTEXT - length - 2;
    if (available <= 0) { truncated = true; break; }
    sections.push(text.slice(0, available));
    length += Math.min(text.length, available) + 2;
    if (text.length > available) { truncated = true; break; }
  }
  return { text: sections.join('\n\n'), truncated };
}

export function requestEmailContext(threadKey, { signal } = {}) {
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    const cleanup = () => {
      clearTimeout(timer);
      window.removeEventListener('message', receive);
      signal?.removeEventListener('abort', abort);
    };
    const abort = () => { cleanup(); reject(new DOMException('Cancelled', 'AbortError')); };
    const receive = (event) => {
      if (event.source !== parent || event.origin !== 'https://mail.google.com'
          || event.data?.type !== 'threadly-email-context-result' || event.data.requestId !== requestId) return;
      cleanup();
      if (event.data.threadKey !== threadKey || typeof event.data.text !== 'string' || event.data.text.length > MAX_EMAIL_CONTEXT) {
        reject(new Error('The email changed. Reopen the assistant.'));
      } else if (event.data.error) reject(new Error('Email text is unavailable. Paste the relevant text instead.'));
      else resolve({text:event.data.text, truncated:Boolean(event.data.truncated)});
    };
    const timer = setTimeout(() => { cleanup(); reject(new Error('Could not read the email. Paste the relevant text instead.')); }, 5000);
    window.addEventListener('message', receive);
    signal?.addEventListener('abort', abort, {once:true});
    if (signal?.aborted) { abort(); return; }
    parent.postMessage({type:'threadly-email-context-request',requestId,threadKey},'https://mail.google.com');
  });
}

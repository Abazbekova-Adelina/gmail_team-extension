import { requestEmailContext } from './email-context.js';

export function mountAssistant({supabase, getChat, gmailKey}) {
  const conversation = document.querySelector('#conversation');
  const toggle = document.querySelector('#assistant-toggle');
  const panel = document.querySelector('#assistant-panel');
  const form = document.querySelector('#assistant-form');
  const generate = document.querySelector('#assistant-generate');
  const status = document.querySelector('#assistant-status');
  const includeEmail = document.querySelector('#assistant-include-email');
  const email = document.querySelector('#assistant-email');
  const emailFields = document.querySelector('#assistant-email-fields');
  const emailStatus = document.querySelector('#assistant-email-status');
  const result = document.querySelector('#assistant-result');
  const draft = document.querySelector('#assistant-reply');
  const copy = document.querySelector('#assistant-copy');
  const stale = document.querySelector('#assistant-stale');
  let controller;
  let emailController;
  let version = 0;
  let resultChat;
  let resultThrough = 0;
  let emailLoading = false;
  const setOpen = (open) => {
    panel.hidden = !open;
    conversation.classList.toggle('assistant-open', open);
    toggle.setAttribute('aria-expanded',String(open));
    toggle.textContent = open ? 'Back to discussion' : 'Gemini assistant';
  };
  toggle.addEventListener('click', () => setOpen(panel.hidden));
  includeEmail.addEventListener('change', async () => {
    emailController?.abort();
    emailFields.hidden = !includeEmail.checked;
    emailStatus.textContent = '';
    email.value = '';
    emailLoading = false;
    if (!includeEmail.checked) return;
    const current = emailController = new AbortController();
    const chat = getChat();
    emailLoading = true;
    emailStatus.textContent = 'Reading the visible email…';
    try {
      const context = await requestEmailContext(gmailKey,{signal:current.signal});
      if (current !== emailController || chat !== getChat()) return;
      email.value = context.text;
      emailStatus.textContent = context.truncated
        ? 'Long email shortened. Review the text below before generating.'
        : 'Review or edit the email text before generating. Collapsed messages and attachments are excluded.';
    } catch (error) {
      if (!current.signal.aborted) emailStatus.textContent = error.message;
    } finally { if (current === emailController) emailLoading = false; }
  });
  const list = (selector, values, empty) => {
    const items = values.map((text) => {
      const item = document.createElement('li'); item.textContent = text; return item;
    });
    if (!items.length) {
      const item = document.createElement('li'); item.textContent = empty; items.push(item);
    }
    document.querySelector(selector).replaceChildren(...items);
  };
  const update = (chat) => {
    if (!resultChat || resultChat !== chat) return;
    stale.hidden = ![...chat.messages.keys()].some((id) => id > resultThrough);
  };
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const chat = getChat();
    if (!chat || generate.disabled) return;
    if (emailLoading) { status.textContent = 'Wait for the email preview before generating.'; return; }
    if (includeEmail.checked && !email.value.trim()) { status.textContent = 'Paste email context or turn off Include the visible email.'; return; }
    const requestVersion = ++version;
    controller?.abort();
    const pending = controller = new AbortController();
    generate.disabled = true;
    generate.textContent = 'Generating…';
    status.textContent = 'Gemini is reviewing the team discussion…';
    // Preserve an edited draft if a regeneration fails.
    try {
      const {data, error} = await supabase.functions.invoke('thread-assistant',{
        body:{discussion_id:chat.discussionId,workspace_id:chat.workspaceId,
          tone:document.querySelector('#assistant-tone').value,
          email_context:includeEmail.checked ? email.value.trim() : ''},
        signal:pending.signal,
      });
      if (requestVersion !== version || chat !== getChat()) return;
      if (error) {
        let message = 'Could not reach the assistant. Check that the Gemini function is deployed and try again.';
        try { message = (await error.context?.json())?.error || message; } catch {}
        throw new Error(message);
      }
      if (!data || typeof data.summary !== 'string' || typeof data.reply !== 'string'
          || !Array.isArray(data.decisions) || !Array.isArray(data.open_questions)) throw new Error('The assistant returned an incomplete result. Try again.');
      document.querySelector('#assistant-summary').textContent = data.summary;
      list('#assistant-decisions',data.decisions.map((d) => d.text),'No confirmed decisions yet.');
      list('#assistant-questions',data.open_questions,'No open questions identified.');
      draft.value = data.reply;
      resultChat = chat;
      resultThrough = data.generated_through;
      result.hidden = false;
      document.querySelector('#assistant-sources').textContent = `${data.message_count} team messages${data.truncated ? ' · Earlier messages excluded' : ''}${data.email_included ? ' · Email context included' : ' · Team discussion only'}`;
      status.textContent = 'Draft ready. Review the wording before using it in Gmail.';
      update(chat);
    } catch (error) {
      if (requestVersion === version && chat === getChat() && !pending.signal.aborted) status.textContent = error.message;
    } finally {
      if (requestVersion === version) {
        generate.disabled = false;
        generate.textContent = 'Summarize & draft reply';
      }
    }
  });
  copy.addEventListener('click', async () => {
    if (resultChat !== getChat()) return;
    const requestVersion = version;
    try {
      await navigator.clipboard.writeText(draft.value);
      if (requestVersion === version) status.textContent = 'Reply copied. Paste it into Gmail when you’re ready.';
    } catch {
      if (requestVersion === version) {
        draft.focus(); draft.select();
        status.textContent = 'Select and copy the draft manually.';
      }
    }
  });
  return {
    update,
    reset() {
      version++;
      controller?.abort(); emailController?.abort();
      resultChat = undefined; resultThrough = 0; emailLoading = false;
      setOpen(false); result.hidden = true; stale.hidden = true;
      draft.value = ''; email.value = ''; includeEmail.checked = false; emailFields.hidden = true;
      document.querySelector('#assistant-tone').value = 'professional';
      status.textContent = ''; emailStatus.textContent = '';
      generate.disabled = false; generate.textContent = 'Summarize & draft reply';
      document.querySelector('#assistant-summary').textContent = '';
      document.querySelector('#assistant-decisions').replaceChildren();
      document.querySelector('#assistant-questions').replaceChildren();
      document.querySelector('#assistant-sources').textContent = '';
    },
  };
}

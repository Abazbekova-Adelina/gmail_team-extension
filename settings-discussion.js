import { rpc, scopeError, supabase } from './backend.js';
import { validDiscussionCode } from './thread-context.js';
import { discussionStorageKey } from './workspaces.js';

const panel = document.querySelector('#thread-sharing');
const status = document.querySelector('#discussion-status');
const picker = document.querySelector('#discussion-threads');
const controls = document.querySelector('#discussion-controls');
const code = document.querySelector('#discussion-code');
const share = document.querySelector('#discussion-share');
const linkCode = document.querySelector('#link-code');

let userId;
let workspaceId;
let threads = [];
let revision = 0;

function askTab(tabId) {
  return chrome.tabs.sendMessage(tabId, { type: 'get-gmail-thread' });
}

async function readThread(tabId) {
  let context;
  try {
    context = await askTab(tabId);
  } catch {
    try {
      await chrome.scripting.insertCSS({ target: { tabId }, files: ['styles.css'] });
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
      context = await askTab(tabId);
    } catch {
      return null;
    }
  }
  return context?.gmailKey ? { ...context, tabId } : null;
}

function selectedThread() {
  const value = picker.querySelector('input:checked')?.value;
  return threads.find((thread) => String(thread.tabId) === value);
}

function threadOption(thread, checked) {
  const option = document.createElement('label');
  option.className = 'thread-option';
  const input = document.createElement('input');
  input.type = 'radio';
  input.name = 'discussion-thread';
  input.value = String(thread.tabId);
  input.checked = checked;
  const subject = document.createElement('strong');
  subject.textContent = thread.subject;
  option.append(input, subject);
  if (thread.account) {
    const account = document.createElement('small');
    account.textContent = thread.account;
    option.append(account);
  }
  return option;
}

async function loadDiscussion(thread, version) {
  controls.hidden = true;
  code.value = '';
  linkCode.value = '';
  if (!thread) return;
  status.textContent = 'Loading discussion…';
  try {
    const { data, error } = await supabase.from('discussion_bindings').select('discussion_id')
      .eq('user_id', userId).eq('workspace_id', workspaceId).eq('gmail_key', thread.gmailKey).maybeSingle();
    if (error) throw error;
    if (version !== revision) return;
    code.value = data?.discussion_id ?? '';
    share.hidden = !data;
    status.textContent = data ? '' : "This email is not connected to this workspace yet. Press Connect Threadly under the email, or paste a teammate's code.";
    controls.hidden = false;
  } catch (error) {
    if (version === revision) status.textContent = scopeError(error);
  }
}

function emptyMessage(gmailTabs) {
  if (!gmailTabs) return 'Open Gmail in this browser, open an email, then press Check again.';
  return 'Gmail is open, but no email is. Open the email you want to discuss, then press Check again.';
}

async function refreshThreads() {
  if (panel.hidden || !panel.open) return;
  const version = ++revision;
  const previous = selectedThread()?.gmailKey;
  controls.hidden = true;
  status.textContent = 'Looking for open emails…';
  try {
    const tabs = await chrome.tabs.query({ url: 'https://mail.google.com/*' });
    tabs.sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0));
    const found = await Promise.all(tabs.map((tab) => readThread(tab.id)));
    if (version !== revision) return;
    const seen = new Set();
    threads = found.filter((thread) => thread && !seen.has(thread.gmailKey) && seen.add(thread.gmailKey));
    const selected = threads.find((thread) => thread.gmailKey === previous) ?? threads[0];
    picker.replaceChildren(...threads.map((thread) => threadOption(thread, thread === selected)));
    status.textContent = threads.length ? '' : emptyMessage(tabs.length);
    await loadDiscussion(selected, version);
  } catch {
    if (version === revision) status.textContent = 'Could not read your Gmail tabs. Press Check again.';
  }
}

export function showDiscussionSettings(accountId, teamId) {
  if (userId === accountId && workspaceId === teamId) return;
  userId = accountId;
  workspaceId = teamId;
  revision++;
  controls.hidden = true;
  panel.hidden = !workspaceId;
  if (!workspaceId) panel.open = false;
  void refreshThreads();
}

panel.addEventListener('toggle', () => void refreshThreads());
picker.addEventListener('change', () => void loadDiscussion(selectedThread(), ++revision));
document.querySelector('#refresh-discussion-threads').addEventListener('click', () => void refreshThreads());
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) void refreshThreads();
});

document.querySelector('#copy-discussion').addEventListener('click', async () => {
  const version = revision;
  try {
    await navigator.clipboard.writeText(code.value);
    if (version === revision) status.textContent = 'Discussion code copied.';
  } catch {
    if (version !== revision) return;
    code.select();
    status.textContent = 'Select and copy the discussion code manually.';
  }
});

document.querySelector('#link-discussion').addEventListener('submit', async (event) => {
  event.preventDefault();
  const thread = selectedThread();
  const teamId = workspaceId;
  const accountId = userId;
  const version = revision;
  const target = linkCode.value.trim();
  if (!thread || !validDiscussionCode(target)) {
    status.textContent = 'Paste a valid discussion code.';
    return;
  }

  const button = event.submitter;
  button.disabled = true;
  try {
    const latest = await readThread(thread.tabId);
    if (version !== revision) return;
    if (latest?.gmailKey !== thread.gmailKey) {
      await refreshThreads();
      if (!controls.hidden) status.textContent = 'The Gmail thread changed. Confirm the thread before connecting it.';
      return;
    }
    const discussionId = await rpc('link_thread_discussion', {
      p_workspace_id: teamId, p_gmail_key: thread.gmailKey, p_discussion_id: target,
    });
    localStorage.setItem(discussionStorageKey(accountId), JSON.stringify({
      workspaceId: teamId, threadKey: thread.gmailKey, discussionId,
    }));
    if (version === revision) {
      code.value = discussionId;
      linkCode.value = '';
      status.textContent = 'Discussion connected.';
    }
  } catch (error) {
    if (version === revision) status.textContent = scopeError(error);
  } finally {
    button.disabled = false;
  }
});

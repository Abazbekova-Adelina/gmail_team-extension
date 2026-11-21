import { rpc, scopeError } from './backend.js';
import { validDiscussionCode } from './thread-context.js';
import { discussionStorageKey } from './workspaces.js';
import { messageMatchKey } from './gmail-metadata.js';

const panel = document.querySelector('#thread-sharing');
const status = document.querySelector('#discussion-status');
const tabSelect = document.querySelector('#discussion-tab');
const controls = document.querySelector('#discussion-controls');
const code = document.querySelector('#discussion-code');
const linkCode = document.querySelector('#link-code');

let userId;
let workspaceId;
let threads = [];
let revision = 0;

async function readThread(tabId) {
  try {
    const context = await chrome.tabs.sendMessage(tabId, { type: 'get-gmail-thread' });
    if (context?.gmailKey) return { ...context, tabId };
  } catch {}
  return null;
}

function selectedThread() {
  return threads.find((thread) => String(thread.tabId) === tabSelect.value);
}

async function loadDiscussion(thread, version) {
  controls.hidden = true;
  code.value = '';
  linkCode.value = '';
  status.textContent = thread ? 'Loading discussion…' : 'Open a thread in Gmail and return here.';
  if (!thread) return;
  try {
    const args = { p_workspace_id: workspaceId, p_gmail_key: thread.gmailKey };
    const key = await messageMatchKey(thread.apiThread);
    if (version !== revision) return;
    const id = key ? await rpc('match_thread_discussion', { ...args, p_message_key: key })
      : await rpc('open_thread_discussion', args);
    if (version !== revision) return;
    code.value = id;
    status.textContent = '';
    controls.hidden = false;
  } catch (error) {
    if (version === revision) status.textContent = scopeError(error);
  }
}

async function refreshThreads() {
  if (panel.hidden || !panel.open) return;
  const version = ++revision;
  controls.hidden = true;
  status.textContent = 'Finding open Gmail threads…';
  try {
    const tabs = await chrome.tabs.query({ currentWindow: true });
    tabs.sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0));
    const found = await Promise.all(tabs.map((tab) => readThread(tab.id)));
    if (version !== revision) return;
    threads = found.filter(Boolean);
    tabSelect.replaceChildren(...threads.map((thread) => new Option(thread.title || 'Gmail thread', thread.tabId)));
    tabSelect.disabled = !threads.length;
    await loadDiscussion(selectedThread(), version);
  } catch {
    if (version === revision) status.textContent = 'Could not find Gmail threads. Try opening this section again.';
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
tabSelect.addEventListener('change', () => void loadDiscussion(selectedThread(), ++revision));
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

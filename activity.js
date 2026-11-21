import { rpc } from './backend.js';
import { workspaceStorageKey } from './workspaces.js';

const count = document.querySelector('#unread-count');
const list = document.querySelector('#activity-list');
const status = document.querySelector('#activity-status');
let userId;
let revision = 0;

function activityRow(activity, accountId) {
  const row = document.createElement('li');
  const label = document.createElement('span');
  const mentions = Number(activity.mention_count);
  const unread = Number(activity.unread_count);
  label.textContent = `${activity.workspace_name} · ${unread} unread${mentions ? ` · ${mentions} @mention${mentions === 1 ? '' : 's'}` : ''}`;
  const time = new Date(activity.latest_at).toLocaleString();
  const detail = document.createElement('small');
  detail.textContent = time;
  label.append(detail);
  row.append(label);

  const thread = /^gmail:([A-Za-z0-9_-]+)$/.exec(activity.gmail_key ?? '');
  if (!thread) {
    const hint = document.createElement('small');
    hint.textContent = 'Open your copy in Gmail to link this discussion.';
    row.append(hint);
    return row;
  }
  const path = localStorage.getItem(`mailbox:${accountId}:${activity.gmail_key}`);
  const mailbox = /^\/mail\/u\/\d+\/$/.test(path ?? '') ? path : '/mail/u/0/';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'text-button';
  button.textContent = 'Open in Gmail';
  button.addEventListener('click', async () => {
    localStorage.setItem(workspaceStorageKey(accountId), activity.workspace_id);
    await chrome.tabs.create({ url: `https://mail.google.com${mailbox}#all/${thread[1]}` });
  });
  row.append(button);
  return row;
}

async function refreshActivity() {
  if (!userId) return;
  const accountId = userId;
  const version = ++revision;
  try {
    const activity = await rpc('chat_activity');
    if (version !== revision) return;
    const unread = activity.reduce((sum, item) => sum + Number(item.unread_count), 0);
    count.hidden = !unread;
    count.textContent = unread;
    status.textContent = unread ? '' : 'You’re caught up.';
    list.replaceChildren(...activity.map((item) => activityRow(item, accountId)));
  } catch (error) {
    if (version !== revision) return;
    status.textContent = error?.code === 'PGRST202'
      ? 'Activity needs a database update.' : 'Couldn’t load activity. Try again in a moment.';
  }
}

export function showActivity(accountId) {
  userId = accountId;
  revision++;
  count.hidden = true;
  status.textContent = accountId ? 'Loading activity…' : '';
  list.replaceChildren();
  void refreshActivity();
}

setInterval(() => { if (!document.hidden) void refreshActivity(); }, 15000);
document.querySelector('#refresh-teams').addEventListener('click', () => void refreshActivity());
document.querySelector('#activity-view-button').addEventListener('click', () => void refreshActivity());
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) void refreshActivity();
});

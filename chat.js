import { watchAccount } from './account.js';
import { rpc, scopeError, supabase } from './backend.js';
import { discussionStorageKey, fetchWorkspaces, preferredWorkspace, workspaceStorageKey } from './workspaces.js';
import { avatarElement, profileDetails } from './avatars.js';
import { validDiscussionCode } from './thread-context.js';

const PAGE_SIZE = 100;
// Older databases can still load history before the avatar migration is applied.
const MESSAGE_FIELDS = '*';
const dateFormat = new Intl.DateTimeFormat(undefined, {
  month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
});
const conversation = document.querySelector('#conversation');
const messageScroll = document.querySelector('#message-scroll');
const messageList = document.querySelector('#messages');
const loadEarlierButton = document.querySelector('#load-earlier');
const retryHistoryButton = document.querySelector('#retry-history');
const historyStatus = document.querySelector('#history-status');
const compose = document.querySelector('#compose');
const messageInput = document.querySelector('#message-input');
const sendButton = document.querySelector('#send');
const chatStatus = document.querySelector('#chat-status');
let activeChat;
let currentUser;
let workspaces = [];
let selectedWorkspace = '';
let selectionVersion = 0;
let workspaceRefreshVersion = 0;
const gmailKey = new URL(location.href).searchParams.get('thread');
const workspaceStatus = document.querySelector('#workspace-status');

function stopChat() {
  selectionVersion++;
  const previous = activeChat;
  activeChat = undefined;
  if (previous?.channel) void supabase.removeChannel(previous.channel);
  conversation.hidden = true;
  messageList.replaceChildren();
  messageInput.value = '';
  messageInput.readOnly = false;
  sendButton.disabled = false;
}
function messageElement(message, chat) {
  const item = document.createElement('li');
  const meta = document.createElement('div');
  const author = document.createElement('strong');
  const time = document.createElement('time');
  const body = document.createElement('p');
  const content = document.createElement('div');
  const ownMessage = message.author_id === chat.userId;
  const name = ownMessage ? chat.profile.name : message.author_name;

  item.className = 'message';
  content.className = 'message-content';
  meta.className = 'message-meta';
  author.textContent = ownMessage ? 'You' : name;
  time.dateTime = message.created_at;
  time.textContent = dateFormat.format(new Date(message.created_at));
  body.className = 'message-body';
  body.textContent = message.body;
  meta.append(author, time);
  content.append(meta, body);
  item.append(avatarElement(name, ownMessage ? chat.profile.avatar : message.author_avatar_url), content);
  return item;
}

function renderHistory(chat, { prepend = false } = {}) {
  const previousHeight = messageScroll.scrollHeight;
  const previousTop = messageScroll.scrollTop;
  const atBottom = previousHeight - previousTop - messageScroll.clientHeight < 24;

  loadEarlierButton.hidden = chat.olderThan === null;
  loadEarlierButton.disabled = chat.loadingEarlier || Boolean(chat.refresh);
  retryHistoryButton.hidden = !chat.historyError;
  retryHistoryButton.disabled = Boolean(chat.refresh) || chat.loadingEarlier;
  const emptyMessage = chat.loaded ? 'No messages yet.' : 'Loading messages…';
  historyStatus.textContent = chat.historyError || (chat.messages.size ? '' : emptyMessage);

  const items = [...chat.messages.values()].sort((a, b) => a.id - b.id);
  messageList.replaceChildren(...items.map((message) => messageElement(message, chat)));
  if (prepend) messageScroll.scrollTop = previousTop + messageScroll.scrollHeight - previousHeight;
  else if (atBottom) messageScroll.scrollTop = messageScroll.scrollHeight;
}

function renderConnection(chat) {
  chatStatus.textContent = chat.sendError || chat.connection;
}

function applyChange(messages, id, message) {
  if (message) messages.set(id, message);
  else messages.delete(id);
}

function receiveMessage(chat, id, message) {
  if (chat !== activeChat) return;
  chat.refresh?.set(id, message);
  applyChange(chat.messages, id, message);
  renderHistory(chat);
}

function messageQuery(chat) {
  return supabase.from('team_messages').select(MESSAGE_FIELDS)
    .eq('workspace_id', chat.workspaceId).eq('discussion_id', chat.discussionId);
}

function earlierCursor(rows) {
  return rows.length === PAGE_SIZE ? rows.at(-1).id : null;
}

async function refreshHistory(chat) {
  const changes = new Map();
  chat.refresh = changes;
  chat.historyError = '';
  renderHistory(chat);

  const { data, error } = await messageQuery(chat).order('id', { ascending: false }).limit(PAGE_SIZE);
  if (chat !== activeChat || chat.refresh !== changes) return;
  chat.refresh = null;

  if (error) {
    chat.historyError = 'Messages could not load.';
  } else {
    chat.messages = new Map(data.map((message) => [message.id, message]));
    for (const [id, message] of changes) applyChange(chat.messages, id, message);
    chat.olderThan = earlierCursor(data);
    chat.loaded = true;
  }
  renderHistory(chat);
}

async function loadEarlier(chat) {
  if (!chat || chat.olderThan === null || chat.loadingEarlier || chat.refresh) return;
  const messages = chat.messages;
  chat.loadingEarlier = true;
  chat.historyError = '';
  renderHistory(chat);

  const { data, error } = await messageQuery(chat).lt('id', chat.olderThan)
    .order('id', { ascending: false }).limit(PAGE_SIZE);
  if (chat !== activeChat) return;
  chat.loadingEarlier = false;
  if (chat.messages !== messages || chat.refresh) {
    renderHistory(chat);
    return;
  }

  if (error) {
    chat.historyError = 'Earlier messages could not load.';
  } else {
    for (const message of data) chat.messages.set(message.id, message);
    chat.olderThan = earlierCursor(data);
  }
  renderHistory(chat, { prepend: !error });
}

function showAccount(user) {
  if (user && user.id === currentUser?.id) {
    currentUser = user;
    if (activeChat) {
      activeChat.profile = profileDetails(user);
      renderHistory(activeChat);
    }
    return;
  }
  stopChat();
  workspaceRefreshVersion++;
  currentUser = user;
  selectedWorkspace = '';
  workspaceStatus.textContent = user ? '' : 'Sign in from the Gmail Team Chat toolbar icon.';
  if (user) void refreshWorkspaces();
}

async function openDiscussion(workspaceId, linkedId) {
  stopChat();
  const version = selectionVersion;
  const user = currentUser;
  if (!user || !workspaceId) return;
  workspaceStatus.textContent = 'Opening this thread’s discussion…';
  if (!gmailKey || !gmailKey.startsWith('gmail:') || gmailKey.length > 240) {
    workspaceStatus.textContent = 'Open an email thread in Gmail to start a discussion.';
    return;
  }
  try {
    const discussionId = linkedId || await rpc('open_thread_discussion', {
      p_workspace_id: workspaceId, p_gmail_key: gmailKey,
    });
    if (version !== selectionVersion || currentUser?.id !== user.id) return;
    const chat = {
      userId: user.id, profile: profileDetails(user), workspaceId, discussionId,
      messages: new Map(), olderThan: null, refresh: null, loaded: false,
      loadingEarlier: false, historyError: '', connection: 'Connecting…', sendError: '', draft: null,
    };
    activeChat = chat;
    conversation.hidden = false;
    workspaceStatus.textContent = '';
    renderConnection(chat);
    void refreshHistory(chat);
    chat.channel = supabase.channel(`discussion-${crypto.randomUUID()}`)
      .on('postgres_changes', {
        event: 'INSERT', schema: 'public', table: 'team_messages',
        filter: `discussion_id=eq.${discussionId}`,
      }, ({new: message}) => {
        if (message.workspace_id === workspaceId && message.discussion_id === discussionId) {
          receiveMessage(chat, message.id, message);
        }
      })
      .subscribe((status) => {
        if (chat !== activeChat) return;
        chat.connection = status === 'SUBSCRIBED' ? 'Live · Workspace members only' : 'Updates paused. Reconnecting…';
        renderConnection(chat);
        if (status === 'SUBSCRIBED') void refreshHistory(chat);
      });
  } catch (error) {
    if (version === selectionVersion) workspaceStatus.textContent = scopeError(error);
  }
}

async function refreshWorkspaces() {
  if (!currentUser) return;
  const userId = currentUser.id;
  const version = ++workspaceRefreshVersion;
  try {
    const teams = await fetchWorkspaces();
    if (version !== workspaceRefreshVersion || currentUser?.id !== userId) return;
    const next = preferredWorkspace(teams, userId);
    const team = teams.find((item) => item.id === next);
    if (!team) {
      stopChat();
      selectedWorkspace = '';
      workspaceStatus.textContent = 'Create a workspace or accept an invitation in Workspace settings.';
      return;
    }
    if (next !== selectedWorkspace || !activeChat) {
      selectedWorkspace = next;
      await openDiscussion(next);
    }
  } catch (error) {
    if (version !== workspaceRefreshVersion || currentUser?.id !== userId) return;
    stopChat();
    workspaceStatus.textContent = scopeError(error);
  }
}

async function sendMessage(chat, draft) {
  const { data, error } = await supabase.from('team_messages')
    .upsert({ client_id: draft.id, body: draft.body, workspace_id: chat.workspaceId, discussion_id: chat.discussionId }, {
      onConflict: 'author_id,client_id', ignoreDuplicates: true,
    })
    .select(MESSAGE_FIELDS)
    .maybeSingle();
  if (error) throw error;
  if (data) return data;

  const { data: existing, error: readError } = await messageQuery(chat)
    .eq('author_id', chat.userId).eq('client_id', draft.id).single();
  if (readError) throw readError;
  return existing;
}

watchAccount(showAccount);
if (!supabase) workspaceStatus.textContent = 'This build needs a Supabase project to sign in.';
loadEarlierButton.addEventListener('click', () => void loadEarlier(activeChat));
retryHistoryButton.addEventListener('click', () => {
  if (activeChat) void refreshHistory(activeChat);
});

compose.addEventListener('submit', async (event) => {
  event.preventDefault();
  const chat = activeChat;
  const body = messageInput.value.trim();
  if (!chat || !body || sendButton.disabled) return;

  if (chat.draft?.body !== body) chat.draft = { id: crypto.randomUUID(), body };
  sendButton.disabled = true;
  messageInput.readOnly = true;
  chat.sendError = '';
  renderConnection(chat);

  try {
    const message = await sendMessage(chat, chat.draft);
    if (chat !== activeChat) return;
    messageInput.value = '';
    chat.draft = null;
    receiveMessage(chat, message.id, message);
    messageScroll.scrollTop = messageScroll.scrollHeight;
  } catch {
    chat.sendError = 'Message did not send. Try again.';
    if (chat === activeChat) renderConnection(chat);
  } finally {
    if (chat === activeChat) {
      sendButton.disabled = false;
      messageInput.readOnly = false;
      messageInput.focus();
    }
  }
});

messageInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing) {
    event.preventDefault();
    compose.requestSubmit(sendButton);
  }
});

// Membership is checked by RLS on every request. Refresh the local team list
// as well, so a revoked membership also clears already-rendered history.
setInterval(() => { if (!document.hidden && currentUser) void refreshWorkspaces(); }, 30000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && currentUser) void refreshWorkspaces();
});

window.addEventListener('storage', (event) => {
  if (!currentUser) return;
  if (event.key === workspaceStorageKey(currentUser.id)) {
    void refreshWorkspaces();
  }
  if (event.key === discussionStorageKey(currentUser.id) && event.newValue) {
    const { workspaceId, threadKey, discussionId } = JSON.parse(event.newValue);
    if (workspaceId === selectedWorkspace && threadKey === gmailKey
      && validDiscussionCode(discussionId) && activeChat?.discussionId !== discussionId) {
      void openDiscussion(workspaceId, discussionId);
    }
  }
});

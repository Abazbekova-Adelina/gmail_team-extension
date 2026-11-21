import { watchAccount } from './account.js';
import { rpc, scopeError, supabase } from './backend.js';
import { fetchWorkspaces, preferredWorkspace, workspaceStorageKey } from './workspaces.js';
import { avatarElement, profileDetails } from './avatars.js';
import { encodeMentions, mentionToken } from './mentions.js';
import { mountMentions } from './mention-composer.js';
import { dayLabel, localDay, timeLabel } from './chat-dates.js';
import { reactionControls } from './reactions.js';
import { mountAssistant } from './assistant.js';

const PAGE_SIZE = 100;
// Older databases can still load history before the avatar migration is applied.
const MESSAGE_FIELDS = '*';
const conversation = document.querySelector('#conversation');
const messageScroll = document.querySelector('#message-scroll');
const messageList = document.querySelector('#messages');
const loadEarlierButton = document.querySelector('#load-earlier');
const retryHistoryButton = document.querySelector('#retry-history');
const historyStatus = document.querySelector('#history-status');
const retryMatchButton = document.querySelector('#retry-match');
const compose = document.querySelector('#compose');
const messageInput = document.querySelector('#message-input');
const sendButton = document.querySelector('#send');
const chatStatus = document.querySelector('#chat-status');
let activeChat;
let currentUser;
let selectedWorkspace = '';
let workspaceRefreshVersion = 0;
const context = new URL(location.href).searchParams;
const gmailKey = context.get('thread');
const messageKey = context.get('message-key');
const mailbox = context.get('mailbox');
const workspaceStatus = document.querySelector('#workspace-status');
const connectedSelect = document.querySelector('#connected-workspace');
const chatDescription = document.querySelector('#chat-description');
let historyVisible = false;
const refreshMentionConfirmation = mountMentions(messageInput, () => activeChat);
const assistant = mountAssistant({supabase, getChat: () => activeChat, gmailKey});

function stopChat() {
  assistant.reset();
  const previous = activeChat;
  activeChat = undefined;
  if (previous?.channel) void supabase.removeChannel(previous.channel);
  conversation.hidden = true;
  retryMatchButton.hidden = true;
  messageList.replaceChildren();
  messageInput.value = '';
  messageInput.readOnly = false;
  sendButton.disabled = false;
  messageInput.placeholder = 'Write a message…';
  connectedSelect.hidden = true;
  chatDescription.textContent = 'Discuss this email privately with your team.';
  refreshMentionConfirmation();
}
function messageElement(message, chat, continuation) {
  const item = document.createElement('li');
  const meta = document.createElement('div');
  const author = document.createElement('strong');
  const time = document.createElement('time');
  const body = document.createElement('p');
  const content = document.createElement('div');
  const bubble = document.createElement('div');
  const ownMessage = message.author_id === chat.userId;
  const name = ownMessage ? chat.profile.name : message.author_name;

  item.className = `message${ownMessage ? ' message-own' : ''}${continuation ? ' message-continuation' : ''}`;
  content.className = 'message-content';
  meta.className = 'message-meta';
  author.textContent = ownMessage ? 'You' : name;
  time.dateTime = message.created_at;
  time.textContent = timeLabel(new Date(message.created_at));
  body.className = 'message-body';
  let offset = 0;
  for (const match of message.body.matchAll(mentionToken)) {
    body.append(message.body.slice(offset, match.index));
    const mention = document.createElement('span');
    mention.className = 'message-mention';
    mention.textContent = `@${chat.members.get(match[1].toLowerCase()) ?? 'Teammate'}`;
    body.append(mention);
    offset = match.index + match[0].length;
  }
  body.append(message.body.slice(offset));
  meta.append(author);
  bubble.className = 'message-bubble';
  if (ownMessage) bubble.classList.add('message-bubble-own');
  const footer = document.createElement('div');
  footer.className = 'message-footer';
  footer.append(reactionControls(message.id, chat, (id, emoji) => void setReaction(chat, id, emoji)), time);
  bubble.append(body, footer);
  content.append(meta, bubble);
  item.append(avatarElement(name, ownMessage ? chat.profile.avatar : message.author_avatar_url), content);
  return item;
}

function messageRows(messages, chat) {
  const rows = [];
  let previousDay;
  let previousAuthor;
  for (const message of messages) {
    const date = new Date(message.created_at);
    const day = localDay(date);
    if (day !== previousDay) {
      const separator = document.createElement('li');
      const label = document.createElement('time');
      separator.className = 'date-divider';
      label.dateTime = day;
      label.textContent = dayLabel(date);
      separator.append(label);
      rows.push(separator);
      previousDay = day;
      previousAuthor = undefined;
    }
    const continuation = day === previousDay && message.author_id === previousAuthor;
    rows.push(messageElement(message, chat, continuation));
    previousAuthor = message.author_id;
  }
  return rows;
}

function renderHistory(chat, { prepend = false } = {}) {
  assistant.update(chat);
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
  messageList.replaceChildren(...messageRows(items, chat));
  if (prepend) messageScroll.scrollTop = previousTop + messageScroll.scrollHeight - previousHeight;
  else if (atBottom) messageScroll.scrollTop = messageScroll.scrollHeight;
  markRead();
}

function markRead() {
  const chat = activeChat;
  if (!chat || !historyVisible || document.hidden || chat.reading
    || messageScroll.scrollHeight - messageScroll.scrollTop - messageScroll.clientHeight >= 24) return;
  const latest = [...chat.messages.keys()].reduce((max, id) => Math.max(max, id), 0);
  if (latest <= chat.readThrough) return;
  chat.reading = true;
  void rpc('mark_discussion_read', { p_discussion_id: chat.discussionId, p_message_id: latest }).then(() => {
    chat.reading = false;
    chat.readThrough = latest;
    if (chat === activeChat) markRead();
  }, () => { chat.reading = false; });
}

async function loadMembers(chat) {
  const { data, error } = await supabase.from('workspace_members').select('user_id,display_name')
    .eq('workspace_id', chat.workspaceId).order('display_name');
  if (error || chat !== activeChat) return;
  chat.members = new Map(data.map((member) => [member.user_id, member.display_name]));
  if (data.some((member) => member.user_id !== chat.userId)) messageInput.placeholder = 'Write a message… Type @name to mention someone.';
  refreshMentionConfirmation();
  if (chat.messages.size) renderHistory(chat);
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

function storeReaction(reactions, reaction) {
  const people = reactions.get(reaction.message_id) ?? new Map();
  if (reaction.emoji) people.set(reaction.user_id, reaction);
  else people.delete(reaction.user_id);
  if (people.size) reactions.set(reaction.message_id, people);
  else reactions.delete(reaction.message_id);
}

function receiveReaction(chat, reaction) {
  if (chat !== activeChat) return;
  chat.reactionRefresh?.set(`${reaction.message_id}:${reaction.user_id}`, reaction);
  storeReaction(chat.reactions, reaction);
  if (chat.messages.has(reaction.message_id)) renderHistory(chat);
}

function sameReactions(previous, current) {
  if (previous.size !== current.size) return false;
  for (const [id, people] of current) {
    const before = previous.get(id);
    if (before?.size !== people.size) return false;
    for (const [userId, reaction] of people) {
      const prior = before.get(userId);
      if (prior?.emoji !== reaction.emoji || prior.avatar_url !== reaction.avatar_url) return false;
    }
  }
  return true;
}

async function refreshReactions(chat) {
  const changes = new Map();
  const reactions = new Map();
  chat.reactionRefresh = changes;
  const ids = [...chat.messages.keys()];
  try {
    for (let start = 0; start < ids.length; start += 100) {
      for (let offset = 0; ; offset += 1000) {
        const { data, error } = await supabase.from('message_reactions').select('message_id,user_id,emoji,avatar_url')
          .eq('discussion_id', chat.discussionId).in('message_id', ids.slice(start, start + 100)).not('emoji', 'is', null)
          .order('message_id').order('user_id').range(offset, offset + 999);
        if (chat !== activeChat || chat.reactionRefresh !== changes || error) return;
        for (const reaction of data) storeReaction(reactions, reaction);
        if (data.length < 1000) break;
      }
    }
    for (const reaction of changes.values()) storeReaction(reactions, reaction);
    if (sameReactions(chat.reactions, reactions)) return;
    chat.reactions = reactions;
    renderHistory(chat);
  } finally {
    if (chat.reactionRefresh === changes) chat.reactionRefresh = null;
  }
}

async function setReaction(chat, messageId, emoji) {
  if (chat !== activeChat || chat.pendingReactions.has(messageId)) return;
  chat.pendingReactions.add(messageId);
  try {
    const reaction = await rpc('set_message_reaction', { p_message_id: messageId, p_emoji: emoji });
    if (chat !== activeChat) return;
    chat.sendError = '';
    receiveReaction(chat, reaction);
    renderConnection(chat);
  } catch (error) {
    if (chat !== activeChat) return;
    chat.sendError = error?.code === 'PGRST202'
      ? 'Reactions need a database update.' : 'Couldn’t save the reaction. Try again.';
    renderConnection(chat);
  } finally {
    chat.pendingReactions.delete(messageId);
  }
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
    chat.catchUpThrough = data[0]?.id ?? 0;
    for (const [id, message] of changes) applyChange(chat.messages, id, message);
    chat.olderThan = earlierCursor(data);
    chat.loaded = true;
    void refreshReactions(chat);
  }
  renderHistory(chat);
}

// Postgres Changes is the fast path. Recover anything missed while a tab was
// suspended or its socket was unavailable, without discarding paginated history.
async function catchUpMessages(chat) {
  if (chat !== activeChat || chat.catchingUp || chat.refresh || !chat.loaded) return;
  chat.catchingUp = true;
  let cursor = chat.catchUpThrough;
  const messages = chat.messages;
  try {
    while (chat === activeChat) {
      const { data, error } = await messageQuery(chat).gt('id', cursor)
        .order('id', { ascending: true }).limit(PAGE_SIZE);
      if (chat !== activeChat || chat.messages !== messages) return;
      if (error) {
        chat.historyError = 'Messages could not load.';
        renderHistory(chat);
        return;
      }
      for (const message of data) {
        chat.refresh?.set(message.id, message);
        chat.messages.set(message.id, message);
      }
      const hadError = Boolean(chat.historyError);
      chat.historyError = '';
      if (data.length || hadError) renderHistory(chat);
      if (data.length) cursor = data.at(-1).id;
      chat.catchUpThrough = cursor;
      if (data.length < PAGE_SIZE) break;
    }
  } finally {
    chat.catchingUp = false;
  }
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
    void refreshReactions(chat);
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

function validThreadKey() {
  return Boolean(gmailKey?.startsWith('gmail:') && gmailKey.length <= 240);
}


function openDiscussion(workspaceId, discussionId) {
  stopChat();
  const user = currentUser;
  if (!user) return;
  const chat = {
    userId: user.id, profile: profileDetails(user), workspaceId, discussionId,
    messages: new Map(), olderThan: null, refresh: null, loaded: false,
    members: new Map(), readThrough: 0, reading: false,
    reactions: new Map(), reactionRefresh: null, pendingReactions: new Set(),
    loadingEarlier: false, historyError: '', connection: 'Connecting…', sendError: '', draft: null,
  };
  activeChat = chat;
  if (mailbox) localStorage.setItem(`mailbox:${user.id}:${gmailKey}`, mailbox);
  conversation.hidden = false;
  workspaceStatus.textContent = '';
  renderConnection(chat);
  void refreshHistory(chat);
  void loadMembers(chat);
  chat.channel = supabase.channel(`discussion-${crypto.randomUUID()}`)
    .on('postgres_changes', {
      // UPDATE also delivers preserved messages moved from a legacy split chat.
      event: '*', schema: 'public', table: 'team_messages',
      filter: `discussion_id=eq.${discussionId}`,
    }, ({new: message}) => {
      if (message.workspace_id === workspaceId && message.discussion_id === discussionId) {
        receiveMessage(chat, message.id, message);
      }
    })
    .subscribe((status) => {
      if (chat !== activeChat) return;
      chat.connection = status === 'SUBSCRIBED' ? '' : 'Updates paused. Reconnecting…';
      renderConnection(chat);
      if (status === 'SUBSCRIBED') {
        if (chat.loaded) void catchUpMessages(chat);
        else void refreshHistory(chat);
      }
    });
}

async function automaticDiscussion(workspaceId) {
  return rpc('automatic_thread_discussion', {
    p_workspace_id: workspaceId, p_gmail_key: gmailKey, p_message_key: messageKey,
  });
}

function showConnected(discussionId, teams, workspaceId) {
  if (activeChat?.workspaceId !== workspaceId || activeChat.discussionId !== discussionId) {
    openDiscussion(workspaceId, discussionId);
  }
  selectedWorkspace = workspaceId;
  connectedSelect.replaceChildren(...teams.map((team) => new Option(team.name, team.id)));
  connectedSelect.value = workspaceId;
  connectedSelect.hidden = teams.length < 2;
  chatDescription.textContent = `Private discussion · ${teams.find((team) => team.id === workspaceId).name}`;
}

async function refreshWorkspaces() {
  if (!currentUser) return;
  const userId = currentUser.id;
  const version = ++workspaceRefreshVersion;
  if (!validThreadKey()) {
    stopChat();
    workspaceStatus.textContent = 'Open an email thread in Gmail to start a discussion.';
    return;
  }
  if (!/^[a-f0-9]{64}$/.test(messageKey ?? '')) {
    stopChat();
    const failed = context.get('match-state') === 'failed';
    workspaceStatus.textContent = failed
      ? `Could not identify this email. ${context.get('match-error') || 'Gmail did not provide its shared email identity'}.`
      : 'Matching this email with your workspace…';
    retryMatchButton.hidden = !failed;
    return;
  }
  try {
    const teams = await fetchWorkspaces();
    if (version !== workspaceRefreshVersion || currentUser?.id !== userId) return;
    if (!teams.length) {
      stopChat();
      selectedWorkspace = '';
      workspaceStatus.textContent = 'Create a workspace or accept an invitation in Threadly settings.';
      return;
    }
    const next = teams.some((team) => team.id === selectedWorkspace)
      ? selectedWorkspace : preferredWorkspace(teams, userId);
    const discussionId = await automaticDiscussion(next);
    if (version !== workspaceRefreshVersion || currentUser?.id !== userId) return;
    showConnected(discussionId, teams, next);
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
connectedSelect.addEventListener('change', () => {
  selectedWorkspace = connectedSelect.value;
  void refreshWorkspaces();
});
if (!supabase) workspaceStatus.textContent = 'This build needs a Supabase project to sign in.';
loadEarlierButton.addEventListener('click', () => void loadEarlier(activeChat));
retryHistoryButton.addEventListener('click', () => {
  if (activeChat) void refreshHistory(activeChat);
});
retryMatchButton.addEventListener('click', () => {
  parent.postMessage({ type: 'threadly-retry-match' }, 'https://mail.google.com');
});

compose.addEventListener('submit', async (event) => {
  event.preventDefault();
  const chat = activeChat;
  const text = messageInput.value.trim();
  if (!chat || !text || sendButton.disabled) return;
  const body = encodeMentions(text, chat.members, chat.userId);
  if (body.length > 2000) {
    chat.sendError = 'This message is too long. Shorten it and try again.';
    renderConnection(chat);
    return;
  }

  if (chat.draft?.body !== body) chat.draft = { id: crypto.randomUUID(), body };
  sendButton.disabled = true;
  messageInput.readOnly = true;
  refreshMentionConfirmation();
  chat.sendError = '';
  renderConnection(chat);

  try {
    const message = await sendMessage(chat, chat.draft);
    if (chat !== activeChat) return;
    messageInput.value = '';
    refreshMentionConfirmation();
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
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && !event.defaultPrevented) {
    event.preventDefault();
    compose.requestSubmit(sendButton);
  }
});

// Membership is checked by RLS on every request. Refresh the local team list
// as well, so a revoked membership also clears already-rendered history.
setInterval(() => { if (!document.hidden && currentUser) void refreshWorkspaces(); }, 30000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && currentUser) void refreshWorkspaces();
  if (!document.hidden && activeChat) {
    void catchUpMessages(activeChat);
    void refreshReactions(activeChat);
  }
  markRead();
});

setInterval(() => {
  if (!document.hidden && historyVisible && activeChat && !activeChat.reactionRefresh) void refreshReactions(activeChat);
  if (!document.hidden && historyVisible && activeChat) void catchUpMessages(activeChat);
}, 8000);

new IntersectionObserver(([entry]) => {
  historyVisible = entry.intersectionRatio >= 0.4;
  markRead();
}, { threshold: 0.4 }).observe(messageScroll);
messageScroll.addEventListener('scroll', markRead);

window.addEventListener('storage', (event) => {
  if (!currentUser) return;
  if (event.key === workspaceStorageKey(currentUser.id)) {
    void refreshWorkspaces();
  }
});

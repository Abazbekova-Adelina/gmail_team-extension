import { createClient } from '@supabase/supabase-js';

const PAGE_SIZE = 100;
const MESSAGE_FIELDS = 'id, author_id, author_name, body, created_at';
const dateFormat = new Intl.DateTimeFormat(undefined, {
  month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
});
const signInView = document.querySelector('#sign-in-view');
const signInButton = document.querySelector('#sign-in');
const signOutButton = document.querySelector('#sign-out');
const authStatus = document.querySelector('#auth-status');
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

const supabase = SUPABASE_URL ? createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: { flowType: 'pkce', detectSessionInUrl: false },
}) : null;

let activeChat;

async function signInWithGoogle() {
  await navigator.locks.request('gmail-team-chat-google-sign-in', { ifAvailable: true }, async (lock) => {
    if (!lock) throw new Error('Finish signing in from the other Gmail tab.');

    const redirectTo = chrome.identity.getRedirectURL('supabase-auth');
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo, skipBrowserRedirect: true },
    });
    if (error) throw error;

    const callback = new URL(await chrome.identity.launchWebAuthFlow({ url: data.url, interactive: true }));
    const expected = new URL(redirectTo);
    const code = callback.searchParams.get('code');
    if (callback.origin !== expected.origin || callback.pathname !== expected.pathname || !code) {
      throw new Error('Google sign-in did not return a session.');
    }

    const { error: sessionError } = await supabase.auth.exchangeCodeForSession(code);
    if (sessionError) throw sessionError;
  });
}

function messageElement(message, userId) {
  const item = document.createElement('li');
  const meta = document.createElement('div');
  const author = document.createElement('strong');
  const time = document.createElement('time');
  const body = document.createElement('p');

  meta.className = 'message-meta';
  author.textContent = message.author_id === userId ? 'You' : message.author_name;
  time.dateTime = message.created_at;
  time.textContent = dateFormat.format(new Date(message.created_at));
  body.className = 'message-body';
  body.textContent = message.body;
  meta.append(author, time);
  item.append(meta, body);
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
  messageList.replaceChildren(...items.map((message) => messageElement(message, chat.userId)));
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

function messageQuery() {
  return supabase.from('team_messages').select(MESSAGE_FIELDS);
}

function earlierCursor(rows) {
  return rows.length === PAGE_SIZE ? rows.at(-1).id : null;
}

async function refreshHistory(chat) {
  const changes = new Map();
  chat.refresh = changes;
  chat.historyError = '';
  renderHistory(chat);

  const { data, error } = await messageQuery().order('id', { ascending: false }).limit(PAGE_SIZE);
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

  const { data, error } = await messageQuery().lt('id', chat.olderThan)
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

function showSession(session) {
  const userId = session?.user.id;
  if (userId && userId === activeChat?.userId) return;

  const previousChat = activeChat;
  activeChat = undefined;
  if (previousChat) void supabase.removeChannel(previousChat.channel);

  conversation.hidden = !userId;
  signInView.hidden = Boolean(userId);
  signOutButton.hidden = !userId;
  signInButton.hidden = Boolean(userId);
  authStatus.textContent = '';
  messageList.replaceChildren();
  messageInput.value = '';
  messageInput.readOnly = false;
  sendButton.disabled = false;
  if (!userId) return;

  const chat = {
    userId,
    messages: new Map(),
    olderThan: null,
    refresh: null,
    loaded: false,
    loadingEarlier: false,
    historyError: '',
    connection: 'Connecting…',
    sendError: '',
    draft: null,
  };
  activeChat = chat;
  renderConnection(chat);
  void refreshHistory(chat);

  chat.channel = supabase.channel(`team-messages-${crypto.randomUUID()}`)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'team_messages' },
      ({ new: message }) => receiveMessage(chat, message.id, message))
    .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'team_messages' },
      ({ old: message }) => receiveMessage(chat, message.id, null))
    .subscribe((status) => {
      if (chat !== activeChat) return;
      chat.connection = status === 'SUBSCRIBED' ? 'Live' : 'Updates paused. Reconnecting…';
      renderConnection(chat);
      if (status === 'SUBSCRIBED') void refreshHistory(chat);
    });
}

async function sendMessage(chat, draft) {
  const { data, error } = await supabase.from('team_messages')
    .upsert({ client_id: draft.id, body: draft.body }, {
      onConflict: 'author_id,client_id', ignoreDuplicates: true,
    })
    .select(MESSAGE_FIELDS)
    .maybeSingle();
  if (error) throw error;
  if (data) return data;

  const { data: existing, error: readError } = await messageQuery()
    .eq('author_id', chat.userId).eq('client_id', draft.id).single();
  if (readError) throw readError;
  return existing;
}

if (supabase) {
  supabase.auth.onAuthStateChange((_event, session) => {
    setTimeout(() => showSession(session), 0);
  });
} else {
  authStatus.textContent = 'This build needs a Supabase project to sign in.';
}

signInButton.addEventListener('click', async () => {
  signInButton.disabled = true;
  authStatus.textContent = 'Waiting for Google sign-in…';
  try {
    await signInWithGoogle();
  } catch (error) {
    console.warn('Google sign-in failed:', error.message);
    authStatus.textContent = 'Sign-in did not finish. Try again.';
  } finally {
    signInButton.disabled = false;
  }
});

signOutButton.addEventListener('click', async () => {
  signOutButton.disabled = true;
  try {
    const { error } = await supabase.auth.signOut({ scope: 'local' });
    if (error) throw error;
    showSession(null);
  } catch {
    if (activeChat) {
      activeChat.sendError = 'Sign-out failed. Try again.';
      renderConnection(activeChat);
    }
  } finally {
    signOutButton.disabled = false;
  }
});

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

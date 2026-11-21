import { createClient } from '@supabase/supabase-js';
import { avatarElement, profileDetails } from './avatars.js';
import { validDiscussionCode } from './thread-context.js';

const PAGE_SIZE = 100;
// Older databases can still load history before the avatar migration is applied.
const MESSAGE_FIELDS = '*';
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
const accountProfile = document.querySelector('#account-profile');

const supabase = SUPABASE_URL ? createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: { flowType: 'pkce', detectSessionInUrl: false },
}) : null;

let activeChat;
let currentUser;
let workspaces = [];
let selectedWorkspace = '';
let selectionVersion = 0;
let workspaceRefreshVersion = 0;
const gmailKey = new URL(location.href).searchParams.get('thread');
const workspaceView = document.querySelector('#workspace-view');
const workspaceSelect = document.querySelector('#workspace-select');
const workspaceStatus = document.querySelector('#workspace-status');
const teamSettings = document.querySelector('#team-settings');
const manageTeam = document.querySelector('#manage-team');
const ownerSettings = document.querySelector('#owner-settings');
const memberSettings = document.querySelector('#member-settings');
const discussionCode = document.querySelector('#discussion-code');

function selectedTeam() { return workspaces.find((team) => team.id === selectedWorkspace); }
function isOwner() { return selectedTeam()?.owner_id === currentUser?.id; }
function setTeamSettings(open) {
  teamSettings.hidden = !open;
  manageTeam.setAttribute('aria-expanded', String(open));
}
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
  discussionCode.value = '';
  document.querySelector('#link-code').value = '';
}
async function rpc(name, params = {}) {
  const {data, error} = await supabase.rpc(name, params);
  if (error) throw error;
  return data;
}
function scopeError(error) {
  if (error?.code === 'P0001' && [
    'This person is already a member.',
    'Invitation is unavailable for this account or has expired.',
    'Discussion is not in this workspace.',
    'Enter a valid email address.',
    'Use a workspace name between 1 and 80 characters.',
  ].includes(error.message)) return error.message;
  return ['PGRST202', '42P01', '42703'].includes(error?.code)
    ? 'Private workspaces need the latest database migration. Ask the app owner to apply it.'
    : 'Could not update the workspace. Check your membership and try again.';
}

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

function showSession(session) {
  const user = session?.user;
  if (user && user.id === currentUser?.id) {
    currentUser = user;
    if (activeChat) {
      activeChat.profile = profileDetails(user);
      renderHistory(activeChat);
    }
    renderAccount(profileDetails(user));
    return;
  }
  stopChat();
  workspaceRefreshVersion++;
  currentUser = user;
  workspaces = [];
  selectedWorkspace = '';
  workspaceSelect.replaceChildren();
  workspaceStatus.textContent = '';
  document.querySelector('#my-invitations').replaceChildren();
  document.querySelector('#pending-invitations').replaceChildren();
  document.querySelector('#team-members').replaceChildren();
  ownerSettings.hidden = true;
  memberSettings.hidden = true;
  workspaceView.hidden = !user;
  signInView.hidden = Boolean(user);
  signOutButton.hidden = !user;
  signInButton.hidden = Boolean(user);
  authStatus.textContent = '';
  accountProfile.replaceChildren();
  accountProfile.hidden = !user;
  if (!user) return;
  renderAccount(profileDetails(user));
  void refreshWorkspaces();
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
    discussionCode.value = discussionId;
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

async function selectWorkspace(id) {
  selectedWorkspace = workspaces.some((team) => team.id === id) ? id : '';
  workspaceSelect.value = selectedWorkspace;
  ownerSettings.hidden = !isOwner();
  memberSettings.hidden = !selectedWorkspace;
  try { localStorage.setItem(`workspace:${currentUser.id}`, selectedWorkspace); } catch {}
  const opening = openDiscussion(selectedWorkspace);
  void refreshTeamDetails();
  await opening;
}

async function refreshWorkspaces(preferred) {
  if (!currentUser) return;
  const userId = currentUser.id;
  const version = ++workspaceRefreshVersion;
  try {
    const [{data, error}, invitations] = await Promise.all([
      supabase.from('workspaces').select('id,name,owner_id').order('created_at'),
      rpc('my_workspace_invitations'),
    ]);
    if (version !== workspaceRefreshVersion || currentUser?.id !== userId) return;
    if (error) throw error;
    workspaces = data;
    workspaceSelect.replaceChildren(new Option('Choose a workspace', ''),
      ...data.map((team) => new Option(team.name, team.id)));
    renderInvitations(invitations);
    let saved;
    try { saved = localStorage.getItem(`workspace:${userId}`); } catch {}
    const next = [preferred, selectedWorkspace, saved, data[0]?.id]
      .find((id) => data.some((team) => team.id === id)) || '';
    if (next !== selectedWorkspace || !activeChat) await selectWorkspace(next);
    else {
      workspaceSelect.value = next;
      void refreshTeamDetails();
    }
    if (!data.length) {
      workspaceStatus.textContent = 'Create a workspace or accept an invitation to get started.';
      setTeamSettings(true);
    }
    if (invitations.length && !data.length) setTeamSettings(true);
  } catch (error) {
    if (version !== workspaceRefreshVersion || currentUser?.id !== userId) return;
    stopChat();
    workspaceStatus.textContent = scopeError(error);
  }
}

function settingsRow(label, action, onClick) {
  const row = document.createElement('li');
  const text = document.createElement('span');
  text.textContent = label;
  row.append(text);
  if (action) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'text-button';
    button.textContent = action;
    button.addEventListener('click', () => runTeamAction(button, onClick));
    row.append(button);
  }
  return row;
}
function renderInvitations(invitations) {
  document.querySelector('#my-invitations').replaceChildren(...(invitations.length
    ? invitations.map((invitation) => settingsRow(invitation.workspace_name, 'Accept', async () => {
      const id = await rpc('accept_workspace_invitation', {p_invitation_id: invitation.id});
      await refreshWorkspaces(id);
    })) : [settingsRow('No pending invitations.')]));
}
async function refreshTeamDetails() {
  const id = selectedWorkspace;
  const userId = currentUser?.id;
  document.querySelector('#team-members').replaceChildren();
  document.querySelector('#pending-invitations').replaceChildren();
  if (!id) return;
  const owner = isOwner();
  const [members, invites] = await Promise.all([
    supabase.from('workspace_members').select('user_id,display_name').eq('workspace_id', id),
    owner ? supabase.from('workspace_invitations').select('id,email,expires_at').eq('workspace_id', id)
      : Promise.resolve({data: []}),
  ]);
  if (selectedWorkspace !== id || currentUser?.id !== userId) return;
  if (members.error || invites.error) {
    workspaceStatus.textContent = 'Could not load team details. Try Refresh.';
    return;
  }
  document.querySelector('#team-members').replaceChildren(...members.data.map((member) =>
    settingsRow(member.display_name + (member.user_id === selectedTeam()?.owner_id ? ' · Owner' : ''),
      owner && member.user_id !== userId ? 'Remove' : '', async () => {
        await rpc('remove_workspace_member', {p_workspace_id: id, p_user_id: member.user_id});
        await refreshTeamDetails();
      })));
  document.querySelector('#pending-invitations').replaceChildren(...(invites.data.length
    ? invites.data.map((invite) => settingsRow(`${invite.email}${new Date(invite.expires_at) < new Date() ? ' · Expired' : ''}`, 'Revoke', async () => {
      await rpc('revoke_workspace_invitation', {p_invitation_id: invite.id});
      await refreshTeamDetails();
    })) : [settingsRow('No pending invitations.')]));
}
async function runTeamAction(button, action) {
  button.disabled = true;
  workspaceStatus.textContent = '';
  const userId = currentUser?.id;
  try { await action(); }
  catch (error) {
    if (userId === currentUser?.id) workspaceStatus.textContent = scopeError(error);
  } finally { button.disabled = false; }
}

function renderAccount(profile) {
  const name = document.createElement('span');
  name.className = 'account-name';
  name.textContent = profile.name;
  accountProfile.replaceChildren(avatarElement(profile.name, profile.avatar), name);
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

workspaceSelect.addEventListener('change', () => void selectWorkspace(workspaceSelect.value));
manageTeam.addEventListener('click', () => {
  setTeamSettings(teamSettings.hidden);
  if (!teamSettings.hidden) void refreshWorkspaces();
});
document.querySelector('#refresh-teams').addEventListener('click', () => void refreshWorkspaces());
document.querySelector('#create-workspace').addEventListener('submit', (event) => {
  event.preventDefault();
  const input = document.querySelector('#workspace-name');
  const name = input.value.trim();
  if (!name) return;
  void runTeamAction(event.submitter, async () => {
    const id = await rpc('create_workspace', {p_name: name});
    input.value = '';
    await refreshWorkspaces(id);
  });
});
document.querySelector('#invite-member').addEventListener('submit', (event) => {
  event.preventDefault();
  const id = selectedWorkspace;
  const input = document.querySelector('#invite-email');
  const email = input.value.trim().toLowerCase();
  void runTeamAction(event.submitter, async () => {
    await rpc('invite_workspace_member', {p_workspace_id: id, p_email: email});
    input.value = '';
    if (selectedWorkspace === id) {
      workspaceStatus.textContent = `Invitation ready for ${email}. They can accept it in Manage team.`;
      await refreshTeamDetails();
    }
  });
});
document.querySelector('#copy-discussion').addEventListener('click', async () => {
  const chat = activeChat;
  if (!chat) return;
  try {
    await navigator.clipboard.writeText(chat.discussionId);
    if (chat === activeChat) workspaceStatus.textContent = 'Discussion code copied. Share it with a workspace member.';
  } catch {
    if (chat === activeChat) {
      discussionCode.select();
      workspaceStatus.textContent = 'Select and copy the discussion code manually.';
    }
  }
});
document.querySelector('#link-discussion').addEventListener('submit', (event) => {
  event.preventDefault();
  const id = selectedWorkspace;
  const code = document.querySelector('#link-code').value.trim();
  if (!validDiscussionCode(code)) {
    workspaceStatus.textContent = 'Paste a valid discussion code.';
    return;
  }
  void runTeamAction(event.submitter, async () => {
    const linkedId = await rpc('link_thread_discussion', {
      p_workspace_id: id, p_gmail_key: gmailKey, p_discussion_id: code,
    });
    if (selectedWorkspace === id) await openDiscussion(id, linkedId);
  });
});
// Membership is checked by RLS on every request. Refresh the local team list
// as well, so a revoked membership also clears already-rendered history.
setInterval(() => { if (!document.hidden && currentUser) void refreshWorkspaces(); }, 30000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && currentUser) void refreshWorkspaces();
});

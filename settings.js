import { mountAccount } from './account.js';
import { rpc, scopeError, supabase } from './backend.js';
import { showDiscussionSettings } from './settings-discussion.js';
import { showActivity } from './activity.js';
import { gmailPermission } from './gmail-metadata.js';
import { validDiscussionCode } from './thread-context.js';
import { fetchWorkspaces, preferredWorkspace, workspaceStorageKey } from './workspaces.js';

const page = new URL(location.href);
const isPopup = page.searchParams.has('popup');
const startSignIn = !isPopup && page.searchParams.has('sign-in');
let startGmailAccess = !isPopup && page.searchParams.has('gmail-access');
let inviteId = page.searchParams.get('invite');
if (!validDiscussionCode(inviteId ?? '')) inviteId = null;
if (isPopup) document.body.classList.add('settings-popup');
if (startSignIn || startGmailAccess) history.replaceState(null, '', 'settings.html');

const workspaceView = document.querySelector('#workspace-view');
const workspaceSelect = document.querySelector('#workspace-select');
const workspaceStatus = document.querySelector('#workspace-status');
const ownerSettings = document.querySelector('#owner-settings');
const memberSettings = document.querySelector('#member-settings');
const workspaceControls = document.querySelector('#workspace-controls');
const activityView = document.querySelector('#activity-view');
const workspaceViewButton = document.querySelector('#workspace-view-button');
const activityViewButton = document.querySelector('#activity-view-button');
const createSettings = document.querySelector('#create-settings');
const peopleSettings = document.querySelector('#people-settings');

let currentUser;
let workspaces = [];
let selectedWorkspace = '';
let refreshVersion = 0;
let detailsVersion = 0;

function showSettingsView(activity) {
  workspaceControls.hidden = activity;
  activityView.hidden = !activity;
  workspaceViewButton.setAttribute('aria-pressed', String(!activity));
  activityViewButton.setAttribute('aria-pressed', String(activity));
}

workspaceViewButton.addEventListener('click', () => showSettingsView(false));
activityViewButton.addEventListener('click', () => showSettingsView(true));

function selectedTeam() {
  return workspaces.find((team) => team.id === selectedWorkspace);
}

function isOwner() {
  return selectedTeam()?.owner_id === currentUser.id;
}

function selectWorkspace(id) {
  selectedWorkspace = id;
  workspaceSelect.value = id;
  ownerSettings.hidden = !isOwner();
  memberSettings.hidden = !id;
  showDiscussionSettings(currentUser.id, id);
  return refreshTeamDetails();
}

async function refreshWorkspaces(preferred) {
  if (!currentUser) return;
  const userId = currentUser.id;
  const version = ++refreshVersion;
  try {
    if (preferred) localStorage.setItem(workspaceStorageKey(userId), preferred);
    const [teams, invitations] = await Promise.all([fetchWorkspaces(), rpc('my_workspace_invitations')]);
    if (version !== refreshVersion || userId !== currentUser?.id) return;
    workspaces = teams;
    workspaceSelect.replaceChildren(new Option('Choose a workspace', ''),
      ...teams.map((team) => new Option(team.name, team.id)));
    workspaceSelect.options[0].disabled = true;
    workspaceSelect.disabled = !teams.length;
    renderInvitations(invitations);
    if (!teams.length && !invitations.length) createSettings.open = true;
    if (invitations.length) peopleSettings.open = true;
    workspaceStatus.textContent = teams.length ? '' : 'Create a workspace or accept an invitation to get started.';
    await selectWorkspace(preferredWorkspace(teams, userId));
  } catch (error) {
    if (version === refreshVersion && userId === currentUser?.id) {
      workspaceStatus.textContent = scopeError(error);
    }
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
  const featured = document.querySelector('#featured-invite');
  featured.hidden = !inviteId;
  featured.replaceChildren();
  if (inviteId) {
    const invitation = invitations.find((item) => item.id === inviteId);
    if (invitation) {
      featured.append(settingsRow(invitation.workspace_name, 'Accept invitation', (userId) => acceptInvitation(invitation.id, userId)));
    } else {
      featured.textContent = 'This invitation is unavailable for this account or has expired.';
    }
  }
  document.querySelector('#my-invitations').replaceChildren(...(invitations.length
    ? invitations.map((invitation) => settingsRow(invitation.workspace_name, 'Accept',
      (userId) => acceptInvitation(invitation.id, userId))) : [settingsRow('No pending invitations.')]));
}

async function acceptInvitation(invitationId, userId) {
  const id = await rpc('accept_workspace_invitation', { p_invitation_id: invitationId });
  if (currentUser?.id !== userId) return;
  if (inviteId === invitationId) {
    inviteId = null;
    history.replaceState(null, '', 'settings.html');
  }
  await refreshWorkspaces(id);
}

function invitationRow(invite) {
  const expired = new Date(invite.expires_at) < new Date();
  const row = settingsRow(`${invite.email}${expired ? ' · Expired' : ''}`, 'Revoke', async () => {
    await rpc('revoke_workspace_invitation', {p_invitation_id: invite.id});
    await refreshTeamDetails();
  });
  if (!expired) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'text-button';
    button.textContent = 'Copy link';
    button.addEventListener('click', () => runTeamAction(button, async () => {
      await navigator.clipboard.writeText(`https://gmail-team-chat.vercel.app/#invite=${invite.id}`);
      workspaceStatus.textContent = 'Invitation link copied.';
    }));
    row.append(button);
  }
  return row;
}
async function refreshTeamDetails() {
  const version = ++detailsVersion;
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
  if (version !== detailsVersion || currentUser?.id !== userId) return;
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
    ? invites.data.map(invitationRow) : [settingsRow('No pending invitations.')]));
}
async function runTeamAction(button, action) {
  button.disabled = true;
  workspaceStatus.textContent = '';
  const userId = currentUser?.id;
  try { await action(userId); }
  catch (error) {
    if (userId === currentUser?.id) workspaceStatus.textContent = scopeError(error);
  } finally { button.disabled = false; }
}

mountAccount((user) => {
  if (currentUser?.id === user?.id) return;
  currentUser = user;
  showSettingsView(false);
  createSettings.open = false;
  peopleSettings.open = false;
  showActivity(user?.id);
  showDiscussionSettings(user?.id, '');
  refreshVersion++;
  detailsVersion++;
  workspaces = [];
  selectedWorkspace = '';
  workspaceSelect.replaceChildren();
  workspaceStatus.textContent = '';
  ownerSettings.hidden = true;
  memberSettings.hidden = true;
  workspaceView.hidden = !user;
  document.querySelector('#my-invitations').replaceChildren();
  document.querySelector('#pending-invitations').replaceChildren();
  document.querySelector('#team-members').replaceChildren();
  document.querySelector('#create-workspace').reset();
  document.querySelector('#invite-member').reset();
  if (user) {
    void refreshWorkspaces().then(() => {
      if (startGmailAccess && currentUser?.id === user.id) {
        startGmailAccess = false;
        matching.click();
      }
    });
  }
}, { isPopup, startSignIn });

workspaceSelect.addEventListener('change', () => {
  const id = workspaceSelect.value;
  localStorage.setItem(workspaceStorageKey(currentUser.id), id);
  workspaceStatus.textContent = '';
  void selectWorkspace(id);
});
window.addEventListener('storage', (event) => {
  if (currentUser && event.key === workspaceStorageKey(currentUser.id)) void refreshWorkspaces();
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) void refreshWorkspaces();
});
document.querySelector('#refresh-teams').addEventListener('click', () => void refreshWorkspaces());
document.querySelector('#create-workspace').addEventListener('submit', (event) => {
  event.preventDefault();
  const input = document.querySelector('#workspace-name');
  const name = input.value.trim();
  if (!name) return;
  void runTeamAction(event.submitter, async (userId) => {
    const id = await rpc('create_workspace', {p_name: name});
    if (currentUser?.id !== userId) return;
    input.value = '';
    createSettings.open = false;
    await refreshWorkspaces(id);
  });
});
document.querySelector('#invite-member').addEventListener('submit', (event) => {
  event.preventDefault();
  const id = selectedWorkspace;
  const input = document.querySelector('#invite-email');
  const email = input.value.trim().toLowerCase();
  void runTeamAction(event.submitter, async (userId) => {
    await rpc('invite_workspace_member', {p_workspace_id: id, p_email: email});
    if (currentUser?.id !== userId) return;
    input.value = '';
    if (selectedWorkspace === id) {
      workspaceStatus.textContent = `Invitation ready for ${email}. Copy its link under Pending invitations.`;
      await refreshTeamDetails();
    }
  });
});

const matching = document.querySelector('#enable-matching');
if (chrome.runtime.getManifest().oauth2) {
  matching.hidden = false;
  void gmailPermission().then((token) => { matching.hidden = Boolean(token); }, () => {});
  matching.addEventListener('click', () => runTeamAction(matching, async () => {
    if (isPopup) {
      await chrome.tabs.create({ url: chrome.runtime.getURL('settings.html?gmail-access=1') });
      return;
    }
    if (!await gmailPermission(true)) throw new Error('Gmail access unavailable');
    matching.hidden = true;
    workspaceStatus.textContent = 'Gmail connected. Refresh your Gmail tab to match discussions.';
  }));
}

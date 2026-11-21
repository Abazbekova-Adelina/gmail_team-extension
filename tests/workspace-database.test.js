import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const owner = '00000000-0000-0000-0000-000000000001';
const member = '00000000-0000-0000-0000-000000000002';
const outsider = '00000000-0000-0000-0000-000000000003';
const unverified = '00000000-0000-0000-0000-000000000004';

test('private workspace and per-thread database authorization', async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`
    create role anon;
    create role authenticated;
    create schema auth;
    create table auth.users (id uuid primary key, email text, email_confirmed_at timestamptz, raw_user_meta_data jsonb default '{}');
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
    grant usage on schema auth to authenticated, anon;
    grant execute on function auth.uid(), auth.jwt() to authenticated, anon;
    create publication supabase_realtime;
    insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data) values
      ('${owner}', 'owner@example.com', now(), '{"full_name":"Owner"}'),
      ('${member}', 'member@example.com', now(), '{"full_name":"Member"}'),
      ('${outsider}', 'outsider@example.com', now(), '{"full_name":"Outsider"}'),
      ('${unverified}', 'unverified@example.com', null, '{}');
  `);
  for (const file of ['20261121180323_create_team_messages.sql', '20261121193000_add_author_avatars.sql']) {
    await db.exec(await readFile(new URL(`../supabase/migrations/${file}`, import.meta.url), 'utf8'));
  }
  // An old public message must survive migration without being readable.
  await db.query(`insert into public.team_messages(author_id,author_name,client_id,body) values ($1,'Owner',gen_random_uuid(),'legacy public message')`, [owner]);
  await db.exec(await readFile(new URL('../supabase/migrations/20261121203000_private_workspaces_and_threads.sql', import.meta.url), 'utf8'));
  await db.exec(await readFile(new URL('../supabase/migrations/20261122200000_thread_matching_and_activity.sql', import.meta.url), 'utf8'));
  await db.exec(await readFile(new URL('../supabase/migrations/20261122210000_message_reactions.sql', import.meta.url), 'utf8'));
  await db.exec(await readFile(new URL('../supabase/migrations/20261123090000_shared_thread_lookup.sql', import.meta.url), 'utf8'));
  await db.exec(await readFile(new URL('../supabase/migrations/20261123110000_assistant_usage.sql', import.meta.url), 'utf8'));
  const as = async (id) => {
    await db.exec('reset role');
    await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [id]);
    await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({sub:id,user_metadata:{full_name:id === owner ? 'Owner' : 'Member'}})]);
    await db.exec('set role authenticated');
  };
  const scalar = async (sql, args = []) => Object.values((await db.query(sql,args)).rows[0])[0];
  const call = (name, args = []) => scalar(`select public.${name}(${args.map((_, i) => '$'+(i+1)).join(',')})`, args);
  const post = (workspace, discussion, text = 'private message') => db.query(
    'insert into public.team_messages(client_id,body,workspace_id,discussion_id) values (gen_random_uuid(),$1,$2,$3) returning id',
    [text,workspace,discussion]);

  await as(owner);
  assert.equal(await scalar('select count(*)::int from public.team_messages'), 0);
  await assert.rejects(() => call('create_workspace',['  ']));
  const team = await call('create_workspace',['Design']);
  const first = await call('open_thread_discussion',[team,'gmail:thread-one']);
  const second = await call('open_thread_discussion',[team,'gmail:thread-two']);
  assert.notEqual(first,second);
  for (let i=0; i<20; i++) assert.equal(await call('claim_assistant_request',[first]),true);
  assert.equal(await call('claim_assistant_request',[second]),false);
  await assert.rejects(()=>db.query('select * from public.assistant_usage'));
  await db.exec('reset role');
  await db.query("update public.assistant_usage set window_start=now()-interval '2 hours' where user_id=$1",[owner]);
  await as(owner);
  assert.equal(await call('claim_assistant_request',[first]),true);
  assert.equal(await call('open_thread_discussion',[team,'gmail:thread-one']),first);
  await post(team,first);
  await post(team,second,'second thread');
  assert.equal(await scalar('select count(*)::int from public.team_messages where discussion_id=$1',[first]),1);
  const invite = await call('invite_workspace_member',[team,' Member@Example.com ']);
  const messageKey = 'a'.repeat(64);
  assert.equal(await call('match_thread_discussion',[team,'gmail:thread-one',messageKey]), first);
  const mention = (await post(team,first,`Can you review this? @{${member}}`)).rows[0].id;
  await assert.rejects(() => post(null,null));
  await assert.rejects(() => db.query('insert into public.workspace_members values ($1,$2,$3)',[team,outsider,'Intruder']));

  await as(outsider);
  await assert.rejects(()=>call('claim_assistant_request',[first]));
  assert.equal(await scalar('select count(*)::int from public.workspaces'),0);
  assert.equal(await scalar('select count(*)::int from public.team_messages'),0);
  assert.equal(await scalar('select count(*)::int from public.workspace_members'),0);
  assert.equal(await scalar('select count(*)::int from public.workspace_invitations'),0);
  await assert.rejects(() => call('accept_workspace_invitation',[invite]));
  await assert.rejects(() => call('open_thread_discussion',[team,'gmail:thread-one']));
  await assert.rejects(() => post(team,first));
  await assert.rejects(() => call('link_thread_discussion',[team,'gmail:other',first]));
  const otherTeam = await call('create_workspace',['Unrelated']);
  const otherThread = await call('open_thread_discussion',[otherTeam,'gmail:thread-one']);
  assert.equal(await call('match_thread_discussion',[otherTeam,'gmail:thread-one',messageKey]), otherThread);
  assert.notEqual(otherThread, first);
  const outsiderShared = (await db.query('select * from public.shared_thread_discussions($1)', [messageKey])).rows;
  assert.deepEqual(outsiderShared.map((row) => row.discussion_id), [otherThread]);
  assert.equal(await scalar('select count(*)::int from public.chat_activity()'), 0);
  await assert.rejects(() => call('set_message_reaction',[mention,'❤️']));
  await post(otherTeam,otherThread,'other workspace');
  await assert.rejects(() => post(otherTeam,first));
  await assert.rejects(() => call('link_thread_discussion',[otherTeam,'gmail:copy',first]));

  await as(member);
  const invites = (await db.query('select * from public.my_workspace_invitations()')).rows;
  assert.equal(invites.length,1);
  assert.equal(invites[0].workspace_name,'Design');
  assert.equal(await call('accept_workspace_invitation',[invite]),team);
  const shared = (await db.query('select * from public.shared_thread_discussions($1)', [messageKey])).rows;
  assert.deepEqual(shared.map((row) => [row.workspace_id, row.discussion_id]), [[team, first]]);
  assert.equal(await scalar('select count(*)::int from public.shared_thread_discussions($1)', ['not-a-key']), 0);
  assert.equal((await call('set_message_reaction',[mention,'❤️'])).emoji, '❤️');
  assert.equal((await call('set_message_reaction',[mention,'👍'])).emoji, '👍');
  await assert.rejects(() => call('set_message_reaction',[mention,'invalid']));
  assert.equal(await scalar('select count(*)::int from public.message_reactions'),1);
  assert.equal((await call('set_message_reaction',[mention,null])).emoji, null);
  assert.equal(await scalar('select count(*)::int from public.team_messages'),3);
  assert.equal(await call('match_thread_discussion',[team,'gmail:matched-mailbox-id',messageKey]), first);
  const activity = (await db.query('select * from public.chat_activity() where discussion_id=$1', [first])).rows[0];
  assert.equal(Number(activity.unread_count), 2);
  assert.equal(Number(activity.mention_count), 1);
  assert.equal(activity.gmail_key, 'gmail:matched-mailbox-id');
  await call('mark_discussion_read',[first,mention]);
  assert.equal(await scalar('select count(*)::int from public.chat_activity() where discussion_id=$1',[first]), 0);
  await post(team,first,'teammate reply');
  await assert.rejects(() => call('invite_workspace_member',[team,'another@example.com']));
  await assert.rejects(() => call('remove_workspace_member',[team,owner]));
  await assert.rejects(() => db.query('insert into public.team_messages(client_id,body,workspace_id,discussion_id,author_id) values (gen_random_uuid(),$1,$2,$3,$4)',['spoof',team,first,owner]));
  assert.equal(await call('link_thread_discussion',[team,'gmail:different-mailbox-id',first]),first);
  assert.equal(await call('open_thread_discussion',[team,'gmail:different-mailbox-id']),first);
  assert.equal(await call('link_thread_discussion',[team,'gmail:manual-link',second]),second);
  assert.equal(await call('match_thread_discussion',[team,'gmail:manual-link',messageKey]),second);
  assert.equal(await scalar('select count(*)::int from public.team_messages where discussion_id=$1',[first]),3);

  // Different Gmail accounts can already have separate local discussions.
  // Joining a shared code must expose both directions of the selected history,
  // without leaking or silently moving messages from the previous discussion.
  const separate = await call('open_thread_discussion', [team, 'gmail:previously-connected-copy']);
  await post(team, separate, 'old separate history');
  assert.equal(await call('link_thread_discussion', [team, 'gmail:previously-connected-copy', first]), first);
  await post(team, first, 'reply after joining shared code');
  const sharedHistory = await db.query('select body from public.team_messages where discussion_id=$1 order by id', [first]);
  assert.deepEqual(sharedHistory.rows.map((row) => row.body), [
    'private message', `Can you review this? @{${member}}`, 'teammate reply', 'reply after joining shared code',
  ]);
  await as(owner);
  assert.equal(await scalar('select body from public.team_messages where discussion_id=$1 order by id desc limit 1', [first]), 'reply after joining shared code');
  assert.equal(await scalar('select count(*)::int from public.team_messages where discussion_id=$1', [separate]), 1);

  // Seed the histories that pre-automatic clients left in separate mailboxes.
  const automaticKey = 'c'.repeat(64);
  const unrelatedKey = 'b'.repeat(64);
  const ambiguousKeys = ['d'.repeat(64), 'e'.repeat(64)];
  const canonical = await call('open_thread_discussion', [team, 'gmail:automatic-owner']);
  const originalMessage = (await post(team, canonical, 'owner existing email history')).rows[0].id;
  assert.equal(await call('match_thread_discussion', [team, 'gmail:automatic-owner', automaticKey]), canonical);
  const unrelated = await call('open_thread_discussion', [team, 'gmail:unrelated-email']);
  await post(team, unrelated, 'unrelated email history');
  await call('match_thread_discussion', [team, 'gmail:unrelated-email', unrelatedKey]);
  const ambiguous = await call('open_thread_discussion', [team, 'gmail:legacy-mixed']);
  await post(team, ambiguous, 'unattributable manual history');
  for (const key of ambiguousKeys) await call('match_thread_discussion', [team, 'gmail:legacy-mixed', key]);
  const adoptable = await call('open_thread_discussion', [team, 'gmail:unkeyed-original']);
  await post(team, adoptable, 'unkeyed original history');
  const manuallyLinked = await call('open_thread_discussion', [team, 'gmail:manual-unkeyed-original']);
  await post(team, manuallyLinked, 'unkeyed manual history');

  await as(member);
  const localCopy = await call('open_thread_discussion', [team, 'gmail:automatic-member']);
  const importedMessage = (await post(team, localCopy, 'member existing email history')).rows[0].id;
  await call('set_message_reaction', [importedMessage, '❤️']);
  await call('link_thread_discussion', [team, 'gmail:manual-unkeyed-copy', manuallyLinked]);
  await call('mark_discussion_read', [canonical, originalMessage]);
  await call('mark_discussion_read', [localCopy, importedMessage]);
  await call('link_thread_discussion', [team, 'gmail:manual-auto-copy', unrelated]);
  await db.exec('reset role');
  await db.exec(await readFile(new URL('../supabase/migrations/20261123100000_automatic_thread_discussion.sql', import.meta.url), 'utf8'));

  await as(member);
  await assert.rejects(() => call('open_thread_discussion', [team, 'gmail:retired-open']));
  await assert.rejects(() => call('match_thread_discussion', [team, 'gmail:retired-match', automaticKey]));
  await assert.rejects(() => call('link_thread_discussion', [team, 'gmail:retired-link', canonical]));
  assert.equal(await call('automatic_thread_discussion', [team, 'gmail:automatic-member', automaticKey]), canonical);
  assert.equal(await scalar('select count(*)::int from public.discussions where id=$1', [localCopy]), 0);
  const merged = (await db.query('select id, body from public.team_messages where discussion_id=$1 order by id', [canonical])).rows;
  assert.deepEqual(merged, [
    { id: originalMessage, body: 'owner existing email history' },
    { id: importedMessage, body: 'member existing email history' },
  ]);
  assert.equal(await scalar('select discussion_id from public.message_reactions where message_id=$1', [importedMessage]), canonical);
  assert.equal(await scalar('select emoji from public.message_reactions where message_id=$1', [importedMessage]), '❤️');
  assert.equal(await scalar('select discussion_id from public.discussion_bindings where gmail_key=$1', ['gmail:automatic-member']), canonical);
  assert.equal(Number(await scalar('select unread_count from public.chat_activity() where discussion_id=$1', [canonical])), 1);
  await db.exec('reset role');
  assert.equal(await scalar('select count(*)::int from public.discussion_reads where discussion_id in ($1,$2)', [canonical, localCopy]), 0);
  assert.equal(await scalar('select discussion_id from public.discussion_message_keys where workspace_id=$1 and message_key=$2', [team, automaticKey]), canonical);
  await as(owner);
  assert.equal(await call('automatic_thread_discussion', [team, 'gmail:automatic-owner', automaticKey]), canonical);
  assert.equal(await call('automatic_thread_discussion', [team, 'gmail:another-owner-local-id', automaticKey]), canonical);
  assert.equal(await scalar('select count(*)::int from public.team_messages where discussion_id=$1', [canonical]), 2);
  await post(team, canonical, 'owner reply after automatic repair');
  await as(member);
  assert.equal(await call('automatic_thread_discussion', [team, 'gmail:automatic-member', automaticKey]), canonical);
  assert.equal(await scalar('select body from public.team_messages where discussion_id=$1 order by id desc limit 1', [canonical]), 'owner reply after automatic repair');

  // A manual binding and a changed hash must not pull unrelated histories in.
  assert.equal(await call('automatic_thread_discussion', [team, 'gmail:manual-auto-copy', automaticKey]), canonical);
  assert.equal(await scalar('select body from public.team_messages where discussion_id=$1', [unrelated]), 'unrelated email history');
  assert.equal(await call('automatic_thread_discussion', [team, 'gmail:manual-unkeyed-copy', automaticKey]), canonical);
  assert.equal(await scalar('select body from public.team_messages where discussion_id=$1', [manuallyLinked]), 'unkeyed manual history');
  assert.equal(await call('automatic_thread_discussion', [team, 'gmail:automatic-member', unrelatedKey]), unrelated);
  assert.equal(await call('automatic_thread_discussion', [team, 'gmail:automatic-member', automaticKey]), canonical);
  assert.equal(await scalar('select count(*)::int from public.team_messages where discussion_id=$1', [canonical]), 3);
  assert.equal(await scalar('select count(*)::int from public.team_messages where discussion_id=$1', [unrelated]), 1);

  // Quarantining mixed legacy hashes must persist after the first key moves;
  // otherwise the final remaining key would incorrectly inherit mixed history.
  await as(owner);
  const repairedAmbiguous = [];
  for (const key of ambiguousKeys) {
    const discussion = await call('automatic_thread_discussion', [team, 'gmail:legacy-mixed', key]);
    assert.notEqual(discussion, ambiguous);
    assert.equal(await scalar('select count(*)::int from public.team_messages where discussion_id=$1', [discussion]), 0);
    repairedAmbiguous.push(discussion);
  }
  assert.notEqual(repairedAmbiguous[0], repairedAmbiguous[1]);
  assert.equal(await scalar('select body from public.team_messages where discussion_id=$1', [ambiguous]), 'unattributable manual history');
  assert.equal(await call('automatic_thread_discussion', [team, 'gmail:legacy-mixed', ambiguousKeys[0]]), repairedAmbiguous[0]);

  // No local-only fallback and no partial binding creation on bad identities.
  for (const key of [null, '', 'not-a-hash', 'A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65)]) {
    await assert.rejects(() => call('automatic_thread_discussion', [team, 'gmail:invalid-identity', key]), /verified email identity/);
  }
  for (const gmailKey of [null, '', 'x'.repeat(241)]) {
    await assert.rejects(() => call('automatic_thread_discussion', [team, gmailKey, automaticKey]), /Open a Gmail thread/);
  }
  assert.equal(await scalar('select count(*)::int from public.discussion_bindings where gmail_key=$1', ['gmail:invalid-identity']), 0);
  await as(outsider);
  await assert.rejects(() => call('automatic_thread_discussion', [team, 'gmail:automatic-owner', automaticKey]), /Workspace membership required/);
  const isolated = await call('automatic_thread_discussion', [otherTeam, 'gmail:automatic-owner', automaticKey]);
  assert.notEqual(isolated, canonical);
  await post(otherTeam, isolated, 'same email in a different workspace');
  assert.equal(await scalar('select count(*)::int from public.team_messages where discussion_id=$1', [canonical]), 0);
  await as(member);
  assert.equal(await scalar('select count(*)::int from public.team_messages where discussion_id=$1', [isolated]), 0);
  assert.equal(await call('automatic_thread_discussion', [team, 'gmail:brand-new-local-id', automaticKey]), canonical);
  const newKey = 'f'.repeat(64);
  const newDiscussion = await call('automatic_thread_discussion', [team, 'gmail:new-email-member', newKey]);
  assert.notEqual(newDiscussion, canonical);
  await as(owner);
  assert.equal(await call('automatic_thread_discussion', [team, 'gmail:new-email-owner', newKey]), newDiscussion);
  assert.equal(await call('automatic_thread_discussion', [team, 'gmail:unkeyed-original', '1'.repeat(64)]), adoptable);
  assert.equal(await scalar('select body from public.team_messages where discussion_id=$1', [adoptable]), 'unkeyed original history');

  await as(owner);
  const expired = await call('invite_workspace_member',[team,'member@example.com']).catch(() => null);
  assert.equal(expired,null); // existing members cannot be reinvited
  const revoke = await call('invite_workspace_member',[team,'outsider@example.com']);
  await call('revoke_workspace_invitation',[revoke]);
  const unverifiedInvite = await call('invite_workspace_member',[team,'unverified@example.com']);
  const expiredInvite = await call('invite_workspace_member',[team,'outsider@example.com']);
  await db.exec('reset role');
  await db.query('update public.workspace_invitations set expires_at=now()-interval \'1 second\' where id=$1',[expiredInvite]);
  await as(unverified);
  await assert.rejects(() => call('accept_workspace_invitation',[unverifiedInvite]));
  await as(outsider);
  await assert.rejects(() => call('accept_workspace_invitation',[revoke]));
  await assert.rejects(() => call('accept_workspace_invitation',[expiredInvite]));

  await as(owner);
  await call('remove_workspace_member',[team,member]);
  await assert.rejects(() => call('remove_workspace_member',[team,owner]));
  await as(member);
  assert.equal(await scalar('select count(*)::int from public.team_messages'),0);
  assert.equal(await scalar('select count(*)::int from public.message_reactions'),0);
  assert.equal(await scalar('select count(*)::int from public.chat_activity()'),0);
  await assert.rejects(() => post(team,first));
  await assert.rejects(() => call('open_thread_discussion',[team,'gmail:thread-one']));
  await assert.rejects(() => call('automatic_thread_discussion', [team, 'gmail:automatic-member', automaticKey]));
  await db.exec('reset role; set role anon');
  await assert.rejects(() => call('create_workspace',['Anonymous']));
  await assert.rejects(()=>call('claim_assistant_request',[first]));
  await assert.rejects(() => call('automatic_thread_discussion', [team, 'gmail:automatic-owner', automaticKey]));
  await assert.rejects(() => db.query('select * from public.team_messages'));
  await assert.rejects(() => db.query('select * from public.chat_activity()'));
  await db.exec('reset role');
  assert.equal(await scalar('select count(*)::int from public.team_messages where workspace_id is null'),1);
});

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
  assert.equal(await call('open_thread_discussion',[team,'gmail:thread-one']),first);
  await post(team,first);
  await post(team,second,'second thread');
  assert.equal(await scalar('select count(*)::int from public.team_messages where discussion_id=$1',[first]),1);
  const invite = await call('invite_workspace_member',[team,' Member@Example.com ']);
  await assert.rejects(() => post(null,null));
  await assert.rejects(() => db.query('insert into public.workspace_members values ($1,$2,$3)',[team,outsider,'Intruder']));

  await as(outsider);
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
  await post(otherTeam,otherThread,'other workspace');
  await assert.rejects(() => post(otherTeam,first));
  await assert.rejects(() => call('link_thread_discussion',[otherTeam,'gmail:copy',first]));

  await as(member);
  const invites = (await db.query('select * from public.my_workspace_invitations()')).rows;
  assert.equal(invites.length,1);
  assert.equal(invites[0].workspace_name,'Design');
  assert.equal(await call('accept_workspace_invitation',[invite]),team);
  assert.equal(await scalar('select count(*)::int from public.team_messages'),2);
  await post(team,first,'teammate reply');
  await assert.rejects(() => call('invite_workspace_member',[team,'another@example.com']));
  await assert.rejects(() => call('remove_workspace_member',[team,owner]));
  await assert.rejects(() => db.query('insert into public.team_messages(client_id,body,workspace_id,discussion_id,author_id) values (gen_random_uuid(),$1,$2,$3,$4)',['spoof',team,first,owner]));
  assert.equal(await call('link_thread_discussion',[team,'gmail:different-mailbox-id',first]),first);
  assert.equal(await call('open_thread_discussion',[team,'gmail:different-mailbox-id']),first);
  assert.equal(await scalar('select count(*)::int from public.team_messages where discussion_id=$1',[first]),2);

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
  await assert.rejects(() => post(team,first));
  await assert.rejects(() => call('open_thread_discussion',[team,'gmail:thread-one']));
  await db.exec('reset role; set role anon');
  await assert.rejects(() => call('create_workspace',['Anonymous']));
  await assert.rejects(() => db.query('select * from public.team_messages'));
  await db.exec('reset role');
  assert.equal(await scalar('select count(*)::int from public.team_messages where workspace_id is null'),1);
});

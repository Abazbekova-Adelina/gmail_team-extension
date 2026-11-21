begin;

create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 80),
  owner_id uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);
create table public.workspace_members (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  display_name text not null,
  primary key (workspace_id, user_id)
);
create table public.workspace_invitations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  email text not null check (email = lower(btrim(email)) and char_length(email) <= 320 and email ~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'),
  expires_at timestamptz not null default now() + interval '7 days',
  unique (workspace_id, email)
);
create table public.discussions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  gmail_key text not null check (char_length(gmail_key) between 1 and 240),
  unique (workspace_id, gmail_key),
  unique (id, workspace_id)
);
create table public.discussion_bindings (
  user_id uuid not null references auth.users(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  gmail_key text not null check (char_length(gmail_key) between 1 and 240),
  discussion_id uuid not null,
  primary key (user_id, workspace_id, gmail_key),
  foreign key (discussion_id, workspace_id) references public.discussions(id, workspace_id) on delete cascade
);

create function public.is_workspace_member(p_workspace_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.workspace_members
    where workspace_id = p_workspace_id and user_id = (select auth.uid()));
$$;
create function public.owns_workspace(p_workspace_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.workspaces
    where id = p_workspace_id and owner_id = (select auth.uid()));
$$;

alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.workspace_invitations enable row level security;
alter table public.discussions enable row level security;
alter table public.discussion_bindings enable row level security;
revoke all on public.workspaces, public.workspace_members, public.workspace_invitations,
  public.discussions, public.discussion_bindings from public, anon, authenticated;
grant select on public.workspaces, public.workspace_members, public.workspace_invitations,
  public.discussions, public.discussion_bindings to authenticated;
create policy "Members read their workspaces" on public.workspaces for select to authenticated
  using (public.is_workspace_member(id));
create policy "Members read their team" on public.workspace_members for select to authenticated
  using (public.is_workspace_member(workspace_id));
create policy "Owners read invitations" on public.workspace_invitations for select to authenticated
  using (public.owns_workspace(workspace_id));
create policy "Members read discussions" on public.discussions for select to authenticated
  using (public.is_workspace_member(workspace_id));
create policy "Members read their own thread bindings" on public.discussion_bindings for select to authenticated
  using (user_id = (select auth.uid()) and public.is_workspace_member(workspace_id));

-- Legacy shared messages have no trustworthy workspace or thread attribution.
-- Preserve them, but never expose or silently assign them to a new private team.
alter table public.team_messages add column workspace_id uuid references public.workspaces(id);
alter table public.team_messages add column discussion_id uuid;
alter table public.team_messages add foreign key (discussion_id, workspace_id)
  references public.discussions(id, workspace_id);
alter table public.team_messages add constraint message_scope_pair
  check ((workspace_id is null) = (discussion_id is null));
create index team_messages_discussion_history on public.team_messages(discussion_id, id desc);
drop policy "Signed-in users read the shared chat" on public.team_messages;
drop policy "Signed-in users post as themselves" on public.team_messages;
create policy "Members read scoped messages" on public.team_messages for select to authenticated
  using (workspace_id is not null and discussion_id is not null and public.is_workspace_member(workspace_id));
create policy "Members post to their discussions" on public.team_messages for insert to authenticated
  with check (author_id = (select auth.uid()) and workspace_id is not null
    and discussion_id is not null and public.is_workspace_member(workspace_id));
grant insert (workspace_id, discussion_id) on public.team_messages to authenticated;

create function public.create_workspace(p_name text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_name text;
begin
  if auth.uid() is null then raise exception 'Sign in first.'; end if;
  if p_name is null or char_length(btrim(p_name)) not between 1 and 80 then
    raise exception 'Use a workspace name between 1 and 80 characters.';
  end if;
  select left(coalesce(nullif(raw_user_meta_data ->> 'full_name', ''), nullif(raw_user_meta_data ->> 'name', ''), 'Google user'), 120)
    into v_name from auth.users where id = auth.uid();
  insert into public.workspaces(name, owner_id) values (btrim(p_name), auth.uid()) returning id into v_id;
  insert into public.workspace_members values (v_id, auth.uid(), v_name);
  return v_id;
end;
$$;

create function public.invite_workspace_member(p_workspace_id uuid, p_email text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_email text := lower(btrim(p_email));
begin
  if not public.owns_workspace(p_workspace_id) then raise exception 'Only the owner can invite teammates.'; end if;
  if v_email is null or char_length(v_email) > 320 or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$' then
    raise exception 'Enter a valid email address.';
  end if;
  if exists (select 1 from public.workspace_members m join auth.users u on u.id = m.user_id
    where m.workspace_id = p_workspace_id and lower(u.email) = v_email) then
    raise exception 'This person is already a member.';
  end if;
  insert into public.workspace_invitations(workspace_id, email) values (p_workspace_id, v_email)
    on conflict (workspace_id, email) do update set expires_at = now() + interval '7 days'
    returning id into v_id;
  return v_id;
end;
$$;

create function public.my_workspace_invitations()
returns table (id uuid, workspace_name text, expires_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select i.id, w.name, i.expires_at from public.workspace_invitations i
    join public.workspaces w on w.id = i.workspace_id
    join auth.users u on u.id = (select auth.uid())
    where i.email = lower(u.email) and u.email_confirmed_at is not null and i.expires_at > now();
$$;

create function public.accept_workspace_invitation(p_invitation_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_invite public.workspace_invitations; v_user auth.users;
begin
  select * into v_user from auth.users where id = auth.uid() and email_confirmed_at is not null;
  if not found then raise exception 'Sign in with a verified Google account.'; end if;
  select * into v_invite from public.workspace_invitations
    where id = p_invitation_id and email = lower(v_user.email) and expires_at > now() for update;
  if not found then raise exception 'Invitation is unavailable for this account or has expired.'; end if;
  insert into public.workspace_members(workspace_id, user_id, display_name)
    values (v_invite.workspace_id, v_user.id, left(coalesce(nullif(v_user.raw_user_meta_data ->> 'full_name', ''), nullif(v_user.raw_user_meta_data ->> 'name', ''), 'Google user'), 120))
    on conflict do nothing;
  delete from public.workspace_invitations where id = v_invite.id;
  return v_invite.workspace_id;
end;
$$;

create function public.revoke_workspace_invitation(p_invitation_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  delete from public.workspace_invitations where id = p_invitation_id and public.owns_workspace(workspace_id);
  if not found then raise exception 'Invitation unavailable.'; end if;
end;
$$;

create function public.remove_workspace_member(p_workspace_id uuid, p_user_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.owns_workspace(p_workspace_id) or p_user_id = auth.uid() then
    raise exception 'Only the owner can remove other members.';
  end if;
  delete from public.workspace_members where workspace_id = p_workspace_id and user_id = p_user_id;
end;
$$;

create function public.open_thread_discussion(p_workspace_id uuid, p_gmail_key text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if not public.is_workspace_member(p_workspace_id) then raise exception 'Workspace membership required.'; end if;
  if p_gmail_key is null or char_length(p_gmail_key) not between 1 and 240 then raise exception 'Open a Gmail thread first.'; end if;
  -- Serialize opening and linking the same local thread across tabs.
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text || p_workspace_id::text || p_gmail_key, 0));
  select discussion_id into v_id from public.discussion_bindings
    where user_id = auth.uid() and workspace_id = p_workspace_id and gmail_key = p_gmail_key;
  if v_id is not null then return v_id; end if;
  insert into public.discussions(workspace_id, gmail_key) values (p_workspace_id, p_gmail_key)
    on conflict (workspace_id, gmail_key) do update set gmail_key = excluded.gmail_key returning id into v_id;
  insert into public.discussion_bindings values (auth.uid(), p_workspace_id, p_gmail_key, v_id);
  return v_id;
end;
$$;

create function public.link_thread_discussion(p_workspace_id uuid, p_gmail_key text, p_discussion_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_workspace_member(p_workspace_id) then raise exception 'Workspace membership required.'; end if;
  if p_gmail_key is null or char_length(p_gmail_key) not between 1 and 240 then raise exception 'Open a Gmail thread first.'; end if;
  if not exists (select 1 from public.discussions where id = p_discussion_id and workspace_id = p_workspace_id) then
    raise exception 'Discussion is not in this workspace.';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text || p_workspace_id::text || p_gmail_key, 0));
  insert into public.discussion_bindings values (auth.uid(), p_workspace_id, p_gmail_key, p_discussion_id)
    on conflict (user_id, workspace_id, gmail_key) do update set discussion_id = excluded.discussion_id;
  return p_discussion_id;
end;
$$;

-- Functions are not executable by PUBLIC/anon, including default Postgres grants.
revoke all on function public.is_workspace_member(uuid), public.owns_workspace(uuid),
  public.create_workspace(text), public.invite_workspace_member(uuid,text),
  public.my_workspace_invitations(), public.accept_workspace_invitation(uuid),
  public.revoke_workspace_invitation(uuid), public.remove_workspace_member(uuid,uuid),
  public.open_thread_discussion(uuid,text), public.link_thread_discussion(uuid,text,uuid)
  from public, anon;
grant execute on function public.is_workspace_member(uuid), public.owns_workspace(uuid),
  public.create_workspace(text), public.invite_workspace_member(uuid,text),
  public.my_workspace_invitations(), public.accept_workspace_invitation(uuid),
  public.revoke_workspace_invitation(uuid), public.remove_workspace_member(uuid,uuid),
  public.open_thread_discussion(uuid,text), public.link_thread_discussion(uuid,text,uuid)
  to authenticated;

commit;

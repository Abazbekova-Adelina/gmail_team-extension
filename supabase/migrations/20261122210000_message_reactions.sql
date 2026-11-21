begin;

create table public.message_reactions (
  message_id integer not null references public.team_messages(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  discussion_id uuid not null,
  emoji text check (emoji in ('👍', '❤️', '🔥', '😂', '😮', '👎')),
  avatar_url text,
  primary key (message_id, user_id),
  foreign key (discussion_id, workspace_id) references public.discussions(id, workspace_id) on delete cascade
);

alter table public.message_reactions enable row level security;
revoke all on public.message_reactions from public, anon, authenticated;
grant select on public.message_reactions to authenticated;
create policy "Workspace members read reactions" on public.message_reactions
  for select to authenticated using (public.is_workspace_member(workspace_id));

create function public.set_message_reaction(p_message_id integer, p_emoji text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_reaction public.message_reactions;
begin
  insert into public.message_reactions(message_id, user_id, workspace_id, discussion_id, emoji, avatar_url)
    select m.id, auth.uid(), m.workspace_id, m.discussion_id, p_emoji,
      coalesce(auth.jwt() -> 'user_metadata' ->> 'avatar_url', auth.jwt() -> 'user_metadata' ->> 'picture')
    from public.team_messages m
    where m.id = p_message_id and public.is_workspace_member(m.workspace_id)
  on conflict (message_id, user_id) do update
    set emoji = excluded.emoji, avatar_url = excluded.avatar_url
  returning * into v_reaction;
  if not found then raise exception 'Message is unavailable.'; end if;
  return to_jsonb(v_reaction);
end;
$$;

revoke all on function public.set_message_reaction(integer,text) from public, anon;
grant execute on function public.set_message_reaction(integer,text) to authenticated;

commit;

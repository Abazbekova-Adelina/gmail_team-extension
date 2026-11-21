begin;

create table public.discussion_message_keys (
  workspace_id uuid not null,
  message_key text not null check (message_key ~ '^[a-f0-9]{64}$'),
  discussion_id uuid not null,
  primary key (workspace_id, message_key),
  foreign key (discussion_id, workspace_id) references public.discussions(id, workspace_id) on delete cascade
);

create table public.discussion_reads (
  user_id uuid not null references auth.users(id) on delete cascade,
  discussion_id uuid not null references public.discussions(id) on delete cascade,
  last_message_id integer not null,
  primary key (user_id, discussion_id)
);

alter table public.discussion_message_keys enable row level security;
alter table public.discussion_reads enable row level security;
revoke all on public.discussion_message_keys, public.discussion_reads from public, anon, authenticated;

create function public.match_thread_discussion(p_workspace_id uuid, p_gmail_key text, p_message_key text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_match uuid;
begin
  if not public.is_workspace_member(p_workspace_id) then raise exception 'Workspace membership required.'; end if;
  if p_gmail_key is null or char_length(p_gmail_key) not between 1 and 240 then raise exception 'Open a Gmail thread first.'; end if;
  if p_message_key is null or p_message_key !~ '^[a-f0-9]{64}$' then
    return public.open_thread_discussion(p_workspace_id, p_gmail_key);
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_workspace_id::text || p_message_key, 1));
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text || p_workspace_id::text || p_gmail_key, 0));
  select discussion_id into v_id from public.discussion_bindings
    where user_id = auth.uid() and workspace_id = p_workspace_id and gmail_key = p_gmail_key;
  select discussion_id into v_match from public.discussion_message_keys
    where workspace_id = p_workspace_id and message_key = p_message_key;
  if v_id is null and v_match is not null then
    insert into public.discussion_bindings values (auth.uid(), p_workspace_id, p_gmail_key, v_match);
    return v_match;
  end if;
  if v_id is null then v_id := public.open_thread_discussion(p_workspace_id, p_gmail_key); end if;
  insert into public.discussion_message_keys values (p_workspace_id, p_message_key, v_id) on conflict do nothing;
  return v_id;
end;
$$;

create function public.mark_discussion_read(p_discussion_id uuid, p_message_id integer)
returns void language sql security definer set search_path = '' as $$
  insert into public.discussion_reads(user_id, discussion_id, last_message_id)
    select auth.uid(), m.discussion_id, m.id from public.team_messages m
    where m.id = p_message_id and m.discussion_id = p_discussion_id
      and public.is_workspace_member(m.workspace_id)
  on conflict (user_id, discussion_id) do update
    set last_message_id = greatest(public.discussion_reads.last_message_id, excluded.last_message_id);
$$;

create function public.chat_activity()
returns table (discussion_id uuid, workspace_id uuid, workspace_name text,
  gmail_key text, unread_count bigint, mention_count bigint, latest_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select m.discussion_id, m.workspace_id, w.name, binding.gmail_key,
    count(*), count(*) filter (where strpos(m.body, '@{' || auth.uid()::text || '}') > 0), max(m.created_at)
  from public.workspace_members member
  join public.workspaces w on w.id = member.workspace_id
  join public.team_messages m on m.workspace_id = member.workspace_id
  left join public.discussion_reads r on r.user_id = member.user_id and r.discussion_id = m.discussion_id
  left join lateral (
    select b.gmail_key from public.discussion_bindings b
    where b.user_id = member.user_id and b.discussion_id = m.discussion_id
    order by b.gmail_key limit 1
  ) binding on true
  where member.user_id = (select auth.uid()) and m.author_id <> member.user_id
    and m.id > coalesce(r.last_message_id, 0)
  group by m.discussion_id, m.workspace_id, w.name, binding.gmail_key
  order by max(m.created_at) desc;
$$;

create index team_messages_workspace_activity on public.team_messages(workspace_id, id desc);
create index discussion_bindings_user_discussion on public.discussion_bindings(user_id, discussion_id);

revoke all on function public.match_thread_discussion(uuid,text,text),
  public.mark_discussion_read(uuid,integer), public.chat_activity() from public, anon;
grant execute on function public.match_thread_discussion(uuid,text,text),
  public.mark_discussion_read(uuid,integer), public.chat_activity() to authenticated;

commit;

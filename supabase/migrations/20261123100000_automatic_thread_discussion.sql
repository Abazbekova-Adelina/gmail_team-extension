begin;

-- Legacy manual links could attach several unrelated Message-ID hashes to one
-- discussion. Its messages have no per-email attribution: retain that history,
-- but never import it into an automatically identified email conversation.
alter table public.discussions add column automatic_identity_conflicted boolean not null default false;
update public.discussions d set automatic_identity_conflicted = true
where exists (
  select 1 from public.discussion_message_keys k
  where k.workspace_id = d.workspace_id and k.discussion_id = d.id
  group by k.discussion_id having count(*) > 1
);

-- Retire legacy writers, which use incompatible locks and allow manual links.
-- Keeping their definitions preserves migration history, not a client fallback.
revoke all on function public.open_thread_discussion(uuid,text),
  public.link_thread_discussion(uuid,text,uuid),
  public.match_thread_discussion(uuid,text,text) from public, anon, authenticated;

create function public.automatic_thread_discussion(p_workspace_id uuid, p_gmail_key text, p_message_key text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_local uuid;
  v_canonical uuid;
  v_local_safe boolean := false;
begin
  if not public.is_workspace_member(p_workspace_id) then raise exception 'Workspace membership required.'; end if;
  if p_gmail_key is null or char_length(p_gmail_key) not between 1 and 240 then
    raise exception 'Open a Gmail thread first.';
  end if;
  if p_message_key is null or p_message_key !~ '^[a-f0-9]{64}$' then
    raise exception 'A verified email identity is required.';
  end if;

  -- One lock order covers both same-hash/different-local and
  -- different-hash/same-local races, including transitive merges.
  perform pg_advisory_xact_lock(hashtextextended(p_workspace_id::text, 2));
  select b.discussion_id into v_local from public.discussion_bindings b
    where b.user_id = auth.uid() and b.workspace_id = p_workspace_id and b.gmail_key = p_gmail_key;
  select k.discussion_id into v_canonical from public.discussion_message_keys k
    join public.discussions d on d.id = k.discussion_id and d.workspace_id = k.workspace_id
    where k.workspace_id = p_workspace_id and k.message_key = p_message_key
      and not d.automatic_identity_conflicted;

  if v_local is not null then
    -- An existing exact hash is evidence. An unkeyed history is attributable
    -- only when it is still the caller's original, single-binding local chat.
    -- A manual link is not evidence that two different emails are equivalent.
    select not d.automatic_identity_conflicted
      and not exists (select 1 from public.discussion_message_keys k
        where k.workspace_id = p_workspace_id and k.discussion_id = d.id and k.message_key <> p_message_key)
      and (exists (select 1 from public.discussion_message_keys k
          where k.workspace_id = p_workspace_id and k.discussion_id = d.id and k.message_key = p_message_key)
        or (d.gmail_key = p_gmail_key and not exists (
          select 1 from public.discussion_bindings b where b.workspace_id = p_workspace_id and b.discussion_id = d.id
            and (b.user_id <> auth.uid() or b.gmail_key <> p_gmail_key))))
      into v_local_safe from public.discussions d
      where d.id = v_local and d.workspace_id = p_workspace_id
      for update;
  end if;

  if v_canonical is null then
    if v_local_safe then
      v_canonical := v_local;
    else
      insert into public.discussions(workspace_id, gmail_key)
        values (p_workspace_id, 'automatic:' || gen_random_uuid()::text) returning id into v_canonical;
    end if;
    insert into public.discussion_message_keys(workspace_id, message_key, discussion_id)
      values (p_workspace_id, p_message_key, v_canonical)
      on conflict (workspace_id, message_key) do update set discussion_id = excluded.discussion_id;
  end if;

  if v_local is not null and v_local <> v_canonical and v_local_safe then
    -- The source row lock also prevents new FK references from arriving during
    -- the move. Keep message IDs/client IDs and reaction identities unchanged.
    update public.team_messages set discussion_id = v_canonical
      where workspace_id = p_workspace_id and discussion_id = v_local;
    update public.message_reactions set discussion_id = v_canonical
      where workspace_id = p_workspace_id and discussion_id = v_local;
    update public.discussion_bindings set discussion_id = v_canonical
      where workspace_id = p_workspace_id and discussion_id = v_local;
    update public.discussion_message_keys set discussion_id = v_canonical
      where workspace_id = p_workspace_id and discussion_id = v_local;
    -- Old high-water marks can hide newly imported, older messages. Reset both
    -- histories rather than incorrectly declaring any imported messages read.
    delete from public.discussion_reads where discussion_id in (v_local, v_canonical);
    delete from public.discussions where id = v_local and workspace_id = p_workspace_id;
  end if;

  insert into public.discussion_bindings(user_id, workspace_id, gmail_key, discussion_id)
    values (auth.uid(), p_workspace_id, p_gmail_key, v_canonical)
    on conflict (user_id, workspace_id, gmail_key) do update set discussion_id = excluded.discussion_id;
  return v_canonical;
end;
$$;

revoke all on function public.automatic_thread_discussion(uuid,text,text) from public, anon;
grant execute on function public.automatic_thread_discussion(uuid,text,text) to authenticated;

commit;

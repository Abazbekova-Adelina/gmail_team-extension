begin;

create function public.shared_thread_discussions(p_message_key text)
returns table (workspace_id uuid, discussion_id uuid)
language sql stable security definer set search_path = '' as $$
  select k.workspace_id, k.discussion_id from public.discussion_message_keys k
  where p_message_key ~ '^[a-f0-9]{64}$' and k.message_key = p_message_key
    and public.is_workspace_member(k.workspace_id);
$$;

revoke all on function public.shared_thread_discussions(text) from public, anon;
grant execute on function public.shared_thread_discussions(text) to authenticated;

commit;

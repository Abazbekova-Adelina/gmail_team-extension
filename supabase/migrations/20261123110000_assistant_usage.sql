begin;
create table public.assistant_usage (
  user_id uuid primary key references auth.users(id) on delete cascade,
  window_start timestamptz not null,
  requests integer not null check (requests between 1 and 20)
);
alter table public.assistant_usage enable row level security;
revoke all on public.assistant_usage from public, anon, authenticated;

create function public.claim_assistant_request(p_discussion_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or not exists (
    select 1 from public.discussions d where d.id=p_discussion_id
      and public.is_workspace_member(d.workspace_id)
  ) then raise exception 'Discussion access required.' using errcode='42501'; end if;
  insert into public.assistant_usage(user_id, window_start, requests) values (auth.uid(), now(), 1)
  on conflict (user_id) do update set
    window_start = case when public.assistant_usage.window_start <= now()-interval '1 hour' then now() else public.assistant_usage.window_start end,
    requests = case when public.assistant_usage.window_start <= now()-interval '1 hour' then 1 else public.assistant_usage.requests+1 end
  where public.assistant_usage.window_start <= now()-interval '1 hour' or public.assistant_usage.requests < 20;
  return found;
end;
$$;
revoke all on function public.claim_assistant_request(uuid) from public, anon;
grant execute on function public.claim_assistant_request(uuid) to authenticated;
commit;

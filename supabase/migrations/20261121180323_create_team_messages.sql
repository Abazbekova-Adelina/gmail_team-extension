create table public.team_messages (
  id integer generated always as identity primary key,
  author_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  author_name text not null default left(coalesce(
    nullif(btrim(auth.jwt() -> 'user_metadata' ->> 'full_name'), ''),
    nullif(btrim(auth.jwt() -> 'user_metadata' ->> 'name'), ''),
    'Google user'
  ), 120),
  client_id uuid not null,
  body text not null check (char_length(body) <= 2000 and body ~ '[^[:space:]]'),
  created_at timestamptz not null default now(),
  unique (author_id, client_id)
);

alter table public.team_messages enable row level security;

revoke all on public.team_messages from public, anon, authenticated;
grant select on public.team_messages to authenticated;
grant insert (client_id, body) on public.team_messages to authenticated;

create policy "Signed-in users read the shared chat"
  on public.team_messages for select to authenticated
  using ((select auth.uid()) is not null);

create policy "Signed-in users post as themselves"
  on public.team_messages for insert to authenticated
  with check ((select auth.uid()) = author_id);

alter publication supabase_realtime add table public.team_messages;

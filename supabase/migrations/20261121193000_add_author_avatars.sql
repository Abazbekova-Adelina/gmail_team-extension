-- Derive photos from the signed-in account, just like author_name. Clients
-- retain insert permission only for client_id and body.
alter table public.team_messages
  add column author_avatar_url text default left(coalesce(
    nullif(auth.jwt() -> 'user_metadata' ->> 'avatar_url', ''),
    nullif(auth.jwt() -> 'user_metadata' ->> 'picture', '')
  ), 2048);

update public.team_messages as message
set author_avatar_url = left(coalesce(
  nullif(account.raw_user_meta_data ->> 'avatar_url', ''),
  nullif(account.raw_user_meta_data ->> 'picture', '')
), 2048)
from auth.users as account
where account.id = message.author_id;

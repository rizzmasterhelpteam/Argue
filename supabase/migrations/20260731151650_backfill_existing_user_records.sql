insert into public.profiles (user_id, display_name, avatar_url)
select
  id,
  nullif(left(coalesce(raw_user_meta_data ->> 'full_name', raw_user_meta_data ->> 'name', ''), 80), ''),
  nullif(left(coalesce(raw_user_meta_data ->> 'avatar_url', ''), 2048), '')
from auth.users
on conflict (user_id) do nothing;

insert into public.user_preferences (user_id)
select id from auth.users
on conflict (user_id) do nothing;

insert into public.subscriptions (user_id, plan, status)
select id, 'free', 'active' from auth.users
on conflict (user_id) do nothing;

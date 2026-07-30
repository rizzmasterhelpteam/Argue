create schema if not exists private;

revoke all on schema private from public;

create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text check (char_length(display_name) between 1 and 80),
  avatar_url text check (avatar_url is null or char_length(avatar_url) <= 2048),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.user_preferences (
  user_id uuid primary key references auth.users(id) on delete cascade,
  default_mode text not null default 'argue' check (default_mode in ('argue', 'brainstorm')),
  input_mode text not null default 'voice' check (input_mode in ('voice', 'text')),
  gemini_voice text,
  replay_voice text,
  autoplay_voice boolean not null default true,
  haptics_enabled boolean not null default true,
  compact_transcript boolean not null default false,
  reduced_motion boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null default 'New conversation' check (char_length(title) between 1 and 160),
  mode text not null default 'argue' check (mode in ('argue', 'brainstorm')),
  archived boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  source text not null check (source in ('voice', 'text')),
  content text not null check (char_length(content) between 1 and 4000),
  model text check (model is null or char_length(model) <= 160),
  created_at timestamptz not null default now()
);

create table if not exists public.voice_usage (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  reservation_hash text not null unique check (char_length(reservation_hash) = 64),
  status text not null check (status in ('reserved', 'completed', 'released', 'failed')),
  started_at timestamptz not null default now(),
  expires_at timestamptz not null,
  ended_at timestamptz,
  duration_seconds integer check (duration_seconds is null or duration_seconds between 0 and 600),
  model text not null check (char_length(model) between 1 and 160),
  created_at timestamptz not null default now()
);

create table if not exists public.api_usage_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  endpoint text not null check (char_length(endpoint) between 1 and 120),
  provider text not null check (char_length(provider) between 1 and 80),
  model text check (model is null or char_length(model) <= 160),
  status_code integer not null check (status_code between 100 and 599),
  latency_ms integer check (latency_ms is null or latency_ms >= 0),
  request_id text check (request_id is null or char_length(request_id) <= 160),
  created_at timestamptz not null default now()
);

create table if not exists public.subscriptions (
  user_id uuid primary key references auth.users(id) on delete cascade,
  plan text not null default 'free' check (plan in ('free', 'pro')),
  status text not null default 'active' check (status in ('active', 'past_due', 'canceled')),
  provider text,
  current_period_end timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists private.rate_limit_buckets (
  bucket text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  window_started timestamptz not null,
  count integer not null default 0 check (count >= 0),
  primary key (bucket, user_id, window_started)
);

create index if not exists conversations_user_updated_idx on public.conversations (user_id, updated_at desc);
create index if not exists conversations_user_archived_updated_idx on public.conversations (user_id, archived, updated_at desc);
create index if not exists messages_conversation_created_idx on public.messages (conversation_id, created_at asc);
create index if not exists messages_user_created_idx on public.messages (user_id, created_at desc);
create index if not exists voice_usage_user_created_idx on public.voice_usage (user_id, created_at desc);
create index if not exists api_usage_logs_user_created_idx on public.api_usage_logs (user_id, created_at desc);

create or replace function private.set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at before update on public.profiles
for each row execute function private.set_updated_at();

drop trigger if exists preferences_set_updated_at on public.user_preferences;
create trigger preferences_set_updated_at before update on public.user_preferences
for each row execute function private.set_updated_at();

drop trigger if exists conversations_set_updated_at on public.conversations;
create trigger conversations_set_updated_at before update on public.conversations
for each row execute function private.set_updated_at();

drop trigger if exists subscriptions_set_updated_at on public.subscriptions;
create trigger subscriptions_set_updated_at before update on public.subscriptions
for each row execute function private.set_updated_at();

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (user_id, display_name, avatar_url)
  values (
    new.id,
    nullif(left(coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name', ''), 80), ''),
    nullif(left(coalesce(new.raw_user_meta_data ->> 'avatar_url', ''), 2048), '')
  ) on conflict (user_id) do nothing;

  insert into public.user_preferences (user_id) values (new.id)
  on conflict (user_id) do nothing;

  insert into public.subscriptions (user_id) values (new.id)
  on conflict (user_id) do nothing;
  return new;
end;
$$;

revoke all on function public.handle_new_user() from public;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

alter table public.profiles enable row level security;
alter table public.user_preferences enable row level security;
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.voice_usage enable row level security;
alter table public.api_usage_logs enable row level security;
alter table public.subscriptions enable row level security;

create policy "profiles_select_own" on public.profiles for select to authenticated
using ((select auth.uid()) = user_id);
create policy "profiles_update_own" on public.profiles for update to authenticated
using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

create policy "preferences_select_own" on public.user_preferences for select to authenticated
using ((select auth.uid()) = user_id);
create policy "preferences_insert_own" on public.user_preferences for insert to authenticated
with check ((select auth.uid()) = user_id);
create policy "preferences_update_own" on public.user_preferences for update to authenticated
using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

create policy "conversations_select_own" on public.conversations for select to authenticated
using ((select auth.uid()) = user_id);
create policy "conversations_insert_own" on public.conversations for insert to authenticated
with check ((select auth.uid()) = user_id);
create policy "conversations_update_own" on public.conversations for update to authenticated
using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "conversations_delete_own" on public.conversations for delete to authenticated
using ((select auth.uid()) = user_id);

create policy "messages_select_own" on public.messages for select to authenticated
using (
  (select auth.uid()) = user_id
  and exists (select 1 from public.conversations c where c.id = conversation_id and c.user_id = (select auth.uid()))
);
create policy "messages_insert_own_user_messages" on public.messages for insert to authenticated
with check (
  (select auth.uid()) = user_id
  and role = 'user'
  and exists (select 1 from public.conversations c where c.id = conversation_id and c.user_id = (select auth.uid()))
);

create policy "voice_usage_select_own" on public.voice_usage for select to authenticated
using ((select auth.uid()) = user_id);
create policy "subscriptions_select_own" on public.subscriptions for select to authenticated
using ((select auth.uid()) = user_id);

create or replace function public.consume_rate_limit(
  p_bucket text,
  p_user_id uuid,
  p_window_seconds integer,
  p_limit integer
)
returns table (allowed boolean, retry_after_seconds integer)
language plpgsql
security definer
set search_path = public, private
as $$
declare
  v_window_started timestamptz;
  v_count integer;
begin
  if p_window_seconds < 1 or p_limit < 1 then
    raise exception 'Invalid rate limit configuration';
  end if;

  v_window_started := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  insert into private.rate_limit_buckets as buckets (bucket, user_id, window_started, count)
  values (p_bucket, p_user_id, v_window_started, 1)
  on conflict (bucket, user_id, window_started)
  do update set count = buckets.count + 1
  returning count into v_count;

  return query select v_count <= p_limit, greatest(1, p_window_seconds - extract(epoch from now() - v_window_started)::integer);
end;
$$;

create or replace function public.reserve_voice_usage(
  p_user_id uuid,
  p_reservation_hash text,
  p_model text,
  p_duration_seconds integer default 60,
  p_daily_limit integer default 5
)
returns table (reservation_id uuid, expires_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_used integer;
  v_expires_at timestamptz := now() + make_interval(secs => p_duration_seconds);
begin
  select count(*) into v_used
  from public.voice_usage
  where user_id = p_user_id and created_at >= now() - interval '24 hours';

  if v_used >= p_daily_limit then
    raise exception 'VOICE_DAILY_LIMIT';
  end if;

  return query
  insert into public.voice_usage (user_id, reservation_hash, status, expires_at, model)
  values (p_user_id, p_reservation_hash, 'reserved', v_expires_at, p_model)
  returning id, public.voice_usage.expires_at;
end;
$$;

create or replace function public.finish_voice_usage(
  p_user_id uuid,
  p_reservation_id uuid,
  p_duration_seconds integer default 0
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.voice_usage
  set status = 'completed', ended_at = now(), duration_seconds = greatest(0, least(p_duration_seconds, 600))
  where id = p_reservation_id and user_id = p_user_id and status = 'reserved';
end;
$$;

revoke all on function public.consume_rate_limit(text, uuid, integer, integer) from public, anon, authenticated;
revoke all on function public.reserve_voice_usage(uuid, text, text, integer, integer) from public, anon, authenticated;
revoke all on function public.finish_voice_usage(uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.consume_rate_limit(text, uuid, integer, integer) to service_role;
grant execute on function public.reserve_voice_usage(uuid, text, text, integer, integer) to service_role;
grant execute on function public.finish_voice_usage(uuid, uuid, integer) to service_role;

alter table public.subscriptions
  drop constraint if exists subscriptions_plan_check,
  add column if not exists status text not null default 'active',
  add column if not exists provider text,
  add column if not exists provider_customer_id text,
  add column if not exists provider_subscription_id text,
  add column if not exists current_period_start timestamptz,
  add column if not exists current_period_end timestamptz,
  add column if not exists cancel_at_period_end boolean not null default false;

alter table public.subscriptions add constraint subscriptions_plan_check check (plan in ('free', 'starter', 'pro'));

create table if not exists public.voice_credit_packs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider_purchase_id text unique,
  seconds_total integer not null check (seconds_total > 0),
  seconds_used integer not null default 0 check (seconds_used >= 0 and seconds_used <= seconds_total),
  expires_at timestamptz not null,
  status text not null default 'active' check (status in ('active', 'expired', 'refunded')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.voice_usage
  add column if not exists plan_at_start text,
  add column if not exists reserved_seconds integer,
  add column if not exists billable_seconds integer,
  add column if not exists usage_source text,
  add column if not exists completed_reason text,
  add column if not exists metadata jsonb not null default '{}'::jsonb;

create index if not exists voice_credit_packs_user_expiry_idx on public.voice_credit_packs (user_id, expires_at) where status = 'active';
create index if not exists messages_text_usage_idx on public.messages (user_id, created_at) where role = 'assistant' and source = 'text';

alter table public.voice_credit_packs enable row level security;
create policy "voice_credit_packs_select_own" on public.voice_credit_packs for select to authenticated using ((select auth.uid()) = user_id);

revoke all on public.voice_credit_packs from anon, authenticated;
grant select on public.voice_credit_packs to authenticated;

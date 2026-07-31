create table public.billing_webhook_events (
  id text primary key check (char_length(id) between 1 and 160),
  provider text not null check (provider = 'dodo'),
  event_type text not null check (char_length(event_type) between 1 and 120),
  payload jsonb not null,
  created_at timestamptz not null default now()
);

alter table public.billing_webhook_events enable row level security;

revoke all on public.billing_webhook_events from anon, authenticated;

create index billing_webhook_events_created_idx on public.billing_webhook_events (created_at desc);

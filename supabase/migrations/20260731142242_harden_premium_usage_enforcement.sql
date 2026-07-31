create unique index if not exists voice_usage_one_active_session_idx
  on public.voice_usage (user_id)
  where status = 'reserved';

create or replace function private.consume_voice_credit_packs(
  p_user_id uuid,
  p_seconds integer
)
returns void
language plpgsql
security definer
set search_path = public, private
as $$
declare
  v_pack record;
  v_remaining integer := greatest(0, coalesce(p_seconds, 0));
  v_debit integer;
begin
  for v_pack in
    select id, seconds_total, seconds_used
    from public.voice_credit_packs
    where user_id = p_user_id
      and status = 'active'
      and expires_at > now()
      and seconds_used < seconds_total
    order by expires_at asc, created_at asc
    for update
  loop
    exit when v_remaining = 0;
    v_debit := least(v_remaining, v_pack.seconds_total - v_pack.seconds_used);
    update public.voice_credit_packs
    set seconds_used = seconds_used + v_debit
    where id = v_pack.id;
    v_remaining := v_remaining - v_debit;
  end loop;

  if v_remaining > 0 then
    raise exception 'ADDON_CREDITS_UNAVAILABLE';
  end if;
end;
$$;

create or replace function public.finalize_expired_voice_reservations(
  p_user_id uuid
)
returns integer
language plpgsql
security definer
set search_path = public, private
as $$
declare
  v_usage record;
  v_billed integer;
  v_count integer := 0;
begin
  for v_usage in
    select id, user_id, started_at, reserved_seconds, usage_source
    from public.voice_usage
    where user_id = p_user_id
      and status = 'reserved'
      and expires_at <= now()
    for update
  loop
    v_billed := least(
      greatest(0, coalesce(v_usage.reserved_seconds, 0)),
      greatest(0, ceil(extract(epoch from now() - v_usage.started_at))::integer)
    );
    if v_usage.usage_source = 'addon' and v_billed > 0 then
      perform private.consume_voice_credit_packs(v_usage.user_id, v_billed);
    end if;
    update public.voice_usage
    set status = 'completed',
        ended_at = now(),
        duration_seconds = v_billed,
        billable_seconds = v_billed,
        completed_reason = 'expired'
    where id = v_usage.id;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

drop function if exists public.reserve_voice_usage(uuid, text, text, integer, integer);
create function public.reserve_voice_usage(
  p_user_id uuid,
  p_reservation_hash text,
  p_model text
)
returns table (
  reservation_id uuid,
  expires_at timestamptz,
  reserved_seconds integer,
  remaining_voice_seconds integer,
  plan text
)
language plpgsql
security definer
set search_path = public, private
as $$
declare
  v_subscription record;
  v_plan text := 'free';
  v_period_start timestamptz := date_trunc('month', now());
  v_period_end timestamptz := date_trunc('month', now()) + interval '1 month';
  v_voice_limit integer := 120;
  v_session_limit integer := 60;
  v_voice_used integer := 0;
  v_subscription_remaining integer := 0;
  v_addon_remaining integer := 0;
  v_reserve integer := 0;
  v_source text := 'subscription';
begin
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));
  perform public.finalize_expired_voice_reservations(p_user_id);

  select plan, status, current_period_start, current_period_end
  into v_subscription
  from public.subscriptions
  where user_id = p_user_id;

  if v_subscription.plan in ('starter', 'pro')
     and v_subscription.status = 'active'
     and (v_subscription.current_period_end is null or v_subscription.current_period_end > now()) then
    v_plan := v_subscription.plan;
    v_period_start := coalesce(v_subscription.current_period_start, v_period_start);
    v_period_end := coalesce(v_subscription.current_period_end, v_period_end);
  end if;

  if v_plan = 'starter' then
    v_voice_limit := 10800;
    v_session_limit := 180;
  elsif v_plan = 'pro' then
    v_voice_limit := 36000;
    v_session_limit := 300;
  end if;

  if exists (select 1 from public.voice_usage where user_id = p_user_id and status = 'reserved') then
    raise exception 'ACTIVE_VOICE_SESSION';
  end if;

  select coalesce(sum(coalesce(billable_seconds, duration_seconds, 0)), 0)
  into v_voice_used
  from public.voice_usage
  where user_id = p_user_id
    and created_at >= v_period_start
    and created_at < v_period_end
    and coalesce(usage_source, 'subscription') = 'subscription';
  v_subscription_remaining := greatest(0, v_voice_limit - v_voice_used);

  if v_subscription_remaining > 0 then
    v_reserve := least(v_session_limit, v_subscription_remaining);
  else
    v_source := 'addon';
    select coalesce(sum(seconds_total - seconds_used), 0)
    into v_addon_remaining
    from public.voice_credit_packs
    where user_id = p_user_id
      and status = 'active'
      and expires_at > now()
      and seconds_used < seconds_total;
    if v_addon_remaining <= 0 then
      raise exception 'VOICE_LIMIT_REACHED';
    end if;
    v_reserve := least(v_session_limit, v_addon_remaining);
  end if;

  return query
  insert into public.voice_usage (
    user_id, reservation_hash, status, started_at, expires_at, model,
    plan_at_start, reserved_seconds, usage_source, metadata
  ) values (
    p_user_id, p_reservation_hash, 'reserved', now(), now() + make_interval(secs => v_reserve), p_model,
    v_plan, v_reserve, v_source, jsonb_build_object('period_start', v_period_start, 'period_end', v_period_end)
  ) returning id, public.voice_usage.expires_at, public.voice_usage.reserved_seconds,
    greatest(0, v_subscription_remaining - case when v_source = 'subscription' then v_reserve else 0 end) +
      case when v_source = 'addon' then v_addon_remaining - v_reserve else v_addon_remaining end,
    v_plan;
end;
$$;

drop function if exists public.finish_voice_usage(uuid, uuid, integer);
create function public.finish_voice_usage(
  p_user_id uuid,
  p_reservation_id uuid,
  p_client_duration_seconds integer default null
)
returns table (billed_seconds integer, status text, idempotent boolean)
language plpgsql
security definer
set search_path = public, private
as $$
declare
  v_usage record;
  v_server_elapsed integer;
  v_candidate integer;
  v_billed integer;
begin
  select id, user_id, started_at, reserved_seconds, usage_source, status,
         coalesce(billable_seconds, 0) as previous_billable
  into v_usage
  from public.voice_usage
  where id = p_reservation_id and user_id = p_user_id
  for update;

  if not found then
    raise exception 'VOICE_RESERVATION_NOT_FOUND';
  end if;
  if v_usage.status <> 'reserved' then
    return query select v_usage.previous_billable, v_usage.status, true;
    return;
  end if;

  v_server_elapsed := greatest(0, ceil(extract(epoch from now() - v_usage.started_at))::integer);
  if p_client_duration_seconds is not null
     and p_client_duration_seconds > 0
     and p_client_duration_seconds <= v_server_elapsed + 5 then
    v_candidate := least(v_server_elapsed, p_client_duration_seconds + 5);
  else
    v_candidate := v_server_elapsed;
  end if;
  v_billed := least(greatest(0, coalesce(v_usage.reserved_seconds, 0)), v_candidate);

  if v_usage.usage_source = 'addon' and v_billed > 0 then
    perform private.consume_voice_credit_packs(p_user_id, v_billed);
  end if;
  update public.voice_usage
  set status = 'completed',
      ended_at = now(),
      duration_seconds = v_server_elapsed,
      billable_seconds = v_billed,
      completed_reason = 'released'
  where id = v_usage.id;
  return query select v_billed, 'completed'::text, false;
end;
$$;

create or replace function public.create_text_reply(
  p_user_id uuid,
  p_conversation_id uuid,
  p_content text,
  p_model text
)
returns table (id uuid, role text, source text, content text, model text, created_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_subscription record;
  v_plan text := 'free';
  v_period_start timestamptz := date_trunc('month', now());
  v_period_end timestamptz := date_trunc('month', now()) + interval '1 month';
  v_limit integer := 3;
  v_used integer;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 1));
  select plan, status, current_period_start, current_period_end
  into v_subscription
  from public.subscriptions
  where user_id = p_user_id;
  if v_subscription.plan in ('starter', 'pro')
     and v_subscription.status = 'active'
     and (v_subscription.current_period_end is null or v_subscription.current_period_end > now()) then
    v_plan := v_subscription.plan;
    v_period_start := coalesce(v_subscription.current_period_start, v_period_start);
    v_period_end := coalesce(v_subscription.current_period_end, v_period_end);
  end if;
  if v_plan = 'starter' then v_limit := 5000; elsif v_plan = 'pro' then v_limit := 20000; end if;
  select count(*) into v_used from public.messages
  where user_id = p_user_id and role = 'assistant' and source = 'text'
    and created_at >= v_period_start and created_at < v_period_end;
  if v_used >= v_limit then raise exception 'TEXT_LIMIT_REACHED'; end if;
  return query insert into public.messages (conversation_id, user_id, role, source, content, model)
  values (p_conversation_id, p_user_id, 'assistant', 'text', p_content, p_model)
  returning public.messages.id, public.messages.role, public.messages.source, public.messages.content, public.messages.model, public.messages.created_at;
end;
$$;

revoke all on function private.consume_voice_credit_packs(uuid, integer) from public;
revoke all on function public.finalize_expired_voice_reservations(uuid) from public, anon, authenticated;
revoke all on function public.reserve_voice_usage(uuid, text, text) from public, anon, authenticated;
revoke all on function public.finish_voice_usage(uuid, uuid, integer) from public, anon, authenticated;
revoke all on function public.create_text_reply(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.finalize_expired_voice_reservations(uuid) to service_role;
grant execute on function public.reserve_voice_usage(uuid, text, text) to service_role;
grant execute on function public.finish_voice_usage(uuid, uuid, integer) to service_role;
grant execute on function public.create_text_reply(uuid, uuid, text, text) to service_role;

create or replace function public.reserve_voice_usage(
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
  v_session_limit integer := 120;
  v_voice_used integer := 0;
  v_subscription_remaining integer := 0;
  v_addon_remaining integer := 0;
  v_reserve integer := 0;
  v_source text := 'subscription';
begin
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));
  perform public.finalize_expired_voice_reservations(p_user_id);

  select s.plan, s.status, s.current_period_start, s.current_period_end
  into v_subscription
  from public.subscriptions s
  where s.user_id = p_user_id;

  if v_subscription.plan in ('starter', 'pro') and v_subscription.status = 'active'
     and (v_subscription.current_period_end is null or v_subscription.current_period_end > now()) then
    v_plan := v_subscription.plan;
    v_period_start := coalesce(v_subscription.current_period_start, v_period_start);
    v_period_end := coalesce(v_subscription.current_period_end, v_period_end);
  end if;
  if v_plan = 'starter' then v_voice_limit := 10800; v_session_limit := 900;
  elsif v_plan = 'pro' then v_voice_limit := 36000; v_session_limit := 1800; end if;

  if exists (select 1 from public.voice_usage vu where vu.user_id = p_user_id and vu.status = 'reserved') then
    raise exception 'ACTIVE_VOICE_SESSION';
  end if;
  select coalesce(sum(coalesce(vu.billable_seconds, vu.duration_seconds, 0)), 0)
  into v_voice_used from public.voice_usage vu
  where vu.user_id = p_user_id and vu.created_at >= v_period_start and vu.created_at < v_period_end
    and coalesce(vu.usage_source, 'subscription') = 'subscription';
  v_subscription_remaining := greatest(0, v_voice_limit - v_voice_used);

  if v_subscription_remaining > 0 then
    v_reserve := least(v_session_limit, v_subscription_remaining);
  else
    v_source := 'addon';
    select coalesce(sum(vcp.seconds_total - vcp.seconds_used), 0) into v_addon_remaining
    from public.voice_credit_packs vcp
    where vcp.user_id = p_user_id and vcp.status = 'active' and vcp.expires_at > now() and vcp.seconds_used < vcp.seconds_total;
    if v_addon_remaining <= 0 then raise exception 'VOICE_LIMIT_REACHED'; end if;
    v_reserve := least(v_session_limit, v_addon_remaining);
  end if;

  return query insert into public.voice_usage (
    user_id, reservation_hash, status, started_at, expires_at, model, plan_at_start, reserved_seconds, usage_source, metadata
  ) values (
    p_user_id, p_reservation_hash, 'reserved', now(), now() + make_interval(secs => v_reserve), p_model,
    v_plan, v_reserve, v_source, jsonb_build_object('period_start', v_period_start, 'period_end', v_period_end)
  ) returning public.voice_usage.id, public.voice_usage.expires_at, public.voice_usage.reserved_seconds,
    greatest(0, v_subscription_remaining - case when v_source = 'subscription' then v_reserve else 0 end)
      + case when v_source = 'addon' then v_addon_remaining - v_reserve else v_addon_remaining end,
    v_plan;
end;
$$;

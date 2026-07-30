create or replace function public.reserve_voice_usage(
  p_user_id uuid,
  p_reservation_hash text,
  p_model text,
  p_duration_seconds integer default 60,
  p_daily_limit integer default 0
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

  if coalesce(p_daily_limit, 0) > 0 and v_used >= p_daily_limit then
    raise exception 'VOICE_DAILY_LIMIT';
  end if;

  return query
  insert into public.voice_usage (user_id, reservation_hash, status, expires_at, model)
  values (p_user_id, p_reservation_hash, 'reserved', v_expires_at, p_model)
  returning id, public.voice_usage.expires_at;
end;
$$;

revoke all on function public.reserve_voice_usage(uuid, text, text, integer, integer) from public, anon, authenticated;
grant execute on function public.reserve_voice_usage(uuid, text, text, integer, integer) to service_role;

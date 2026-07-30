import { createClient } from '@supabase/supabase-js';

function value(env, name) {
  const raw = env?.[name];
  return typeof raw === 'string' ? raw.trim() : '';
}

export function getSupabaseServerConfig(env) {
  return {
    url: value(env, 'SUPABASE_URL') || value(env, 'VITE_SUPABASE_URL'),
    serviceRoleKey: value(env, 'SUPABASE_SERVICE_ROLE_KEY'),
  };
}

export function createServiceSupabase(env) {
  if (env?.__supabaseClient) return env.__supabaseClient;
  const { url, serviceRoleKey } = getSupabaseServerConfig(env);
  if (!url || !serviceRoleKey) return null;
  return createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
}

export function getBearerToken(request) {
  const authorization = request.headers.get('authorization') || '';
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || '';
}

export async function requireAuthenticatedUser(request, env) {
  const token = getBearerToken(request);
  if (!token) {
    return { error: { message: 'Sign in to continue.', status: 401, code: 'AUTH_REQUIRED' } };
  }

  const supabase = createServiceSupabase(env);
  if (!supabase) {
    return { error: { message: 'Authentication is not configured yet.', status: 503, code: 'SUPABASE_NOT_CONFIGURED' } };
  }

  const { data, error } = await supabase.auth.getUser(token);
  const user = data?.user;
  if (error || !user || user.is_anonymous || user.app_metadata?.provider === 'anonymous') {
    return { error: { message: 'Your session is invalid or has expired. Please sign in again.', status: 401, code: 'INVALID_SESSION' } };
  }

  return { supabase, user, token };
}

export async function sha256(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function enforcePersistentRateLimit(supabase, { bucket, userId, windowSeconds, limit }) {
  const { data, error } = await supabase.rpc('consume_rate_limit', {
    p_bucket: bucket,
    p_user_id: userId,
    p_window_seconds: windowSeconds,
    p_limit: limit,
  });
  if (error) throw error;
  const result = Array.isArray(data) ? data[0] : data;
  return {
    allowed: Boolean(result?.allowed),
    retryAfterSeconds: Number(result?.retry_after_seconds) || windowSeconds,
  };
}

export async function reserveVoiceUsage(supabase, { userId, model, durationSeconds = 60, dailyLimit = 5 }) {
  const reservationSecret = crypto.randomUUID();
  const reservationHash = await sha256(reservationSecret);
  const { data, error } = await supabase.rpc('reserve_voice_usage', {
    p_user_id: userId,
    p_reservation_hash: reservationHash,
    p_model: model,
    p_duration_seconds: durationSeconds,
    p_daily_limit: dailyLimit,
  });
  if (error) throw error;
  const reservation = Array.isArray(data) ? data[0] : data;
  if (!reservation?.reservation_id) throw new Error('Voice reservation was not created.');
  return reservation;
}

export async function finishVoiceUsage(supabase, { userId, reservationId, durationSeconds = 0 }) {
  const { error } = await supabase.rpc('finish_voice_usage', {
    p_user_id: userId,
    p_reservation_id: reservationId,
    p_duration_seconds: durationSeconds,
  });
  if (error) throw error;
}

export async function writeUsageLog(supabase, entry) {
  const { error } = await supabase.from('api_usage_logs').insert(entry);
  if (error) console.error('Failed to write API usage log', error.code || error.message);
}

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

export async function reserveVoiceUsage(supabase, { userId, model }) {
  const reservationSecret = crypto.randomUUID();
  const reservationHash = await sha256(reservationSecret);
  const { data, error } = await supabase.rpc('reserve_voice_usage', {
    p_user_id: userId,
    p_reservation_hash: reservationHash,
    p_model: model,
  });
  if (error) throw error;
  const reservation = Array.isArray(data) ? data[0] : data;
  if (!reservation?.reservation_id) throw new Error('Voice reservation was not created.');
  return reservation;
}

export async function finishVoiceUsage(supabase, { userId, reservationId, clientDurationSeconds = null }) {
  const { data, error } = await supabase.rpc('finish_voice_usage', {
    p_user_id: userId,
    p_reservation_id: reservationId,
    p_client_duration_seconds: Number.isFinite(clientDurationSeconds) ? Math.max(0, Math.floor(clientDurationSeconds)) : null,
  });
  if (error) throw error;
  return Array.isArray(data) ? data[0] : data;
}

export async function writeUsageLog(supabase, entry) {
  const { error } = await supabase.from('api_usage_logs').insert(entry);
  if (error) console.error('Failed to write API usage log', error.code || error.message);
}

export const PLAN_DEFINITIONS = {
  free: { monthlyTextLimit: 3, monthlyVoiceSeconds: 120, maxVoiceSessionSeconds: 120, chatRateLimit: 3, chatWindowSeconds: 300, liveStartRateLimit: 1, liveStartWindowSeconds: 300 },
  starter: { monthlyTextLimit: 5000, monthlyVoiceSeconds: 10800, maxVoiceSessionSeconds: 900, chatRateLimit: 20, chatWindowSeconds: 60, liveStartRateLimit: 3, liveStartWindowSeconds: 600 },
  pro: { monthlyTextLimit: 20000, monthlyVoiceSeconds: 36000, maxVoiceSessionSeconds: 1800, chatRateLimit: 30, chatWindowSeconds: 60, liveStartRateLimit: 5, liveStartWindowSeconds: 600 },
};

export async function getUserEntitlement(supabase, userId) {
  const subscriptionQuery = supabase.from('subscriptions');
  if (typeof subscriptionQuery?.select !== 'function') return { plan: 'free', status: 'active', billingPeriodStart: new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString(), billingPeriodEnd: new Date(new Date().getFullYear(), new Date().getMonth() + 1, 1).toISOString(), textRepliesUsed: 0, textRepliesLimit: 3, voiceSecondsUsed: 0, voiceSecondsLimit: 120, addonVoiceSecondsRemaining: 0, remainingVoiceSeconds: 120, maxVoiceSessionSeconds: 120, ...PLAN_DEFINITIONS.free };
  const { data: subscription, error: subscriptionError } = await subscriptionQuery.select('plan,status,current_period_start,current_period_end').eq('user_id', userId).maybeSingle();
  if (subscriptionError) throw subscriptionError;
  const subscriptionIsActive = Boolean(
    PLAN_DEFINITIONS[subscription?.plan]
    && subscription?.plan !== 'free'
    && subscription?.status === 'active'
    && (!subscription.current_period_end || new Date(subscription.current_period_end).getTime() > Date.now()),
  );
  const plan = subscriptionIsActive ? subscription.plan : 'free';
  const definition = PLAN_DEFINITIONS[plan];
  const periodStart = subscriptionIsActive && subscription?.current_period_start ? subscription.current_period_start : new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
  const periodEnd = subscriptionIsActive && subscription?.current_period_end ? subscription.current_period_end : new Date(new Date().getFullYear(), new Date().getMonth() + 1, 1).toISOString();
  const [
    { count: textRepliesUsed, error: textUsageError },
    { data: voiceRows, error: voiceUsageError },
    { data: addonRows, error: addonUsageError },
  ] = await Promise.all([
    supabase.from('messages').select('id', { count: 'exact', head: true }).eq('user_id', userId).eq('role', 'assistant').eq('source', 'text').gte('created_at', periodStart).lt('created_at', periodEnd),
    supabase.from('voice_usage').select('duration_seconds,billable_seconds,usage_source').eq('user_id', userId).gte('created_at', periodStart).lt('created_at', periodEnd),
    supabase.from('voice_credit_packs').select('seconds_total,seconds_used').eq('user_id', userId).eq('status', 'active').gt('expires_at', new Date().toISOString()),
  ]);
  if (textUsageError) throw textUsageError;
  if (voiceUsageError) throw voiceUsageError;
  if (addonUsageError) throw addonUsageError;
  const voiceSecondsUsed = (voiceRows || []).reduce((sum, row) => row.usage_source === 'addon' ? sum : sum + Number(row.billable_seconds ?? row.duration_seconds ?? 0), 0);
  const addonVoiceSecondsRemaining = (addonRows || []).reduce((sum, row) => sum + Math.max(0, Number(row.seconds_total) - Number(row.seconds_used)), 0);
  return { plan, status: subscriptionIsActive ? 'active' : (subscription?.status || 'free'), billingPeriodStart: periodStart, billingPeriodEnd: periodEnd, textRepliesUsed: textRepliesUsed || 0, textRepliesLimit: definition.monthlyTextLimit, voiceSecondsUsed, voiceSecondsLimit: definition.monthlyVoiceSeconds, addonVoiceSecondsRemaining, remainingVoiceSeconds: Math.max(0, definition.monthlyVoiceSeconds - voiceSecondsUsed) + addonVoiceSecondsRemaining, maxVoiceSessionSeconds: definition.maxVoiceSessionSeconds, ...definition };
}

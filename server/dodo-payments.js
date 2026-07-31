import { Webhook } from 'standardwebhooks';
import { ApiError, json } from './api.js';
import { createServiceSupabase, requireAuthenticatedUser } from './supabase.js';

const DODO_TEST_API = 'https://test.dodopayments.com';
const DODO_LIVE_API = 'https://live.dodopayments.com';
const PLANS = new Set(['starter', 'pro']);

function envValue(env, name) {
  const value = env?.[name];
  return typeof value === 'string' ? value.trim() : '';
}

function requestId(request) {
  return request.headers.get('x-request-id') || request.headers.get('x-vercel-id') || crypto.randomUUID();
}

function apiBaseUrl(env) {
  const configured = envValue(env, 'DODO_PAYMENTS_API_BASE_URL');
  if (configured) return configured.replace(/\/$/, '');
  return envValue(env, 'DODO_PAYMENTS_ENVIRONMENT') === 'test_mode' ? DODO_TEST_API : DODO_LIVE_API;
}

function productId(env, plan) {
  return envValue(env, plan === 'starter' ? 'DODO_PAYMENTS_STARTER_PRODUCT_ID' : 'DODO_PAYMENTS_PRO_PRODUCT_ID');
}

function planForProduct(env, id) {
  if (id && id === productId(env, 'starter')) return 'starter';
  if (id && id === productId(env, 'pro')) return 'pro';
  return null;
}

function appOrigin(request, env) {
  const configured = envValue(env, 'APP_URL');
  if (configured) return configured.replace(/\/$/, '');
  return new URL(request.url).origin;
}

async function authenticated(request, env, id, stage) {
  const result = await requireAuthenticatedUser(request, env);
  if (result.error) throw new ApiError(result.error.message, result.error.status, null, { code: result.error.code, stage, requestId: id });
  return result;
}

function checkoutUser(user) {
  const email = typeof user.email === 'string' ? user.email : '';
  if (!email) throw new ApiError('An email address is required before starting checkout.', 400, null, { code: 'EMAIL_REQUIRED', stage: 'billing' });
  const name = user.user_metadata?.full_name || user.user_metadata?.name;
  return { email, ...(typeof name === 'string' && name.trim() ? { name: name.trim().slice(0, 120) } : {}) };
}

export async function handleDodoCheckout(request, env) {
  const id = requestId(request);
  const { supabase, user } = await authenticated(request, env, id, 'billing');
  const payload = await request.json().catch(() => null);
  const plan = typeof payload?.plan === 'string' ? payload.plan.toLowerCase() : '';
  if (!PLANS.has(plan)) throw new ApiError('Choose Starter or Pro.', 400, null, { code: 'INVALID_PLAN', stage: 'billing', requestId: id });

  const apiKey = envValue(env, 'DODO_PAYMENTS_API_KEY');
  const selectedProductId = productId(env, plan);
  if (!apiKey || !selectedProductId) throw new ApiError('Billing is not configured yet.', 503, null, { code: 'BILLING_NOT_CONFIGURED', stage: 'billing', requestId: id });

  const origin = appOrigin(request, env);
  const response = await fetch(`${apiBaseUrl(env)}/checkouts`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      product_cart: [{ product_id: selectedProductId, quantity: 1 }],
      customer: checkoutUser(user),
      return_url: `${origin}/?checkout=success`,
      cancel_url: `${origin}/?checkout=cancelled`,
      metadata: { argue_user_id: user.id, argue_plan: plan },
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.checkout_url) {
    console.error('Dodo checkout creation failed', response.status);
    throw new ApiError('Checkout could not be started. Please try again.', 502, null, { code: 'DODO_CHECKOUT_FAILED', stage: 'billing', requestId: id });
  }

  await supabase.from('api_usage_logs').insert({ user_id: user.id, endpoint: '/api/billing/checkout', provider: 'dodo', model: plan, status_code: 200, request_id: id });
  return json({ checkoutUrl: data.checkout_url });
}

function webhookHeaders(request) {
  return {
    'webhook-id': request.headers.get('webhook-id') || '',
    'webhook-signature': request.headers.get('webhook-signature') || '',
    'webhook-timestamp': request.headers.get('webhook-timestamp') || '',
  };
}

function subscriptionStatus(eventType, data) {
  if (eventType === 'subscription.on_hold') return 'expired';
  if (eventType === 'subscription.cancelled' || eventType === 'subscription.expired') return 'expired';
  return data.status === 'active' ? 'active' : 'active';
}

function timestamp(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : null;
}

export async function handleDodoWebhook(request, env) {
  const webhookKey = envValue(env, 'DODO_PAYMENTS_WEBHOOK_KEY');
  if (!webhookKey) throw new ApiError('Billing webhooks are not configured.', 503, null, { code: 'BILLING_NOT_CONFIGURED', stage: 'webhook' });
  const rawBody = await request.text();
  const headers = webhookHeaders(request);
  let event;
  try {
    event = new Webhook(webhookKey).verify(rawBody, headers);
  } catch {
    throw new ApiError('Invalid webhook signature.', 401, null, { code: 'INVALID_WEBHOOK_SIGNATURE', stage: 'webhook' });
  }

  const supabase = createServiceSupabase(env);
  if (!supabase) throw new ApiError('Billing database is not configured.', 503, null, { code: 'SUPABASE_NOT_CONFIGURED', stage: 'webhook' });
  const { error: eventError } = await supabase.from('billing_webhook_events').insert({ id: headers['webhook-id'], provider: 'dodo', event_type: event?.type || 'unknown', payload: event });
  if (eventError?.code === '23505') return json({ received: true, duplicate: true });
  if (eventError) throw eventError;

  const data = event?.data || {};
  if (typeof event?.type === 'string' && event.type.startsWith('subscription.')) {
    const metadata = data.metadata || {};
    const userId = metadata.argue_user_id || metadata.user_id;
    const plan = planForProduct(env, data.product_id);
    if (typeof userId === 'string' && plan && typeof data.subscription_id === 'string') {
      const { error } = await supabase.from('subscriptions').upsert({
        user_id: userId,
        plan,
        status: subscriptionStatus(event.type, data),
        provider: 'dodo',
        provider_customer_id: typeof data.customer_id === 'string' ? data.customer_id : null,
        provider_subscription_id: data.subscription_id,
        current_period_start: timestamp(data.current_period_start || data.period_start),
        current_period_end: timestamp(data.next_billing_date || data.current_period_end || data.period_end),
        cancel_at_period_end: Boolean(data.cancel_at_next_billing_date),
      }, { onConflict: 'user_id' });
      if (error) throw error;
    }
  }
  return json({ received: true });
}

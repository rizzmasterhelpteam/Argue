import {
  enforcePersistentRateLimit,
  finishVoiceUsage,
  getUserEntitlement,
  requireAuthenticatedUser,
  reserveVoiceUsage,
  writeUsageLog,
} from './supabase.js';
import { displayMode, normalizeMode, systemPrompt } from './prompts.js';

const GROQ_API_URL = 'https://api.groq.com/openai/v1';
const GEMINI_AUTH_TOKEN_URL = 'https://generativelanguage.googleapis.com/v1beta/auth_tokens';
const GEMINI_LIVE_API_VERSION = 'v1beta';
const LIVE_TOKEN_TIMEOUT_MS = 8_000;
const CHAT_TIMEOUT_MS = 20_000;

export const DEFAULT_REASONING_MODEL = 'openai/gpt-oss-120b';
export const DEFAULT_FALLBACK_MODEL = 'openai/gpt-oss-20b';
export const DEFAULT_GEMINI_LIVE_MODEL = 'gemini-3.1-flash-live-preview';
export const DEFAULT_GEMINI_LIVE_VOICE = 'Kore';
export const MAX_CHAT_INPUT_CHARS = 2_000;
export const MAX_CHAT_BODY_BYTES = 12_000;
export const MAX_LIVE_TOKEN_BODY_BYTES = 1_000;
export const MAX_MESSAGE_BODY_BYTES = 6_000;


export class ApiError extends Error {
  constructor(message, status = 500, retryAfterSeconds = null, details = {}) {
    super(message);
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
    this.code = details.code || 'API_REQUEST_FAILED';
    this.stage = details.stage || 'api';
    this.requestId = details.requestId || null;
  }
}

export function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...extraHeaders,
    },
  });
}

function requestId(request) {
  return request?.headers?.get('x-request-id')
    || request?.headers?.get('x-vercel-id')
    || globalThis.crypto?.randomUUID?.()
    || `argue-${Date.now().toString(36)}`;
}

function safeUpstreamMessage(value) {
  return typeof value === 'string'
    ? value.replace(/(?:AIza|gsk_|sk-)[A-Za-z0-9_-]+/gi, '[redacted]').slice(0, 240)
    : '';
}

export function errorResponse(error, request) {
  const status = error instanceof ApiError ? error.status : 500;
  const retryAfter = error instanceof ApiError ? error.retryAfterSeconds : null;
  const id = error instanceof ApiError ? error.requestId || requestId(request) : requestId(request);
  if (!(error instanceof ApiError)) console.error('API request failed', error?.code || 'UNEXPECTED_ERROR', id);
  return json({
    error: error instanceof ApiError ? error.message : 'The AI service is temporarily unavailable.',
    code: error instanceof ApiError ? error.code : 'API_REQUEST_FAILED',
    stage: error instanceof ApiError ? error.stage : 'api',
    requestId: id,
  }, status, retryAfter ? { 'retry-after': String(retryAfter) } : {});
}

function envValue(env, name) {
  const value = env?.[name];
  return typeof value === 'string' ? value.trim() : '';
}

function getGeminiApiKey(env) {
  return envValue(env, 'GEMINI_API_KEY') || envValue(env, 'GOOGLE_API_KEY');
}

function requireGroqApiKey(env) {
  const key = envValue(env, 'GROQ_API_KEY');
  if (!key) throw new ApiError('The AI service is not configured yet.', 503, null, { code: 'GROQ_NOT_CONFIGURED', stage: 'chat' });
  return key;
}

export function getLiveModel(env) {
  return (envValue(env, 'GEMINI_LIVE_MODEL') || DEFAULT_GEMINI_LIVE_MODEL).replace(/^models\//, '');
}

export function getLiveVoice(env) {
  return envValue(env, 'GEMINI_LIVE_VOICE') || DEFAULT_GEMINI_LIVE_VOICE;
}

function contentLengthExceeds(request, maximum) {
  const length = Number(request.headers.get('content-length'));
  return Number.isFinite(length) && length > maximum;
}

async function parseJson(request, details) {
  try {
    return await request.json();
  } catch {
    throw new ApiError('Please send a valid request.', 400, null, details);
  }
}

async function fetchWithTimeout(url, options, timeoutMs, requestSignal) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const signal = requestSignal && typeof AbortSignal.any === 'function'
    ? AbortSignal.any([controller.signal, requestSignal])
    : controller.signal;
  try {
    return await fetch(url, { ...options, signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function authenticate(request, env, id, stage) {
  const result = await requireAuthenticatedUser(request, env);
  if (result.error) throw new ApiError(result.error.message, result.error.status, null, { code: result.error.code, stage, requestId: id });
  return result;
}

async function assertOwnedConversation(supabase, userId, conversationId, id) {
  if (typeof conversationId !== 'string' || !conversationId) {
    throw new ApiError('A conversation is required.', 400, null, { code: 'INVALID_CONVERSATION', stage: 'chat', requestId: id });
  }
  const { data, error } = await supabase
    .from('conversations')
    .select('id,user_id,mode,archived')
    .eq('id', conversationId)
    .maybeSingle();
  if (error) throw error;
  if (!data || data.user_id !== userId || data.archived) {
    throw new ApiError('That conversation is unavailable.', 403, null, { code: 'CONVERSATION_FORBIDDEN', stage: 'chat', requestId: id });
  }
  return data;
}

async function enforceRateLimit(supabase, options, message, id, stage) {
  const result = await enforcePersistentRateLimit(supabase, options);
  if (!result.allowed) throw new ApiError(message, 429, result.retryAfterSeconds, { code: 'RATE_LIMITED', stage, requestId: id });
}

function getMessageContent(value) {
  return typeof value === 'string' ? value.trim().slice(0, 4_000) : '';
}

function responseMessage(row) {
  return {
    id: row.id,
    role: row.role,
    source: row.source,
    content: row.content,
    model: row.model,
    createdAt: row.created_at,
  };
}

async function groqCompletion({ model, messages, env, signal }) {
  const response = await fetchWithTimeout(`${GROQ_API_URL}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${requireGroqApiKey(env)}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.45,
      max_completion_tokens: 180,
      ...(model === 'openai/gpt-oss-20b' || model === 'openai/gpt-oss-120b' ? { reasoning_effort: 'low' } : {}),
    }),
  }, CHAT_TIMEOUT_MS, signal);

  if (!response.ok) {
    console.error('Groq request failed', response.status);
    throw new ApiError('The AI service could not complete that request.', response.status === 429 ? 429 : 502, null, {
      code: response.status === 429 ? 'GROQ_QUOTA_EXHAUSTED' : 'GROQ_UPSTREAM_UNAVAILABLE',
      stage: 'chat',
    });
  }
  return response.json();
}

export function buildLiveTokenConstraints(env, mode = 'argue') {
  return {
    model: `models/${getLiveModel(env)}`,
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: {
        voiceConfig: { prebuiltVoiceConfig: { voiceName: getLiveVoice(env) } },
      },
      thinkingConfig: { thinkingLevel: 'low' },
    },
    systemInstruction: { parts: [{ text: systemPrompt(mode) }] },
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    sessionResumption: {},
    realtimeInputConfig: {
      automaticActivityDetection: {
        disabled: false,
        prefixPaddingMs: 250,
        silenceDurationMs: 700,
      },
    },
  };
}

export async function handleLiveToken(request, env) {
  const id = requestId(request);
  const startedAt = Date.now();
  if (contentLengthExceeds(request, MAX_LIVE_TOKEN_BODY_BYTES)) throw new ApiError('That voice session request is too large.', 413, null, { code: 'REQUEST_TOO_LARGE', stage: 'token_creation', requestId: id });
  const { supabase, user } = await authenticate(request, env, id, 'token_creation');
  const entitlement = await getUserEntitlement(supabase, user.id);
  const payload = await parseJson(request, { code: 'INVALID_ARGUMENT', stage: 'token_creation', requestId: id });
  const mode = normalizeMode(payload?.mode);
  const apiKey = getGeminiApiKey(env);
  if (!apiKey) throw new ApiError('Gemini Live is not configured yet.', 503, null, { code: 'GEMINI_NOT_CONFIGURED', stage: 'token_creation', requestId: id });

  await enforceRateLimit(supabase, {
    bucket: 'live-token', userId: user.id, windowSeconds: entitlement.liveStartWindowSeconds, limit: entitlement.liveStartRateLimit,
  }, 'Too many voice starts. Please wait a few minutes and try again.', id, 'rate_limit');

  const model = getLiveModel(env);
  let reservation;
  try {
    reservation = await reserveVoiceUsage(supabase, { userId: user.id, model, durationSeconds: entitlement.maxVoiceSessionSeconds });
  } catch (error) {
    if (String(error?.message || '').includes('VOICE_DAILY_LIMIT')) {
      throw new ApiError('The free voice limit is 5 sessions per day. Please try again tomorrow.', 429, 3600, { code: 'VOICE_LIMIT_REACHED', stage: 'rate_limit', requestId: id });
    }
    throw error;
  }

  try {
    const tokenResponse = await fetchWithTimeout(GEMINI_AUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'x-goog-api-key': apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({
        uses: 1,
        expireTime: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
        newSessionExpireTime: new Date(Date.now() + entitlement.maxVoiceSessionSeconds * 1000).toISOString(),
        bidiGenerateContentSetup: buildLiveTokenConstraints(env, mode),
      }),
    }, LIVE_TOKEN_TIMEOUT_MS, request.signal);

    if (!tokenResponse.ok) {
      const upstream = await tokenResponse.json().catch(() => null);
      console.error('Gemini Live token provisioning failed', { requestId: id, status: tokenResponse.status, message: safeUpstreamMessage(upstream?.error?.message) });
      const code = tokenResponse.status === 429 ? 'GEMINI_QUOTA_EXHAUSTED' : 'GEMINI_UPSTREAM_UNAVAILABLE';
      throw new ApiError(tokenResponse.status === 429 ? 'Gemini Live quota is temporarily exhausted.' : 'Gemini Live is temporarily unavailable.', tokenResponse.status === 429 ? 429 : 502, tokenResponse.status === 429 ? 60 : null, { code, stage: 'token_creation', requestId: id });
    }
    const tokenData = await tokenResponse.json().catch(() => null);
    if (!tokenData?.name) throw new ApiError('Gemini Live returned an invalid session token.', 502, null, { code: 'GEMINI_TOKEN_REQUEST_REJECTED', stage: 'token_creation', requestId: id });
    await writeUsageLog(supabase, { user_id: user.id, endpoint: '/api/live/token', provider: 'gemini', model, status_code: 200, latency_ms: Date.now() - startedAt, request_id: id });
    return json({
      token: tokenData.name,
      model,
      voice: getLiveVoice(env),
      apiVersion: GEMINI_LIVE_API_VERSION,
      expiresAt: tokenData.expireTime || reservation.expires_at || null,
      reservationId: reservation.reservation_id,
      mode: displayMode(mode),
      maxSessionSeconds: entitlement.maxVoiceSessionSeconds,
      remainingVoiceSeconds: entitlement.remainingVoiceSeconds,
    });
  } catch (error) {
    await finishVoiceUsage(supabase, { userId: user.id, reservationId: reservation.reservation_id, durationSeconds: 0 }).catch(() => {});
    throw error;
  }
}

export async function handleLiveRelease(request, env) {
  const id = requestId(request);
  const { supabase, user } = await authenticate(request, env, id, 'voice_release');
  const payload = await parseJson(request, { code: 'INVALID_ARGUMENT', stage: 'voice_release', requestId: id });
  if (typeof payload?.reservationId !== 'string' || !payload.reservationId) throw new ApiError('A voice reservation is required.', 400, null, { code: 'INVALID_ARGUMENT', stage: 'voice_release', requestId: id });
  await finishVoiceUsage(supabase, { userId: user.id, reservationId: payload.reservationId, durationSeconds: Number(payload.durationSeconds) || 0 });
  return json({ ok: true });
}

export async function handleChat(request, env) {
  const id = requestId(request);
  const startedAt = Date.now();
  if (contentLengthExceeds(request, MAX_CHAT_BODY_BYTES)) throw new ApiError('That argument is too large. Start a new conversation or shorten it.', 413, null, { code: 'REQUEST_TOO_LARGE', stage: 'chat', requestId: id });
  const { supabase, user } = await authenticate(request, env, id, 'chat');
  const entitlement = await getUserEntitlement(supabase, user.id);
  const payload = await parseJson(request, { code: 'INVALID_ARGUMENT', stage: 'chat', requestId: id });
  const input = getMessageContent(payload?.input);
  if (!input || input.length > MAX_CHAT_INPUT_CHARS) throw new ApiError(`Your argument must be between 1 and ${MAX_CHAT_INPUT_CHARS} characters.`, 400, null, { code: 'INVALID_ARGUMENT', stage: 'chat', requestId: id });
  const conversation = await assertOwnedConversation(supabase, user.id, payload?.conversationId, id);
  const mode = normalizeMode(conversation.mode);
  await enforceRateLimit(supabase, { bucket: 'chat', userId: user.id, windowSeconds: entitlement.chatWindowSeconds, limit: entitlement.chatRateLimit }, 'Too many messages. Please wait a moment and try again.', id, 'rate_limit');
  if (entitlement.textRepliesUsed >= entitlement.textRepliesLimit) throw new ApiError('Monthly fair-use text limit reached. Upgrade or wait for reset.', 429, 3600, { code: 'TEXT_LIMIT_REACHED', stage: 'quota', requestId: id });

  const { data: savedUserMessage, error: saveUserError } = await supabase
    .from('messages')
    .insert({ conversation_id: conversation.id, user_id: user.id, role: 'user', source: 'text', content: input })
    .select('id,role,source,content,model,created_at')
    .single();
  if (saveUserError) throw saveUserError;

  const { data: history, error: historyError } = await supabase
    .from('messages')
    .select('role,content')
    .eq('conversation_id', conversation.id)
    .order('created_at', { ascending: false })
    .limit(8);
  if (historyError) throw historyError;
  const model = envValue(env, 'GROQ_REASONING_MODEL') || DEFAULT_REASONING_MODEL;
  const fallbackModel = envValue(env, 'GROQ_FALLBACK_MODEL') || DEFAULT_FALLBACK_MODEL;
  const messages = [
    { role: 'system', content: systemPrompt(mode) },
    ...(history || []).reverse().map((message) => ({ role: message.role, content: message.content })),
  ];

  let data;
  let usedModel = model;
  try {
    data = await groqCompletion({ model, messages, env, signal: request.signal });
  } catch (error) {
    if (!fallbackModel || fallbackModel === model || error.code === 'GROQ_QUOTA_EXHAUSTED') throw error;
    usedModel = fallbackModel;
    data = await groqCompletion({ model: fallbackModel, messages, env, signal: request.signal });
  }
  const reply = getMessageContent(data?.choices?.[0]?.message?.content || data?.choices?.[0]?.text);
  if (!reply) throw new ApiError('The AI returned an empty response.', 502, null, { code: 'EMPTY_AI_RESPONSE', stage: 'chat', requestId: id });

  const { data: savedAssistantMessage, error: saveAssistantError } = await supabase
    .from('messages')
    .insert({ conversation_id: conversation.id, user_id: user.id, role: 'assistant', source: 'text', content: reply, model: usedModel })
    .select('id,role,source,content,model,created_at')
    .single();
  if (saveAssistantError) throw saveAssistantError;
  await supabase.from('conversations').update({ title: input.slice(0, 80) }).eq('id', conversation.id).eq('user_id', user.id);
  await writeUsageLog(supabase, { user_id: user.id, endpoint: '/api/chat', provider: 'groq', model: usedModel, status_code: 200, latency_ms: Date.now() - startedAt, request_id: id });
  return json({ reply, conversationId: conversation.id, userMessage: responseMessage(savedUserMessage), assistantMessage: responseMessage(savedAssistantMessage) });
}

export async function handlePersistVoiceMessage(request, env) {
  const id = requestId(request);
  if (contentLengthExceeds(request, MAX_MESSAGE_BODY_BYTES)) throw new ApiError('That transcript is too large.', 413, null, { code: 'REQUEST_TOO_LARGE', stage: 'messages', requestId: id });
  const { supabase, user } = await authenticate(request, env, id, 'messages');
  const payload = await parseJson(request, { code: 'INVALID_ARGUMENT', stage: 'messages', requestId: id });
  const content = getMessageContent(payload?.content);
  const role = payload?.role;
  if (!content || !['user', 'assistant'].includes(role)) throw new ApiError('A valid confirmed voice message is required.', 400, null, { code: 'INVALID_ARGUMENT', stage: 'messages', requestId: id });
  const conversation = await assertOwnedConversation(supabase, user.id, payload?.conversationId, id);
  const { data, error } = await supabase
    .from('messages')
    .insert({ conversation_id: conversation.id, user_id: user.id, role, source: 'voice', content, model: role === 'assistant' ? getLiveModel(env) : null })
    .select('id,role,source,content,model,created_at')
    .single();
  if (error) throw error;
  return json({ message: responseMessage(data) });
}

export async function handleDeleteAccount(request, env) {
  const id = requestId(request);
  const { supabase, user } = await authenticate(request, env, id, 'account');
  const { error } = await supabase.auth.admin.deleteUser(user.id);
  if (error) throw error;
  return json({ ok: true });
}

export function handleStatus(_request, env) {
  return json({
    supabaseConfigured: Boolean((envValue(env, 'SUPABASE_URL') || envValue(env, 'VITE_SUPABASE_URL')) && envValue(env, 'SUPABASE_SERVICE_ROLE_KEY')),
    chatReady: Boolean(envValue(env, 'GROQ_API_KEY')),
    liveReady: Boolean(getGeminiApiKey(env)),
    liveModel: getLiveModel(env),
    buildCommit: envValue(env, 'VERCEL_GIT_COMMIT_SHA') || envValue(env, 'GIT_COMMIT_SHA') || 'local',
  });
}

export async function handleUsage(request, env) {
  const id = requestId(request);
  const { supabase, user } = await authenticate(request, env, id, 'usage');
  return json(await getUserEntitlement(supabase, user.id));
}

export const handleHealth = handleStatus;

export async function handleApi(request, env, url = new URL(request.url)) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204 });
  if ((url.pathname === '/api/status' || url.pathname === '/api/health') && request.method === 'GET') return handleStatus(request, env);
  if (url.pathname === '/api/me/usage' && request.method === 'GET') return handleUsage(request, env);
  if ((url.pathname === '/api/live/token' || url.pathname === '/api/live-token') && request.method === 'POST') return handleLiveToken(request, env);
  if (url.pathname === '/api/live/release' && request.method === 'POST') return handleLiveRelease(request, env);
  if (url.pathname === '/api/chat' && request.method === 'POST') return handleChat(request, env);
  if (url.pathname === '/api/messages' && request.method === 'POST') return handlePersistVoiceMessage(request, env);
  if (url.pathname === '/api/account' && request.method === 'DELETE') return handleDeleteAccount(request, env);
  return json({ error: 'API route not found.', code: 'NOT_FOUND', stage: 'routing', requestId: requestId(request) }, 404);
}

export function __resetRateLimitsForTests() {}

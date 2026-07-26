const GROQ_API_URL = 'https://api.groq.com/openai/v1';
const GEMINI_AUTH_TOKEN_URL = 'https://generativelanguage.googleapis.com/v1beta/auth_tokens';
const GEMINI_LIVE_API_VERSION = 'v1beta';
const LIVE_TOKEN_TIMEOUT_MS = 8 * 1000;

export const DEFAULT_REASONING_MODEL = 'openai/gpt-oss-120b';
export const DEFAULT_GEMINI_LIVE_MODEL = 'gemini-3.1-flash-live-preview';
export const DEFAULT_GEMINI_LIVE_VOICE = 'Kore';

export const MAX_CHAT_INPUT_CHARS = 2000;
export const MAX_CHAT_HISTORY_MESSAGES = 8;
export const MAX_CHAT_MESSAGE_CHARS = 1200;
export const MAX_CHAT_BODY_BYTES = 24000;
export const MAX_LIVE_TOKEN_BODY_BYTES = 1000;

const LIVE_TOKEN_RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;
const LIVE_TOKEN_RATE_LIMIT_MAX_REQUESTS = 20;
const LIVE_SESSION_RATE_LIMIT_WINDOW_MS = 24 * 60 * 60 * 1000;
const LIVE_SESSION_RATE_LIMIT_MAX_REQUESTS = 5;

// Vercel functions are intentionally stateless for this MVP. These maps protect
// warm instances without adding a paid/shared store to the Hobby deployment.
const liveTokenRateLimits = new Map();
const liveSessionRateLimits = new Map();

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
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...extraHeaders,
  };
  if (status === 429 && !headers['retry-after']) headers['retry-after'] = '60';
  return new Response(JSON.stringify(body), { status, headers });
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
  const responseRequestId = error instanceof ApiError ? error.requestId || requestId(request) : requestId(request);
  const headers = retryAfter ? { 'retry-after': String(retryAfter) } : {};
  const responseBody = {
    error: error instanceof ApiError ? error.message : 'The AI service is temporarily unavailable.',
    code: error instanceof ApiError ? error.code : 'API_REQUEST_FAILED',
    stage: error instanceof ApiError ? error.stage : 'api',
    requestId: responseRequestId,
  };
  if (!(error instanceof ApiError)) console.error('API request failed', responseBody.code, responseRequestId);
  return json(responseBody, status, headers);
}

function environmentValue(env, name) {
  const value = env?.[name];
  return typeof value === 'string' ? value.trim() : '';
}

function getGeminiApiKey(env) {
  for (const name of ['GEMINI_API_KEY', 'GOOGLE_API_KEY']) {
    const value = environmentValue(env, name);
    if (value) return value;
  }
  return '';
}

function requireGroqApiKey(env) {
  const apiKey = environmentValue(env, 'GROQ_API_KEY');
  if (!apiKey) {
    throw new ApiError('The AI service is not configured yet.', 503, null, {
      code: 'GROQ_NOT_CONFIGURED',
      stage: 'chat',
    });
  }
  return apiKey;
}

function requestRateLimitKey(request) {
  const ip = request.headers.get('x-vercel-forwarded-for')
    || request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || request.headers.get('cf-connecting-ip')
    || 'anonymous';
  const user = request.headers.get('x-user-id')?.trim();
  return user ? `${user}:${ip}` : ip;
}

function enforceRateLimit(store, request, windowMs, maxRequests, message, details) {
  const key = requestRateLimitKey(request);
  const now = Date.now();
  const current = store.get(key);
  const entry = current && now - current.startedAt < windowMs
    ? current
    : { startedAt: now, count: 0 };

  if (entry.count >= maxRequests) {
    const retryAfterSeconds = Math.max(1, Math.ceil((entry.startedAt + windowMs - now) / 1000));
    throw new ApiError(message, 429, retryAfterSeconds, details);
  }

  entry.count += 1;
  store.set(key, entry);
  if (store.size > 1000) {
    for (const [storedKey, storedEntry] of store) {
      if (now - storedEntry.startedAt >= windowMs) store.delete(storedKey);
    }
  }
}

export function getLiveModel(env) {
  return (environmentValue(env, 'GEMINI_LIVE_MODEL') || DEFAULT_GEMINI_LIVE_MODEL).replace(/^models\//, '');
}

export function getLiveVoice(env) {
  return environmentValue(env, 'GEMINI_LIVE_VOICE') || DEFAULT_GEMINI_LIVE_VOICE;
}

function contentLengthExceeds(request, maximum) {
  const length = Number(request.headers.get('content-length'));
  return Number.isFinite(length) && length > maximum;
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

export async function handleLiveToken(request, env) {
  const id = requestId(request);
  if (contentLengthExceeds(request, MAX_LIVE_TOKEN_BODY_BYTES)) {
    throw new ApiError('That voice session request is too large.', 413, null, {
      code: 'REQUEST_TOO_LARGE',
      stage: 'token_creation',
      requestId: id,
    });
  }

  const apiKey = getGeminiApiKey(env);
  if (!apiKey) {
    throw new ApiError('Gemini Live is not configured yet.', 503, null, {
      code: 'GEMINI_NOT_CONFIGURED',
      stage: 'token_creation',
      requestId: id,
    });
  }

  let payload = {};
  try {
    payload = await request.json();
  } catch {
    // An empty body is valid; Argue is the default mode.
  }

  const mode = payload?.mode === 'Brainstorm' ? 'Brainstorm' : 'Argue';
  enforceRateLimit(
    liveTokenRateLimits,
    request,
    LIVE_TOKEN_RATE_LIMIT_WINDOW_MS,
    LIVE_TOKEN_RATE_LIMIT_MAX_REQUESTS,
    'Too many voice starts. Please wait a few minutes and try again.',
    { code: 'RATE_LIMITED', stage: 'rate_limit', requestId: id },
  );
  enforceRateLimit(
    liveSessionRateLimits,
    request,
    LIVE_SESSION_RATE_LIMIT_WINDOW_MS,
    LIVE_SESSION_RATE_LIMIT_MAX_REQUESTS,
    'The free voice limit is 5 sessions per day. Please try again tomorrow.',
    { code: 'RATE_LIMITED', stage: 'rate_limit', requestId: id },
  );

  let tokenResponse;
  try {
    tokenResponse = await fetchWithTimeout(GEMINI_AUTH_TOKEN_URL, {
      method: 'POST',
      headers: {
        'x-goog-api-key': apiKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        uses: 1,
        expireTime: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
        newSessionExpireTime: new Date(Date.now() + 60 * 1000).toISOString(),
      }),
    }, LIVE_TOKEN_TIMEOUT_MS);
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new ApiError('Gemini Live token creation timed out. Please try again.', 504, 5, {
        code: 'GEMINI_UPSTREAM_UNAVAILABLE',
        stage: 'token_creation',
        requestId: id,
      });
    }
    throw new ApiError('Gemini Live is temporarily unavailable.', 502, null, {
      code: 'GEMINI_UPSTREAM_UNAVAILABLE',
      stage: 'token_creation',
      requestId: id,
    });
  }

  if (!tokenResponse.ok) {
    const errorData = await tokenResponse.json().catch(() => null);
    const upstreamError = errorData?.error || {};
    console.error('Gemini Live token provisioning failed', {
      requestId: id,
      httpStatus: tokenResponse.status,
      status: upstreamError.status || '',
      code: upstreamError.code || tokenResponse.status,
      message: safeUpstreamMessage(upstreamError.message),
    });
    if (tokenResponse.status === 401) {
      throw new ApiError('Gemini Live rejected the API key.', 502, null, { code: 'GEMINI_INVALID_KEY', stage: 'token_creation', requestId: id });
    }
    if (tokenResponse.status === 403) {
      throw new ApiError('Gemini Live access is not enabled for this API key.', 502, null, { code: 'GEMINI_PERMISSION_DENIED', stage: 'token_creation', requestId: id });
    }
    if (tokenResponse.status === 404) {
      throw new ApiError('The configured Gemini Live model is unavailable.', 502, null, { code: 'GEMINI_MODEL_UNAVAILABLE', stage: 'token_creation', requestId: id });
    }
    if (tokenResponse.status === 429) {
      throw new ApiError('Gemini Live quota is temporarily exhausted.', 429, 60, { code: 'GEMINI_QUOTA_EXHAUSTED', stage: 'token_creation', requestId: id });
    }
    if (tokenResponse.status === 400) {
      throw new ApiError('Gemini Live rejected the session request.', 502, null, { code: 'GEMINI_TOKEN_REQUEST_REJECTED', stage: 'token_creation', requestId: id });
    }
    throw new ApiError('Gemini Live is temporarily unavailable.', 502, null, { code: 'GEMINI_UPSTREAM_UNAVAILABLE', stage: 'token_creation', requestId: id });
  }

  const tokenData = await tokenResponse.json().catch(() => null);
  if (!tokenData?.name) {
    throw new ApiError('Gemini Live returned an invalid session token.', 502, null, {
      code: 'GEMINI_TOKEN_REQUEST_REJECTED',
      stage: 'token_creation',
      requestId: id,
    });
  }

  return json({
    token: tokenData.name,
    model: getLiveModel(env),
    voice: getLiveVoice(env),
    apiVersion: GEMINI_LIVE_API_VERSION,
    expiresAt: tokenData.expireTime || null,
    mode,
  });
}

function getMessageContent(message) {
  const content = message?.content;
  if (typeof content === 'string') return content.trim().slice(0, MAX_CHAT_MESSAGE_CHARS);
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part : part?.text || ''))
      .join(' ')
      .trim()
      .slice(0, MAX_CHAT_MESSAGE_CHARS);
  }
  return '';
}

async function groqJson(path, body, env) {
  const response = await fetch(`${GROQ_API_URL}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${requireGroqApiKey(env)}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    console.error(`Groq ${path} failed with status ${response.status}`);
    throw new ApiError('The AI service could not complete that request.', response.status === 429 ? 429 : 502, null, {
      code: response.status === 429 ? 'GROQ_QUOTA_EXHAUSTED' : 'GROQ_UPSTREAM_UNAVAILABLE',
      stage: 'chat',
    });
  }

  return response.json();
}

function normalizeMessages(messages) {
  if (!Array.isArray(messages)) return [];

  return messages
    .filter((message) => message && (message.role === 'user' || message.role === 'assistant'))
    .map((message) => ({ role: message.role, content: getMessageContent(message) }))
    .filter((message) => message.content)
    .slice(-MAX_CHAT_HISTORY_MESSAGES);
}

function systemPrompt(mode) {
  if (mode === 'Brainstorm') {
    return 'You are Argue AI in Brainstorm mode: a serious, sharp thinking partner. Keep every reply compact: 2 or 3 short sentences, or up to 3 compact bullets, with a maximum of 60 words. Use plain, precise language. Surface the strongest insight, one meaningful risk or tradeoff, and one practical next step or question. Stay constructive and intellectually honest. Skip jokes, fluff, throat-clearing, headings, and long explanations. Do not claim to browse the web or know current facts unless they are provided in the conversation.';
  }

  return 'You are Argue AI in Argue mode: a witty, rigorous debate partner. Keep every reply to 1 to 3 short sentences and no more than 55 words. Use small, plain words for maximum punch. Open with the strongest challenge, add one concrete twist or tradeoff, and end with one crisp question only when it moves the debate forward. Add a clever, good-natured joke or playful turn when it fits; never force humor, mock the user, or target sensitive groups. No fluff, headings, long setup, or repeated claims. Stay fair, accurate, and intellectually honest. Do not invent sources or claim to have current web data.';
}

export async function handleChat(request, env) {
  if (contentLengthExceeds(request, MAX_CHAT_BODY_BYTES)) {
    throw new ApiError('That argument history is too large. Start a new conversation or shorten it.', 413, null, { code: 'REQUEST_TOO_LARGE', stage: 'chat' });
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    throw new ApiError('Please send a valid argument.', 400, null, { code: 'INVALID_ARGUMENT', stage: 'chat' });
  }

  const input = typeof payload?.input === 'string' ? payload.input.trim() : '';
  if (!input || input.length > MAX_CHAT_INPUT_CHARS) {
    throw new ApiError(`Your argument must be between 1 and ${MAX_CHAT_INPUT_CHARS} characters.`, 400, null, { code: 'INVALID_ARGUMENT', stage: 'chat' });
  }

  const history = normalizeMessages(payload.messages);
  const lastMessage = history.at(-1);
  const model = environmentValue(env, 'GROQ_REASONING_MODEL') || DEFAULT_REASONING_MODEL;
  const isGptOss = model === 'openai/gpt-oss-20b' || model === 'openai/gpt-oss-120b';
  const messages = [
    { role: 'system', content: systemPrompt(payload.mode) },
    ...history,
    ...(lastMessage?.role === 'user' && lastMessage.content === input ? [] : [{ role: 'user', content: input }]),
  ];

  const data = await groqJson('/chat/completions', {
    model,
    messages,
    temperature: payload.mode === 'Brainstorm' ? 0.35 : 0.6,
    max_completion_tokens: 256,
    ...(isGptOss ? { reasoning_effort: 'low' } : {}),
  }, env);

  const reply = getMessageContent(data?.choices?.[0]?.message) || data?.choices?.[0]?.text?.trim();
  if (!reply) throw new ApiError('The AI returned an empty response.', 502, null, { code: 'EMPTY_AI_RESPONSE', stage: 'chat' });

  return json({ reply });
}

export function handleHealth(_request, env) {
  const liveConfigured = Boolean(getGeminiApiKey(env));
  return json({
    status: 'ok',
    environment: environmentValue(env, 'VERCEL_ENV') || environmentValue(env, 'NODE_ENV') || 'development',
    liveConfigured,
    liveStatus: liveConfigured ? 'credentials-present-not-verified' : 'credentials-missing',
    textConfigured: Boolean(environmentValue(env, 'GROQ_API_KEY')),
    liveModel: getLiveModel(env),
    liveVoice: getLiveVoice(env),
    apiVersion: GEMINI_LIVE_API_VERSION,
    buildCommit: environmentValue(env, 'VERCEL_GIT_COMMIT_SHA') || environmentValue(env, 'GIT_COMMIT_SHA') || 'local',
  });
}

export async function handleApi(request, env, url = new URL(request.url)) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204 });
  if (url.pathname === '/api/health' && request.method === 'GET') return handleHealth(request, env);
  if (url.pathname === '/api/live-token' && request.method === 'POST') return handleLiveToken(request, env);
  if (url.pathname === '/api/chat' && request.method === 'POST') return handleChat(request, env);
  return json({ error: 'API route not found.', code: 'NOT_FOUND', stage: 'routing', requestId: requestId(request) }, 404);
}

export function __resetRateLimitsForTests() {
  liveTokenRateLimits.clear();
  liveSessionRateLimits.clear();
}

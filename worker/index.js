const GROQ_API_URL = 'https://api.groq.com/openai/v1';
const GEMINI_AUTH_TOKEN_URL = 'https://generativelanguage.googleapis.com/v1beta/auth_tokens';
const DEFAULT_REASONING_MODEL = 'openai/gpt-oss-120b';
const DEFAULT_GEMINI_LIVE_MODEL = 'gemini-3.1-flash-live-preview';
const DEFAULT_GEMINI_LIVE_VOICE = 'Kore';
const LIVE_TOKEN_RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;
const LIVE_TOKEN_RATE_LIMIT_MAX_REQUESTS = 20;

const liveTokenRateLimits = new Map();

class ApiError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.status = status;
  }
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

function requireApiKey(env) {
  if (!env.GROQ_API_KEY) {
    throw new ApiError('The AI service is not configured yet.', 503);
  }
  return env.GROQ_API_KEY;
}

function requestRateLimitKey(request) {
  return request.headers.get('cf-connecting-ip')
    || request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || 'anonymous';
}

function enforceRateLimit(store, request, windowMs, maxRequests) {
  const key = requestRateLimitKey(request);
  const now = Date.now();
  const current = store.get(key);
  const entry = current && now - current.startedAt < windowMs
    ? current
    : { startedAt: now, count: 0 };

  if (entry.count >= maxRequests) {
    throw new ApiError('Live voice is temporarily rate-limited. Please try again soon.', 429);
  }

  entry.count += 1;
  store.set(key, entry);
  if (store.size > 1000) {
    for (const [storedKey, storedEntry] of store) {
      if (now - storedEntry.startedAt >= windowMs) store.delete(storedKey);
    }
  }
}

function getLiveModel(env) {
  const configuredModel = typeof env.GEMINI_LIVE_MODEL === 'string' ? env.GEMINI_LIVE_MODEL.trim() : '';
  return (configuredModel || DEFAULT_GEMINI_LIVE_MODEL).replace(/^models\//, '');
}

function getLiveVoice(env) {
  const configuredVoice = typeof env.GEMINI_LIVE_VOICE === 'string' ? env.GEMINI_LIVE_VOICE.trim() : '';
  return configuredVoice || DEFAULT_GEMINI_LIVE_VOICE;
}

async function handleLiveToken(request, env) {
  if (!env.GEMINI_API_KEY) {
    throw new ApiError('Gemini Live is not configured yet.', 503);
  }

  let payload = {};
  try {
    payload = await request.json();
  } catch {
    // The mode is optional; use Argue when no body is provided.
  }

  const mode = payload?.mode === 'Brainstorm' ? 'Brainstorm' : 'Argue';
  const model = getLiveModel(env);
  const voice = getLiveVoice(env);
  enforceRateLimit(liveTokenRateLimits, request, LIVE_TOKEN_RATE_LIMIT_WINDOW_MS, LIVE_TOKEN_RATE_LIMIT_MAX_REQUESTS);

  const tokenResponse = await fetch(GEMINI_AUTH_TOKEN_URL, {
    method: 'POST',
    headers: {
      'x-goog-api-key': env.GEMINI_API_KEY,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      uses: 1,
      expireTime: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      newSessionExpireTime: new Date(Date.now() + 60 * 1000).toISOString(),
      liveConnectConstraints: {
        model: `models/${model}`,
        config: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: voice },
            },
          },
        },
      },
    }),
  });

  if (!tokenResponse.ok) {
    console.error('Gemini Live token provisioning failed', tokenResponse.status);
    throw new ApiError('Gemini Live could not start right now.', tokenResponse.status === 429 ? 429 : 502);
  }

  const tokenData = await tokenResponse.json().catch(() => null);
  if (!tokenData?.name) {
    throw new ApiError('Gemini Live returned an invalid session token.', 502);
  }

  return json({
    token: tokenData.name,
    model,
    voice,
    expiresAt: tokenData.expireTime || null,
    mode,
  });
}

function getMessageContent(message) {
  const content = message?.content;
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part : part?.text || ''))
      .join(' ')
      .trim();
  }
  return '';
}

async function groqJson(path, body, env) {
  const response = await fetch(`${GROQ_API_URL}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${requireApiKey(env)}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    console.error(`Groq ${path} failed with status ${response.status}`);
    throw new ApiError('The AI service could not complete that request.', response.status === 429 ? 429 : 502);
  }

  return response.json();
}

function normalizeMessages(messages) {
  if (!Array.isArray(messages)) return [];

  return messages
    .filter((message) => message && (message.role === 'user' || message.role === 'assistant'))
    .map((message) => ({ role: message.role, content: getMessageContent(message) }))
    .filter((message) => message.content)
    .slice(-10);
}

function systemPrompt(mode) {
  if (mode === 'Brainstorm') {
    return 'You are Argue AI in Brainstorm mode: a serious, sharp thinking partner. Keep every reply compact: 2 or 3 short sentences, or up to 3 compact bullets, with a maximum of 60 words. Use plain, precise language. Surface the strongest insight, one meaningful risk or tradeoff, and one practical next step or question. Stay constructive and intellectually honest. Skip jokes, fluff, throat-clearing, headings, and long explanations. Do not claim to browse the web or know current facts unless they are provided in the conversation.';
  }

  return 'You are Argue AI in Argue mode: a witty, rigorous debate partner. Keep every reply to 1 to 3 short sentences and no more than 55 words. Use small, plain words for maximum punch. Open with the strongest challenge, add one concrete twist or tradeoff, and end with one crisp question only when it moves the debate forward. Add a clever, good-natured joke or playful turn when it fits; never force humor, mock the user, or target sensitive groups. No fluff, headings, long setup, or repeated claims. Stay fair, accurate, and intellectually honest. Do not invent sources or claim to have current web data.';
}

async function handleChat(request, env) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    throw new ApiError('Please send a valid argument.', 400);
  }

  const input = typeof payload?.input === 'string' ? payload.input.trim() : '';
  if (!input || input.length > 4000) {
    throw new ApiError('Your argument must be between 1 and 4000 characters.', 400);
  }

  const history = normalizeMessages(payload.messages);
  const lastMessage = history.at(-1);
  const model = env.GROQ_REASONING_MODEL || DEFAULT_REASONING_MODEL;
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
    max_completion_tokens: 512,
    ...(isGptOss ? { reasoning_effort: 'low' } : {}),
  }, env);

  const reply = getMessageContent(data?.choices?.[0]?.message) || data?.choices?.[0]?.text?.trim();
  if (!reply) throw new ApiError('The AI returned an empty response.', 502);

  return json({ reply });
}

async function handleApi(request, env, url) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204 });
  if (url.pathname === '/api/health' && request.method === 'GET') {
    return json({
      status: 'ok',
      configured: Boolean(env.GROQ_API_KEY || env.GEMINI_API_KEY),
      textConfigured: Boolean(env.GROQ_API_KEY),
      liveConfigured: Boolean(env.GEMINI_API_KEY),
      reasoningModel: env.GROQ_REASONING_MODEL || DEFAULT_REASONING_MODEL,
      liveModel: getLiveModel(env),
      liveVoice: getLiveVoice(env),
    });
  }
  if (url.pathname === '/api/live-token' && request.method === 'POST') return handleLiveToken(request, env);
  if (url.pathname === '/api/chat' && request.method === 'POST') return handleChat(request, env);
  return json({ error: 'API route not found.' }, 404);
}

const worker = {
  async fetch(request, env) {
    const url = new URL(request.url);

    try {
      if (url.pathname.startsWith('/api/')) return await handleApi(request, env, url);

      const assetPath = url.pathname === '/' || url.pathname.endsWith('/')
        ? `${url.pathname}index.html`
        : url.pathname;
      const assetRequest = new Request(new URL(assetPath, request.url), request);
      const response = await env.ASSETS.fetch(assetRequest);

      if (response.status === 404 && request.method === 'GET' && !url.pathname.includes('.')) {
        return env.ASSETS.fetch(new Request(new URL('/index.html', request.url), request));
      }

      return response;
    } catch (error) {
      console.error('API request failed', error instanceof ApiError ? error.status : error?.code || 500);
      const status = error instanceof ApiError ? error.status : 500;
      return json({ error: error instanceof ApiError ? error.message : 'The AI service is temporarily unavailable.' }, status);
    }
  },
};

export default worker;

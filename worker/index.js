const GROQ_API_URL = 'https://api.groq.com/openai/v1';
const DEFAULT_TRANSCRIPTION_MODEL = 'whisper-large-v3-turbo';
const DEFAULT_REASONING_MODEL = 'openai/gpt-oss-120b';
const DEFAULT_TTS_LANGUAGE = 'en-GB';
const DEFAULT_TTS_VOICE = 'en-GB-Chirp3-HD-Algenib';
const MAX_TTS_TEXT_LENGTH = 4000;
const TTS_RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;
const TTS_RATE_LIMIT_MAX_REQUESTS = 30;

let ttsCredentialValue = '';
let ttsCredentials = null;
let ttsAccessToken = '';
let ttsAccessTokenExpiry = 0;
const ttsRateLimits = new Map();

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

function getTtsCredentials(env) {
  const encodedCredentials = env.GOOGLE_TTS_CREDENTIALS_BASE64;
  if (!encodedCredentials) {
    throw new ApiError('Voice playback is not configured yet.', 503);
  }

  if (ttsCredentials && ttsCredentialValue === encodedCredentials) return { credentials: ttsCredentials, encodedCredentials };

  let credentials;
  try {
    const decodedCredentials = Buffer.from(encodedCredentials, 'base64').toString('utf8');
    credentials = JSON.parse(decodedCredentials);
  } catch {
    throw new ApiError('Voice playback is configured incorrectly.', 503);
  }

  if (!credentials?.project_id || !credentials?.client_email || !credentials?.private_key) {
    throw new ApiError('Voice playback is configured incorrectly.', 503);
  }

  ttsCredentials = credentials;
  ttsCredentialValue = encodedCredentials;
  ttsAccessToken = '';
  ttsAccessTokenExpiry = 0;
  return { credentials, encodedCredentials };
}

function base64UrlEncode(value) {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function privateKeyBytes(privateKey) {
  const encoded = privateKey
    .replace('-----BEGIN PRIVATE KEY-----', '')
    .replace('-----END PRIVATE KEY-----', '')
    .replace(/\s/g, '');
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}

async function getGoogleAccessToken(credentials, encodedCredentials) {
  const now = Math.floor(Date.now() / 1000);
  if (ttsAccessToken && ttsCredentialValue === encodedCredentials && now < ttsAccessTokenExpiry - 60) {
    return ttsAccessToken;
  }

  const assertionHeader = base64UrlEncode(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const assertionPayload = base64UrlEncode(JSON.stringify({
    iss: credentials.client_email,
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }));
  const assertionData = `${assertionHeader}.${assertionPayload}`;

  let key;
  try {
    key = await crypto.subtle.importKey(
      'pkcs8',
      privateKeyBytes(credentials.private_key),
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign'],
    );
  } catch {
    throw new ApiError('Voice playback credentials are invalid.', 503);
  }

  const signature = await crypto.subtle.sign(
    { name: 'RSASSA-PKCS1-v1_5' },
    key,
    new TextEncoder().encode(assertionData),
  );
  const assertion = `${assertionData}.${base64UrlEncode(new Uint8Array(signature))}`;
  const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });

  if (!tokenResponse.ok) {
    console.error('Google TTS auth failed', tokenResponse.status);
    throw new ApiError('Voice playback authentication failed.', 502);
  }

  const tokenData = await tokenResponse.json();
  if (!tokenData?.access_token) throw new ApiError('Voice playback authentication failed.', 502);
  ttsAccessToken = tokenData.access_token;
  ttsAccessTokenExpiry = now + Number(tokenData.expires_in || 3600);
  return ttsAccessToken;
}

function ttsRateLimitKey(request) {
  return request.headers.get('cf-connecting-ip')
    || request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || 'anonymous';
}

function enforceTtsRateLimit(request) {
  const key = ttsRateLimitKey(request);
  const now = Date.now();
  const current = ttsRateLimits.get(key);
  const entry = current && now - current.startedAt < TTS_RATE_LIMIT_WINDOW_MS
    ? current
    : { startedAt: now, count: 0 };

  if (entry.count >= TTS_RATE_LIMIT_MAX_REQUESTS) {
    throw new ApiError('Voice playback is temporarily rate-limited. Please try again soon.', 429);
  }

  entry.count += 1;
  ttsRateLimits.set(key, entry);
  if (ttsRateLimits.size > 1000) {
    for (const [storedKey, storedEntry] of ttsRateLimits) {
      if (now - storedEntry.startedAt >= TTS_RATE_LIMIT_WINDOW_MS) ttsRateLimits.delete(storedKey);
    }
  }
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
  const messages = [
    { role: 'system', content: systemPrompt(payload.mode) },
    ...history,
    ...(lastMessage?.role === 'user' && lastMessage.content === input ? [] : [{ role: 'user', content: input }]),
  ];

  const data = await groqJson('/chat/completions', {
    model: env.GROQ_REASONING_MODEL || DEFAULT_REASONING_MODEL,
    messages,
    temperature: payload.mode === 'Brainstorm' ? 0.35 : 0.6,
    max_tokens: payload.mode === 'Brainstorm' ? 280 : 220,
  }, env);

  const reply = getMessageContent(data?.choices?.[0]?.message) || data?.choices?.[0]?.text?.trim();
  if (!reply) throw new ApiError('The AI returned an empty response.', 502);

  return json({ reply });
}

async function handleTranscription(request, env) {
  const formData = await request.formData();
  const audio = formData.get('audio');
  if (!audio || typeof audio.arrayBuffer !== 'function') {
    throw new ApiError('Please record an audio argument first.', 400);
  }
  if (audio.size > 25 * 1024 * 1024) {
    throw new ApiError('That recording is too large. Please keep it under 25 MB.', 413);
  }

  const audioBytes = await audio.arrayBuffer();
  const upstream = new FormData();
  upstream.append('file', new Blob([audioBytes], { type: audio.type || 'audio/webm' }), formData.get('filename') || 'argument.webm');
  upstream.append('model', env.GROQ_TRANSCRIPTION_MODEL || DEFAULT_TRANSCRIPTION_MODEL);
  upstream.append('response_format', 'json');

  const response = await fetch(`${GROQ_API_URL}/audio/transcriptions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${requireApiKey(env)}` },
    body: upstream,
  });

  if (!response.ok) {
    console.error(`Groq transcription failed with status ${response.status}`);
    throw new ApiError('The recording could not be transcribed.', response.status === 429 ? 429 : 502);
  }

  const data = await response.json();
  const transcript = typeof data?.text === 'string' ? data.text.trim() : '';
  if (!transcript) throw new ApiError('No speech was detected in that recording.', 422);

  return json({ transcript });
}

async function handleTts(request, env) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    throw new ApiError('Please send text to speak.', 400);
  }

  const text = typeof payload?.text === 'string' ? payload.text.trim() : '';
  if (!text || text.length > MAX_TTS_TEXT_LENGTH) {
    throw new ApiError(`Text must be between 1 and ${MAX_TTS_TEXT_LENGTH} characters.`, 400);
  }

  enforceTtsRateLimit(request);

  const { credentials, encodedCredentials } = getTtsCredentials(env);
  const accessToken = await getGoogleAccessToken(credentials, encodedCredentials);
  const languageCode = env.GOOGLE_TTS_LANGUAGE || DEFAULT_TTS_LANGUAGE;
  const configuredVoice = env.GOOGLE_TTS_VOICE || DEFAULT_TTS_VOICE;
  const voiceName = configuredVoice.startsWith(`${languageCode}-`)
    ? configuredVoice
    : `${languageCode}-${configuredVoice}`;
  let response;
  try {
    response = await fetch('https://texttospeech.googleapis.com/v1/text:synthesize', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        input: { text },
        voice: {
          languageCode,
          name: voiceName,
        },
        audioConfig: { audioEncoding: 'MP3' },
      }),
    });
  } catch (error) {
    console.error('Google TTS request failed', error?.code || 'unknown');
    throw new ApiError('Voice playback could not be generated right now.', error?.code === 8 ? 429 : 502);
  }

  if (!response.ok) {
    console.error('Google TTS API failed', response.status);
    throw new ApiError('Voice playback could not be generated right now.', response.status === 429 ? 429 : 502);
  }

  const responseData = await response.json().catch(() => null);
  if (!responseData?.audioContent) {
    throw new ApiError('Voice playback returned empty audio.', 502);
  }

  const audioBytes = Buffer.from(responseData.audioContent, 'base64');
  if (!audioBytes.length) throw new ApiError('Voice playback returned empty audio.', 502);

  return new Response(audioBytes, {
    status: 200,
    headers: {
      'content-type': 'audio/mpeg',
      'cache-control': 'private, no-store',
      'content-length': String(audioBytes.length),
      'x-content-type-options': 'nosniff',
    },
  });
}

async function handleApi(request, env, url) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204 });
  if (url.pathname === '/api/health' && request.method === 'GET') {
    return json({
      status: 'ok',
      configured: Boolean(env.GROQ_API_KEY),
      transcriptionModel: env.GROQ_TRANSCRIPTION_MODEL || DEFAULT_TRANSCRIPTION_MODEL,
      reasoningModel: env.GROQ_REASONING_MODEL || DEFAULT_REASONING_MODEL,
    });
  }
  if (url.pathname === '/api/chat' && request.method === 'POST') return handleChat(request, env);
  if (url.pathname === '/api/transcribe' && request.method === 'POST') return handleTranscription(request, env);
  if (url.pathname === '/api/tts' && request.method === 'POST') return handleTts(request, env);
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

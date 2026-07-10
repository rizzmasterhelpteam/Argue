const GROQ_API_URL = 'https://api.groq.com/openai/v1';
const DEFAULT_TRANSCRIPTION_MODEL = 'whisper-large-v3-turbo';
const DEFAULT_REASONING_MODEL = 'openai/gpt-oss-20b';

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
    return 'You are Argue AI in Brainstorm mode. Help the user develop ideas with focused, practical questions and useful alternatives. Keep replies punchy: 2 to 4 short sentences or 3 compact bullets. Be concise, clear, and constructive. Do not claim to browse the web or know current facts unless they are provided in the conversation.';
  }

  return 'You are Argue AI in Argue mode. Make the response sharp and useful, not long. In 2 to 4 short sentences: lead with the strongest challenge, add one concrete nuance, and end with one pointed question. Prefer plain text over tables or long formatting. Challenge the user\'s position respectfully, stay intellectually honest, and do not invent sources or claim to have current web data.';
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
    temperature: 0.45,
    max_tokens: 360,
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
      console.error(error);
      const status = error instanceof ApiError ? error.status : 500;
      return json({ error: error instanceof ApiError ? error.message : 'The AI service is temporarily unavailable.' }, status);
    }
  },
};

export default worker;

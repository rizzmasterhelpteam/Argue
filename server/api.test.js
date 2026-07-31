import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildLiveTokenConstraints, errorResponse, handleChat, handleLiveToken, handleStatus } from './api.js';

function request(path, options = {}) {
  return new Request(`https://argue.test${path}`, options);
}

function jsonRequest(path, body, headers = {}) {
  return request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer test-access-token', ...headers },
    body: JSON.stringify(body),
  });
}

function createSupabaseMock({ conversationOwner = 'user-a' } = {}) {
  let messageIndex = 0;
  const calls = { rpc: [], inserts: [] };
  const client = {
    auth: {
      getUser: vi.fn(async () => ({ data: { user: { id: 'user-a', is_anonymous: false, app_metadata: {} } }, error: null })),
    },
    rpc: vi.fn(async (name, args) => {
      calls.rpc.push({ name, args });
      if (name === 'consume_rate_limit') return { data: [{ allowed: true, retry_after_seconds: 30 }], error: null };
      if (name === 'reserve_voice_usage') return { data: [{ reservation_id: 'reservation-a', expires_at: '2026-07-30T12:02:00Z', reserved_seconds: 120, remaining_voice_seconds: 0, plan: 'free' }], error: null };
      if (name === 'create_text_reply') return { data: [{ id: `message-${++messageIndex}`, role: 'assistant', source: 'text', content: args.p_content, model: args.p_model, created_at: '2026-07-30T12:00:00Z' }], error: null };
      return { data: null, error: null };
    }),
    from(table) {
      const messages = {
        select() { return messages; },
        eq() { return messages; },
        order() { return messages; },
        limit: async () => ({ data: [{ role: 'user', content: 'A saved message.' }], error: null }),
        insert(values) {
          calls.inserts.push({ table, values });
          const row = { id: `message-${++messageIndex}`, ...values, created_at: '2026-07-30T12:00:00Z' };
          return { select: () => ({ single: async () => ({ data: row, error: null }) }) };
        },
      };
      if (table === 'messages') return messages;
      if (table === 'conversations') {
        const query = {
          select() { return query; },
          eq() { return query; },
          maybeSingle: async () => ({ data: { id: 'conversation-a', user_id: conversationOwner, mode: 'argue', archived: false }, error: null }),
          update: () => ({ eq: () => ({ eq: async () => ({ error: null }) }) }),
        };
        return query;
      }
      return { insert: async (values) => { calls.inserts.push({ table, values }); return { error: null }; } };
    },
  };
  return { client, calls };
}

describe('authenticated Vercel API handlers', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('rejects unauthenticated requests before provider calls', async () => {
    const upstream = vi.fn();
    vi.stubGlobal('fetch', upstream);
    const response = await handleChat(request('/api/chat', { method: 'POST', body: '{}' }), {}).catch(errorResponse);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(upstream).not.toHaveBeenCalled();
  });

  it('creates a constrained one-use Live token after a persistent reservation', async () => {
    const { client, calls } = createSupabaseMock();
    const upstream = vi.fn(async () => new Response(JSON.stringify({ name: 'authTokens/test', expireTime: 'later' }), { status: 200 }));
    vi.stubGlobal('fetch', upstream);
    const response = await handleLiveToken(jsonRequest('/api/live/token', { mode: 'Argue' }), {
      __supabaseClient: client,
      GEMINI_API_KEY: 'server-only-key',
      GEMINI_LIVE_MODEL: 'gemini-3.1-flash-live-preview',
      GEMINI_LIVE_VOICE: 'Kore',
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ token: 'authTokens/test', reservationId: 'reservation-a', model: 'gemini-3.1-flash-live-preview' });
    expect(calls.rpc.map((call) => call.name)).toEqual(['consume_rate_limit', 'reserve_voice_usage']);
    expect(calls.rpc[1].args).toMatchObject({ p_user_id: 'user-a', p_model: 'gemini-3.1-flash-live-preview' });
    const requestBody = JSON.parse(upstream.mock.calls[0][1].body);
    expect(requestBody.uses).toBe(1);
    expect(requestBody.bidiGenerateContentSetup).toMatchObject({
      model: 'models/gemini-3.1-flash-live-preview',
      generationConfig: { responseModalities: ['AUDIO'] },
      sessionResumption: {},
    });
    expect(requestBody.bidiGenerateContentSetup.systemInstruction.parts[0].text).toContain('Argue AI');
  });

  it('uses server-owned conversation history and persists both text messages', async () => {
    const { client, calls } = createSupabaseMock();
    vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
      const body = JSON.parse(options.body);
      expect(body.model).toBe('openai/gpt-oss-120b');
      expect(body.messages[0].role).toBe('system');
      expect(body.messages[0].content).toContain('one to three short sentences');
      expect(body.max_completion_tokens).toBe(180);
      return new Response(JSON.stringify({ choices: [{ message: { content: 'Short answer.' } }] }), { status: 200 });
    }));
    const response = await handleChat(jsonRequest('/api/chat', { conversationId: 'conversation-a', input: 'Cities should ban private cars.' }), {
      __supabaseClient: client,
      GROQ_API_KEY: 'server-only-key',
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ reply: 'Short answer.', conversationId: 'conversation-a' });
    expect(calls.inserts.filter((entry) => entry.table === 'messages')).toHaveLength(1);
    expect(calls.rpc.map((call) => call.name)).toContain('create_text_reply');
  });

  it('denies a conversation owned by another user', async () => {
    const { client } = createSupabaseMock({ conversationOwner: 'user-b' });
    const response = await handleChat(jsonRequest('/api/chat', { conversationId: 'conversation-b', input: 'A private claim.' }), {
      __supabaseClient: client,
      GROQ_API_KEY: 'server-only-key',
    }).catch(errorResponse);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'CONVERSATION_FORBIDDEN' });
  });

  it('reports only safe status fields and locks the exact Live model', async () => {
    expect(buildLiveTokenConstraints({ GEMINI_LIVE_MODEL: 'gemini-3.1-flash-live-preview' }).model).toBe('models/gemini-3.1-flash-live-preview');
    const response = handleStatus(request('/api/status'), {
      SUPABASE_URL: 'https://project.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'server-only',
      GROQ_API_KEY: 'text-key',
      GEMINI_API_KEY: 'live-key',
      GEMINI_LIVE_MODEL: 'gemini-3.1-flash-live-preview',
    });
    expect(await response.json()).toEqual({
      supabaseConfigured: true,
      supabaseProjectRef: 'project',
      chatReady: true,
      liveReady: true,
      liveModel: 'gemini-3.1-flash-live-preview',
      buildCommit: 'local',
    });
  });
});

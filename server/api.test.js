import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __resetRateLimitsForTests,
  errorResponse,
  handleChat,
  handleHealth,
  handleLiveToken,
} from './api.js';

function request(path, options = {}) {
  return new Request(`https://argue.test${path}`, options);
}

function jsonRequest(path, body, headers = {}) {
  return request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

describe('Vercel API handlers', () => {
  afterEach(() => {
    __resetRateLimitsForTests();
    vi.unstubAllGlobals();
  });

  it('creates a short-lived Live token without exposing the API key', async () => {
    const upstream = vi.fn(async () => new Response(JSON.stringify({ name: 'authTokens/test', expireTime: 'later' }), { status: 200 }));
    vi.stubGlobal('fetch', upstream);

    const response = await handleLiveToken(
      jsonRequest('/api/live-token', { mode: 'Argue' }, { 'x-forwarded-for': '203.0.113.10' }),
      {
        GEMINI_API_KEY: 'server-only-key',
        GEMINI_LIVE_MODEL: 'gemini-3.1-flash-live-preview',
        GEMINI_LIVE_VOICE: 'Kore',
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      token: 'authTokens/test',
      model: 'gemini-3.1-flash-live-preview',
      voice: 'Kore',
      apiVersion: 'v1beta',
    });
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it('returns 503 when Live credentials are missing', async () => {
    const response = await handleLiveToken(jsonRequest('/api/live-token', {}), {}).catch(errorResponse);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: 'Gemini Live is not configured yet.', code: 'GEMINI_NOT_CONFIGURED', stage: 'token_creation' });
  });

  it('enforces the free daily voice-session limit', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ name: 'authTokens/test' }), { status: 200 })));
    const env = { GEMINI_API_KEY: 'server-only-key' };
    let response;

    for (let index = 0; index < 6; index += 1) {
      response = await handleLiveToken(
        jsonRequest('/api/live-token', { mode: 'Argue' }, { 'x-forwarded-for': '203.0.113.11' }),
        env,
      ).catch(errorResponse);
    }

    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ error: 'The free voice limit is 5 sessions per day. Please try again tomorrow.', code: 'RATE_LIMITED', stage: 'rate_limit' });
  });

  it('maps invalid-key and quota responses to safe structured errors', async () => {
    const env = { GEMINI_API_KEY: 'server-only-key' };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { status: 'PERMISSION_DENIED', code: 403, message: 'bad key' } }), { status: 403 })));
    const denied = await handleLiveToken(jsonRequest('/api/live-token', {}, { 'x-forwarded-for': '203.0.113.12' }), env).catch(errorResponse);
    expect(denied.status).toBe(502);
    expect(await denied.json()).toMatchObject({ code: 'GEMINI_PERMISSION_DENIED', stage: 'token_creation' });

    __resetRateLimitsForTests();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { status: 'RESOURCE_EXHAUSTED', code: 429, message: 'quota' } }), { status: 429 })));
    const quota = await handleLiveToken(jsonRequest('/api/live-token', {}, { 'x-forwarded-for': '203.0.113.13' }), env).catch(errorResponse);
    expect(quota.status).toBe(429);
    expect(await quota.json()).toMatchObject({ code: 'GEMINI_QUOTA_EXHAUSTED', stage: 'token_creation' });
  });

  it('keeps text chat compact and still returns the Groq response', async () => {
    const upstream = vi.fn(async (_url, options) => {
      const body = JSON.parse(options.body);
      expect(body.max_completion_tokens).toBe(256);
      expect(body.messages.length).toBeLessThanOrEqual(10);
      return new Response(JSON.stringify({ choices: [{ message: { content: 'Short answer.' } }] }), { status: 200 });
    });
    vi.stubGlobal('fetch', upstream);

    const response = await handleChat(
      jsonRequest('/api/chat', {
        mode: 'Argue',
        input: 'Cities should ban private cars.',
        messages: Array.from({ length: 20 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: `Message ${index}` })),
      }),
      { GROQ_API_KEY: 'server-only-key', GROQ_REASONING_MODEL: 'openai/gpt-oss-120b' },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ reply: 'Short answer.' });
  });

  it('reports only compact configuration diagnostics from health', async () => {
    const response = handleHealth(request('/api/health'), {
      GROQ_API_KEY: 'text-key',
      GEMINI_API_KEY: 'live-key',
      GEMINI_LIVE_MODEL: 'gemini-3.1-flash-live-preview',
      GEMINI_LIVE_VOICE: 'Kore',
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: 'ok',
      environment: 'development',
      textConfigured: true,
      liveConfigured: true,
      liveModel: 'gemini-3.1-flash-live-preview',
      liveStatus: 'credentials-present-not-verified',
      liveVoice: 'Kore',
      apiVersion: 'v1beta',
      buildCommit: 'local',
    });
  });
});

import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import liveTokenHandler from '../api/live-token.js';
import healthHandler from '../api/health.js';

function responseRecorder() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(name, value) {
      this.headers[name] = value;
    },
    end(body) {
      this.body = body;
    },
  };
}

function nodeRequest(method, url, body = '') {
  const request = Readable.from(body ? [body] : []);
  request.method = method;
  request.url = url;
  request.headers = { host: 'argue.test', 'content-type': 'application/json' };
  return request;
}

describe('Vercel route entrypoints', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('serves /api/health from a direct Vercel route', async () => {
    vi.stubEnv('GROQ_API_KEY', 'configured');
    vi.stubEnv('GEMINI_API_KEY', 'configured');
    const res = responseRecorder();

    await healthHandler(nodeRequest('GET', '/api/health'), res);

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(JSON.parse(res.body.toString())).toMatchObject({
      status: 'ok',
      textConfigured: true,
      liveConfigured: true,
    });
  });

  it('serves /api/live-token without proxying audio traffic', async () => {
    vi.stubEnv('GEMINI_API_KEY', 'server-only');
    vi.stubEnv('GEMINI_LIVE_MODEL', 'gemini-3.1-flash-live-preview');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ name: 'authTokens/route-test' }), { status: 200 })));
    const res = responseRecorder();

    await liveTokenHandler(
      nodeRequest('POST', '/api/live-token', JSON.stringify({ mode: 'Argue' })),
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(JSON.parse(res.body.toString())).toMatchObject({
      token: 'authTokens/route-test',
      model: 'gemini-3.1-flash-live-preview',
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toContain('generativelanguage.googleapis.com');
  });
});

import { errorResponse, handleApi } from '../server/api.js';

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
      return errorResponse(error, request);
    }
  },
};

export default worker;

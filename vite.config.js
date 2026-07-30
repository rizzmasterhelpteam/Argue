import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { cloudflare } from '@cloudflare/vite-plugin';
import { errorResponse, handleApi } from './server/api.js';

const isTest = process.env.VITEST === 'true';

function localApiPlugin(env) {
  return {
    name: 'argue-ai-local-api',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const method = req.method || 'GET';
        const url = new URL(req.url || '/', 'http://localhost');
        if (!url.pathname.startsWith('/api/')) {
          next();
          return;
        }

        let request;
        try {
          const chunks = [];
          for await (const chunk of req) chunks.push(Buffer.from(chunk));
          const body = chunks.length ? Buffer.concat(chunks) : undefined;
          const headers = new Headers();
          for (const [name, value] of Object.entries(req.headers || {})) {
            if (Array.isArray(value)) headers.set(name, value.join(', '));
            else if (value != null) headers.set(name, String(value));
          }
          request = new Request(new URL(url.pathname + url.search, 'http://localhost'), {
            method,
            headers,
            body: method === 'GET' || method === 'HEAD' ? undefined : body,
          });
          const response = await handleApi(request, env, url);
          res.statusCode = response.status;
          response.headers.forEach((value, name) => res.setHeader(name, value));
          res.end(Buffer.from(await response.arrayBuffer()));
        } catch (error) {
          const response = errorResponse(error, request);
          res.statusCode = response.status;
          response.headers.forEach((value, name) => res.setHeader(name, value));
          res.end(Buffer.from(await response.arrayBuffer()));
        }
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const localEnv = { ...process.env, ...loadEnv(mode, process.cwd(), '') };
  const isCloudflareBuild = mode === 'cloudflare';
  return {
    plugins: [
      react(),
      ...(isTest ? [] : [localApiPlugin(localEnv)]),
      ...(isCloudflareBuild ? [cloudflare({ configPath: 'wrangler.json' })] : []),
    ],
    server: {
      host: '0.0.0.0',
    },
    test: {
      environment: 'jsdom',
      globals: true,
      setupFiles: './src/test/setup.js',
      css: true,
    },
  };
});

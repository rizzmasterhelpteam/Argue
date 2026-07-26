import { errorResponse, json } from './api.js';

function requestHeaders(nodeHeaders) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(nodeHeaders || {})) {
    if (Array.isArray(value)) headers.set(name, value.join(', '));
    else if (value != null) headers.set(name, String(value));
  }
  return headers;
}

export function toWebRequest(req) {
  const method = req.method || 'GET';
  const protocol = req.headers?.['x-forwarded-proto'] || 'https';
  const host = req.headers?.host || 'localhost';
  const requestUrl = `${protocol}://${host}${req.url || '/'}`;
  const hasBody = method !== 'GET' && method !== 'HEAD';

  return new Request(requestUrl, {
    method,
    headers: requestHeaders(req.headers),
    body: hasBody ? req : undefined,
    ...(hasBody ? { duplex: 'half' } : {}),
  });
}

export async function sendWebResponse(res, response) {
  res.statusCode = response.status;
  response.headers.forEach((value, name) => res.setHeader(name, value));
  res.end(Buffer.from(await response.arrayBuffer()));
}

export async function handleVercelRoute(req, res, allowedMethod, routeHandler) {
  if (req.method === 'OPTIONS') {
    await sendWebResponse(res, new Response(null, { status: 204 }));
    return;
  }

  if ((req.method || 'GET') !== allowedMethod) {
    await sendWebResponse(res, json({ error: `Method ${req.method || 'GET'} is not allowed.` }, 405, { allow: allowedMethod }));
    return;
  }

  let request;
  try {
    request = toWebRequest(req);
    await sendWebResponse(res, await routeHandler(request, process.env));
  } catch (error) {
    await sendWebResponse(res, errorResponse(error, request));
  }
}

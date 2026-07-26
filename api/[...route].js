import worker from '../worker/index.js';

export const config = {
  api: {
    bodyParser: false,
  },
};

function requestHeaders(nodeHeaders) {
  const headers = new Headers();

  for (const [name, value] of Object.entries(nodeHeaders)) {
    if (Array.isArray(value)) headers.set(name, value.join(', '));
    else if (value != null) headers.set(name, String(value));
  }

  return headers;
}

export default async function handler(req, res) {
  const method = req.method || 'GET';
  const protocol = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers.host || 'localhost';
  const requestUrl = `${protocol}://${host}${req.url || '/'}`;
  const hasBody = method !== 'GET' && method !== 'HEAD';

  const request = new Request(requestUrl, {
    method,
    headers: requestHeaders(req.headers),
    body: hasBody ? req : undefined,
    ...(hasBody ? { duplex: 'half' } : {}),
  });

  const response = await worker.fetch(request, process.env);
  res.statusCode = response.status;
  response.headers.forEach((value, name) => res.setHeader(name, value));
  res.end(Buffer.from(await response.arrayBuffer()));
}

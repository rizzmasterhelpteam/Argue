import { supabase } from './supabase';

function invalidApiResponse(response) {
  const error = new Error('The server returned an invalid response.');
  error.code = 'INVALID_API_RESPONSE';
  error.status = response.status;
  return error;
}

export async function apiJson(path, options = {}) {
  const request = async (forceRefresh = false) => {
    const headers = new Headers(options.headers || {});
    if (!headers.has('content-type') && options.body) headers.set('content-type', 'application/json');
    let session;
    if (supabase) {
      const result = forceRefresh ? await supabase.auth.refreshSession() : await supabase.auth.getSession();
      session = result.data?.session;
    }
    if (path.startsWith('/api/billing/') && !session?.access_token) {
      const error = new Error('Please sign in again before upgrading.');
      error.code = 'AUTH_REQUIRED';
      error.status = 401;
      throw error;
    }
    if (session?.access_token) headers.set('authorization', `Bearer ${session.access_token}`);
    const response = await fetch(`${import.meta.env.VITE_API_BASE_URL || ''}${path}`, { ...options, headers });
    const contentType = response.headers?.get?.('content-type');
    if (contentType && !contentType.toLowerCase().includes('application/json')) throw invalidApiResponse(response);
    let data;
    try {
      data = await response.json();
    } catch {
      throw invalidApiResponse(response);
    }
    return { response, data };
  };

  let { response, data } = await request();
  if (response.status === 401 && data.code === 'INVALID_SESSION' && supabase) {
    ({ response, data } = await request(true));
  }
  if (!response.ok) {
    const error = new Error(data.error || 'The AI service is unavailable right now.');
    error.code = data.code;
    error.stage = data.stage;
    error.requestId = data.requestId;
    error.status = response.status;
    throw error;
  }
  return data;
}

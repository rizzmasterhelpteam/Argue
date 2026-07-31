import { supabase } from './supabase';

export async function apiJson(path, options = {}) {
  const request = async (forceRefresh = false) => {
    const headers = new Headers(options.headers || {});
    if (!headers.has('content-type') && options.body) headers.set('content-type', 'application/json');
    let session;
    if (supabase) {
      const result = forceRefresh ? await supabase.auth.refreshSession() : await supabase.auth.getSession();
      session = result.data?.session;
    }
    if (session?.access_token) headers.set('authorization', `Bearer ${session.access_token}`);
    const response = await fetch(`${import.meta.env.VITE_API_BASE_URL || ''}${path}`, { ...options, headers });
    return { response, data: await response.json().catch(() => ({})) };
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

import { supabase } from './supabase';

export async function apiJson(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (!headers.has('content-type') && options.body) headers.set('content-type', 'application/json');

  const { data: { session } = {} } = supabase ? await supabase.auth.getSession() : {};
  if (session?.access_token) headers.set('authorization', `Bearer ${session.access_token}`);

  const response = await fetch(`${import.meta.env.VITE_API_BASE_URL || ''}${path}`, {
    ...options,
    headers,
  });
  const data = await response.json().catch(() => ({}));
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

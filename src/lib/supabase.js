import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL?.trim();
const publishableKey = (
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY
  || import.meta.env.VITE_SUPABASE_ANON_KEY
  || ''
).trim();

export const supabaseConfigError = !url
  ? 'VITE_SUPABASE_URL is not configured.'
  : !publishableKey
    ? 'VITE_SUPABASE_PUBLISHABLE_KEY is not configured.'
    : '';

export const supabase = supabaseConfigError
  ? null
  : createClient(url, publishableKey, {
    auth: {
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: true,
      flowType: 'pkce',
    },
  });

export const isSupabaseConfigured = Boolean(supabase);

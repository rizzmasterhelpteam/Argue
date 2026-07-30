import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { apiJson } from '../lib/apiClient';
import { supabase, supabaseConfigError } from '../lib/supabase';

const AuthContext = createContext({
  configured: false,
  loading: false,
  user: null,
  session: null,
  error: supabaseConfigError,
});

export function AuthProvider({ children }) {
  const [state, setState] = useState({
    configured: Boolean(supabase),
    loading: Boolean(supabase),
    user: null,
    session: null,
    error: supabaseConfigError,
  });

  useEffect(() => {
    if (!supabase) return undefined;
    let active = true;
    const setSession = (session) => {
      const user = session?.user && !session.user.is_anonymous ? session.user : null;
      if (active) setState({ configured: true, loading: false, user, session: user ? session : null, error: '' });
    };

    supabase.auth.getSession().then(({ data, error }) => {
      if (error) {
        if (active) setState({ configured: true, loading: false, user: null, session: null, error: error.message });
        return;
      }
      setSession(data.session);
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => setSession(session));
    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, []);

  const signIn = useCallback(async ({ email, password }) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
  }, []);

  const signUp = useCallback(async ({ email, password }) => {
    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: { emailRedirectTo: `${window.location.origin}/` },
    });
    if (error) throw error;
  }, []);

  const signInWithGoogle = useCallback(async () => {
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: `${window.location.origin}/` },
    });
    if (error) throw error;
  }, []);

  const signOut = useCallback(async () => {
    const { error } = await supabase.auth.signOut();
    if (error) throw error;
  }, []);

  const deleteAccount = useCallback(async () => {
    await apiJson('/api/account', { method: 'DELETE' });
    await supabase.auth.signOut();
  }, []);

  const value = useMemo(() => ({ ...state, signIn, signUp, signInWithGoogle, signOut, deleteAccount }), [state, signIn, signUp, signInWithGoogle, signOut, deleteAccount]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}

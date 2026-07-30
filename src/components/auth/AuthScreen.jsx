import { useState } from 'react';
import { ArrowRight, GoogleLogo, LockKey, UserCircle } from '@phosphor-icons/react';
import { useAuth } from '../../context/AuthContext';

export function AuthScreen() {
  const { configured, loading, error, signIn, signUp, signInWithGoogle } = useAuth();
  const [isRegistering, setIsRegistering] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [notice, setNotice] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event) => {
    event.preventDefault();
    setNotice('');
    setSubmitting(true);
    try {
      await (isRegistering ? signUp({ email, password }) : signIn({ email, password }));
      if (isRegistering) setNotice('Check your email to confirm your account.');
    } catch (submitError) {
      setNotice(submitError.message || 'We could not complete that request.');
    } finally {
      setSubmitting(false);
    }
  };

  if (!configured) {
    return (
      <main className="auth-stage">
        <section className="auth-panel" aria-labelledby="auth-title">
          <div className="auth-mark"><LockKey size={30} weight="fill" /></div>
          <p className="eyebrow">DEVELOPMENT CONFIGURATION</p>
          <h1 id="auth-title">Argue AI needs Supabase.</h1>
          <p>{error || 'Add the Supabase public URL and publishable key before opening the app.'}</p>
        </section>
      </main>
    );
  }

  return (
    <main className="auth-stage">
      <section className="auth-panel" aria-labelledby="auth-title">
        <div className="auth-mark"><UserCircle size={32} weight="fill" /></div>
        <p className="eyebrow">ARGUE AI</p>
        <h1 id="auth-title">{isRegistering ? 'Make your case.' : 'Welcome back.'}</h1>
        <p>{isRegistering ? 'Create an account to keep every argument and idea.' : 'Sign in to continue your conversations.'}</p>
        <form onSubmit={submit} className="auth-form">
          <label>Email<input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} required /></label>
          <label>Password<input type="password" autoComplete={isRegistering ? 'new-password' : 'current-password'} value={password} onChange={(event) => setPassword(event.target.value)} minLength="8" required /></label>
          <button type="submit" disabled={loading || submitting}>{submitting ? 'Working...' : isRegistering ? 'Create account' : 'Sign in'} <ArrowRight size={18} weight="bold" /></button>
        </form>
        <button className="auth-google" type="button" onClick={() => signInWithGoogle().catch((oauthError) => setNotice(oauthError.message))} disabled={loading || submitting}><GoogleLogo size={19} /> Continue with Google</button>
        <button className="auth-switch" type="button" onClick={() => { setIsRegistering((value) => !value); setNotice(''); }}>
          {isRegistering ? 'Already have an account? Sign in' : 'New here? Create an account'}
        </button>
        {notice && <p className="auth-notice" role="status">{notice}</p>}
      </section>
    </main>
  );
}

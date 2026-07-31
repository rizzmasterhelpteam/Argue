import { useState } from 'react';
import { ArrowRight, Eye, EyeSlash, GoogleLogo, LockKey, Waveform } from '@phosphor-icons/react';
import { useAuth } from '../../context/AuthContext';

export function AuthScreen() {
  const { configured, loading, error, signIn, signUp, signInWithGoogle } = useAuth();
  const [isRegistering, setIsRegistering] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [notice, setNotice] = useState('');
  const [noticeType, setNoticeType] = useState('status');
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event) => {
    event.preventDefault();
    setNotice('');
    setSubmitting(true);
    try {
      await (isRegistering ? signUp({ email, password }) : signIn({ email, password }));
      if (isRegistering) { setNoticeType('status'); setNotice('Check your email to confirm your account.'); }
    } catch (submitError) {
      setNoticeType('alert');
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
        <div className="auth-brand" aria-label="Argue AI"><span>Argue</span><b>AI</b></div>
        <div className="auth-mark" aria-hidden="true"><Waveform size={25} weight="bold" /></div>
        <p className="eyebrow">YOUR THINKING ARENA</p>
        <h1 id="auth-title">{isRegistering ? 'Make your case.' : 'Welcome back.'}</h1>
        <p>{isRegistering ? 'Create an account to keep every argument and idea.' : 'Sign in to continue your conversations.'}</p>
        <form onSubmit={submit} className="auth-form">
          <label>Email<input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} required /></label>
          <label>Password<span className="password-field"><input type={showPassword ? 'text' : 'password'} autoComplete={isRegistering ? 'new-password' : 'current-password'} value={password} onChange={(event) => setPassword(event.target.value)} minLength="8" required /><button type="button" aria-label={showPassword ? 'Hide password' : 'Show password'} aria-pressed={showPassword} onClick={() => setShowPassword((value) => !value)}>{showPassword ? <EyeSlash size={19} /> : <Eye size={19} />}</button></span>{isRegistering && <small>Use at least 8 characters.</small>}</label>
          <button type="submit" disabled={loading || submitting}>{submitting ? 'Working...' : isRegistering ? 'Create account' : 'Sign in'} <ArrowRight size={18} weight="bold" /></button>
        </form>
        <button className="auth-google" type="button" onClick={() => signInWithGoogle().catch((oauthError) => { setNoticeType('alert'); setNotice(oauthError.message); })} disabled={loading || submitting}><GoogleLogo size={19} /> Continue with Google</button>
        <button className="auth-switch" type="button" onClick={() => { setIsRegistering((value) => !value); setNotice(''); }}>
          {isRegistering ? 'Already have an account? Sign in' : 'New here? Create an account'}
        </button>
        {notice && <p className="auth-notice" role={noticeType}>{notice}</p>}
      </section>
    </main>
  );
}

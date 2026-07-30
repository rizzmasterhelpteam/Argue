import { App } from '../App';
import { useAuth } from '../context/AuthContext';
import { AuthScreen } from '../components/auth/AuthScreen';

export function AuthenticatedApp() {
  const { configured, loading, user, signOut, deleteAccount } = useAuth();
  if (loading) return <main className="auth-stage"><p className="auth-loading" role="status">Restoring your session...</p></main>;
  if (!configured || !user) return <AuthScreen />;
  return <App user={user} onLogout={signOut} onDeleteAccount={deleteAccount} />;
}

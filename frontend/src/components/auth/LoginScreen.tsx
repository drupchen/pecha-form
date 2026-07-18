import React, { useState } from 'react';
import { useAuthStore } from '../../store/useAuthStore';
import { AuthShell, AuthCard, AuthInput, AuthButton, AuthError } from './AuthShell';
import { GoogleButton } from './GoogleButton';

/** The sign-in gate. Two modes: normal login (email/password + Google), and the
 *  one-time "create the first admin" form when the platform has no accounts yet. */
export const LoginScreen: React.FC = () => {
  const login = useAuthStore(s => s.login);
  const loginGoogle = useAuthStore(s => s.loginGoogle);
  const createFirstAdmin = useAuthStore(s => s.createFirstAdmin);
  const bootstrapNeeded = useAuthStore(s => s.bootstrapNeeded);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (bootstrapNeeded) await createFirstAdmin(email, password, displayName);
      else await login(email, password);
    } catch (err: any) {
      setError(friendly(err));
    } finally {
      setBusy(false);
    }
  };

  const onGoogle = async (credential: string) => {
    setError(null);
    try {
      await loginGoogle(credential);
    } catch (err: any) {
      setError(friendly(err));
    }
  };

  return (
    <AuthShell>
      <AuthCard>
        <form onSubmit={submit} className="flex flex-col gap-3">
          <div className="font-display text-lg">
            {bootstrapNeeded ? 'Create the first administrator' : 'Sign in'}
          </div>
          {bootstrapNeeded && (
            <>
              <p className="text-sm text-mist-600">
                No accounts exist yet. This account becomes the platform administrator.
              </p>
              <AuthInput placeholder="Display name" value={displayName}
                         onChange={e => setDisplayName(e.target.value)} />
            </>
          )}
          <AuthInput type="email" required placeholder="Email" value={email}
                     autoComplete="username" onChange={e => setEmail(e.target.value)} />
          <AuthInput type="password" required placeholder="Password" value={password}
                     autoComplete={bootstrapNeeded ? 'new-password' : 'current-password'}
                     onChange={e => setPassword(e.target.value)} />
          <AuthError>{error}</AuthError>
          <AuthButton type="submit" disabled={busy}>
            {bootstrapNeeded ? 'Create administrator' : 'Sign in'}
          </AuthButton>
        </form>
        {!bootstrapNeeded && (
          <>
            <GoogleButton onCredential={onGoogle} />
            <p className="text-xs text-center text-mist-600">
              Access is by invitation — ask your organization's admin for an invite link.
            </p>
          </>
        )}
      </AuthCard>
    </AuthShell>
  );
};

function friendly(err: any): string {
  const msg = String(err?.message ?? err ?? '');
  if (msg.includes('invite_required')) {
    return 'This Google account has no access yet — open your invite link first.';
  }
  try {
    const parsed = JSON.parse(msg);
    if (parsed?.detail) return String(parsed.detail);
  } catch { /* not JSON */ }
  if (msg.includes('Failed to fetch')) return 'Cannot reach the server — is the backend running?';
  return msg || 'Sign-in failed';
}

import React, { useEffect, useState } from 'react';
import { API_BASE, J, jfetch } from '../../api/http';
import { useAuthStore } from '../../store/useAuthStore';
import { AuthShell, AuthCard, AuthInput, AuthButton, AuthError } from './AuthShell';
import { GoogleButton } from './GoogleButton';

interface InviteInfo {
  email: string;
  org_name: string;
  account_exists: boolean;
}

/** The ?invite=<token> landing: shows who the invite is for, then either creates
 *  the account (set a password / continue with Google) or — for an existing
 *  account — attaches the membership. On success the query param is stripped and
 *  the app proceeds signed-in. */
export const InviteAccept: React.FC<{ token: string }> = ({ token }) => {
  const loginGoogle = useAuthStore(s => s.loginGoogle);
  const login = useAuthStore(s => s.login);
  const authStatus = useAuthStore(s => s.status);
  const authedEmail = useAuthStore(s => s.user?.email ?? null);
  const [info, setInfo] = useState<InviteInfo | null>(null);
  const [dead, setDead] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    jfetch<InviteInfo>(`${API_BASE}/invites/${encodeURIComponent(token)}`)
      .then(setInfo)
      .catch(() => setDead('This invite link is invalid, expired, or already used.'));
  }, [token]);

  const finish = () => {
    // Drop ?invite= so a reload doesn't re-run the accept flow.
    window.history.replaceState(null, '', window.location.pathname);
    window.location.reload();
  };

  const accept = async () => {
    await jfetch(`${API_BASE}/invites/${encodeURIComponent(token)}/accept`, {
      method: 'POST', headers: J,
      body: JSON.stringify({ password, display_name: displayName }),
    });
    finish();
  };

  const acceptPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await accept();
    } catch (err: any) {
      setError(detailOf(err));
      setBusy(false);
    }
  };

  // Existing account: sign in (if needed) with the invite's email, then attach
  // the membership — all without leaving this screen (the token stays in the URL).
  const signInAndJoin = async (e?: React.FormEvent) => {
    e?.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (authStatus !== 'authenticated' && info) await login(info.email, password);
      await accept();
    } catch (err: any) {
      setError(detailOf(err));
      setBusy(false);
    }
  };

  const acceptGoogle = async (credential: string) => {
    setError(null);
    try {
      await loginGoogle(credential, token);
      finish();
    } catch (err: any) {
      setError(detailOf(err));
    }
  };

  return (
    <AuthShell>
      <AuthCard>
        {dead ? (
          <AuthError>{dead}</AuthError>
        ) : !info ? (
          <div className="text-sm text-mist-600">Checking your invitation…</div>
        ) : (
          <>
            <div className="font-display text-lg">Join {info.org_name}</div>
            <p className="text-sm text-mist-600">
              This invitation is for <b>{info.email}</b>.
            </p>
            {info.account_exists ? (
              authStatus === 'authenticated' && authedEmail === info.email ? (
                <div className="flex flex-col gap-3">
                  <AuthError>{error}</AuthError>
                  <AuthButton disabled={busy} onClick={() => void signInAndJoin()}>
                    Join {info.org_name}
                  </AuthButton>
                </div>
              ) : (
                <form onSubmit={signInAndJoin} className="flex flex-col gap-3">
                  <p className="text-sm">
                    An account with this email already exists — sign in to join.
                  </p>
                  <AuthInput type="password" required placeholder="Password"
                             autoComplete="current-password" value={password}
                             onChange={e => setPassword(e.target.value)} />
                  <AuthError>{error}</AuthError>
                  <AuthButton type="submit" disabled={busy}>
                    Sign in &amp; join {info.org_name}
                  </AuthButton>
                </form>
              )
            ) : (
              <form onSubmit={acceptPassword} className="flex flex-col gap-3">
                <AuthInput placeholder="Display name" value={displayName}
                           onChange={e => setDisplayName(e.target.value)} />
                <AuthInput type="password" required placeholder="Choose a password"
                           autoComplete="new-password" value={password}
                           onChange={e => setPassword(e.target.value)} />
                <AuthError>{error}</AuthError>
                <AuthButton type="submit" disabled={busy}>Create account &amp; join</AuthButton>
              </form>
            )}
            {!info.account_exists && <GoogleButton onCredential={acceptGoogle} />}
          </>
        )}
      </AuthCard>
    </AuthShell>
  );
};

function detailOf(err: any): string {
  const msg = String(err?.message ?? err ?? '');
  try {
    const parsed = JSON.parse(msg);
    if (parsed?.detail) return String(parsed.detail);
  } catch { /* not JSON */ }
  return msg || 'Could not accept the invitation';
}

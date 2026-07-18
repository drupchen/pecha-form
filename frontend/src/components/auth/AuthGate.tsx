import React, { useEffect } from 'react';
import { useAuthStore } from '../../store/useAuthStore';
import { AuthShell } from './AuthShell';
import { LoginScreen } from './LoginScreen';
import { InviteAccept } from './InviteAccept';

/** Session gate around the app body. Boots by asking /auth/me once, then renders
 *  the invite screen (?invite=), the login screen, or the app. The headless
 *  ?print= branch never mounts this (see App.tsx) — print auth rides the token. */
export const AuthGate: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const status = useAuthStore(s => s.status);
  const boot = useAuthStore(s => s.boot);

  useEffect(() => { void boot(); }, [boot]);

  const inviteToken = new URLSearchParams(window.location.search).get('invite');
  if (inviteToken && status !== 'booting') return <InviteAccept token={inviteToken} />;

  if (status === 'booting') {
    return (
      <AuthShell>
        <div className="text-sm text-mist-200">Opening…</div>
      </AuthShell>
    );
  }
  if (status === 'unauthenticated') return <LoginScreen />;
  return <>{children}</>;
};

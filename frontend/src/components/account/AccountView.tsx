import React, { useState } from 'react';
import { Check, KeyRound, ShieldCheck, Building2 } from 'lucide-react';
import { useAuthStore, type Section, type PermLevel } from '../../store/useAuthStore';
import { patchProfile, changePassword } from '../../api/account';
import { GoogleButton } from '../auth/GoogleButton';
import { userInitials } from '../Header';

const SECTIONS: { key: Section; label: string }[] = [
  { key: 'texts', label: 'Texts' },
  { key: 'workspace', label: 'Workspace' },
  { key: 'translate', label: 'Translate' },
  { key: 'phonetics', label: 'Phonetics' },
  { key: 'documents', label: 'Documents' },
];

const LEVEL_STYLE: Record<PermLevel, string> = {
  modify: 'bg-jade/15 text-jade',
  read: 'bg-lapis/10 text-lapis',
  none: 'bg-black/5 text-mist-600',
};

/** My account: profile, sign-in methods, and what each membership grants. */
export const AccountView: React.FC = () => {
  const user = useAuthStore(s => s.user);
  const orgs = useAuthStore(s => s.orgs);
  const activeOrgId = useAuthStore(s => s.activeOrgId);
  const refreshMe = useAuthStore(s => s.refreshMe);
  const loginGoogle = useAuthStore(s => s.loginGoogle);

  const [savedFlash, setSavedFlash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!user) return null;
  const initials = userInitials(user.display_name, user.email);

  const flash = (what: string) => {
    setSavedFlash(what);
    setTimeout(() => setSavedFlash(null), 2500);
  };

  const rename = async (name: string) => {
    if (!name.trim() || name.trim() === user.display_name) return;
    setError(null);
    try {
      await patchProfile(name.trim());
      await refreshMe();
      flash('Name saved');
    } catch (e) { setError(detail(e)); }
  };

  const linkGoogle = async (credential: string) => {
    setError(null);
    try {
      await loginGoogle(credential);
      await refreshMe();
      flash('Google linked');
    } catch (e) { setError(detail(e)); }
  };

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="max-w-2xl flex flex-col gap-5">
        <h2 className="font-display text-lg">My account</h2>
        {error && <div className="text-sm text-red-700">{error}</div>}
        {savedFlash && (
          <div className="text-sm text-jade flex items-center gap-1">
            <Check size={14} /> {savedFlash}
          </div>
        )}

        {/* Profile */}
        <section className="rounded-lg bg-white p-4 flex items-center gap-4"
                 style={{ boxShadow: '0 0 0 1px var(--gline-soft)' }}>
          <div
            className="h-14 w-14 rounded-full flex items-center justify-center text-lg font-semibold text-sky-deep shrink-0"
            style={{
              background: 'radial-gradient(circle at 38% 32%, var(--gold-soft), var(--gold) 60%, var(--bronze))',
              boxShadow: '0 0 0 1px var(--gline)',
            }}
          >
            {initials || '?'}
          </div>
          <div className="min-w-0 flex-1">
            <input
              defaultValue={user.display_name}
              placeholder="Display name"
              onBlur={e => void rename(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
              className="font-display text-xl bg-transparent border-b border-transparent focus:border-current outline-none w-full"
            />
            <div className="text-sm text-mist-600 truncate">{user.email}</div>
            {user.is_superuser && (
              <div className="mt-1 text-xs text-gold flex items-center gap-1">
                <ShieldCheck size={13} /> Platform administrator
              </div>
            )}
          </div>
        </section>

        {/* Sign-in methods */}
        <section className="rounded-lg bg-white p-4"
                 style={{ boxShadow: '0 0 0 1px var(--gline-soft)' }}>
          <div className="text-sm font-medium mb-3 flex items-center gap-1.5">
            <KeyRound size={14} /> Sign-in
          </div>
          <PasswordForm hasPassword={user.has_password}
                        onDone={() => { void refreshMe(); flash('Password updated'); }}
                        onError={e => setError(detail(e))} />
          <div className="mt-4 pt-4 border-t" style={{ borderColor: 'var(--gline-soft)' }}>
            {user.has_google ? (
              <div className="text-sm text-jade flex items-center gap-1.5">
                <Check size={14} /> Google account linked — "Continue with Google" works.
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                <div className="text-sm text-mist-600">
                  Link a Google account (its email must be <b>{user.email}</b>) to sign
                  in with one click:
                </div>
                <GoogleButton onCredential={c => void linkGoogle(c)} />
              </div>
            )}
          </div>
        </section>

        {/* Memberships */}
        <section className="flex flex-col gap-2">
          <div className="text-sm font-medium flex items-center gap-1.5">
            <Building2 size={14} /> Organizations
          </div>
          {orgs.map(o => (
            <div key={o.id} className="rounded-lg bg-white p-4"
                 style={{ boxShadow: '0 0 0 1px var(--gline-soft)' }}>
              <div className="flex items-center gap-2 flex-wrap mb-2">
                <span className="font-medium">{o.name}</span>
                {o.id === activeOrgId && (
                  <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-gold/20 text-amber-robe">
                    active
                  </span>
                )}
                {o.can_manage_org && (
                  <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-jade/15 text-jade flex items-center gap-1">
                    <ShieldCheck size={11} /> org admin
                  </span>
                )}
                <span className="ml-auto text-xs text-mist-600">
                  {user.is_superuser && o.roles.length === 0
                    ? 'full access (platform admin)'
                    : o.roles.join(', ') || 'no roles'}
                </span>
              </div>
              <div className="flex gap-1.5 flex-wrap">
                {SECTIONS.map(s => {
                  const lvl = o.perms[s.key] ?? 'none';
                  return (
                    <span key={s.key}
                          className={`text-[11px] px-2 py-0.5 rounded-full ${LEVEL_STYLE[lvl]}`}
                          title={`${s.label}: ${lvl}`}>
                      {s.label} · {lvl}
                    </span>
                  );
                })}
              </div>
            </div>
          ))}
        </section>
      </div>
    </div>
  );
};

const PasswordForm: React.FC<{
  hasPassword: boolean;
  onDone: () => void;
  onError: (e: unknown) => void;
}> = ({ hasPassword, onDone, onError }) => {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await changePassword(hasPassword ? current : null, next);
      setCurrent('');
      setNext('');
      onDone();
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="flex items-end gap-2 flex-wrap">
      {hasPassword && (
        <label className="flex flex-col gap-1 text-xs text-mist-600">
          Current password
          <input type="password" required value={current} autoComplete="current-password"
                 onChange={e => setCurrent(e.target.value)}
                 className="px-2 py-1.5 rounded-md border bg-white text-sm outline-none"
                 style={{ borderColor: 'var(--gline-soft)' }} />
        </label>
      )}
      <label className="flex flex-col gap-1 text-xs text-mist-600">
        {hasPassword ? 'New password' : 'Set a password'}
        <input type="password" required value={next} autoComplete="new-password"
               onChange={e => setNext(e.target.value)}
               className="px-2 py-1.5 rounded-md border bg-white text-sm outline-none"
               style={{ borderColor: 'var(--gline-soft)' }} />
      </label>
      <button type="submit" disabled={busy}
              className="px-3 py-1.5 rounded-md text-sm hover:bg-black/5 disabled:opacity-50"
              style={{ boxShadow: 'inset 0 0 0 1px var(--gline-soft)' }}>
        {hasPassword ? 'Change password' : 'Set password'}
      </button>
    </form>
  );
};

function detail(e: any): string {
  const msg = String(e?.message ?? e ?? '');
  try {
    const parsed = JSON.parse(msg);
    if (parsed?.detail) return String(parsed.detail);
  } catch { /* not JSON */ }
  return msg || 'Request failed';
}

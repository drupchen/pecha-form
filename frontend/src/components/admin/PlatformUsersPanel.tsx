import React, { useCallback, useEffect, useState } from 'react';
import { ShieldCheck, KeyRound } from 'lucide-react';
import { listUsers, type PlatformUser } from '../../api/adminClient';
import { detail } from './MembersPanel';

/** Platform admins: every account and which orgs it belongs to. Read-only —
 *  membership/role changes happen inside each org's panels. */
export const PlatformUsersPanel: React.FC = () => {
  const [users, setUsers] = useState<PlatformUser[]>([]);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    listUsers().then(u => { setUsers(u); setError(null); })
      .catch(e => setError(detail(e)));
  }, []);
  useEffect(reload, [reload]);

  return (
    <div className="max-w-3xl">
      <h2 className="font-display text-lg mb-4">All users</h2>
      {error && <div className="text-sm text-red-700 mb-3">{error}</div>}
      <div className="flex flex-col gap-2">
        {users.map(u => (
          <div key={u.id}
               className="flex items-center gap-3 px-4 py-2.5 rounded-lg bg-white"
               style={{ boxShadow: '0 0 0 1px var(--gline-soft)' }}>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium truncate flex items-center gap-1.5">
                {u.display_name || u.email}
                {u.is_superuser && (
                  <span title="Platform admin"><ShieldCheck size={13} className="text-gold" /></span>
                )}
              </div>
              <div className="text-xs text-mist-600 truncate">
                {u.email}
                {' · '}
                {u.orgs.length
                  ? u.orgs.map(o => o.org_name).join(', ')
                  : 'no organizations'}
              </div>
            </div>
            <span className="text-xs text-mist-600 flex items-center gap-1"
                  title={[u.has_password && 'password', u.has_google && 'Google']
                    .filter(Boolean).join(' + ') || 'no sign-in method'}>
              <KeyRound size={13} />
              {[u.has_password && 'password', u.has_google && 'Google']
                .filter(Boolean).join(' + ') || '—'}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
};

import React, { useCallback, useEffect, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { useAuthStore } from '../../store/useAuthStore';
import { listMembers, listRoles, removeMember, setMemberRoles,
         type MemberRow, type RoleRow } from '../../api/adminClient';
import { ConfirmDialog } from '../ui/Modal';

/** The org's people: who's in, wearing which role chips. Roles toggle in place
 *  (a membership may carry several); removal asks first. */
export const MembersPanel: React.FC = () => {
  const orgId = useAuthStore(s => s.activeOrgId);
  const selfId = useAuthStore(s => s.user?.id);
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [roles, setRoles] = useState<RoleRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<MemberRow | null>(null);

  const reload = useCallback(() => {
    if (orgId == null) return;
    Promise.all([listMembers(orgId), listRoles(orgId)])
      .then(([m, r]) => { setMembers(m); setRoles(r); setError(null); })
      .catch(e => setError(detail(e)));
  }, [orgId]);
  useEffect(reload, [reload]);

  const toggleRole = async (m: MemberRow, roleId: number) => {
    if (orgId == null) return;
    const next = m.role_ids.includes(roleId)
      ? m.role_ids.filter(id => id !== roleId)
      : [...m.role_ids, roleId];
    try {
      await setMemberRoles(orgId, m.user_id, next);
      reload();
    } catch (e) { setError(detail(e)); }
  };

  return (
    <div className="max-w-3xl">
      <h2 className="font-display text-lg mb-4">Members</h2>
      {error && <div className="text-sm text-red-700 mb-3">{error}</div>}
      <div className="flex flex-col gap-2">
        {members.map(m => (
          <div key={m.user_id}
               className="flex items-center gap-3 px-4 py-2.5 rounded-lg bg-white"
               style={{ boxShadow: '0 0 0 1px var(--gline-soft)' }}>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium truncate">
                {m.display_name || m.email}
                {m.user_id === selfId && <span className="text-mist-600"> (you)</span>}
              </div>
              <div className="text-xs text-mist-600 truncate">{m.email}</div>
            </div>
            <div className="flex flex-wrap gap-1 justify-end">
              {roles.map(r => {
                const on = m.role_ids.includes(r.id);
                return (
                  <button
                    key={r.id}
                    onClick={() => void toggleRole(m, r.id)}
                    className={`px-2 py-0.5 rounded-full text-xs transition-colors ${
                      on ? 'text-sky-deep font-semibold' : 'text-mist-600 hover:bg-black/5'
                    }`}
                    style={on ? {
                      background: 'linear-gradient(180deg, var(--gold-soft), var(--gold))',
                      boxShadow: '0 0 0 1px var(--gline)',
                    } : { boxShadow: 'inset 0 0 0 1px var(--gline-soft)' }}
                    title={on ? `Remove role “${r.name}”` : `Grant role “${r.name}”`}
                  >
                    {r.name}
                  </button>
                );
              })}
            </div>
            <button onClick={() => setRemoving(m)}
                    className="opacity-50 hover:opacity-100 hover:text-red-700"
                    title="Remove from organization">
              <Trash2 size={15} />
            </button>
          </div>
        ))}
        {members.length === 0 && !error && (
          <div className="text-sm text-mist-600">No members yet.</div>
        )}
      </div>
      {removing && orgId != null && (
        <ConfirmDialog
          title="Remove member"
          message={<>Remove <b>{removing.display_name || removing.email}</b> from this
            organization? Their account remains; only the membership goes.</>}
          confirmLabel="Remove"
          onCancel={() => setRemoving(null)}
          onConfirm={() => {
            removeMember(orgId, removing.user_id)
              .then(reload).catch(e => setError(detail(e)));
            setRemoving(null);
          }}
        />
      )}
    </div>
  );
};

export function detail(e: any): string {
  const msg = String(e?.message ?? e ?? '');
  try {
    const parsed = JSON.parse(msg);
    if (parsed?.detail) return String(parsed.detail);
  } catch { /* not JSON */ }
  return msg || 'Request failed';
}

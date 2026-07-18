import React, { useCallback, useEffect, useState } from 'react';
import { Copy, Plus, Trash2, Check } from 'lucide-react';
import { useAuthStore } from '../../store/useAuthStore';
import { createInvite, listInvites, listRoles, revokeInvite,
         type InviteRow, type RoleRow } from '../../api/adminClient';
import { Modal } from '../ui/Modal';
import { detail } from './MembersPanel';

/** Pending invites + the "Invite member" flow. No email is sent — the minted
 *  link is shown ONCE for copy-paste (only its hash is stored server-side). */
export const InvitesPanel: React.FC = () => {
  const orgId = useAuthStore(s => s.activeOrgId);
  const [invites, setInvites] = useState<InviteRow[]>([]);
  const [roles, setRoles] = useState<RoleRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [email, setEmail] = useState('');
  const [roleIds, setRoleIds] = useState<number[]>([]);
  const [mintedUrl, setMintedUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const reload = useCallback(() => {
    if (orgId == null) return;
    Promise.all([listInvites(orgId), listRoles(orgId)])
      .then(([i, r]) => { setInvites(i); setRoles(r); setError(null); })
      .catch(e => setError(detail(e)));
  }, [orgId]);
  useEffect(reload, [reload]);

  const roleName = (id: number) => roles.find(r => r.id === id)?.name ?? `#${id}`;

  const mint = async (e: React.FormEvent) => {
    e.preventDefault();
    if (orgId == null) return;
    try {
      const r = await createInvite(orgId, email.trim(), roleIds);
      setMintedUrl(r.invite_url);
      setEmail('');
      setRoleIds([]);
      reload();
    } catch (err) { setError(detail(err)); }
  };

  const copy = async (url: string) => {
    await navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="max-w-3xl">
      <div className="flex items-center justify-between mb-4">
        <h2 className="font-display text-lg">Invites</h2>
        <button onClick={() => { setCreating(true); setMintedUrl(null); setError(null); }}
                className="px-3 py-1.5 rounded-md text-sm flex items-center gap-1 hover:bg-black/5"
                style={{ boxShadow: 'inset 0 0 0 1px var(--gline-soft)' }}>
          <Plus size={14} /> Invite member
        </button>
      </div>
      {error && <div className="text-sm text-red-700 mb-3">{error}</div>}
      <div className="flex flex-col gap-2">
        {invites.map(i => {
          const ids: number[] = JSON.parse(i.role_ids || '[]');
          return (
            <div key={i.id}
                 className="flex items-center gap-3 px-4 py-2.5 rounded-lg bg-white"
                 style={{ boxShadow: '0 0 0 1px var(--gline-soft)' }}>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium truncate">{i.email}</div>
                <div className="text-xs text-mist-600">
                  {ids.length ? ids.map(roleName).join(', ') : 'no roles'} ·{' '}
                  {i.expired ? <span className="text-red-700">expired</span>
                             : <>expires {i.expires_at?.slice(0, 10)}</>}
                </div>
              </div>
              <button onClick={() => {
                        if (orgId != null) {
                          revokeInvite(orgId, i.id).then(reload)
                            .catch(e => setError(detail(e)));
                        }
                      }}
                      className="opacity-50 hover:opacity-100 hover:text-red-700"
                      title="Revoke invite">
                <Trash2 size={15} />
              </button>
            </div>
          );
        })}
        {invites.length === 0 && !error && (
          <div className="text-sm text-mist-600">No pending invites.</div>
        )}
      </div>

      {creating && (
        <Modal title="Invite member" onClose={() => setCreating(false)}>
          {mintedUrl ? (
            <div className="flex flex-col gap-3">
              <p className="text-sm">
                Share this link with the invitee — it is shown only once:
              </p>
              <div className="flex items-center gap-2">
                <code className="flex-1 text-xs bg-black/5 rounded-md px-2 py-2 break-all">
                  {mintedUrl}
                </code>
                <button onClick={() => void copy(mintedUrl)}
                        className="p-2 rounded-md hover:bg-black/5" title="Copy link">
                  {copied ? <Check size={15} className="text-green-700" /> : <Copy size={15} />}
                </button>
              </div>
              <button onClick={() => setCreating(false)}
                      className="self-end px-3 py-1.5 rounded-md text-sm"
                      style={{ boxShadow: 'inset 0 0 0 1px var(--gline-soft)' }}>
                Done
              </button>
            </div>
          ) : (
            <form onSubmit={mint} className="flex flex-col gap-3">
              <input
                type="email" required placeholder="Email" value={email}
                onChange={e => setEmail(e.target.value)}
                className="px-3 py-2 rounded-md border bg-white text-sm outline-none"
                style={{ borderColor: 'var(--gline-soft)' }}
              />
              <div className="text-xs text-mist-600">Roles granted on accept:</div>
              <div className="flex flex-wrap gap-1">
                {roles.map(r => {
                  const on = roleIds.includes(r.id);
                  return (
                    <button type="button" key={r.id}
                            onClick={() => setRoleIds(ids =>
                              on ? ids.filter(x => x !== r.id) : [...ids, r.id])}
                            className={`px-2 py-0.5 rounded-full text-xs ${
                              on ? 'text-sky-deep font-semibold' : 'text-mist-600 hover:bg-black/5'
                            }`}
                            style={on ? {
                              background: 'linear-gradient(180deg, var(--gold-soft), var(--gold))',
                              boxShadow: '0 0 0 1px var(--gline)',
                            } : { boxShadow: 'inset 0 0 0 1px var(--gline-soft)' }}>
                      {r.name}
                    </button>
                  );
                })}
              </div>
              {error && <div className="text-sm text-red-700">{error}</div>}
              <button type="submit"
                      className="self-end px-3 py-1.5 rounded-md text-sm font-semibold text-sky-deep"
                      style={{
                        background: 'linear-gradient(180deg, var(--gold-soft), var(--gold))',
                        boxShadow: '0 0 0 1px var(--gline)',
                      }}>
                Create invite link
              </button>
            </form>
          )}
        </Modal>
      )}
    </div>
  );
};

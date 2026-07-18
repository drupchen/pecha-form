import React, { useCallback, useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { createOrg, listOrgs, renameOrg, type OrgRow } from '../../api/adminClient';
import { detail } from './MembersPanel';

/** Platform admins: every organization, create + inline rename. Deletion is
 *  deliberately absent from the UI (the API refuses non-empty orgs anyway). */
export const PlatformOrgsPanel: React.FC = () => {
  const [orgs, setOrgs] = useState<OrgRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState('');

  const reload = useCallback(() => {
    listOrgs().then(o => { setOrgs(o); setError(null); })
      .catch(e => setError(detail(e)));
  }, []);
  useEffect(reload, [reload]);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim()) return;
    try {
      await createOrg(newName.trim());
      setNewName('');
      reload();
    } catch (err) { setError(detail(err)); }
  };

  return (
    <div className="max-w-2xl">
      <h2 className="font-display text-lg mb-4">Organizations</h2>
      {error && <div className="text-sm text-red-700 mb-3">{error}</div>}
      <div className="flex flex-col gap-2">
        {orgs.map(o => (
          <div key={o.id}
               className="flex items-center gap-3 px-4 py-2.5 rounded-lg bg-white"
               style={{ boxShadow: '0 0 0 1px var(--gline-soft)' }}>
            <input
              defaultValue={o.name}
              onBlur={e => {
                const name = e.target.value.trim();
                if (name && name !== o.name) {
                  renameOrg(o.id, name).then(reload).catch(err => setError(detail(err)));
                }
              }}
              className="flex-1 text-sm font-medium bg-transparent border-b border-transparent focus:border-current outline-none"
            />
            <span className="text-xs text-mist-600">
              {o.member_count ?? 0} member{(o.member_count ?? 0) === 1 ? '' : 's'}
            </span>
          </div>
        ))}
      </div>
      <form onSubmit={add} className="mt-4 flex gap-2">
        <input
          value={newName}
          onChange={e => setNewName(e.target.value)}
          placeholder="New organization name"
          className="px-3 py-1.5 rounded-md border bg-white text-sm outline-none"
          style={{ borderColor: 'var(--gline-soft)' }}
        />
        <button type="submit"
                className="px-3 py-1.5 rounded-md text-sm flex items-center gap-1 hover:bg-black/5"
                style={{ boxShadow: 'inset 0 0 0 1px var(--gline-soft)' }}>
          <Plus size={14} /> Create
        </button>
      </form>
      <p className="mt-3 text-xs text-mist-600">
        A new organization starts with the five standard roles. Invite its first
        admin from its Invites panel (switch org via your avatar menu).
      </p>
    </div>
  );
};

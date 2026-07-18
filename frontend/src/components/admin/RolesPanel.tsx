import React, { useCallback, useEffect, useState } from 'react';
import { Plus, Trash2, ShieldCheck } from 'lucide-react';
import { useAuthStore, type Section, type PermLevel } from '../../store/useAuthStore';
import { createRole, deleteRole, listRoles, updateRole,
         type RoleRow } from '../../api/adminClient';
import { ConfirmDialog } from '../ui/Modal';
import { detail } from './MembersPanel';

const SECTIONS: { key: Section; label: string }[] = [
  { key: 'texts', label: 'Texts' },
  { key: 'workspace', label: 'Workspace' },
  { key: 'translate', label: 'Translate' },
  { key: 'phonetics', label: 'Phonetics' },
  { key: 'documents', label: 'Documents' },
];
const LEVELS: PermLevel[] = ['none', 'read', 'modify'];

/** Role editor: each role is a 5-section × none/read/modify grid plus the
 *  org-admin capability. The seeded roles are ordinary editable rows. */
export const RolesPanel: React.FC = () => {
  const orgId = useAuthStore(s => s.activeOrgId);
  const [roles, setRoles] = useState<RoleRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<RoleRow | null>(null);
  const [newName, setNewName] = useState('');

  const reload = useCallback(() => {
    if (orgId == null) return;
    listRoles(orgId).then(r => { setRoles(r); setError(null); })
      .catch(e => setError(detail(e)));
  }, [orgId]);
  useEffect(reload, [reload]);

  const patch = async (role: RoleRow, body: Partial<RoleRow>) => {
    if (orgId == null) return;
    try {
      await updateRole(orgId, role.id, body);
      reload();
    } catch (e) { setError(detail(e)); }
  };

  const addRole = async (e: React.FormEvent) => {
    e.preventDefault();
    if (orgId == null || !newName.trim()) return;
    try {
      await createRole(orgId, { name: newName.trim() });
      setNewName('');
      reload();
    } catch (e) { setError(detail(e)); }
  };

  return (
    <div className="max-w-3xl">
      <h2 className="font-display text-lg mb-4">Roles</h2>
      {error && <div className="text-sm text-red-700 mb-3">{error}</div>}
      <div className="flex flex-col gap-4">
        {roles.map(role => (
          <div key={role.id} className="rounded-lg bg-white p-4"
               style={{ boxShadow: '0 0 0 1px var(--gline-soft)' }}>
            <div className="flex items-center gap-2 mb-3">
              <input
                defaultValue={role.name}
                onBlur={e => {
                  const name = e.target.value.trim();
                  if (name && name !== role.name) void patch(role, { name });
                }}
                className="font-medium text-sm bg-transparent border-b border-transparent focus:border-current outline-none"
              />
              <label className="ml-auto flex items-center gap-1.5 text-xs text-mist-600 cursor-pointer"
                     title="Org admin: manage members, roles and invites; full access to every section">
                <input type="checkbox" checked={role.can_manage_org}
                       onChange={e => void patch(role, { can_manage_org: e.target.checked })} />
                <ShieldCheck size={13} /> org admin
              </label>
              <button onClick={() => setDeleting(role)}
                      className="opacity-50 hover:opacity-100 hover:text-red-700"
                      title="Delete role">
                <Trash2 size={15} />
              </button>
            </div>
            <div className="grid grid-cols-[1fr_auto] gap-y-1.5 text-sm">
              {SECTIONS.map(s => (
                <React.Fragment key={s.key}>
                  <div className="py-0.5">{s.label}</div>
                  <div className="flex gap-1">
                    {LEVELS.map(lvl => {
                      const on = (role.perms[s.key] ?? 'none') === lvl;
                      return (
                        <button
                          key={lvl}
                          disabled={role.can_manage_org}
                          onClick={() => void patch(role, {
                            perms: { ...role.perms, [s.key]: lvl },
                          })}
                          className={`px-2 py-0.5 rounded-md text-xs capitalize transition-colors disabled:opacity-40 ${
                            on ? 'text-sky-deep font-semibold' : 'text-mist-600 hover:bg-black/5'
                          }`}
                          style={on ? {
                            background: 'linear-gradient(180deg, var(--gold-soft), var(--gold))',
                            boxShadow: '0 0 0 1px var(--gline)',
                          } : { boxShadow: 'inset 0 0 0 1px var(--gline-soft)' }}
                        >
                          {lvl}
                        </button>
                      );
                    })}
                  </div>
                </React.Fragment>
              ))}
            </div>
            {role.can_manage_org && (
              <div className="mt-2 text-xs text-mist-600">
                Org admins have full access to every section — the grid is moot.
              </div>
            )}
          </div>
        ))}
      </div>
      <form onSubmit={addRole} className="mt-4 flex gap-2">
        <input
          value={newName}
          onChange={e => setNewName(e.target.value)}
          placeholder="New role name"
          className="px-3 py-1.5 rounded-md border bg-white text-sm outline-none"
          style={{ borderColor: 'var(--gline-soft)' }}
        />
        <button type="submit"
                className="px-3 py-1.5 rounded-md text-sm flex items-center gap-1 hover:bg-black/5"
                style={{ boxShadow: 'inset 0 0 0 1px var(--gline-soft)' }}>
          <Plus size={14} /> Add role
        </button>
      </form>
      {deleting && orgId != null && (
        <ConfirmDialog
          title="Delete role"
          message={<>Delete the role <b>{deleting.name}</b>? Members still wearing it
            block deletion (unassign it first).</>}
          confirmLabel="Delete"
          onCancel={() => setDeleting(null)}
          onConfirm={() => {
            deleteRole(orgId, deleting.id)
              .then(reload).catch(e => setError(detail(e)));
            setDeleting(null);
          }}
        />
      )}
    </div>
  );
};

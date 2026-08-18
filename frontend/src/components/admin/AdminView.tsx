import React, { useState } from 'react';
import { Users, Shield, Mail, Building2, Globe, Type, Copyright, Image } from 'lucide-react';
import { useAuthStore } from '../../store/useAuthStore';
import { MembersPanel } from './MembersPanel';
import { RolesPanel } from './RolesPanel';
import { InvitesPanel } from './InvitesPanel';
import { PlatformOrgsPanel } from './PlatformOrgsPanel';
import { PlatformUsersPanel } from './PlatformUsersPanel';
import { StylesPanel } from './StylesPanel';
import { CopyrightPanel } from './CopyrightPanel';
import { ImagesPanel } from './ImagesPanel';

type Panel = 'members' | 'roles' | 'invites' | 'styles' | 'copyright' | 'images'
           | 'orgs' | 'users';

/** Panels that want the whole area — the Style Studio is a specimen page beside a roles
 *  panel, and both want the height. The rest are cards in a comfortable margin. */
const FULL_BLEED: Panel[] = ['styles'];

/** ORGANIZATION SETTINGS, plus platform administration.
 *
 *  Everything that belongs to the organization rather than to one booklet: who is in it and
 *  what they may do (members / roles / invites), and what every booklet it publishes inherits
 *  — the style template, the copyright boilerplate, the cover and back-cover marks. Those
 *  last three were reachable only from inside a booklet's pagination bench, or not at all.
 *
 *  Superusers additionally get the platform-wide panels (organizations / users). */
export const AdminView: React.FC = () => {
  const isSuperuser = useAuthStore(s => s.user?.is_superuser === true);
  const orgName = useAuthStore(s => s.orgs.find(o => o.id === s.activeOrgId)?.name);
  const [panel, setPanel] = useState<Panel>('members');

  const items: { key: Panel; label: string; icon: React.ReactNode; platform?: boolean }[] = [
    { key: 'members', label: 'Members', icon: <Users size={15} /> },
    { key: 'roles', label: 'Roles', icon: <Shield size={15} /> },
    { key: 'invites', label: 'Invites', icon: <Mail size={15} /> },
    { key: 'styles', label: 'Styles', icon: <Type size={15} /> },
    { key: 'copyright', label: 'Copyright', icon: <Copyright size={15} /> },
    { key: 'images', label: 'Cover & back', icon: <Image size={15} /> },
    { key: 'orgs', label: 'Organizations', icon: <Building2 size={15} />, platform: true },
    { key: 'users', label: 'All users', icon: <Globe size={15} />, platform: true },
  ];

  return (
    <div className="flex-1 flex overflow-hidden">
      <aside className="w-52 shrink-0 border-r p-3 flex flex-col gap-1"
             style={{ borderColor: 'var(--gline-soft)' }}>
        <div className="px-2 py-1 text-[11px] uppercase tracking-wide text-mist-600">
          {orgName ?? 'Organization'}
        </div>
        {items.filter(i => !i.platform).map(i => (
          <NavButton key={i.key} active={panel === i.key} onClick={() => setPanel(i.key)}>
            {i.icon}{i.label}
          </NavButton>
        ))}
        {isSuperuser && (
          <>
            <div className="px-2 py-1 mt-3 text-[11px] uppercase tracking-wide text-mist-600">
              Platform
            </div>
            {items.filter(i => i.platform).map(i => (
              <NavButton key={i.key} active={panel === i.key} onClick={() => setPanel(i.key)}>
                {i.icon}{i.label}
              </NavButton>
            ))}
          </>
        )}
      </aside>
      <div className={`flex-1 flex flex-col ${
        FULL_BLEED.includes(panel) ? 'overflow-hidden' : 'overflow-y-auto p-6'}`}>
        {panel === 'members' && <MembersPanel />}
        {panel === 'roles' && <RolesPanel />}
        {panel === 'invites' && <InvitesPanel />}
        {panel === 'styles' && <StylesPanel />}
        {panel === 'copyright' && <CopyrightPanel />}
        {panel === 'images' && <ImagesPanel />}
        {panel === 'orgs' && isSuperuser && <PlatformOrgsPanel />}
        {panel === 'users' && isSuperuser && <PlatformUsersPanel />}
      </div>
    </div>
  );
};

const NavButton: React.FC<{
  active: boolean; onClick: () => void; children: React.ReactNode;
}> = ({ active, onClick, children }) => (
  <button
    onClick={onClick}
    className={`px-2 py-1.5 rounded-md flex items-center gap-2 text-sm text-left transition-colors ${
      active ? 'text-gold' : 'hover:bg-black/5'
    }`}
    style={active ? {
      background: 'rgba(236,179,32,0.10)',
      boxShadow: 'inset 0 0 0 1px var(--gline)',
    } : undefined}
  >
    {children}
  </button>
);

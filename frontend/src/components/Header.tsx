import React, { useEffect, useRef, useState } from 'react';
import { Layout, FileText, Undo2, Redo2, Languages, Volume2, Library, RefreshCw,
         Shield, LogOut, Check, Building2, UserRound } from 'lucide-react';
import type { Route } from '../App';
import { useUndoStore } from '../store/useUndoStore';
import { useTextStore } from '../store/useTextStore';
import { useUIStore } from '../store/useUIStore';
import { useAuthStore, type Section } from '../store/useAuthStore';
import { usePerms, useIsAdmin } from '../store/usePermissions';

interface HeaderProps {
  currentRoute: Route;
  onNavigate: (route: Route) => void;
}

// `needsText` tabs operate on the currently-open text and are disabled until one is
// loaded (i.e. while on the Texts landing). Texts and Documents are text-independent.
// `section` gates visibility: a role granting 'none' hides the tab entirely.
const TABS: { route: Route; label: string; icon: React.ReactNode; needsText?: boolean;
              section: Section }[] = [
  { route: '/', label: 'Texts', icon: <FileText size={16} />, section: 'texts' },
  { route: '/workspace', label: 'Workspace', icon: <Layout size={16} />, needsText: true, section: 'workspace' },
  { route: '/translate', label: 'Translate', icon: <Languages size={16} />, needsText: true, section: 'translate' },
  { route: '/phonetics', label: 'Phonetics', icon: <Volume2 size={16} />, needsText: true, section: 'phonetics' },
  { route: '/documents', label: 'Documents', icon: <Library size={16} />, section: 'documents' },
];

export const Header: React.FC<HeaderProps> = ({ currentRoute, onNavigate }) => {
  // Subscribe to history length so the button's disabled state stays live.
  const historyLen = useUndoStore(s => s.history.length);
  const topDescription = useUndoStore(s => s.topDescription());
  const undo = useUndoStore(s => s.undo);
  const canUndo = historyLen > 0;
  const redoLen = useUndoStore(s => s.redoStack.length);
  const topRedoDescription = useUndoStore(s => s.topRedoDescription());
  const redo = useUndoStore(s => s.redo);
  const canRedo = redoLen > 0;
  const hasText = useTextStore(s => s.currentText != null);
  const bumpRefresh = useUIStore(s => s.bumpRefresh);
  const perms = usePerms();
  const isAdmin = useIsAdmin();
  const visibleTabs = TABS.filter(t => perms?.[t.section] !== 'none');
  return (
    <header
      className="shrink-0 border-b text-mist-100"
      style={{
        background: 'linear-gradient(180deg, var(--sky-night) 0%, var(--sky-deep) 100%)',
        borderColor: 'var(--gline-soft)',
      }}
    >
      <div className="max-w-screen-2xl mx-auto px-5 h-16 flex items-center justify-between">
        <div className="flex items-center gap-3 cursor-pointer" onClick={() => onNavigate('/')}>
          {/* Gold seal — the wordmark's "small solid form" */}
          <div
            className="h-10 w-10 rounded-full flex items-center justify-center text-sky-deep text-lg font-display"
            style={{
              background: 'radial-gradient(circle at 38% 32%, var(--gold-soft), var(--gold) 60%, var(--bronze))',
              boxShadow: '0 0 0 1px var(--gline), 0 0 18px rgba(236,179,32,0.4)',
            }}
            aria-hidden
          >
            ༀ
          </div>
          <span className="font-display text-2xl text-cream-hi tracking-tight">Sapche</span>
        </div>

        <nav className="flex items-center gap-1">
          {hasText && (
            <button
              onClick={() => bumpRefresh()}
              className="px-2 py-1.5 rounded-md flex items-center gap-1 text-sm font-medium text-mist-200 hover:text-gold hover:bg-white/5 transition-colors"
              title="Refresh — pull the latest lower-layer changes into this view"
            >
              <RefreshCw size={16} />
              Refresh
            </button>
          )}
          <button
            onClick={() => { if (canUndo) void undo(); }}
            disabled={!canUndo}
            className="px-2 py-1.5 rounded-md flex items-center gap-1 text-sm font-medium text-mist-200 hover:text-gold hover:bg-white/5 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            title={canUndo ? `Undo: ${topDescription} (Ctrl+Z)` : 'Nothing to undo'}
          >
            <Undo2 size={16} />
            Undo
          </button>
          <button
            onClick={() => { if (canRedo) void redo(); }}
            disabled={!canRedo}
            className="px-2 py-1.5 mr-2 rounded-md flex items-center gap-1 text-sm font-medium text-mist-200 hover:text-gold hover:bg-white/5 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            title={canRedo ? `Redo: ${topRedoDescription} (Ctrl+Shift+Z)` : 'Nothing to redo'}
          >
            <Redo2 size={16} />
          </button>
          {visibleTabs.map(t => {
            // Text-scoped tabs need a loaded document; Texts and Documents don't.
            const disabled = !!t.needsText && !hasText;
            const active = currentRoute === t.route;
            return (
              <button
                key={t.route}
                onClick={() => !disabled && onNavigate(t.route)}
                disabled={disabled}
                className={`px-3 py-1.5 rounded-md flex items-center gap-2 text-sm font-medium transition-colors ${
                  active
                    ? 'text-gold'
                    : 'text-mist-200 hover:text-cream-hi hover:bg-white/5'
                } disabled:opacity-40 disabled:cursor-not-allowed`}
                style={active ? {
                  background: 'rgba(236,179,32,0.10)',
                  boxShadow: 'inset 0 0 0 1px var(--gline)',
                } : undefined}
              >
                {t.icon}
                {t.label}
              </button>
            );
          })}
          {isAdmin && (
            <button
              onClick={() => onNavigate('/admin')}
              data-nav="admin"
              className={`px-3 py-1.5 rounded-md flex items-center gap-2 text-sm font-medium transition-colors ${
                currentRoute === '/admin'
                  ? 'text-gold' : 'text-mist-200 hover:text-cream-hi hover:bg-white/5'
              }`}
              style={currentRoute === '/admin' ? {
                background: 'rgba(236,179,32,0.10)',
                boxShadow: 'inset 0 0 0 1px var(--gline)',
              } : undefined}
            >
              <Shield size={16} />
              Admin
            </button>
          )}
          <UserMenu onNavigate={onNavigate} />
        </nav>
      </div>
    </header>
  );
};

/** Initials for the avatar chip: first letters of the first two WORDS that start
 *  with a letter/digit — so "Drupchen (admin)" is "D", not "D(". */
export function userInitials(displayName: string, email: string): string {
  const words = (displayName || email)
    .split(/[\s@._-]+/)
    .filter(w => /[\p{L}\p{N}]/u.test(w[0] ?? ''));
  return words.slice(0, 2).map(w => w[0].toUpperCase()).join('') || '?';
}

/** Avatar chip + dropdown: identity, account page, the org switcher, logout. */
const UserMenu: React.FC<{ onNavigate: (route: Route) => void }> = ({ onNavigate }) => {
  const user = useAuthStore(s => s.user);
  const orgs = useAuthStore(s => s.orgs);
  const activeOrgId = useAuthStore(s => s.activeOrgId);
  const switchOrg = useAuthStore(s => s.switchOrg);
  const logout = useAuthStore(s => s.logout);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);

  if (!user) return null;
  const initials = userInitials(user.display_name, user.email);

  return (
    <div className="relative ml-2" ref={ref}>
      <button
        onClick={() => setOpen(o => !o)}
        className="h-9 w-9 rounded-full flex items-center justify-center text-sm font-semibold text-cream-hi transition-colors hover:brightness-110"
        style={{ background: 'rgba(255,255,255,0.10)', boxShadow: 'inset 0 0 0 1px var(--gline-soft)' }}
        title={user.email}
      >
        {initials || '?'}
      </button>
      {open && (
        <div
          className="absolute right-0 top-11 w-64 rounded-lg py-2 z-50 bg-cream-hi text-ink text-sm"
          style={{ boxShadow: '0 0 0 1px var(--gline), 0 12px 32px rgba(0,0,0,0.35)' }}
        >
          <div className="px-4 py-2 border-b" style={{ borderColor: 'var(--gline-soft)' }}>
            <div className="font-medium truncate">{user.display_name || user.email}</div>
            <div className="text-xs text-mist-600 truncate">{user.email}</div>
          </div>
          <button
            onClick={() => { setOpen(false); onNavigate('/account'); }}
            className="w-full px-4 py-1.5 flex items-center gap-2 hover:bg-black/5 text-left border-b"
            style={{ borderColor: 'var(--gline-soft)' }}
          >
            <UserRound size={14} /> My account
          </button>
          {orgs.length > 0 && (
            <div className="py-1 border-b" style={{ borderColor: 'var(--gline-soft)' }}>
              <div className="px-4 py-1 text-[11px] uppercase tracking-wide text-mist-600 flex items-center gap-1">
                <Building2 size={12} /> Organization
              </div>
              {orgs.map(o => (
                <button
                  key={o.id}
                  onClick={() => { setOpen(false); switchOrg(o.id); }}
                  className="w-full px-4 py-1.5 flex items-center justify-between hover:bg-black/5 text-left"
                >
                  <span className="truncate">{o.name}</span>
                  {o.id === activeOrgId && <Check size={14} className="text-gold shrink-0" />}
                </button>
              ))}
            </div>
          )}
          <button
            onClick={() => { setOpen(false); void logout(); }}
            className="w-full px-4 py-1.5 flex items-center gap-2 hover:bg-black/5 text-left"
          >
            <LogOut size={14} /> Sign out
          </button>
        </div>
      )}
    </div>
  );
};

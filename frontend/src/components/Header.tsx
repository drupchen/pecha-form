import React from 'react';
import { Layout, FileText, Undo2 } from 'lucide-react';
import type { Route } from '../App';
import { useUndoStore } from '../store/useUndoStore';

interface HeaderProps {
  currentRoute: Route;
  onNavigate: (route: Route) => void;
}

const TABS: { route: Route; label: string; icon: React.ReactNode }[] = [
  { route: '/', label: 'Texts', icon: <FileText size={16} /> },
  { route: '/workspace', label: 'Workspace', icon: <Layout size={16} /> },
];

export const Header: React.FC<HeaderProps> = ({ currentRoute, onNavigate }) => {
  // Subscribe to history length so the button's disabled state stays live.
  const historyLen = useUndoStore(s => s.history.length);
  const topDescription = useUndoStore(s => s.topDescription());
  const undo = useUndoStore(s => s.undo);
  const canUndo = historyLen > 0;
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
          <button
            onClick={() => { if (canUndo) void undo(); }}
            disabled={!canUndo}
            className="px-2 py-1.5 mr-2 rounded-md flex items-center gap-1 text-sm font-medium text-mist-200 hover:text-gold hover:bg-white/5 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            title={canUndo ? `Undo: ${topDescription} (Ctrl+Z)` : 'Nothing to undo'}
          >
            <Undo2 size={16} />
            Undo
          </button>
          {TABS.map(t => {
            // Workspace needs a loaded document; Texts is always available.
            const disabled = t.route !== '/' && currentRoute === '/';
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
        </nav>
      </div>
    </header>
  );
};

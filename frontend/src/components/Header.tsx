import React from 'react';
import { Layout, FileText, Undo2, Redo2, Languages, Volume2, Library, RefreshCw } from 'lucide-react';
import type { Route } from '../App';
import { useUndoStore } from '../store/useUndoStore';
import { useTextStore } from '../store/useTextStore';
import { useUIStore } from '../store/useUIStore';

interface HeaderProps {
  currentRoute: Route;
  onNavigate: (route: Route) => void;
}

// `needsText` tabs operate on the currently-open text and are disabled until one is
// loaded (i.e. while on the Texts landing). Texts and Documents are text-independent.
const TABS: { route: Route; label: string; icon: React.ReactNode; needsText?: boolean }[] = [
  { route: '/', label: 'Texts', icon: <FileText size={16} /> },
  { route: '/workspace', label: 'Workspace', icon: <Layout size={16} />, needsText: true },
  { route: '/translate', label: 'Translate', icon: <Languages size={16} />, needsText: true },
  { route: '/phonetics', label: 'Phonetics', icon: <Volume2 size={16} />, needsText: true },
  { route: '/documents', label: 'Documents', icon: <Library size={16} /> },
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
          {TABS.map(t => {
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
        </nav>
      </div>
    </header>
  );
};

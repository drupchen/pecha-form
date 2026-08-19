import React, { useEffect, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { TreePane } from './TreePane';

/**
 * The read-only sapche column the translate and phonetics benches put beside their rows.
 * It folds away to a thin rail so the rows can have the whole width back — those rows carry
 * Tibetan plus one column per edition, and 20rem of orientation is a lot to pay once you
 * know where you are.
 *
 * Collapsing UNMOUNTS the pane, which is safe: everything it shows lives in
 * `useTreeNodeStore` / `useUIStore`, and neither bench needs it mounted (each fetches its own
 * nodes, and the scroll-spy sets `selectedTreeNodeId` itself).
 *
 * `storageKey` is per bench, so the two remember independently. It is a view preference, not
 * shared data, so it lives in localStorage next to the translate bench's type sizes.
 */
export const TreeSidebar: React.FC<{ storageKey: string }> = ({ storageKey }) => {
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(storageKey) !== '0';   // absent or unreadable: open
    } catch {
      return true;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, open ? '1' : '0');
    } catch { /* private mode / quota: the fold just won't outlive the session */ }
  }, [storageKey, open]);

  if (!open) {
    return (
      <div
        className="h-full w-8 shrink-0 bg-cream flex flex-col items-center pt-2"
        style={{ borderRight: '1px solid var(--cline)' }}
      >
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="p-1 text-bronze hover:text-vermilion"
          title="Show the tree"
        >
          <ChevronRight size={18} />
        </button>
      </div>
    );
  }

  return (
    <div
      className="w-80 shrink-0 h-full overflow-hidden"
      style={{ borderRight: '1px solid var(--cline)' }}
    >
      <TreePane forceConsult onCollapse={() => setOpen(false)} />
    </div>
  );
};

import { useEffect, useState } from 'react'
import { Header } from './components/Header'
import { ErrorBoundary } from './components/ErrorBoundary'
import { TextPicker } from './components/TextPicker'
import { WorkspaceView } from './components/workspace/WorkspaceView'
import { TranslateView } from './components/translate/TranslateView'
import { PhoneticsView } from './components/phonetics/PhoneticsView'
import { useUndoStore } from './store/useUndoStore'
import { useTextStore } from './store/useTextStore'
import { useUIStore } from './store/useUIStore'

export type Route = '/' | '/workspace' | '/translate' | '/phonetics';

export default function App() {
  const [route, setRoute] = useState<Route>('/');
  const currentDocId = useTextStore(s => s.currentText?.id ?? null);
  const workspaceFullscreen = useUIStore(s => s.workspaceFullscreen);

  // Global Ctrl/Cmd+Z to undo. Skip when the user is typing in an input/textarea/contentEditable.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.shiftKey) return; // leave Ctrl+Shift+Z for a future redo
      if (e.key !== 'z' && e.key !== 'Z') return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || (t as any).isContentEditable)) return;
      e.preventDefault();
      void useUndoStore.getState().undo();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // History is document-scoped: dropping it on doc switch keeps inverses honest.
  // Also clear the band position, the selected anchor, and any per-node
  // collapse state so none carries across docs (node ids would point at the
  // wrong doc).
  useEffect(() => {
    useUndoStore.getState().clear();
    useUIStore.getState().setLastHoveredTreeNodeId(null);
    useUIStore.getState().setSelectedTreeNodeId(null);
    useUIStore.getState().expandAllTreeNodes();
  }, [currentDocId]);

  return (
    <ErrorBoundary>
      <div className="h-screen overflow-hidden bg-cream-hi text-ink flex flex-col font-sans">
        {!(route === '/workspace' && workspaceFullscreen) && (
          <Header currentRoute={route} onNavigate={setRoute} />
        )}
        <main className="flex-1 w-full flex flex-col h-full overflow-hidden">
          {route === '/' && <TextPicker onNavigate={setRoute} />}
          {route === '/workspace' && <WorkspaceView />}
          {route === '/translate' && <TranslateView />}
          {route === '/phonetics' && <PhoneticsView />}
        </main>
      </div>
    </ErrorBoundary>
  );
}

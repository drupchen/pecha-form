import { useEffect, useState } from 'react'
import { Header } from './components/Header'
import { ErrorBoundary } from './components/ErrorBoundary'
import { TextPicker } from './components/TextPicker'
import { WorkspaceView } from './components/workspace/WorkspaceView'
import { TranslateView } from './components/translate/TranslateView'
import { PhoneticsView } from './components/phonetics/PhoneticsView'
import { DocumentsView } from './components/documents/DocumentsView'
import { PrintBooklet } from './components/documents/PrintBooklet'
import { AuthGate } from './components/auth/AuthGate'
import { AdminView } from './components/admin/AdminView'
import { AccountView } from './components/account/AccountView'
import { PermissionNotice } from './components/PermissionNotice'
import { useUndoStore } from './store/useUndoStore'
import { useTextStore } from './store/useTextStore'
import { useUIStore } from './store/useUIStore'
import { usePerms } from './store/usePermissions'
import { getUiState, putUiState } from './api/account'
import type { Section } from './store/useAuthStore'

export type Route = '/' | '/workspace' | '/translate' | '/phonetics' | '/documents'
  | '/admin' | '/account';

/** The permission section of each CONTENT route ('/admin' and '/account' are
 *  gated separately and excluded from resume). */
export const ROUTE_SECTION: Partial<Record<Route, Section>> = {
  '/': 'texts',
  '/workspace': 'workspace',
  '/translate': 'translate',
  '/phonetics': 'phonetics',
  '/documents': 'documents',
};

// Print/PDF mode: `?print=<documentId>&lang=<code>` renders ONLY the booklet, for
// headless Chromium to print. No app chrome, no header, no stores. Determined from the
// URL at load, so it is a stable top-level branch (hooks below only run for the app).
function printModeParams() {
  const p = new URLSearchParams(window.location.search);
  const id = p.get('print');
  if (!id || !Number.isFinite(Number(id))) return null;
  // `version` = the declared version this render is FOR (a frozen version's own semver, or the
  // latest for a live export), used to resolve `{{version}}` in the copyright.
  return { documentId: Number(id), lang: p.get('lang') || 'en', version: p.get('version') || '' };
}

export default function App() {
  const printParams = printModeParams();
  if (printParams) {
    return (
      <ErrorBoundary>
        <PrintBooklet documentId={printParams.documentId} lang={printParams.lang}
                      version={printParams.version} />
      </ErrorBoundary>
    );
  }

  return (
    <ErrorBoundary>
      <AuthGate>
        <AppBody />
      </AuthGate>
    </ErrorBoundary>
  );
}

function AppBody() {
  const [route, setRoute] = useState<Route>('/');
  const perms = usePerms();
  const currentDocId = useTextStore(s => s.currentText?.id ?? null);
  const workspaceFullscreen = useUIStore(s => s.workspaceFullscreen);
  // Resume gate: the save-effect stays quiet until the stored state has been
  // applied (or found empty), so the landing page never overwrites it.
  const [resumed, setResumed] = useState(false);

  // Restore the last location (per user & org, server-side): reopen the text,
  // then jump to the tab — but only where the current roles still allow it.
  useEffect(() => {
    let cancelled = false;
    getUiState()
      .then(async state => {
        if (cancelled) return;
        const target = state.last_route as Route | null;
        const section = target ? ROUTE_SECTION[target] : undefined;
        const allowed = !!section && perms?.[section] !== 'none';
        if (state.last_text_id != null && allowed) {
          await useTextStore.getState().loadText(state.last_text_id).catch(() => {});
        }
        if (cancelled) return;
        const hasText = useTextStore.getState().currentText != null;
        // Text-scoped tabs need the text to actually have loaded.
        const needsText = target === '/workspace' || target === '/translate' || target === '/phonetics';
        if (target && allowed && (!needsText || hasText)) setRoute(target);
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setResumed(true); });
    return () => { cancelled = true; };
    // Run once on mount — perms are already hydrated (AuthGate gates render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist the location (debounced): only the five content routes count.
  useEffect(() => {
    if (!resumed || !(route in ROUTE_SECTION)) return;
    const t = window.setTimeout(() => {
      void putUiState({ last_route: route, last_text_id: currentDocId }).catch(() => {});
    }, 1000);
    return () => window.clearTimeout(t);
  }, [resumed, route, currentDocId]);

  // Global Ctrl/Cmd+Z to undo, Ctrl/Cmd+Shift+Z to redo. Skip when the user is typing in
  // an input/textarea/contentEditable.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key !== 'z' && e.key !== 'Z') return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || (t as any).isContentEditable)) return;
      e.preventDefault();
      if (e.shiftKey) void useUndoStore.getState().redo();
      else void useUndoStore.getState().undo();
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

  // Permission gating: a route whose section is 'none' is unreachable — bounce to
  // the first visible one (or show the no-access panel when there is none).
  const firstVisible = (Object.keys(ROUTE_SECTION) as Route[])
    .find(r => perms?.[ROUTE_SECTION[r]!] !== 'none');
  useEffect(() => {
    const section = ROUTE_SECTION[route];
    if (section && perms && perms[section] === 'none') {
      setRoute(firstVisible ?? '/');
    }
  }, [route, perms, firstVisible]);

  // Zero sections granted: keep the chrome (avatar menu = sign out / switch org
  // / admin, if any) and put the notice where the content would go.
  const noAccess = !!perms && !firstVisible;

  return (
    <div className="h-screen overflow-hidden bg-cream-hi text-ink flex flex-col font-sans">
      {!(route === '/workspace' && workspaceFullscreen) && (
        <Header currentRoute={route} onNavigate={setRoute} />
      )}
      {noAccess && route !== '/admin' && route !== '/account' ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <div className="font-display text-xl mb-2">No access</div>
            <p className="text-sm text-mist-600">
              Your roles grant no sections in this organization — ask its admin.
            </p>
          </div>
        </div>
      ) : (
      <main className="flex-1 w-full flex flex-col h-full overflow-hidden">
        {route === '/' && <TextPicker onNavigate={setRoute} />}
        {route === '/workspace' && <WorkspaceView />}
        {route === '/translate' && <TranslateView />}
        {route === '/phonetics' && <PhoneticsView />}
        {route === '/documents' && <DocumentsView />}
        {route === '/admin' && <AdminView />}
        {route === '/account' && <AccountView />}
      </main>
      )}
      <PermissionNotice />
    </div>
  );
}

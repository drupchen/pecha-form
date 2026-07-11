import React, { useEffect, useMemo } from 'react';
import { useTextStore } from '../../store/useTextStore';
import { useTagStore } from '../../store/useTagStore';
import { useMarkerStore } from '../../store/useMarkerStore';
import { useSuggestionStore } from '../../store/useSuggestionStore';
import { useNoteStore } from '../../store/useNoteStore';
import { useTreeNodeStore } from '../../store/useTreeNodeStore';
import { usePassageStore } from '../../store/usePassageStore';
import { useUIStore } from '../../store/useUIStore';
import { SplitPane } from './SplitPane';
import { TreePane } from './TreePane';
import { TaggerPane } from './TaggerPane';
import { Sidebar } from './Sidebar';
import { LinkOverlay } from './LinkOverlay';
import { Pencil, BookOpen, Search, ChevronUp, ChevronDown, X, Maximize2, Minimize2, Link2, WrapText, Pilcrow } from 'lucide-react';
import { TaggerSearchContext, findMatches } from './TaggerSearchContext';
import { scrollTaggerToOffset } from './scrollTaggerToOffset';

export const WorkspaceView: React.FC = () => {
  const { currentText } = useTextStore();
  const { fetchTags, fetchSpans } = useTagStore();
  const { fetchMarkers } = useMarkerStore();
  const { fetchSuggestions } = useSuggestionStore();
  const { fetchNotes, fetchCategories } = useNoteStore();
  const { fetchNodes, saveStatus, error: treeError } = useTreeNodeStore();
  const { fetchPassages } = usePassageStore();
  const editMode = useUIStore(s => s.editMode);
  const setEditMode = useUIStore(s => s.setEditMode);
  const searchQuery = useUIStore(s => s.searchQuery);
  const setSearchQuery = useUIStore(s => s.setSearchQuery);
  const searchMatchIndex = useUIStore(s => s.searchMatchIndex);
  const setSearchMatchIndex = useUIStore(s => s.setSearchMatchIndex);
  const fullscreen = useUIStore(s => s.workspaceFullscreen);
  const toggleFullscreen = useUIStore(s => s.toggleWorkspaceFullscreen);
  const setFullscreen = useUIStore(s => s.setWorkspaceFullscreen);
  const pendingPassageSource = useUIStore(s => s.pendingPassageSource);
  const setPendingPassageSource = useUIStore(s => s.setPendingPassageSource);
  const passageNotice = useUIStore(s => s.passageNotice);
  const verseVertical = useUIStore(s => s.verseVerticalMode);
  const toggleVerseVertical = useUIStore(s => s.toggleVerseVerticalMode);
  const sapcheNewlines = useUIStore(s => s.sapcheNewlineMode);
  const toggleSapcheNewlines = useUIStore(s => s.toggleSapcheNewlineMode);

  // While "place a passage" is armed, Escape cancels it.
  useEffect(() => {
    if (!pendingPassageSource) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); setPendingPassageSource(null); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pendingPassageSource, setPendingPassageSource]);

  // Escape exits full-screen (unless typing in an input — that Escape clears search).
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || (t as any).isContentEditable)) return;
      e.preventDefault();
      setFullscreen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fullscreen, setFullscreen]);

  const searchMatches = useMemo(
    () => (currentText ? findMatches(currentText.raw_text, searchQuery) : []),
    [currentText?.raw_text, searchQuery],
  );

  // Auto-scroll the tagger to the current match whenever the cursor moves.
  useEffect(() => {
    if (searchMatches.length === 0) return;
    const m = searchMatches[searchMatchIndex];
    if (m) scrollTaggerToOffset(m.start);
  }, [searchMatchIndex, searchMatches]);

  const gotoMatch = (delta: number) => {
    if (searchMatches.length === 0) return;
    const next = (searchMatchIndex + delta + searchMatches.length) % searchMatches.length;
    setSearchMatchIndex(next);
  };

  // Load all per-document data when the active document changes.
  useEffect(() => {
    if (!currentText) return;
    const id = currentText.id;
    fetchTags(id);
    fetchSpans(id);
    fetchMarkers(id);
    fetchSuggestions(id);
    fetchNotes(id);
    fetchCategories(id);
    fetchNodes(id);
    fetchPassages(id);
  }, [currentText, fetchTags, fetchSpans, fetchMarkers, fetchSuggestions, fetchNotes, fetchCategories, fetchNodes, fetchPassages]);

  if (!currentText) {
    return (
      <div className="flex-1 flex items-center justify-center text-slate-500">
        No text selected. Pick one from the Texts tab.
      </div>
    );
  }

  const statusLabel =
    saveStatus === 'saving' ? 'Saving…' :
    saveStatus === 'saved'  ? 'Saved ✓' :
    saveStatus === 'error'  ? 'Save failed' : '';

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden">
      {pendingPassageSource && (
        <div className="shrink-0 px-4 py-1.5 flex items-center justify-center gap-3 text-xs bg-blue-600 text-white">
          <Link2 size={13} />
          <span>Move the <strong>hairline</strong> to a syllable boundary (downstream) and <strong>click</strong> to place the passage there.</span>
          {passageNotice && (
            <span className="px-2 py-0.5 rounded bg-amber-300 text-amber-950 font-medium">
              {passageNotice}
            </span>
          )}
          <button
            type="button"
            onClick={() => setPendingPassageSource(null)}
            className="underline underline-offset-2 hover:opacity-80"
          >
            Cancel (Esc)
          </button>
        </div>
      )}
      {fullscreen && (
        <button
          type="button"
          onClick={() => setFullscreen(false)}
          className="fixed top-2 right-2 z-50 p-1.5 rounded-md bg-cream-hi/90 backdrop-blur-sm shadow-sm text-bronze hover:text-lapis transition-colors"
          style={{ border: '1px solid var(--cline)' }}
          title="Exit full screen (Esc)"
        >
          <Minimize2 size={16} />
        </button>
      )}
      {!fullscreen && (
      <div
        className="px-5 py-2.5 shrink-0 flex items-center gap-3 bg-cream-hi"
        style={{ borderBottom: '1px solid var(--cline)' }}
      >
        <h2 className="font-display text-xl text-lapis truncate shrink-0 max-w-xs" title={currentText.title}>
          {currentText.title}
        </h2>
        {/* Tagger-pane search bar — centered between title and right-side controls. */}
        <div className="flex-1 flex justify-center">
          <div
            className="flex items-center gap-1 px-2 py-1 rounded-md bg-white w-80"
            style={{ border: '1px solid var(--cline)' }}
          >
            <Search size={12} className="text-bronze shrink-0" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  gotoMatch(e.shiftKey ? -1 : 1);
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  setSearchQuery('');
                  (e.currentTarget as HTMLInputElement).blur();
                }
              }}
              placeholder="Search in tagger text…"
              className="flex-1 min-w-0 text-xs bg-transparent outline-none tibetan-text-sm py-0.5 text-ink placeholder:text-ink-soft/60"
            />
            {searchQuery && (
              <span className="text-[10px] text-bronze font-mono shrink-0">
                {searchMatches.length === 0 ? '0' : `${searchMatchIndex + 1}/${searchMatches.length}`}
              </span>
            )}
            <button
              type="button"
              onClick={() => gotoMatch(-1)}
              disabled={searchMatches.length === 0}
              className="p-0.5 text-bronze hover:text-vermilion disabled:opacity-30 disabled:hover:text-bronze"
              title="Previous match (Shift+Enter)"
            >
              <ChevronUp size={12} />
            </button>
            <button
              type="button"
              onClick={() => gotoMatch(1)}
              disabled={searchMatches.length === 0}
              className="p-0.5 text-bronze hover:text-vermilion disabled:opacity-30 disabled:hover:text-bronze"
              title="Next match (Enter)"
            >
              <ChevronDown size={12} />
            </button>
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                className="p-0.5 text-bronze hover:text-vermilion-deep"
                title="Clear search (Esc)"
              >
                <X size={12} />
              </button>
            )}
          </div>
        </div>
        <div className="flex items-center gap-3 text-xs shrink-0">
          {statusLabel && (
            <span className={
              saveStatus === 'saved' ? 'text-jade' :
              saveStatus === 'error' ? 'text-vermilion' : 'text-ink-soft'
            }>{statusLabel}</span>
          )}
          {treeError && <span className="text-vermilion truncate max-w-md" title={treeError}>{treeError}</span>}
          <div
            className="flex rounded-md overflow-hidden text-xs font-medium"
            style={{ border: '1px solid var(--cline)' }}
          >
            <button
              type="button"
              onClick={() => setEditMode('edit')}
              className={`px-3 py-1 flex items-center gap-1 transition-colors ${
                editMode === 'edit'
                  ? 'bg-vermilion text-cream-hi'
                  : 'text-ink-soft hover:bg-cream'
              }`}
              title="Edit mode — all affordances enabled"
            >
              <Pencil size={12} /> Edit
            </button>
            <button
              type="button"
              onClick={() => setEditMode('consult')}
              className={`px-3 py-1 flex items-center gap-1 transition-colors ${
                editMode === 'consult'
                  ? 'bg-azure text-cream-hi'
                  : 'text-ink-soft hover:bg-cream'
              }`}
              title="Consult mode — only suggestions and notes are editable"
            >
              <BookOpen size={12} /> Consult
            </button>
          </div>
          <button
            type="button"
            onClick={toggleVerseVertical}
            className={`p-1.5 rounded-md transition-colors ${
              verseVertical
                ? 'bg-lapis text-cream-hi'
                : 'text-bronze hover:text-lapis hover:bg-cream'
            }`}
            style={{ border: '1px solid var(--cline)' }}
            title={verseVertical
              ? 'Verse vertical mode ON — spaces in verse-tagged passages render as line breaks'
              : 'Verse vertical mode — lay out verse-tagged passages vertically'}
          >
            <WrapText size={14} />
          </button>
          <button
            type="button"
            onClick={toggleSapcheNewlines}
            className={`p-1.5 rounded-md transition-colors ${
              sapcheNewlines
                ? 'bg-lapis text-cream-hi'
                : 'text-bronze hover:text-lapis hover:bg-cream'
            }`}
            style={{ border: '1px solid var(--cline)' }}
            title={sapcheNewlines
              ? 'Sapche line breaks ON — a line break renders after each sapche-tagged run'
              : 'Sapche line breaks — end the line after each sapche-tagged run'}
          >
            <Pilcrow size={14} />
          </button>
          <button
            type="button"
            onClick={toggleFullscreen}
            className="p-1.5 rounded-md text-bronze hover:text-lapis hover:bg-cream transition-colors"
            style={{ border: '1px solid var(--cline)' }}
            title="Full screen"
          >
            <Maximize2 size={14} />
          </button>
        </div>
      </div>
      )}
      <TaggerSearchContext.Provider value={searchMatches}>
        <div className="flex-1 flex overflow-hidden">
          <div className="flex-1 overflow-hidden">
            <SplitPane left={<TreePane />} right={<TaggerPane />} initialLeftPct={25} />
          </div>
          <Sidebar />
        </div>
        <LinkOverlay />
      </TaggerSearchContext.Provider>
    </div>
  );
};

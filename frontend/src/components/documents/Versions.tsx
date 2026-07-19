import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { X, Download, ExternalLink, RotateCw, Trash2, Archive, Loader2, GitBranch } from 'lucide-react';
import {
  getVersions, createVersion, retryVersion, deleteVersion, versionPdfUrl,
  getVersionSnapshot,
  type DocumentVersion, type VersionSnapshot, type VersionSnapshotText,
} from '../../api/client';
import '../../styles/booklet.css';

/** Frozen-version manager. Bumps freeze a per-edition PDF everywhere and, at the tip of
 *  each major, a lossless data snapshot; this drawer lists them and opens the read-only
 *  snapshot viewer. Polls while anything is still rendering. */
export const VersionsPanel: React.FC<{
  documentId: number;
  languages: string[];
  canEdit: boolean;
  onClose: () => void;
}> = ({ documentId, languages, canEdit, onClose }) => {
  const [versions, setVersions] = useState<DocumentVersion[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [viewing, setViewing] = useState<DocumentVersion | null>(null);
  const timer = useRef<number | null>(null);

  const load = useCallback(async () => {
    try {
      setVersions(await getVersions(documentId));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [documentId]);

  useEffect(() => { void load(); }, [load]);

  // Poll every 3s while any version is still rendering (the PDF render is off-thread).
  useEffect(() => {
    const rendering = versions?.some(v => v.status === 'rendering');
    if (!rendering) return;
    timer.current = window.setTimeout(() => { void load(); }, 3000);
    return () => { if (timer.current) window.clearTimeout(timer.current); };
  }, [versions, load]);

  const bump = async (kind: 'major' | 'minor') => {
    setBusy(true);
    setError(null);
    try {
      await createVersion(documentId, kind, note.trim() || undefined);
      setNote('');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const doRetry = async (v: DocumentVersion) => {
    try { await retryVersion(documentId, v.id); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  const doDelete = async (v: DocumentVersion) => {
    if (!confirm(`Delete version ${v.semver}? Its frozen PDFs and snapshot are removed.`)) return;
    try { await deleteVersion(documentId, v.id); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  return (
    <div className="w-96 shrink-0 overflow-auto px-4 py-4 bg-cream-hi flex flex-col"
         style={{ borderLeft: '1px solid var(--cline)' }}>
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs text-ink-soft uppercase tracking-wide flex items-center gap-1">
          <GitBranch size={13} /> Versions
        </span>
        <button type="button" onClick={onClose} className="text-ink-soft hover:text-ink p-1"
                title="Close">
          <X size={15} />
        </button>
      </div>

      {canEdit && (
        <div className="mb-4 pb-4" style={{ borderBottom: '1px solid var(--cline)' }}>
          <input
            type="text"
            value={note}
            onChange={e => setNote(e.target.value)}
            placeholder="Note for this version (optional)"
            className="w-full px-2 py-1 rounded-md bg-transparent text-sm mb-2"
            style={{ border: '1px solid var(--cline)' }}
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={busy || languages.length === 0}
              onClick={() => void bump('minor')}
              className="flex-1 px-2 py-1.5 rounded-md text-lapis hover:bg-cream text-xs disabled:opacity-40"
              style={{ border: '1px solid var(--cline)' }}
              title="Freeze a new minor version (X.n+1)"
            >
              Bump minor
            </button>
            <button
              type="button"
              disabled={busy || languages.length === 0}
              onClick={() => void bump('major')}
              className="flex-1 px-2 py-1.5 rounded-md text-lapis hover:bg-cream text-xs disabled:opacity-40"
              style={{ border: '1px solid var(--cline)' }}
              title="Freeze a new major version (n+1.0)"
            >
              Bump major
            </button>
          </div>
          <div className="mt-2 text-[11px] text-ink-soft italic">
            Every version freezes a PDF per edition, independent of the database. The tip of
            each major also keeps a data snapshot for read-only access.
          </div>
        </div>
      )}

      {error && <div className="text-vermilion text-xs mb-2">{error}</div>}

      {versions === null ? (
        <div className="text-xs text-ink-soft">Loading…</div>
      ) : versions.length === 0 ? (
        <div className="text-xs text-ink-soft">No versions yet. Bump one to freeze the booklet.</div>
      ) : (
        <div className="flex flex-col gap-2">
          {versions.map(v => (
            <VersionRow
              key={v.id}
              v={v}
              documentId={documentId}
              languages={languages}
              canEdit={canEdit}
              onRetry={() => void doRetry(v)}
              onDelete={() => void doDelete(v)}
              onViewSnapshot={() => setViewing(v)}
            />
          ))}
        </div>
      )}

      {viewing && (
        <VersionSnapshotView
          documentId={documentId}
          version={viewing}
          onClose={() => setViewing(null)}
        />
      )}
    </div>
  );
};

const STATUS_STYLE: Record<DocumentVersion['status'], string> = {
  rendering: 'text-amber-700 bg-amber-50',
  ready: 'text-emerald-700 bg-emerald-50',
  failed: 'text-vermilion bg-red-50',
};

const VersionRow: React.FC<{
  v: DocumentVersion;
  documentId: number;
  languages: string[];
  canEdit: boolean;
  onRetry: () => void;
  onDelete: () => void;
  onViewSnapshot: () => void;
}> = ({ v, documentId, languages, canEdit, onRetry, onDelete, onViewSnapshot }) => {
  const editions = v.langs.length ? v.langs : languages;
  return (
    <div className="rounded-md px-3 py-2 bg-cream" style={{ border: '1px solid var(--cline)' }}>
      <div className="flex items-center gap-2 mb-1">
        <span className="font-display text-lapis text-sm">v{v.semver}</span>
        <span className={`px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wide flex items-center gap-1 ${STATUS_STYLE[v.status]}`}>
          {v.status === 'rendering' && <Loader2 size={10} className="animate-spin" />}
          {v.status}
        </span>
        {v.has_snapshot && (
          <span className="px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wide text-lapis bg-cream-hi flex items-center gap-1"
                style={{ border: '1px solid var(--cline)' }} title="Has a data snapshot">
            <Archive size={10} /> snapshot
          </span>
        )}
        <div className="flex-1" />
        {canEdit && (
          <button type="button" onClick={onDelete} className="text-ink-soft hover:text-vermilion p-0.5"
                  title="Delete this version">
            <Trash2 size={13} />
          </button>
        )}
      </div>

      {v.note && <div className="text-xs text-ink mb-1">{v.note}</div>}
      <div className="text-[11px] text-ink-soft mb-1.5">{new Date(v.created_at).toLocaleString()}</div>

      {v.status === 'failed' && (
        <div className="flex items-center gap-2 mb-1">
          {v.error && <span className="text-[11px] text-vermilion truncate" title={v.error}>{v.error}</span>}
          {canEdit && (
            <button type="button" onClick={onRetry}
                    className="px-1.5 py-0.5 rounded text-[11px] text-lapis hover:bg-cream-hi flex items-center gap-1"
                    style={{ border: '1px solid var(--cline)' }}>
              <RotateCw size={11} /> retry
            </button>
          )}
        </div>
      )}

      {v.status === 'ready' && (
        <div className="flex flex-wrap items-center gap-1.5 mb-1">
          {editions.map(lang => (
            <span key={lang} className="inline-flex items-center rounded overflow-hidden"
                  style={{ border: '1px solid var(--cline)' }}>
              <a href={versionPdfUrl(documentId, v.id, lang)} target="_blank" rel="noreferrer"
                 className="px-1.5 py-0.5 text-[11px] text-lapis hover:bg-cream-hi flex items-center gap-1"
                 title={`View ${lang} PDF`}>
                <ExternalLink size={10} /> {lang}
              </a>
              <a href={versionPdfUrl(documentId, v.id, lang, true)}
                 className="px-1 py-0.5 text-ink-soft hover:bg-cream-hi hover:text-lapis"
                 style={{ borderLeft: '1px solid var(--cline)' }}
                 title={`Download ${lang} PDF`}>
                <Download size={10} />
              </a>
            </span>
          ))}
        </div>
      )}

      {v.has_snapshot && (
        <button type="button" onClick={onViewSnapshot}
                className="mt-1 px-1.5 py-0.5 rounded text-[11px] text-lapis hover:bg-cream-hi flex items-center gap-1"
                style={{ border: '1px solid var(--cline)' }}>
          <Archive size={11} /> data snapshot
        </button>
      )}
    </div>
  );
};

// ── Read-only snapshot viewer: the frozen texts' Tibetan + translations + phonetics ──

/** Slice the syllable text a chunk/phonetics span covers, from a text's frozen syllables
 *  (ordered by idx; each carries its uuid `id`). */
function sliceSyllables(text: VersionSnapshotText, startId: string, endId: string): string {
  const idxOf = new Map<string, number>();
  text.syllables.forEach(s => idxOf.set(s.id, s.idx));
  const a = idxOf.get(startId);
  const b = idxOf.get(endId);
  if (a == null || b == null) return '';
  const lo = Math.min(a, b), hi = Math.max(a, b);
  return text.syllables
    .filter(s => s.idx >= lo && s.idx <= hi)
    .sort((x, y) => x.idx - y.idx)
    .map(s => s.text)
    .join('');
}

export const VersionSnapshotView: React.FC<{
  documentId: number;
  version: DocumentVersion;
  onClose: () => void;
}> = ({ documentId, version, onClose }) => {
  const [snap, setSnap] = useState<VersionSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    getVersionSnapshot(documentId, version.id)
      .then(s => { if (live) setSnap(s); })
      .catch(e => { if (live) setError(e instanceof Error ? e.message : String(e)); });
    return () => { live = false; };
  }, [documentId, version.id]);

  // Translations grouped by chunk_id → {lang: body}.
  const transByChunk = useMemo(() => {
    const m = new Map<number, Record<string, string>>();
    snap?.translations.forEach(t => {
      const cur = m.get(t.chunk_id) ?? {};
      cur[t.lang] = t.body;
      m.set(t.chunk_id, cur);
    });
    return m;
  }, [snap]);

  // The texts actually placed in the booklet (its text items), in reading order.
  const bookletTexts = useMemo(() => {
    if (!snap) return [];
    const order: number[] = [];
    snap.document_items.forEach(it => {
      if (it.text_id != null && !order.includes(it.text_id)) order.push(it.text_id);
    });
    return order
      .map(id => snap.texts[String(id)])
      .filter((t): t is VersionSnapshotText => !!t);
  }, [snap]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={onClose}>
      <div className="bg-cream-hi rounded-lg shadow-xl w-[min(880px,92vw)] max-h-[88vh] flex flex-col"
           style={{ border: '1px solid var(--cline)' }} onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3"
             style={{ borderBottom: '1px solid var(--cline)' }}>
          <div className="flex items-center gap-2">
            <Archive size={15} className="text-lapis" />
            <span className="font-display text-lapis">Data snapshot · v{version.semver}</span>
            <span className="text-[11px] text-ink-soft">read-only</span>
          </div>
          <button type="button" onClick={onClose} className="text-ink-soft hover:text-ink p-1">
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 overflow-auto px-4 py-3">
          {error ? (
            <div className="text-vermilion text-sm">{error}</div>
          ) : !snap ? (
            <div className="text-ink-soft text-sm">Loading snapshot…</div>
          ) : (
            <div className="flex flex-col gap-6">
              {bookletTexts.map((t, ti) => (
                <SnapshotText key={ti} t={t} transByChunk={transByChunk} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

const SnapshotText: React.FC<{
  t: VersionSnapshotText;
  transByChunk: Map<number, Record<string, string>>;
}> = ({ t, transByChunk }) => {
  const title = t.text[0]?.title ?? '—';
  // Phonetics indexed by their start syllable so we can show them alongside a chunk.
  const phonByStart = useMemo(() => {
    const m = new Map<string, VersionSnapshotText['phonetics']>();
    t.phonetics.forEach(p => {
      const arr = m.get(p.start_syl_id) ?? [];
      arr.push(p);
      m.set(p.start_syl_id, arr);
    });
    return m;
  }, [t.phonetics]);

  const chunks = [...t.translation_chunks].sort((a, b) => {
    const ia = t.syllables.find(s => s.id === a.start_syl_id)?.idx ?? 0;
    const ib = t.syllables.find(s => s.id === b.start_syl_id)?.idx ?? 0;
    return ia - ib;
  });

  return (
    <div>
      <div className="font-display text-lapis text-base mb-2 pb-1"
           style={{ borderBottom: '1px solid var(--cline)' }}>{title}</div>
      <div className="flex flex-col gap-3">
        {chunks.map(c => {
          const bo = sliceSyllables(t, c.start_syl_id, c.end_syl_id);
          const trans = transByChunk.get(c.id) ?? {};
          const phon = phonByStart.get(c.start_syl_id) ?? [];
          return (
            <div key={c.id} className="text-sm">
              <div className="flex items-baseline gap-2">
                {c.level != null && (
                  <span className="text-[10px] text-ink-soft uppercase shrink-0">
                    {c.render_as || c.kind} · L{c.level}
                  </span>
                )}
                <span className="text-ink" style={{ fontFamily: 'var(--font-tibetan, serif)' }}>{bo}</span>
              </div>
              {phon.map((p, pi) => (
                <div key={`p${pi}`} className="text-[13px] text-ink-soft italic pl-2 flex gap-1">
                  <span className="text-[10px] uppercase shrink-0 mt-0.5">{p.lang}</span>
                  <span className="bk-snap-body" dangerouslySetInnerHTML={{ __html: p.body }} />
                </div>
              ))}
              {Object.entries(trans).map(([lang, body]) => (
                <div key={lang} className="text-[13px] text-ink pl-2 flex gap-1">
                  <span className="text-[10px] text-ink-soft uppercase shrink-0 mt-0.5">{lang}</span>
                  <span className="bk-snap-body" dangerouslySetInnerHTML={{ __html: body }} />
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
};

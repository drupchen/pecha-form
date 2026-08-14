import React, { useEffect, useRef, useState } from 'react';
import { History, X } from 'lucide-react';
import { getTranslationRevisions, type TranslationRevision } from '../../api/client';
import { sanitizeTranslationHtml } from './sanitize';

/**
 * Per-chunk wording history: who wrote which expression, and when.
 *
 * The server keeps only the CURRENT wording in `translations`, so this panel reads
 * the append-only `translation_revisions` log. Entries are fetched on open (not with
 * the page — a bench shows hundreds of chunks and almost none of them get asked).
 * The shared translation's history and this booklet's overrides are interleaved by
 * time, which is what answers "where did this phrasing come from".
 */

/** "12 Aug 2026, 14:03" — the log is read across days, so the date leads. */
function stamp(iso: string): string {
  const d = new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z');
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

export const ChunkHistory: React.FC<{
  chunkId: number;
  lang: string;
  className?: string;
  style?: React.CSSProperties;
}> = ({ chunkId, lang, className, style }) => {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<TranslationRevision[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setError(null);
    getTranslationRevisions(chunkId, lang)
      .then((r) => { if (!cancelled) setRows(r); })
      .catch((e: any) => { if (!cancelled) setError(e.message || 'Could not load the history'); });
    return () => { cancelled = true; };
  }, [open, chunkId, lang]);

  // Close on outside click / Escape, like the other bench popovers.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => { setOpen(o => !o); setRows(null); }}
        className={className}
        style={style}
        title="Who wrote this wording, and when"
      >
        <History size={10} /> history
      </button>
      {open && (
        <div
          className="absolute right-0 z-30 mt-1 w-[24rem] max-h-80 overflow-y-auto rounded-md bg-cream-hi shadow-lg p-2 flex flex-col gap-1.5"
          style={{ border: '1px solid var(--cline)' }}
        >
          <div className="flex items-center justify-between text-[10px] text-ink-soft">
            <span>wording history — {lang}</span>
            <button type="button" onClick={() => setOpen(false)} title="Close">
              <X size={11} />
            </button>
          </div>

          {error && <div className="text-[10px] text-red-700">{error}</div>}
          {!error && rows === null && <div className="text-[10px] text-ink-soft">loading…</div>}
          {rows?.length === 0 && (
            <div className="text-[10px] text-ink-soft italic">
              No recorded changes yet — the history starts from the first edit after
              provenance was switched on.
            </div>
          )}

          {rows?.map((r) => (
            <div key={r.id} className="rounded p-1.5 bg-white" style={{ border: '1px solid var(--cline)' }}>
              <div className="flex items-center gap-1.5 text-[10px] text-ink-soft flex-wrap">
                <span className="font-medium text-ink">{r.author_name ?? 'unknown'}</span>
                <span>{stamp(r.created_at)}</span>
                {r.scope === 'override' && (
                  <span className="px-1.5 rounded-full bg-lapis/15 text-lapis" title="A booklet-local wording">
                    booklet-local
                  </span>
                )}
                {r.source === 'suggestion' && (
                  <span className="px-1.5 rounded-full bg-jade/15 text-jade" title={r.note ?? undefined}>
                    accepted suggestion
                  </span>
                )}
                {r.status === 'final' && <span className="text-jade">final</span>}
              </div>
              <div
                className="mt-1 text-xs"
                dangerouslySetInnerHTML={{ __html: sanitizeTranslationHtml(r.body) }}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

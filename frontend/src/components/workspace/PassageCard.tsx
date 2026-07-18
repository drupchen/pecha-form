import React, { useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, X } from 'lucide-react';
import type { Segment } from './segments';
import { readTokenSelection, tokenBreak, shortVerseGroupEnders, sapcheRunStartIds } from './segments';
import { BreakPopover, type BreakTarget } from './BreakPopover';
import { useDisplayBreakStore } from '../../store/useDisplayBreakStore';
import type { Passage } from '../../api/client';
import { useTextStore } from '../../store/useTextStore';
import { useTagStore } from '../../store/useTagStore';
import { useNoteStore } from '../../store/useNoteStore';
import { useTreeNodeStore } from '../../store/useTreeNodeStore';
import { useEditorTokenStore } from '../../store/useEditorTokenStore';
import { usePassageStore } from '../../store/usePassageStore';
import { useLinkStore } from '../../store/useLinkStore';
import { useUIStore } from '../../store/useUIStore';
import { SegmentTagPopover } from './SegmentTagPopover';

const LINK_COLOR = '#A28348';

/**
 * A standalone card for a passage GROUP — the "segment of passages" presentation.
 * The group's first passage is the boundary starter (own_segment or node-linked);
 * the rest flow into the same card, exactly like host text flows within a segment
 * (see passageGroups.ts). Renders each run through the same per-syllable token
 * pipeline as inline passages (source ids/offsets → the source's tags display;
 * per-occurrence notes; verse-vertical), supports selection → the tag/note popover
 * (including Split, which divides the group or a passage within it), and can be
 * linked to a sapche tree node via the starter (node.passage_id; cross-pane link
 * key = -starter.id, a key space disjoint from segment_start offsets).
 */
export const PassageCard: React.FC<{ group: Passage[] }> = ({ group }) => {
  const starter = group[0];
  const currentText = useTextStore(s => s.currentText);
  const allSpans = useTagStore(s => s.spans);
  const allNotes = useNoteStore(s => s.notes);
  const editorTokens = useEditorTokenStore(s => s.tokens);
  const nodes = useTreeNodeStore(s => s.nodes);
  const updateNode = useTreeNodeStore(s => s.updateNode);
  const editPassage = usePassageStore(s => s.editPassage);
  const splitPassageAt = usePassageStore(s => s.splitPassageAt);
  const setHovered = useLinkStore(s => s.setHovered);
  // Boolean, not the raw key: hovering one card must not re-render every card.
  const isLinkHovered = useLinkStore(s => s.hoveredKey === -group[0].id);
  const consultMode = useUIStore(s => s.editMode === 'consult');
  const lineBreaksOn = useUIStore(s => s.lineBreaksOn);
  const lineBreakGroups = useUIStore(s => s.lineBreakGroups);
  const verseVertical = lineBreaksOn && lineBreakGroups.verse;
  const sapcheNewlines = lineBreaksOn && lineBreakGroups.sapche;
  const mantraNewlines = lineBreaksOn && lineBreakGroups.mantra;
  const taggerFontSize = useUIStore(s => s.taggerFontSize);

  const textRef = useRef<HTMLDivElement>(null);
  const [selection, setSelection] = useState<{
    start: number; end: number; startSylId: string; endSylId: string; rect: DOMRect;
    passageId?: number;
  } | null>(null);
  const [linkPickerOpen, setLinkPickerOpen] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);
  const breakOverrides = useDisplayBreakStore(s => s.breaks);
  const [breakTarget, setBreakTarget] = useState<BreakTarget | null>(null);

  const linkKey = -starter.id;  // passage key space (negative), disjoint from segment offsets
  const linkedNode = nodes.find(n => n.passage_id === starter.id);

  const groupSyls = useMemo(
    () => group.flatMap(p => p.members.flatMap(m => m.syllables)),
    [group],
  );
  // Verse breaks are suppressed after seed/invocation groups (≤2 syllables); the
  // whole group flows as one run, so suppression is computed over its full length.
  const verseSuppress = useMemo(
    () => verseVertical
      ? shortVerseGroupEnders(groupSyls.map(s => ({ id: s.syl_id, text: s.text, nature: s.nature })))
      : new Set<string>(),
    [verseVertical, groupSyls],
  );
  const srcOffsets = useMemo(
    () => new Map(editorTokens.map(t => [t.id, [t.start_offset, t.end_offset] as const])),
    [editorTokens],
  );
  const regularSpans = useMemo(() => allSpans.filter(a => a.tag.tag_kind === 'regular'), [allSpans]);
  // "Annotation space" (see SegmentCard.sylSpace): a span may only paint a syllable
  // whose provenance matches its anchor's — transcluded content shows only its
  // origin's tags, never the insertion locale's.
  const sylSpace = useMemo(() => {
    const m = new Map<string, number | 'host'>();
    for (const t of editorTokens) {
      m.set(t.id, t.source === 'transclusion' && t.src_text_id != null ? t.src_text_id : 'host');
    }
    return m;
  }, [editorTokens]);
  const spanSpace = (s: { start_syl_id: string | null }): number | 'host' =>
    (s.start_syl_id && sylSpace.get(s.start_syl_id)) || 'host';

  // Tokens immediately BEFORE a mid-card sapche run starter: they get an automatic
  // break so the heading opens its own line (a starter at the card's first token has
  // no predecessor and gets none). Computed over the whole group — it flows as one run.
  const preSapche = useMemo(() => {
    if (!sapcheNewlines) return new Set<string>();
    const toks = groupSyls.flatMap(s => {
      const o = srcOffsets.get(s.syl_id);
      return o ? [{ id: s.syl_id, start_offset: o[0], end_offset: o[1] }] : [];
    });
    const starts = sapcheRunStartIds(
      toks, regularSpans as any, id => sylSpace.get(id) ?? 'host', spanSpace as any);
    const out = new Set<string>();
    const nonEmpty = groupSyls.filter(s => s.text !== '');
    nonEmpty.forEach((s, i) => {
      const nxt = nonEmpty[i + 1];
      if (nxt && starts.has(nxt.syl_id)) out.add(s.syl_id);
    });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sapcheNewlines, groupSyls, srcOffsets, regularSpans, sylSpace]);

  // Synthetic segment for the popover: the SOURCE offset range of the group (tags
  // anchor shared syllable ids anyway; passage splits go through `passageSplit`).
  const syntheticSegment: Segment = useMemo(() => {
    const offs = groupSyls.map(s => srcOffsets.get(s.syl_id)).filter((x): x is readonly [number, number] => !!x);
    const start = offs.length ? Math.min(...offs.map(o => o[0])) : 0;
    const end = offs.length ? Math.max(...offs.map(o => o[1])) : 0;
    const groupIds = new Set(group.map(p => p.id));
    return {
      key: `passage-${starter.id}`,
      start,
      end,
      text: groupSyls.map(s => s.text).join(''),
      tokens: [],
      annotations: regularSpans.filter(a => a.start_offset < end && a.end_offset > start),
      suggestions: [],
      notes: allNotes.filter(n => n.passage_id != null && groupIds.has(n.passage_id)),
    };
  }, [starter.id, group, groupSyls, srcOffsets, regularSpans, allNotes]);

  // Split dispatch for selections inside this card — passages split exactly like
  // ordinary text. Interior of a member passage → divide it (the second half starts
  // its own card); at a member's end with a follower in the group → the follower
  // becomes a starter (the group divides there).
  const passageSplit = useMemo(() => {
    if (!selection || selection.passageId == null) return undefined;
    const gi = group.findIndex(p => p.id === selection.passageId);
    if (gi < 0) return undefined;
    const p = group[gi];
    const runSyls = p.members.flatMap(m => m.syllables.map(s => s.syl_id));
    const idx = runSyls.indexOf(selection.endSylId);
    if (idx < 0) return undefined;
    const interior = idx < runSyls.length - 1;
    const follower = group[gi + 1];
    const canSplit = interior || follower != null;
    const onSplit = async () => {
      if (interior) {
        await splitPassageAt(p.id, {
          after_syl_id: selection.endSylId, second_own_segment: true,
        });
      } else if (follower) {
        await editPassage(follower.id, { own_segment: true });
      }
    };
    return { canSplit, onSplit };
  }, [selection, group, splitPassageAt, editPassage]);

  if (!currentText) return null;

  const handleMouseUp = () => {
    setTimeout(() => {
      if (!textRef.current) return;
      const result = readTokenSelection(textRef.current);
      if (!result) { setSelection(null); return; }
      setSelection(result);
    }, 0);
  };

  const linkCandidates = nodes
    .filter(n => n.segment_start === null && n.passage_id == null)
    .sort((a, b) => (a.title || '').localeCompare(b.title || ''));

  const handleLinkToNode = async (nodeId: number) => {
    setLinkError(null);
    try {
      await updateNode(nodeId, { passage_id: starter.id });
      setLinkPickerOpen(false);
    } catch (e: any) {
      setLinkError(e.message || 'Could not link');
    }
  };

  const handleUnlink = async () => {
    if (!linkedNode) return;
    if (!confirm(`Unlink this passage from tree node "${linkedNode.title || `#${linkedNode.id}`}"?`)) return;
    try { await updateNode(linkedNode.id, { passage_id: null }); }
    catch (e: any) { alert(e.message); }
  };

  return (
    <div
      className="rounded-lg mb-2 bg-cream-hi"
      style={{
        border: '1px solid var(--cline)',
        ['--link-color' as any]: LINK_COLOR,
        ...(isLinkHovered
          ? { boxShadow: `0 0 0 2px ${LINK_COLOR}`, backgroundColor: `${LINK_COLOR}1f` }
          : {}),
      }}
      data-link-key={linkKey}
      onMouseEnter={() => setHovered(linkKey)}
      onMouseLeave={() => setHovered(null)}
    >
      {/* Header: passage identity + tree link affordance (both via the starter) */}
      <div
        className="px-3 py-1 flex items-center gap-2 text-[10px] text-bronze"
        style={{ borderBottom: '1px solid var(--cline)' }}
      >
        <span className="uppercase tracking-wider" style={{ color: 'var(--passage-fg, #1E7A6B)' }}>
          Passage{group.length > 1 ? ` ×${group.length}` : ''}
        </span>
        {linkedNode ? (
          <button
            type="button"
            onClick={handleUnlink}
            className="flex items-center gap-1 hover:text-vermilion-deep"
            title={`Click to unlink from tree node "${linkedNode.title || `#${linkedNode.id}`}"`}
          >
            <Link size={10} /> tree: {linkedNode.title || `#${linkedNode.id}`}
          </button>
        ) : (
          !consultMode && (
            <button
              type="button"
              onClick={() => { setLinkError(null); setLinkPickerOpen(true); }}
              className="flex items-center gap-1 hover:text-lapis"
              title="Link this passage to a sapche tree node"
            >
              <Link size={10} /> Link…
            </button>
          )
        )}
      </div>

      {/* Body: each run through the token pipeline (source ids/offsets → shared tags). */}
      <div className="p-3" onMouseUp={handleMouseUp}>
        <div
          ref={textRef}
          className="passage-run tibetan-text whitespace-pre-wrap break-words select-text"
          style={{ fontSize: `${taggerFontSize}rem`, ...(starter.color ? { ['--passage-fg' as any]: starter.color } : {}) }}
          data-text-container
          title="Linked passage — the same text as its source (tags are shared; notes are per-occurrence)"
        >
          {group.map(p => p.members.flatMap(m => m.syllables).map((s, si) => {
            const off = srcOffsets.get(s.syl_id);
            const ro = off ? off[0] : -1;
            const reo = off ? off[1] : -1;
            const sSpace = sylSpace.get(s.syl_id) ?? 'host';
            const anns = ro >= 0
              ? regularSpans.filter(a => a.start_offset <= ro && a.end_offset >= reo
                  && spanSpace(a) === sSpace)
              : [];
            const note = ro >= 0
              ? allNotes.find(n => n.passage_id === p.id && n.start_offset <= ro && n.end_offset >= reo)
              : undefined;
            const style: React.CSSProperties = {};
            if (anns.length === 1) style.backgroundColor = `${anns[0].tag.color}33`;
            else if (anns.length > 1) {
              const stops = anns
                .map((a, i) => `${a.tag.color}33 ${i * 7}px, ${a.tag.color}33 ${(i + 1) * 7}px`)
                .join(', ');
              style.background = `repeating-linear-gradient(45deg, ${stops})`;
            }
            if (anns.some(a => { const n = a.tag.name.trim().toLowerCase(); return n.startsWith('small') || n === 'sapche'; })) {
              style.fontSize = '0.75em';
            }
            if (note) style.borderBottom = '1.5px dashed #A28348';
            // Display-only line breaks (¶ mode): clickable ↵ element carrying the
            // actual newlines; real '\n' tokens move theirs into it.
            const brk = tokenBreak(s.text, reo, anns, {
              verse: verseVertical, sapche: sapcheNewlines, mantra: mantraNewlines,
              suppressVerse: verseSuppress.has(s.syl_id),
              nextStartsSapche: preSapche.has(s.syl_id),
            });
            const override = lineBreaksOn ? breakOverrides.get(s.syl_id) : undefined;
            const showBreak = lineBreaksOn && (brk.auto > 0 || override !== undefined);
            const count = override ?? brk.auto;
            return (
              <React.Fragment key={`pc-${p.id}-${si}`}>
                <span
                  data-syl-id={s.syl_id}
                  data-passage-id={p.id}
                  {...(ro >= 0 ? { 'data-ro': ro, 'data-reo': reo } : {})}
                  style={style}
                  title={note ? note.body : undefined}
                >
                  {brk.isReal && showBreak ? '' : s.text}
                </span>
                {showBreak && (
                  <span
                    className={`break-icon${count === 0 ? ' break-icon--off' : ''}`}
                    title={count === 0 ? 'Suppressed line break — click to edit' : 'Line break — click to edit'}
                    onClick={(e) => {
                      e.stopPropagation();
                      setBreakTarget({
                        sylId: s.syl_id, auto: brk.auto, count,
                        anchor: (e.currentTarget as HTMLElement).getBoundingClientRect(),
                      });
                    }}
                  >
                    {'↵' + '\n'.repeat(count)}
                  </span>
                )}
              </React.Fragment>
            );
          }))}
        </div>
      </div>

      {selection && (
        <SegmentTagPopover
          segment={syntheticSegment}
          selection={selection}
          passageSplit={passageSplit}
          onClose={() => { setSelection(null); window.getSelection()?.removeAllRanges(); }}
        />
      )}

      {breakTarget && currentText && (
        <BreakPopover
          textId={currentText.id}
          target={breakTarget}
          onClose={() => setBreakTarget(null)}
        />
      )}

      {linkPickerOpen && createPortal(
        <>
          <div className="fixed inset-0 z-40" onClick={() => setLinkPickerOpen(false)} />
          <div
            className="fixed z-50 bg-cream-hi shadow-xl rounded-xl p-3 w-80 max-h-96 overflow-hidden flex flex-col"
            style={{ top: '20%', left: '50%', transform: 'translateX(-50%)', border: '1px solid var(--cline)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-2 shrink-0">
              <h4 className="font-display text-base text-lapis">Link passage to tree node</h4>
              <button onClick={() => setLinkPickerOpen(false)} className="p-1 text-bronze hover:text-vermilion-deep">
                <X size={14} />
              </button>
            </div>
            {linkError && <p className="text-xs text-vermilion-deep mb-2 shrink-0">{linkError}</p>}
            {linkCandidates.length === 0 ? (
              <p className="text-xs text-ink-soft italic">
                No free tree nodes available. Create one in the tree pane first.
              </p>
            ) : (
              <ul className="flex flex-col gap-0.5 overflow-y-auto">
                {linkCandidates.map(n => (
                  <li key={n.id}>
                    <button
                      onClick={() => handleLinkToNode(n.id)}
                      className="w-full text-left text-xs px-2 py-1.5 rounded hover:bg-cream truncate"
                      title={n.title || `(untitled #${n.id})`}
                    >
                      <span className="tibetan-text-sm text-ink" style={{ fontSize: '13px' }}>
                        {n.title || `(untitled #${n.id})`}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>,
        document.body,
      )}
    </div>
  );
};

import React, { useContext, useRef, useState, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { Link, Link2, GitBranchPlus, Trash2, X } from 'lucide-react';
import type { Segment } from './segments';
import { readTokenSelection, tokenBreak, shortVerseGroupEnders, sapcheRunStartIds } from './segments';
import { BreakPopover, type BreakTarget } from './BreakPopover';
import { useDisplayBreakStore } from '../../store/useDisplayBreakStore';
import { useTextStore } from '../../store/useTextStore';
import { useTagStore, type Span, type Tag } from '../../store/useTagStore';
import { HoverTagPopover } from './HoverTagPopover';
import { useTreeNodeStore } from '../../store/useTreeNodeStore';
import { usePassageStore } from '../../store/usePassageStore';
import { useMarkerStore } from '../../store/useMarkerStore';
import { partitionAnchorPassages } from './passageGroups';
import type { Passage } from '../../api/client';
import { useLinkStore, scrollToLinkPartner } from '../../store/useLinkStore';
import { useUIStore } from '../../store/useUIStore';
import { useSuggestionStore } from '../../store/useSuggestionStore';
import { useEditorTokenStore } from '../../store/useEditorTokenStore';
import { useNoteStore } from '../../store/useNoteStore';
import { SegmentTagPopover } from './SegmentTagPopover';
import { TaggerSearchContext } from './TaggerSearchContext';

interface Props {
  segment: Segment;
  /** The NEXT segment's first render-token id: a passage anchored there with
   *  `attach_prev` renders at the END of this card ("stays on the same segment"). */
  nextSegmentAnchorSylId?: string | null;
  /** Segment 0 has no previous card — attach_prev passages anchored at its first
   *  token fall back to rendering inline at its start. */
  isFirstSegment?: boolean;
}

// Neutral accent for the cross-pane link affordance (no tag color anymore).
const LINK_COLOR = '#A28348';

// Provenance foreground colours for a *secondary* text's composed tokens. A
// parent-link renders in the default ink; changed/added/transcluded syllables get a
// distinct colour so their origin is visible at a glance (syllable-native — keyed by
// the token's `source`, never offsets).
const PROVENANCE_COLOR: Record<string, string> = {
  override: '#B45309',      // amber — a parent syllable changed in place
  added: '#1E7A6B',         // jade — a syllable added in the secondary
  transclusion: '#2563EB',  // lapis — a range linked in from another text
};
const PROVENANCE_TITLE: Record<string, string> = {
  override: 'Changed in this secondary text',
  added: 'Added in this secondary text',
  transclusion: 'Transcluded from another text',
};

/**
 * Renders one segment as a stacked card. Segments are uniform — they're
 * marker-bounded text regions. A segment may be "linked" to a tree node iff
 * some node has `segment_start === segment.start`; the segment can also carry
 * any number of overlapping inline annotation spans rendered as colored
 * backgrounds inside the body text.
 */
export const SegmentCard: React.FC<Props> = ({ segment, nextSegmentAnchorSylId, isFirstSegment }) => {
  const { currentText } = useTextStore();
  const loadText = useTextStore(s => s.loadText);
  const texts = useTextStore(s => s.texts);
  const deleteSuggestion = useSuggestionStore(s => s.deleteSuggestion);
  const { tags, updateSpan, deleteSpan, deleteTag } = useTagStore();
  // Full-text data for PASSAGE-run rendering: a passage's source syllables may live in
  // another segment, so per-segment slices don't cover them.
  const allSpansFull = useTagStore(s => s.spans);
  const allNotesFull = useNoteStore(s => s.notes);
  const editorTokensAll = useEditorTokenStore(s => s.tokens);
  const { nodes, createNode, updateNode } = useTreeNodeStore();
  const activeNodeId = useTreeNodeStore(s => s.activeNodeId);
  const setActiveNode = useTreeNodeStore(s => s.setActiveNode);
  const editingAppend = useTreeNodeStore(s => s.editingAppend);
  const setHovered = useLinkStore(s => s.setHovered);
  const setFocused = useLinkStore(s => s.setFocused);
  const hoveredKey = useLinkStore(s => s.hoveredKey);
  const allPassages = usePassageStore(s => s.passages);
  const editPassage = usePassageStore(s => s.editPassage);
  const splitPassageAt = usePassageStore(s => s.splitPassageAt);
  const createMarker = useMarkerStore(s => s.createMarker);
  const pendingPassageSource = useUIStore(s => s.pendingPassageSource);
  const sessionMode = useUIStore(s => s.sessionMode);
  const consultMode = useUIStore(s => s.editMode === 'consult');
  const lineBreaksOn = useUIStore(s => s.lineBreaksOn);
  const lineBreakGroups = useUIStore(s => s.lineBreakGroups);
  const verseVertical = lineBreaksOn && lineBreakGroups.verse;
  const sapcheNewlines = lineBreaksOn && lineBreakGroups.sapche;
  const mantraNewlines = lineBreaksOn && lineBreakGroups.mantra;
  const breakOverrides = useDisplayBreakStore(s => s.breaks);
  const [breakTarget, setBreakTarget] = useState<BreakTarget | null>(null);
  const taggerFontSize = useUIStore(s => s.taggerFontSize);
  const searchMatchIndex = useUIStore(s => s.searchMatchIndex);
  const allSearchMatches = useContext(TaggerSearchContext);
  const searchMatchesInSegment = useMemo(
    () => allSearchMatches.filter(m => m.start < segment.end && m.end > segment.start),
    [allSearchMatches, segment.start, segment.end],
  );
  const currentSearchMatch = allSearchMatches[searchMatchIndex];
  const textRef = useRef<HTMLDivElement>(null);
  const [selection, setSelection] = useState<{
    start: number; end: number; startSylId: string; endSylId: string; rect: DOMRect;
    passageId?: number;
  } | null>(null);
  const [linkPickerOpen, setLinkPickerOpen] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);
  // Annotation-edit popover state. `editTarget` is the annotation span being
  // edited. `annPicker` shows when the user clicks a fragment with multiple
  // overlapping annotations — they pick one, which becomes `editTarget`.
  const [editTarget, setEditTarget] = useState<{ span: Span; anchor: DOMRect } | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [annPicker, setAnnPicker] = useState<{ anns: Span[]; anchor: DOMRect } | null>(null);
  const [hoverPopover, setHoverPopover] = useState<{ tags: Tag[]; anchorRect: DOMRect } | null>(null);

  if (!currentText) return null;

  // Link key = segment.start. Both this segment and any tree node linked to
  // it carry the same `data-link-key` for the cross-pane LinkOverlay.
  const linkKey = segment.start;
  const linkedNode = nodes.find(n => n.segment_start === segment.start);

  const isLinkHovered = hoveredKey === linkKey;
  const linkProps: Record<string, any> = {
    'data-link-key': linkKey,
    onMouseEnter: () => setHovered(linkKey),
    onMouseLeave: () => setHovered(null),
  };
  const linkStyle: React.CSSProperties = {
    ['--link-color' as any]: LINK_COLOR,
    ...(isLinkHovered
      ? { boxShadow: `0 0 0 2px ${LINK_COLOR}`, backgroundColor: `${LINK_COLOR}1f` }
      : {}),
  };

  // In session mode, build pseudo-spans from session tags whose paired
  // open/close markers overlap this segment. In regular mode, just show
  // regular-kind annotation spans.
  const sessionRangeSpans = useMemo<Span[]>(() => {
    if (!sessionMode) return [];
    return tags
      .filter(t => t.tag_kind === 'session' && t.open_position != null && t.close_position != null)
      .filter(t => t.open_position! < segment.end && t.close_position! > segment.start)
      .map(t => ({
        id: -t.id, // pseudo id; negative to distinguish from real spans
        // Session tags are always text-scoped (never shared/null).
        text_id: t.text_id!,
        tag_id: t.id,
        start_offset: t.open_position!,
        end_offset: t.close_position!,
        start_syl_id: null,
        end_syl_id: null,
        tag: t,
      }));
  }, [sessionMode, tags, segment.start, segment.end]);

  // Open-only session tags whose open_position falls inside this segment —
  // rendered as inline hairlines (no closed range yet).
  const sessionOpenHairlines = useMemo(() => {
    if (!sessionMode) return [] as { position: number; color: string; name: string }[];
    return tags
      .filter(t => t.tag_kind === 'session' && t.open_position != null && t.close_position == null)
      .filter(t => t.open_position! >= segment.start && t.open_position! <= segment.end)
      .map(t => ({ position: t.open_position!, color: t.color, name: t.name }));
  }, [sessionMode, tags, segment.start, segment.end]);

  const visibleAnnotations = useMemo(() => {
    if (sessionMode) return sessionRangeSpans;
    return segment.annotations.filter(s => s.tag.tag_kind === 'regular');
  }, [sessionMode, sessionRangeSpans, segment.annotations]);

  // "Annotation space": tags paint by offset interval, but a transclusion is spliced
  // BETWEEN host syllables, so a host/ancestor span surrounding the insertion point
  // would numerically cover the foreign tokens. A span may only paint a token whose
  // space matches its anchor's space — transcluded content carries ONLY the tags
  // declared on its origin (or created on its own syllables), never the insertion
  // locale's. Primaries are unaffected (every token is 'host').
  const sylSpace = useMemo(() => {
    const m = new Map<string, number | 'host'>();
    for (const t of editorTokensAll) {
      m.set(t.id, t.source === 'transclusion' && t.src_text_id != null ? t.src_text_id : 'host');
    }
    return m;
  }, [editorTokensAll]);
  const spanSpace = (s: { start_syl_id: string | null }): number | 'host' =>
    (s.start_syl_id && sylSpace.get(s.start_syl_id)) || 'host';

  // Passages anchored MID-SEGMENT render inline (in a distinct colour) BEFORE their
  // anchor syllable; anchor === null renders at the end of the text (last segment).
  // Boundary-anchored passages (anchored at this segment's FIRST render token) are
  // rendered by TaggerPane as their own standalone cards — skipped here. Same-anchor
  // passages order by (position, id).
  // Passages explicitly linked to a sapche node ("own section") render as standalone
  // cards in TaggerPane — everything else renders INLINE in its segment.
  const nodeLinkedPassageIds = useMemo(
    () => new Set(nodes.filter(n => n.passage_id != null).map(n => n.passage_id as number)),
    [nodes],
  );

  const passagesByAnchor = useMemo(() => {
    const tokenIds = new Set(segment.tokens.map(t => t.id));
    const firstRenderId = segment.tokens.find(t => !t.inserted && t.text !== '')?.id;
    const map = new Map<string, Passage[]>();
    const atEnd: Passage[] = [];
    // Only the pre-starter prefix of each anchor's passages renders inline; from the
    // first own_segment/node-linked passage on, they group into standalone cards
    // (TaggerPane) — a split is one boundary, everything after it flows together.
    const mine = allPassages.filter(p => p.text_id === currentText.id);
    const inlinePassages = [...new Set(mine.map(p => p.anchor_syl_id))].flatMap(anchor =>
      partitionAnchorPassages(
        mine.filter(p => p.anchor_syl_id === anchor), nodeLinkedPassageIds).inline);
    for (const p of inlinePassages) {
      // A boundary passage claimed by THIS card: anchored at the next segment's first
      // token with attach_prev → renders at the END of this card (same segment).
      if (p.anchor_syl_id && nextSegmentAnchorSylId && p.anchor_syl_id === nextSegmentAnchorSylId && p.attach_prev) {
        atEnd.push(p);
        continue;
      }
      // attach_prev passages anchored at THIS card's first token belong to the PREVIOUS
      // card's end — skip here (segment 0 has no previous: keep them inline at start).
      if (p.anchor_syl_id && p.anchor_syl_id === firstRenderId && p.attach_prev && !isFirstSegment) continue;
      if (p.anchor_syl_id && tokenIds.has(p.anchor_syl_id)) {
        const arr = map.get(p.anchor_syl_id) ?? [];
        arr.push(p);
        map.set(p.anchor_syl_id, arr);
      } else if (!p.anchor_syl_id && segment.end >= currentText.raw_text.length) {
        atEnd.push(p);
      }
    }
    const order = (a: Passage, b: Passage) => a.position - b.position || a.id - b.id;
    map.forEach(arr => arr.sort(order));
    atEnd.sort(order);
    return { map, atEnd };
  }, [allPassages, segment.tokens, segment.end, currentText.id, currentText.raw_text.length, nextSegmentAnchorSylId, isFirstSegment, nodeLinkedPassageIds]);

  // Split dispatch for selections INSIDE an inline passage run — passages split exactly
  // like ordinary text. Interior point → divide the passage (backend /split); at the
  // run's end → the boundary lands before whatever follows: a sibling passage gets
  // promoted (own_segment), or host text follows and the marker/attach_prev machinery
  // takes over.
  const passageSplit = useMemo(() => {
    if (!selection || selection.passageId == null || !currentText) return undefined;
    const p = allPassages.find(x => x.id === selection.passageId);
    if (!p) return undefined;
    const runSyls = p.members.flatMap(m => m.syllables.map(s => s.syl_id));
    const idx = runSyls.indexOf(selection.endSylId);
    if (idx < 0) return undefined;
    const interior = idx < runSyls.length - 1;
    const siblings = allPassages
      .filter(x => x.text_id === currentText.id && x.anchor_syl_id === p.anchor_syl_id)
      .sort((a, b) => a.position - b.position || a.id - b.id);
    const follower = siblings[siblings.findIndex(x => x.id === p.id) + 1];
    const followerIsStarter =
      follower != null && (follower.own_segment || nodeLinkedPassageIds.has(follower.id));
    // Trailing = nothing of THIS segment's host text follows the passage (claimed
    // boundary / end-of-text). Otherwise the anchor host token follows it mid-card.
    const trailing = p.anchor_syl_id == null || p.anchor_syl_id === nextSegmentAnchorSylId;
    const firstRenderId = segment.tokens.find(t => !t.inserted && t.text !== '')?.id;
    const headOfSegment = p.anchor_syl_id != null && p.anchor_syl_id === firstRenderId;
    const anchorTok = p.anchor_syl_id != null
      ? segment.tokens.find(t => t.id === p.anchor_syl_id)
      : undefined;

    const canSplit = interior
      ? true
      : follower
        ? !followerIsStarter  // boundary already there if the follower is a starter
        : !trailing && anchorTok != null;  // host follows → marker/attach side

    const onSplit = async () => {
      if (interior) {
        if (trailing) {
          await splitPassageAt(p.id, {
            after_syl_id: selection.endSylId, second_own_segment: true,
          });
        } else {
          // Mid-segment: first half ends the earlier segment, second heads the later
          // one; the boundary itself is a marker at the anchor token (already a
          // segment boundary when the passage heads its card).
          await splitPassageAt(p.id, {
            after_syl_id: selection.endSylId,
            first_attach_prev: true, second_attach_prev: false,
          });
          if (!headOfSegment && anchorTok) {
            await createMarker(currentText.id, anchorTok.start_offset);
          }
        }
      } else if (follower && !followerIsStarter) {
        await editPassage(follower.id, { own_segment: true });
      } else if (anchorTok) {
        await editPassage(p.id, { attach_prev: true });
        if (!headOfSegment) await createMarker(currentText.id, anchorTok.start_offset);
      }
    };

    return { canSplit, onSplit };
  }, [selection, allPassages, currentText, segment.tokens, nextSegmentAnchorSylId,
      nodeLinkedPassageIds, splitPassageAt, editPassage, createMarker]);

  // Render the body as a flat sequence of corrected syllable tokens (Phase 3 E2).
  // Each token is a span carrying `data-syl-id` + raw offsets (`data-ro`/`data-reo`)
  // so the displayed text is the corrected, selectable text and selection snaps to
  // whole syllables. Tag/note/search overlays + session hairlines are applied per
  // token. Corrected/inserted tokens get an amber dotted underline; the original is
  // shown on hover.
  const fragments = useMemo(() => {
    const tagBgStyle = (anns: typeof visibleAnnotations): React.CSSProperties => {
      if (anns.length === 1) {
        return { backgroundColor: `${anns[0].tag.color}33` };
      }
      if (anns.length > 1) {
        const STRIPE_PX = 7;
        const stops = anns
          .map((a, i) => `${a.tag.color}33 ${i * STRIPE_PX}px, ${a.tag.color}33 ${(i + 1) * STRIPE_PX}px`)
          .join(', ');
        return { background: `repeating-linear-gradient(45deg, ${stops})` };
      }
      return {};
    };

    const out: React.ReactNode[] = [];
    const tokens = segment.tokens;
    // Fallback before the token layer has loaded: render the raw text as one
    // selectable span so the pane is never blank (offsets still work coarsely).
    if (tokens.length === 0) {
      out.push(
        <span key="raw" data-syl-id="" data-ro={segment.start} data-reo={segment.end}>
          {segment.text}
        </span>,
      );
      return out;
    }

    // Passage runs render their SOURCE syllables as real tokens (data-syl-id = the
    // shared source uuid, data-ro/reo = the source occurrence's offsets), so the
    // source's tags display inside the run automatically, the run is selectable /
    // taggable (tags are SHARED with the source by design), and per-occurrence notes
    // (note.passage_id) underline only here. data-passage-id on every token lets the
    // popover attach notes to this occurrence and lets armed placement insert a new
    // passage right after this one.
    const srcOffsets = new Map(editorTokensAll.map(t => [t.id, [t.start_offset, t.end_offset] as const]));
    const passageSpans = allSpansFull.filter(a => a.tag.tag_kind === 'regular');
    // Verse breaks are suppressed after seed/invocation groups (≤2 syllables).
    const verseSuppress = verseVertical ? shortVerseGroupEnders(tokens) : new Set<string>();

    // The clickable ↵ element at a break point. It carries the ACTUAL newlines (the
    // body is whitespace-pre-wrap), so editing the break edits the layout in place.
    // No data-syl-id — readTokenSelection ignores it.
    const breakEl = (key: string, sylId: string, auto: 0 | 1, count: number) => (
      <span
        key={key}
        className={`break-icon${count === 0 ? ' break-icon--off' : ''}`}
        title={count === 0 ? 'Suppressed line break — click to edit' : 'Line break — click to edit'}
        onClick={(e) => {
          e.stopPropagation();
          setBreakTarget({
            sylId, auto, count,
            anchor: (e.currentTarget as HTMLElement).getBoundingClientRect(),
          });
        }}
      >
        {'↵' + '\n'.repeat(count)}
      </span>
    );
    // Resolve one token's break in ¶ mode: automatic rule + user override.
    const breakFor = (id: string, text: string, endOffset: number, anns: { tag: { name: string }; end_offset: number }[], suppressed: boolean, nextStartsSapche = false) => {
      const brk = tokenBreak(text, endOffset, anns, {
        verse: verseVertical, sapche: sapcheNewlines, mantra: mantraNewlines,
        suppressVerse: suppressed, nextStartsSapche,
      });
      const override = lineBreaksOn ? breakOverrides.get(id) : undefined;
      const show = lineBreaksOn && (brk.auto > 0 || override !== undefined);
      return { ...brk, show, count: override ?? brk.auto };
    };
    // A mid-card sapche run starts on its own line: the token BEFORE a run starter
    // gets an automatic break (same icon/override machinery as every other break).
    const tokenSpaceOf = (id: string) => sylSpace.get(id) ?? 'host';
    const sapcheStarts = sapcheNewlines
      ? sapcheRunStartIds(
          tokens.filter(t => t.text !== ''), visibleAnnotations as any,
          tokenSpaceOf, spanSpace as any)
      : new Set<string>();
    const renderPassage = (p: Passage) => {
      const syls = p.members.flatMap(m => m.syllables);
      const runSuppress = verseVertical
        ? shortVerseGroupEnders(syls.map(s => ({ id: s.syl_id, text: s.text, nature: s.nature })))
        : new Set<string>();
      const pSapcheStarts = sapcheNewlines
        ? sapcheRunStartIds(
            syls.flatMap(s => {
              const o = srcOffsets.get(s.syl_id);
              return o ? [{ id: s.syl_id, start_offset: o[0], end_offset: o[1] }] : [];
            }),
            passageSpans as any, tokenSpaceOf, spanSpace as any)
        : new Set<string>();
      out.push(
        <span
          key={`passage-${p.id}`}
          data-passage-id={p.id}
          className="passage-run"
          style={p.color ? ({ ['--passage-fg' as any]: p.color }) : undefined}
          title="Linked passage — the same text as its source (tags are shared; notes are per-occurrence)"
        >
          {syls.map((s, si) => {
            const off = srcOffsets.get(s.syl_id);
            const ro = off ? off[0] : -1;
            const reo = off ? off[1] : -1;
            const sSpace = sylSpace.get(s.syl_id) ?? 'host';
            const anns = ro >= 0
              ? passageSpans.filter(a => a.start_offset <= ro && a.end_offset >= reo
                  && spanSpace(a) === sSpace)
              : [];
            const note = ro >= 0
              ? allNotesFull.find(n => n.passage_id === p.id && n.start_offset <= ro && n.end_offset >= reo)
              : undefined;
            const style: React.CSSProperties = { ...tagBgStyle(anns) };
            if (anns.some(a => { const n = a.tag.name.trim().toLowerCase(); return n.startsWith('small') || n === 'sapche'; })) {
              style.fontSize = '0.75em';
            }
            if (note) style.borderBottom = '1.5px dashed #A28348';
            const nxtSyl = syls.slice(si + 1).find(x => x.text !== '');
            const brk = breakFor(s.syl_id, s.text, reo, anns, runSuppress.has(s.syl_id),
                                 nxtSyl != null && pSapcheStarts.has(nxtSyl.syl_id));
            return (
              <React.Fragment key={`pt-${p.id}-${si}`}>
                <span
                  data-syl-id={s.syl_id}
                  data-passage-id={p.id}
                  {...(ro >= 0 ? { 'data-ro': ro, 'data-reo': reo } : {})}
                  style={style}
                  title={note ? note.body : undefined}
                >
                  {brk.isReal && brk.show ? '' : s.text}
                </span>
                {brk.show && breakEl(`pt-br-${p.id}-${si}`, s.syl_id, brk.auto, brk.count)}
              </React.Fragment>
            );
          })}
        </span>,
      );
    };

    const renderHairlinesAt = (pos: number) => {
      for (const h of sessionOpenHairlines.filter(x => x.position === pos)) {
        out.push(
          <span
            key={`hairline-${h.name}-${pos}`}
            title={`Session ${h.name} opens here (close it from the popup)`}
            style={{
              display: 'inline-block', width: '3px', height: '1.1em',
              backgroundColor: h.color, verticalAlign: 'middle', margin: '0 1px',
            }}
          />,
        );
      }
    };

    for (let ti = 0; ti < tokens.length; ti++) {
      const t = tokens[ti];
      renderHairlinesAt(t.start_offset);
      // Inline passages anchored before this syllable.
      const anchoredPassages = passagesByAnchor.map.get(t.id);
      if (anchoredPassages) anchoredPassages.forEach(renderPassage);

      // A removed (deleted/extracted) range arrives as token(s) with empty text but a
      // non-null `original`. On their own they render as invisible zero-width spans, so
      // the deletion vanishes. Collapse a run of them into ONE visible marker: hover
      // shows the removed text; in edit mode a plain deletion restores on click, an
      // extraction opens the text the range was moved into.
      if (t.text === '' && t.original != null && !t.inserted) {
        let tj = ti;
        let removed = '';
        while (tj < tokens.length
               && tokens[tj].text === '' && tokens[tj].original != null && !tokens[tj].inserted) {
          removed += tokens[tj].original ?? '';
          tj++;
        }
        const runStart = t.start_offset;
        const runEnd = tokens[tj - 1].end_offset;
        // The delete-suggestion covering this run (for restore / extraction link).
        const sug = segment.suggestions.find(
          s => s.suggested_text === '' && s.start_offset <= runStart && s.end_offset >= runEnd,
        );
        const extractedId = sug?.extracted_text_id ?? null;
        const isExtract = extractedId != null;
        const extractedTitle = isExtract ? (texts.find(d => d.id === extractedId)?.title ?? null) : null;
        const removedFlat = removed.replace(/\n/g, ' ');
        const preview = removedFlat.slice(0, 12);
        const canAct = !consultMode && (isExtract ? true : !!sug);
        const accent = isExtract ? '#0f766e' : '#b91c1c';
        const tint = isExtract ? 'rgba(15,118,110,0.12)' : 'rgba(185,28,28,0.12)';
        const title = isExtract
          ? `Extracted${extractedTitle ? ` to “${extractedTitle}”` : ''}: “${removedFlat}”`
            + (canAct ? ' — click to open' : '')
          : `Removed: “${removedFlat}”` + (canAct ? ' — click to restore' : '');
        out.push(
          <span
            key={`del-${t.idx}`}
            data-del-marker=""
            data-ro={runStart}
            data-reo={runEnd}
            contentEditable={false}
            className={canAct ? 'cursor-pointer' : undefined}
            title={title}
            style={{
              display: 'inline-flex', alignItems: 'baseline', gap: '3px',
              margin: '0 2px', padding: '0 4px', borderRadius: '4px',
              fontSize: '0.7em', verticalAlign: 'middle', userSelect: 'none',
              background: tint, color: accent, border: `1px solid ${accent}55`,
            }}
            onClick={canAct ? (e) => {
              e.stopPropagation();
              if (isExtract && extractedId != null) loadText(extractedId);
              else if (sug) deleteSuggestion(sug.id);
            } : undefined}
          >
            <span aria-hidden>{isExtract ? '⤴' : '⌫'}</span>
            {preview && (
              <span style={{ textDecoration: 'line-through', opacity: 0.85 }}>
                {preview}{removedFlat.length > preview.length ? '…' : ''}
              </span>
            )}
          </span>,
        );
        ti = tj - 1;
        continue;
      }
      // A token (a syllable) is fully covered or not — annotation boundaries are on
      // syllable edges. Inserted tokens are zero-width (start == end). The span must
      // also share the token's annotation space (see `sylSpace`).
      const tSpace = t.source === 'transclusion' && t.src_text_id != null ? t.src_text_id : 'host';
      const anns = visibleAnnotations.filter(x =>
        x.start_offset <= t.start_offset && x.end_offset >= t.end_offset
        && (sessionMode || spanSpace(x as any) === tSpace));
      const note = segment.notes.find(x => x.start_offset <= t.start_offset && x.end_offset >= t.end_offset);
      const searchHit = searchMatchesInSegment.find(m => m.start <= t.start_offset && m.end >= t.end_offset);
      const isCurrentSearchHit = !!searchHit && currentSearchMatch
        && searchHit.start === currentSearchMatch.start
        && searchHit.end === currentSearchMatch.end;
      const corrected = t.inserted || (t.original != null && t.original !== t.text);
      const style: React.CSSProperties = { ...tagBgStyle(anns) };
      // A run tagged "small" or "sapche" (small-letters annotations) renders at 75% size.
      // `em` (not rem) so it composes with the pane-wide taggerFontSize on the container.
      if (anns.some(a => { const n = a.tag.name.trim().toLowerCase(); return n.startsWith('small') || n === 'sapche'; })) {
        style.fontSize = '0.75em';
      }
      const classes: string[] = [];
      // Secondary-text provenance: colour changed/added/transcluded syllables.
      const prov = t.source && t.source !== 'parent-link' ? t.source : undefined;
      if (prov) {
        style.color = PROVENANCE_COLOR[prov];
      }
      if (searchHit) {
        style.backgroundColor = isCurrentSearchHit ? '#fb923c' : '#fde68a';
        style.color = '#1f2937';  // search highlight wins over provenance colour
      }
      if (corrected) {
        // Applied correction: amber dotted underline; original shown on hover.
        style.borderBottom = '1.5px dotted #D85C1B';
      } else if (note) {
        style.borderBottom = '1.5px dashed #A28348';
      }
      const title = corrected
        ? (t.inserted
            ? `inserted: "${t.text}"`
            : `was: "${(t.original ?? '').replace(/\n/g, ' ')}"`)
        : prov
          ? (prov === 'override' && t.original
              ? `${PROVENANCE_TITLE[prov]} (was: "${t.original.replace(/\n/g, ' ')}")`
              : PROVENANCE_TITLE[prov])
          : undefined;
      // Inherited spans (a transclusion source's tags) are read-only here: hover shows
      // them, but the edit popover only offers the host's own spans.
      const editableAnns = anns.filter(a => !a.inherited);
      const onAnnClick = editableAnns.length > 0 && !consultMode
        ? (e: React.MouseEvent<HTMLSpanElement>) => {
            // While "place a passage" is armed, the click's job is PLACEMENT: let it
            // bubble to the pane's delegated hairline handler instead of opening the
            // tag editor (which used to swallow every click on tagged syllables — the
            // reason placement could never be completed on a tagged text).
            if (pendingPassageSource) return;
            e.stopPropagation();
            const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
            setEditError(null);
            if (editableAnns.length === 1) {
              setAnnPicker(null);
              setEditTarget({ span: editableAnns[0], anchor: rect });
            } else {
              setEditTarget(null);
              setAnnPicker({ anns: editableAnns, anchor: rect });
            }
          }
        : undefined;
      const onAnnMouseEnter = anns.length > 0
        ? (e: React.MouseEvent<HTMLSpanElement>) => {
            const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
            setHoverPopover({ tags: anns.map(x => x.tag), anchorRect: rect });
          }
        : undefined;
      const onAnnMouseLeave = anns.length > 0
        ? () => setHoverPopover(null)
        : undefined;
      if (editableAnns.length > 0 && !consultMode) classes.push('cursor-pointer');
      // Display-only line breaks (¶ mode): the break point renders as a clickable ↵
      // element carrying the actual newlines; a real '\n' token moves its newline
      // into that element so it becomes suppressible/doublable like the others.
      const nextTok = tokens.slice(ti + 1).find(x => x.text !== '');
      const brk = breakFor(t.id, t.text, t.end_offset, anns, verseSuppress.has(t.id),
                           nextTok != null && sapcheStarts.has(nextTok.id));
      const renderText = brk.isReal && brk.show ? '' : t.text;
      out.push(
        <span
          key={`t-${t.idx}`}
          data-syl-id={t.id}
          data-ro={t.start_offset}
          data-reo={t.end_offset}
          {...(t.inserted ? { 'data-inserted': '' } : {})}
          className={classes.join(' ')}
          style={style}
          title={title}
          onClick={onAnnClick}
          onMouseEnter={onAnnMouseEnter}
          onMouseLeave={onAnnMouseLeave}
        >
          {renderText}
        </span>,
      );
      if (brk.show) out.push(breakEl(`t-br-${t.idx}`, t.id, brk.auto, brk.count));
    }
    passagesByAnchor.atEnd.forEach(renderPassage);
    renderHairlinesAt(segment.end);
    return out;
  }, [segment, visibleAnnotations, sessionOpenHairlines, searchMatchesInSegment, currentSearchMatch, consultMode, passagesByAnchor, texts, loadText, deleteSuggestion, verseVertical, sapcheNewlines, mantraNewlines, lineBreaksOn, breakOverrides, pendingPassageSource, editorTokensAll, allSpansFull, allNotesFull]);

  const handleMouseUp = () => {
    // In session mode, the pane-level handler in TaggerPane takes over so it
    // can capture cross-card selections. Skip the per-card handler entirely.
    if (sessionMode) return;
    // While "place a passage" is armed, clicks are placement gestures — don't let a
    // slightly-draggy click reopen the selection popover mid-placement.
    if (pendingPassageSource) return;
    setTimeout(() => {
      if (!textRef.current) return;
      // Token-based selection: absolute raw offsets already snapped to whole
      // syllables (the token spans are the snap units).
      const result = readTokenSelection(textRef.current);
      if (!result) {
        setSelection(null);
        return;
      }
      const { start, end, startSylId, endSylId, rect, passageId } = result;
      // Priority 1: a tree node is being renamed RIGHT NOW — append the
      // selection to its rename input.
      if (editingAppend) {
        const text = currentText.raw_text.substring(start, end);
        if (text) editingAppend(text);
        setSelection({ start, end, startSylId, endSylId, rect, passageId });
        return;
      }
      // Priority 2: auto-fill an "active" tree node's title with the selected
      // text, but only when its title is a placeholder.
      if (activeNodeId != null) {
        const target = nodes.find(n => n.id === activeNodeId);
        const PLACEHOLDERS = new Set(['', 'New section']);
        const isPlaceholder = !target?.title || PLACEHOLDERS.has(target.title.trim());
        if (target && isPlaceholder) {
          const text = currentText.raw_text.substring(start, end).trim();
          if (text) {
            updateNode(activeNodeId, { title: text }).catch(() => { /* surfaced via store error */ });
            setActiveNode(null);
            const el = document.querySelector(`[data-node-id="${activeNodeId}"]`) as HTMLElement | null;
            if (el) {
              el.classList.remove('link-pulse');
              void el.offsetWidth;
              el.classList.add('link-pulse');
              setTimeout(() => el.classList.remove('link-pulse'), 1200);
            }
          }
        }
      }
      setSelection({ start, end, startSylId, endSylId, rect, passageId });
    }, 0);
  };

  const clearSelection = () => {
    setSelection(null);
    window.getSelection()?.removeAllRanges();
  };

  // (Passage placement moved to TaggerPane: a snapping hairline + one delegated click
  // handler cover host tokens, passage runs, and standalone PassageCards uniformly.)

  // Default title when promoting a segment that's been unnamed — use the first
  // ~30 chars of segment text, trimmed, so the new node has a readable label.
  const defaultSegmentTitle = (): string => {
    const t = segment.text.trim();
    if (!t) return 'Section';
    return t.length > 30 ? t.slice(0, 30).trim() + '…' : t;
  };

  const handlePromote = async () => {
    try {
      await createNode(currentText.id, {
        parent_id: null,
        segment_start: segment.start,
        // Part 6: anchor the link on the segment's first syllable.
        segment_start_syl_id: segment.tokens[0]?.id ?? null,
      });
    } catch (e: any) {
      alert(e.message);
    }
  };

  const handleLinkToNode = async (nodeId: number) => {
    setLinkError(null);
    try {
      await updateNode(nodeId, {
        segment_start: segment.start,
        segment_start_syl_id: segment.tokens[0]?.id ?? null,
      });
      setLinkPickerOpen(false);
    } catch (e: any) {
      setLinkError(e.message || 'Could not link');
    }
  };

  // Candidate tree nodes for linking: free-form ones not already pointing at
  // a segment or a passage. Sort by title for predictable picker UX.
  const linkCandidates = useMemo(
    () =>
      nodes
        .filter(n => n.segment_start === null && n.passage_id == null)
        .sort((a, b) => (a.title || '').localeCompare(b.title || '')),
    [nodes],
  );

  const handleUnlink = async () => {
    if (!linkedNode) return;
    const label = linkedNode.title?.trim() || `#${linkedNode.id}`;
    if (!confirm(`Unlink this segment from tree node "${label}"? The node will stay in the tree.`)) return;
    // If the node has no explicit title, give it one before clearing the link
    // (CHECK constraint: title or segment_start must be non-null).
    const params: { segment_start: null; title?: string } = { segment_start: null };
    if (!linkedNode.title?.trim()) {
      params.title = defaultSegmentTitle();
    }
    try {
      await updateNode(linkedNode.id, params);
    } catch (e: any) {
      alert(e.message);
    }
  };

  // Candidate tags for re-tagging the annotation the user is currently editing
  // (every tag except the current one — no type filter anymore).
  const tagChangeCandidates = useMemo(() => {
    const t = editTarget?.span.tag;
    if (!t) return [];
    return tags.filter(x => x.id !== t.id);
  }, [tags, editTarget]);

  const handleChangeTag = async (targetSpanId: number, newTagId: number) => {
    setEditError(null);
    try {
      await updateSpan(targetSpanId, newTagId);
      setEditTarget(null);
    } catch (e: any) {
      setEditError(e.message || 'Could not change tag');
    }
  };

  const handleRemoveTag = async (targetSpan: Span) => {
    try {
      // Session "pseudo-spans" (synthesized from paired session tags for
      // rendering) have a negative id. Route those through deleteTag, which
      // wipes the open/close markers in one step.
      if (targetSpan.id < 0) {
        await deleteTag(targetSpan.tag.id);
      } else {
        await deleteSpan(targetSpan.id);
      }
      setEditTarget(null);
    } catch (e: any) {
      setEditError(e.message || 'Could not remove tag');
    }
  };

  const rootRef = useRef<HTMLDivElement>(null);

  return (
    <div
      ref={rootRef}
      {...linkProps}
      style={{
        ...linkStyle,
        border: '1px solid var(--cline)',
        boxShadow: '0 16px 40px -22px rgba(7,27,56,0.35)',
      }}
      className="relative group rounded-md mb-2 bg-cream-hi transition-shadow hover:shadow-sky-hi"
    >
      {/* Header — clickable when linked: scrolls partner tree node into view */}
      <div
        className={`flex items-center justify-between px-3 py-1.5 ${
          linkedNode ? 'cursor-pointer hover:bg-cream' : ''
        }`}
        style={{ borderBottom: '1px solid var(--cline)' }}
        onClick={() => {
          if (!linkedNode) return;
          setFocused(linkKey);
          scrollToLinkPartner(linkKey, rootRef.current);
        }}
        title={linkedNode ? 'Click to find the linked tree node' : undefined}
      >
        <div className="flex items-center gap-2 min-w-0">
          {linkedNode && (
            sessionMode || consultMode ? (
              <span
                className="flex items-center gap-1 text-[10px] text-bronze px-1 py-0.5 truncate"
                title={`Linked to tree node "${linkedNode.title || `#${linkedNode.id}`}" (read-only in this mode)`}
              >
                <Link2 size={10} />
                tree: {linkedNode.title || `#${linkedNode.id}`}
              </span>
            ) : (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); handleUnlink(); }}
                className="flex items-center gap-1 text-[10px] text-ink-soft hover:text-vermilion-deep hover:bg-vermilion/10 rounded px-1 py-0.5 truncate"
                title={`Click to unlink this segment from tree node "${linkedNode.title || `#${linkedNode.id}`}"`}
              >
                <Link2 size={10} />
                tree: {linkedNode.title || `#${linkedNode.id}`}
              </button>
            )
          )}
          <span className="text-[10px] text-bronze font-mono">
            {segment.start}–{segment.end}
          </span>
        </div>
        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          {!sessionMode && !consultMode && !linkedNode && (
            <>
              <button
                onClick={(e) => { e.stopPropagation(); handlePromote(); }}
                className="text-[11px] px-2 py-0.5 text-bronze hover:text-vermilion hover:bg-cream rounded"
                title="Create a tree node linked to this segment"
              >
                <GitBranchPlus size={12} className="inline mr-1" />
                Promote
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); setLinkError(null); setLinkPickerOpen(true); }}
                className="text-[11px] px-2 py-0.5 text-bronze hover:text-lapis hover:bg-cream rounded"
                title="Link this segment to an existing free-form tree node"
              >
                <Link size={12} className="inline mr-1" />
                Link…
              </button>
            </>
          )}
        </div>
      </div>

      {/* Body */}
      <div className="p-3" onMouseUp={handleMouseUp}>
        {/* The textRef container wraps ONLY the text content (no UI) so selection offsets match. */}
        <div
          ref={textRef}
          className={`tibetan-text whitespace-pre-wrap break-words text-ink select-text ${pendingPassageSource ? 'cursor-crosshair' : 'cursor-text'}`}
          style={{ fontSize: `${taggerFontSize}rem` }}
          data-text-container
          data-segment-start={segment.start}
          data-segment-end={segment.end}
          data-segment-syl={segment.tokens[0]?.id ?? ''}
        >
          {fragments}
        </div>
      </div>

      {hoverPopover && (
        <HoverTagPopover tags={hoverPopover.tags} anchorRect={hoverPopover.anchorRect} />
      )}

      {selection && (
        <SegmentTagPopover
          segment={segment}
          selection={selection}
          trailingPassages={passagesByAnchor.atEnd}
          passageSplit={passageSplit}
          onClose={clearSelection}
        />
      )}

      {breakTarget && currentText && (
        <BreakPopover
          textId={currentText.id}
          target={breakTarget}
          onClose={() => setBreakTarget(null)}
        />
      )}

      {(editTarget || annPicker) && createPortal(
        (() => {
          const anchor = editTarget?.anchor ?? annPicker?.anchor;
          if (!anchor) return null;
          const PW = 240;
          const left = Math.max(8, Math.min(window.innerWidth - PW - 8, anchor.left));
          const top = anchor.bottom + 6;
          const close = () => { setEditTarget(null); setAnnPicker(null); setEditError(null); };
          const editTag = editTarget?.span.tag;
          return (
            <>
              <div className="fixed inset-0 z-40" onClick={close} />
              <div
                className="fixed z-50 bg-cream-hi shadow-xl rounded-lg p-2 flex flex-col"
                style={{ top, left, width: PW, border: '1px solid var(--cline)' }}
                onClick={(e) => e.stopPropagation()}
              >
                {editTarget && editTag ? (
                  <>
                    <div className="flex items-center justify-between px-1 mb-1">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span
                          className="inline-block w-2.5 h-2.5 rounded-full shrink-0"
                          style={{ backgroundColor: editTag.color }}
                        />
                        <span className="text-xs font-medium text-ink truncate" title={editTag.name}>
                          {editTag.name}
                        </span>
                      </div>
                      <button onClick={close} className="p-0.5 text-bronze hover:text-vermilion-deep shrink-0">
                        <X size={12} />
                      </button>
                    </div>

                    {editError && (
                      <p className="text-[11px] text-vermilion-deep mx-1 mb-1">{editError}</p>
                    )}

                    {/* Session pseudo-spans (negative id) can't change tag — they're tied to their session tag. Hide the change-to list. */}
                    {editTarget.span.id >= 0 && (
                      <>
                        <div className="text-[10px] font-medium text-bronze px-1 mt-1 mb-0.5 uppercase tracking-wider">
                          Change to
                        </div>
                        {tagChangeCandidates.length === 0 ? (
                          <p className="text-[11px] text-ink-soft italic px-1 py-1">
                            No other tags available.
                          </p>
                        ) : (
                          <ul className="flex flex-col gap-0.5 max-h-48 overflow-y-auto">
                            {tagChangeCandidates.map(t => (
                              <li key={t.id}>
                                <button
                                  onClick={() => handleChangeTag(editTarget.span.id, t.id)}
                                  className="w-full text-left text-xs px-2 py-1 rounded hover:bg-cream flex items-center gap-2"
                                >
                                  <span
                                    className="inline-block w-2.5 h-2.5 rounded-full shrink-0"
                                    style={{ backgroundColor: t.color }}
                                  />
                                  <span className="truncate">{t.name}</span>
                                </button>
                              </li>
                            ))}
                          </ul>
                        )}
                      </>
                    )}

                    <div className="my-1.5" style={{ borderTop: '1px solid var(--cline)' }} />
                    <button
                      onClick={() => handleRemoveTag(editTarget.span)}
                      className="w-full text-left text-xs px-2 py-1.5 rounded text-vermilion-deep hover:bg-vermilion/10 flex items-center gap-2"
                    >
                      <Trash2 size={12} /> Remove tag
                    </button>
                  </>
                ) : annPicker && (
                  <>
                    <div className="flex items-center justify-between px-1 mb-1">
                      <span className="text-xs font-medium text-ink">
                        Pick an annotation
                      </span>
                      <button onClick={close} className="p-0.5 text-bronze hover:text-vermilion-deep">
                        <X size={12} />
                      </button>
                    </div>
                    <ul className="flex flex-col gap-0.5 max-h-48 overflow-y-auto">
                      {annPicker.anns.map(a => (
                        <li key={`${a.id}-${a.start_offset}`}>
                          <button
                            onClick={() => {
                              setEditError(null);
                              setEditTarget({ span: a, anchor: annPicker.anchor });
                              setAnnPicker(null);
                            }}
                            className="w-full text-left text-xs px-2 py-1 rounded hover:bg-cream flex items-center gap-2"
                          >
                            <span
                              className="inline-block w-2.5 h-2.5 rounded-full shrink-0"
                              style={{ backgroundColor: a.tag.color }}
                            />
                            <span className="truncate">{a.tag.name}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </div>
            </>
          );
        })(),
        document.body,
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
              <h4 className="font-display text-base text-lapis">
                Link to free-form tree node
              </h4>
              <button onClick={() => setLinkPickerOpen(false)} className="p-1 text-bronze hover:text-vermilion-deep">
                <X size={14} />
              </button>
            </div>
            {linkError && (
              <p className="text-xs text-vermilion-deep mb-2 shrink-0">{linkError}</p>
            )}
            {linkCandidates.length === 0 ? (
              <p className="text-xs text-ink-soft italic">
                No free-form tree nodes available. Create one in the tree pane first.
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

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Copy, GripVertical, HelpCircle, Plus, Trash2 } from 'lucide-react';
import { Modal } from '../ui/Modal';
import { AutoGrowTextarea } from '../ui/AutoGrowTextarea';
import { usePhoneticSettingsStore, rulesFor } from '../../store/usePhoneticSettingsStore';
import {
  applyPhoneticRules, compileRule, emptyRule, mergeRules, type PhoneticRule,
} from './rules';

/**
 * The replacement table: what the bench does to every string it generates, made editable.
 *
 * One ordered list per (kind, language) — the order IS the behaviour, since each rule sees
 * what the ones above it produced, which is why the rows can be dragged. Saving writes the
 * whole list; existing lines keep the text they already have until "regenerate all".
 */

const KINDS: { id: 'bo' | 'skt'; label: string }[] = [
  { id: 'bo', label: 'Tibetan' },
  { id: 'skt', label: 'Sanskrit' },
];

export const RulesModal: React.FC<{
  kind: 'bo' | 'skt';
  lang: string;
  langs: readonly string[];
  langName: (l: string) => string;
  /** What to put in the try-it box. Set when the popup is opened from a LINE: the raw string
   *  the rules are handed for that line, so the box reproduces what generation did to it. */
  sample?: string;
  /** Called after a list is saved. Set when the popup was opened from a LINE: the bench
   *  re-applies the rules to that line, so the save shows where it was asked for. */
  onSaved?: () => void;
  onClose: () => void;
}> = ({ kind: kind0, lang: lang0, langs, langName, sample, onSaved, onClose }) => {
  const lists = usePhoneticSettingsStore(s => s.lists);
  const saveList = usePhoneticSettingsStore(s => s.saveList);

  const [kind, setKind] = useState<'bo' | 'skt'>(kind0);
  const [lang, setLang] = useState(lang0);
  const [draft, setDraft] = useState<PhoneticRule[]>(() => rulesFor(lists, kind0, lang0));
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const dragFrom = useRef<number | null>(null);
  // Copying to the other languages: which rows are picked, which languages they go to, and
  // what the last copy did.
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [targets, setTargets] = useState<Set<string>>(new Set());
  const [copyReport, setCopyReport] = useState<string | null>(null);
  // Shown after a save that re-applied the rules to the line the popup was opened from.
  const [applied, setApplied] = useState(false);

  // Switching list discards nothing silently: an edited list is saved on the way out.
  const stored = rulesFor(lists, kind, lang);
  useEffect(() => {
    setDraft(stored); setDirty(false); setSaveError(null);
    setPicked(new Set()); setTargets(new Set()); setCopyReport(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, lang]);

  /**
   * Copy the picked rules into other languages' lists of the SAME kind — English, German and
   * Portuguese want near-identical tables, and retyping them is how they drift apart.
   *
   * What is copied is what is ON SCREEN, so an edit made just before copying travels with it.
   * `mergeRules` appends and skips what the target already has; each target is one save.
   */
  const copyToTargets = async () => {
    const rules = [...picked].sort((a, b) => a - b)
      .map(i => draft[i]).filter((r): r is PhoneticRule => !!r && !!r.find);
    if (!rules.length || !targets.size) return;
    setSaving(true);
    try {
      const done: string[] = [];
      for (const to of targets) {
        const { rules: merged, added, skipped } = mergeRules(rulesFor(lists, kind, to), rules);
        if (added) await saveList(kind, to, merged);
        done.push(`${langName(to)} (${added ? `+${added}` : 'nothing new'}${
          skipped ? `, ${skipped} already there` : ''})`);
      }
      setCopyReport(`copied to ${done.join(', ')}`);
      setPicked(new Set());
      setTargets(new Set());
    } catch (e: any) {
      setCopyReport(e.message || 'Could not copy the rules');
    } finally {
      setSaving(false);
    }
  };

  const errors = useMemo(
    () => draft.map(r => { const c = compileRule(r); return 'error' in c ? c.error : null; }),
    [draft]);
  // An empty row is a row being written, not a broken one — only a bad REGEX blocks saving.
  const blocking = draft.map((r, i) => (r.find && r.regex ? errors[i] : null));
  const canSave = dirty && !blocking.some(Boolean) && !saving;

  const edit = (i: number, patch: Partial<PhoneticRule>) => {
    setDraft(d => d.map((r, j) => (j === i ? { ...r, ...patch } : r)));
    setDirty(true);
    setApplied(false);
  };
  const removeAt = (i: number) => { setDraft(d => d.filter((_, j) => j !== i)); setDirty(true); };
  const add = () => { setDraft(d => [...d, emptyRule()]); setDirty(true); };

  const dropOn = (to: number) => {
    const from = dragFrom.current;
    dragFrom.current = null;
    if (from == null || from === to) return;
    setDraft(d => {
      const next = [...d];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
    setDirty(true);
  };

  const save = async () => {
    setSaving(true);
    try {
      // Rows that say nothing are dropped rather than stored — an abandoned "add rule".
      await saveList(kind, lang, draft.filter(r => r.find));
      setDirty(false);
      setSaveError(null);
      onSaved?.();
      setApplied(true);
    } catch (e: any) {
      setSaveError(e.message || 'Could not save the rules');
    } finally {
      setSaving(false);
    }
  };

  const cell = 'px-1.5 py-1 rounded bg-white text-xs w-full';
  const cellStyle = { border: '1px solid var(--cline)' };

  return (
    // Esc (and the scrim) must dismiss the HELP first when it is open, or reading it would
    // throw away an unsaved table.
    <Modal title="Phonetics replacements"
           onClose={() => (helpOpen ? setHelpOpen(false) : onClose())} width={880}>
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-4 text-xs">
          <div className="flex items-center gap-1">
            {KINDS.map(k => (
              <button key={k.id} type="button" onClick={() => setKind(k.id)}
                className={`px-2.5 py-1 rounded-md font-medium transition-colors ${
                  kind === k.id ? 'bg-lapis text-cream-hi' : 'text-ink-soft hover:bg-cream'}`}
                style={kind === k.id ? undefined : cellStyle}>
                {k.label}
              </button>
            ))}
          </div>
          <label className="flex items-center gap-1.5">
            <span className="text-ink-soft">language</span>
            <select value={lang} onChange={e => setLang(e.target.value)}
                    className="px-2 py-1 rounded-md bg-white font-medium" style={cellStyle}>
              {langs.map(l => <option key={l} value={l}>{langName(l)}</option>)}
            </select>
          </label>
          <div className="flex-1" />
          <span className="text-ink-soft">
            applied top to bottom, to every line this bench generates
          </span>
          <button type="button" onClick={() => setHelpOpen(true)}
                  className="px-2 py-1 rounded-md flex items-center gap-1 text-lapis hover:bg-cream"
                  style={cellStyle} title="What the regex option does">
            <HelpCircle size={12} /> regex help
          </button>
        </div>

        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2 text-[10px] text-ink-soft px-1">
            <input type="checkbox" className="w-3 shrink-0" title="Select every rule"
                   checked={picked.size > 0 && picked.size === draft.filter(r => r.find).length}
                   onChange={e => setPicked(e.target.checked
                     ? new Set(draft.map((r, i) => (r.find ? i : -1)).filter(i => i >= 0))
                     : new Set())} />
            <span className="w-4 shrink-0" />
            <span className="flex-1">find</span>
            <span className="flex-1">replace with</span>
            <span className="w-28 shrink-0">kind</span>
            <span className="flex-1">note</span>
            <span className="w-5 shrink-0" />
          </div>

          {draft.map((r, i) => (
            <div
              key={i}
              className="flex items-start gap-2"
              onDragOver={e => { e.preventDefault(); }}
              onDrop={e => { e.preventDefault(); dropOn(i); }}
            >
              <input type="checkbox" className="w-3 shrink-0 mt-2" checked={picked.has(i)}
                     disabled={!r.find}
                     title="Pick this rule to copy to another language"
                     onChange={() => setPicked(prev => {
                       const next = new Set(prev);
                       next.has(i) ? next.delete(i) : next.add(i);
                       return next;
                     })} />
              <div
                draggable
                onDragStart={() => { dragFrom.current = i; }}
                onDragEnd={() => { dragFrom.current = null; }}
                title="Drag to change where this rule runs"
                className="w-4 shrink-0 pt-1.5 cursor-grab text-ink-soft hover:text-lapis"
              >
                <GripVertical size={12} />
              </div>
              <div className="flex-1 flex flex-col gap-0.5">
                <input value={r.find} onChange={e => edit(i, { find: e.target.value })}
                       className={`${cell} font-mono`}
                       style={{ ...cellStyle,
                                borderColor: blocking[i] ? 'var(--rust, #a33)' : 'var(--cline)' }} />
                {blocking[i] && (
                  <span className="text-[10px]" style={{ color: 'var(--rust, #a33)' }}>
                    {blocking[i]}
                  </span>
                )}
              </div>
              <input value={r.replace} onChange={e => edit(i, { replace: e.target.value })}
                     className={`${cell} flex-1 font-mono`} style={cellStyle} />
              <div className="w-28 shrink-0 flex items-center gap-2 text-[11px] pt-1">
                {([['string', false], ['regex', true]] as const).map(([label, isRe]) => (
                  <label key={label} className="flex items-center gap-1 cursor-pointer">
                    <input type="radio" name={`kind-${i}`} checked={r.regex === isRe}
                           onChange={() => edit(i, { regex: isRe })} />
                    {label}
                  </label>
                ))}
              </div>
              <input value={r.note} onChange={e => edit(i, { note: e.target.value })}
                     placeholder="why" className={`${cell} flex-1`} style={cellStyle} />
              <button type="button" onClick={() => removeAt(i)}
                      className="w-5 shrink-0 pt-1.5 text-ink-soft hover:text-red-700"
                      title="Remove this rule">
                <Trash2 size={12} />
              </button>
            </div>
          ))}

          {!draft.length && (
            <div className="text-xs text-ink-soft italic px-1 py-2">
              No replacements for {langName(lang)} {kind === 'bo' ? 'Tibetan' : 'Sanskrit'} yet.
            </div>
          )}

          <button type="button" onClick={add}
                  className="self-start mt-1 px-2 py-1 rounded-md flex items-center gap-1 text-xs text-lapis hover:bg-cream"
                  style={cellStyle}>
            <Plus size={12} /> add rule
          </button>
        </div>

        {/* Ticked rules travel to the other languages of the SAME kind — they arrive at the
            END of the target's table, the only placement that cannot change what its own
            rules already do. */}
        {picked.size > 0 && (
          <div className="flex items-center gap-2 flex-wrap text-xs rounded-md px-3 py-2 bg-cream">
            <Copy size={12} className="text-lapis" />
            <span>copy {picked.size} rule{picked.size === 1 ? '' : 's'} to</span>
            {langs.filter(l => l !== lang).map(l => {
              const on = targets.has(l);
              return (
                <button key={l} type="button"
                        onClick={() => setTargets(prev => {
                          const next = new Set(prev);
                          next.has(l) ? next.delete(l) : next.add(l);
                          return next;
                        })}
                        className={`px-2 py-0.5 rounded-full transition-colors ${
                          on ? 'bg-lapis text-cream-hi' : 'text-ink-soft hover:bg-white'}`}
                        style={on ? undefined : cellStyle}>
                  {langName(l)}
                </button>
              );
            })}
            <button type="button" onClick={() => void copyToTargets()}
                    disabled={!targets.size || saving}
                    className={`px-2 py-1 rounded-md font-semibold ${
                      targets.size && !saving ? 'bg-lapis text-cream-hi' : 'text-ink-soft'}`}
                    style={targets.size && !saving ? undefined : cellStyle}
                    title="Append these rules to the chosen languages, skipping any they already have">
              copy
            </button>
            <span className="text-ink-soft">
              they arrive at the end of that table — drag them where they belong
            </span>
          </div>
        )}
        {copyReport && <div className="text-[11px] text-lapis px-1">{copyReport}</div>}

        <Preview rules={draft} initial={sample} />

        {helpOpen && <RegexHelp onClose={() => setHelpOpen(false)} />}

        <div className="flex items-center gap-3 pt-1">
          <span className="text-[11px] text-ink-soft flex-1">
            {applied && onSaved
              ? <span className="text-lapis">saved, and re-applied to the line you came from —
                  the rest keep their text until <em>regenerate all</em>.</span>
              : <>Lines already written keep their text — use <em>regenerate all</em> to apply
                  these.</>}
          </span>
          {saveError && <span className="text-[11px] text-red-700">{saveError}</span>}
          <button type="button" onClick={onClose}
                  className="px-3 py-1.5 rounded-md text-xs" style={cellStyle}>
            Close
          </button>
          <button type="button" onClick={() => void save()} disabled={!canSave}
                  className={`px-3 py-1.5 rounded-md text-xs font-semibold ${
                    canSave ? 'bg-lapis text-cream-hi' : 'text-ink-soft'}`}
                  style={canSave ? undefined : cellStyle}>
            {saving ? 'saving…' : dirty ? 'Save' : 'Saved'}
          </button>
        </div>
      </div>
    </Modal>
  );
};

/**
 * What the `regex` option means, written around the rules this bench actually ships rather
 * than as a regular-expression manual. Every example below is either a default rule or a
 * mistake that is easy to make in this table.
 */
const RegexHelp: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const code = 'font-mono px-1 rounded bg-cream';
  const Row: React.FC<{ p: string; what: string; eg: React.ReactNode }> = ({ p, what, eg }) => (
    <tr>
      <td className="py-1 pr-3 align-top"><span className={code}>{p}</span></td>
      <td className="py-1 pr-3 align-top">{what}</td>
      <td className="py-1 align-top text-ink-soft">{eg}</td>
    </tr>
  );

  return (
    <Modal title="Using a regular expression" onClose={onClose} width={620}>
      <div className="flex flex-col gap-3 text-xs leading-relaxed">
        <p>
          With <strong>string</strong> selected, <em>find</em> means exactly the characters you
          typed — <span className={code}>(a)</span> finds those three characters, nothing else.
          With <strong>regex</strong> it becomes a <em>pattern</em>, so a few characters take on
          special meaning:
        </p>

        <table className="w-full">
          <tbody>
            <Row p="\b" what="a word edge — the start or end of a word"
                 eg={<><span className={code}>e\b</span> changes Peme → Pemé, but leaves the e in Pema alone</>} />
            <Row p="^  $" what="the start / the end of the whole line"
                 eg={<><span className={code}>^Om</span> only matches an Om that opens the line</>} />
            <Row p="." what="any single character"
                 eg={<><span className={code}>H.ng</span> matches Hung and Hang</>} />
            <Row p="[…]" what="any one of these characters"
                 eg={<><span className={code}>[aeiou]</span> matches a single vowel</>} />
            <Row p="?  +  *" what="the thing before it: optional / one or more / any number"
                 eg={<><span className={code}>ah+</span> matches ah, ahh, ahhh</>} />
            <Row p="|" what="either side"
                 eg={<><span className={code}>Om|Ah</span> matches whichever appears</>} />
            <Row p="(…)  $1" what="capture a piece, and put it back in the replacement"
                 eg={<>find <span className={code}>(H)ung</span>, replace <span className={code}>$1oung</span> → Houng</>} />
            <Row p="\" what="take the next character literally"
                 eg={<><span className={code}>\.</span> matches a full stop, not any character</>} />
          </tbody>
        </table>

        <div className="rounded-md px-3 py-2 bg-cream flex flex-col gap-1.5">
          <div><strong>Three things that catch people out here</strong></div>
          <div>
            <strong>Order is behaviour.</strong> Each rule sees what the ones above it produced.
            A rule <span className={code}>Hung → Houng</span> placed above{' '}
            <span className={code}>u → ou</span> gives <em>Hooung</em>, because the second rule
            then runs on the first one's output. That is why the word fixes sit at the bottom of
            the French list.
          </div>
          <div>
            <strong>Case matters.</strong> <span className={code}>u</span> does not match{' '}
            <span className={code}>U</span> — which is why the French rules list both.
          </div>
          <div>
            <strong>A rule matches inside words too.</strong>{' '}
            <span className={code}>Benza</span> also fires inside Benzasato; write{' '}
            <span className={code}>\bBenza\b</span> as a regex if you mean the word alone.
          </div>
        </div>

        <p className="text-ink-soft">
          A pattern that isn't valid is flagged under the field and simply skipped when
          generating — it can never break the bench. Use <em>try it</em> at the bottom of the
          table to see the whole list run on a line before you save.
        </p>

        <div className="rounded-md px-3 py-2 flex flex-col gap-1.5"
             style={{ border: '1px solid var(--cline)' }}>
          <div><strong>Which regex is this?</strong></div>
          <div>
            <strong>JavaScript (ECMAScript)</strong>, run in the browser. Any tutorial or
            reference for “JavaScript regular expressions” applies — MDN's is the canonical
            one. To experiment outside the app, <span className={code}>regex101.com</span> works
            if you set its flavour to <em>ECMAScript (JavaScript)</em>. The replacement side is
            JavaScript's <span className={code}>replace()</span> syntax:{' '}
            <span className={code}>$1</span> … <span className={code}>$9</span> for groups,{' '}
            <span className={code}>$&amp;</span> for the whole match,{' '}
            <span className={code}>$&lt;name&gt;</span> for a named group, and{' '}
            <span className={code}>$$</span> for a literal dollar.
          </div>
          <div>
            Every rule runs with the <em>global</em> flag and no others. So there is no
            case-insensitive option — <span className={code}>(?i)</span> is not valid
            JavaScript and the rule would be skipped — and{' '}
            <span className={code}>^</span>/<span className={code}>$</span> mean the start and
            end of the whole line.
          </div>
          <div>
            <strong>Accents are not letters</strong> to <span className={code}>\b</span> and{' '}
            <span className={code}>\w</span>, which are ASCII-only here: there is no word edge
            after the é in <em>gué</em>, so <span className={code}>gué\b</span> never matches,
            and <span className={code}>\w+</span> reads <em>Péma</em> as two pieces. Match the
            accented letters explicitly instead.
          </div>
        </div>

        <div className="flex justify-end">
          <button type="button" onClick={onClose}
                  className="px-3 py-1.5 rounded-md text-xs"
                  style={{ border: '1px solid var(--cline)' }}>
            Close
          </button>
        </div>
      </div>
    </Modal>
  );
};

/** Try the table on a string without touching any data — the fastest way to see what an
 *  order change actually does. */
const Preview: React.FC<{ rules: PhoneticRule[]; initial?: string }> = ({ rules, initial }) => {
  const [sample, setSample] = useState(initial || 'Om Benza Guru Pema Siddhi Hung');
  return (
    // A whole recited line goes in here, so both sides WRAP: the box grows to fit what is
    // typed (a one-line input clipped the end of the string it was meant to test) and the
    // result beside it has always wrapped.
    <div className="flex items-start gap-2 text-xs rounded-md px-2 py-1.5 bg-cream">
      <span className="text-ink-soft shrink-0 pt-1.5">try it</span>
      <AutoGrowTextarea value={sample} onChange={e => setSample(e.target.value)} rows={1}
                        className="px-1.5 py-1 rounded bg-white flex-1 font-mono text-xs resize-none overflow-hidden leading-relaxed"
                        style={{ border: '1px solid var(--cline)' }} />
      <span className="text-ink-soft shrink-0 pt-1.5">→</span>
      <span className="flex-1 font-mono pt-1.5 leading-relaxed whitespace-pre-wrap break-words">
        {applyPhoneticRules(sample, rules)}
      </span>
    </div>
  );
};

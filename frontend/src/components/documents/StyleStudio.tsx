import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  X, Upload, RotateCcw, FileDown, FileUp, Bold, Italic, Plus, Copy, Trash2,
} from 'lucide-react';
import {
  getOrgStyles, getDocStyles, getOrgFonts, putOrgStyle, deleteOrgStyle,
  putDocStyle, deleteDocStyle, uploadOrgFont, styleTemplateUrl, importStyleTemplate,
  getStyleSample, putStyleSample, type OrgFont,
} from '../../api/client';
import {
  ROLE_DEFS, BUNDLED_FONTS, resolveStyles, compileStyleCss,
  type StyleProps, type RoleDef, type StudioFormat,
} from './bookletStyles';
import '../../styles/booklet.css';

/**
 * Style Studio (Phase 4, replacing the drawer). An editable SPECIMEN — a page or two of
 * sample content covering every role — rendered with the live compiled styles, beside a
 * roles panel. Write your own text, apply the booklet's named styles (per-block role) and
 * inline bold/italic, and refine each style at the ORG or DOCUMENT level in one place —
 * no scrolling the 162-page booklet. Specimen content is saved per organization.
 */
type Scope = 'org' | 'doc';
type StyleMap = Record<string, StyleProps>;
interface Block { id: string; kind: string; parts: string[] }

/** Specimen block kinds — each mirrors a role's real booklet DOM so the styles apply. */
const KINDS: { kind: string; label: string; roles: string[]; parts: number }[] = [
  { kind: 'title', label: 'Title page', roles: ['title_tib', 'title_main', 'title_sub'], parts: 3 },
  { kind: 'section_1', label: 'Section title 1', roles: ['section_1'], parts: 1 },
  { kind: 'section_2', label: 'Section title 2', roles: ['section_2'], parts: 1 },
  { kind: 'section_3', label: 'Section title 3', roles: ['section_3'], parts: 1 },
  { kind: 'tibetan_title', label: 'Tibetan section title', roles: ['tibetan_title'], parts: 1 },
  { kind: 'tibetan_body', label: 'Tibetan body (verso)', roles: ['tibetan_body'], parts: 1 },
  { kind: 'tibetan_inline', label: 'Tibetan (above phonetics)', roles: ['tibetan_inline'], parts: 1 },
  { kind: 'tibetan_small', label: 'Tibetan small letters', roles: ['tibetan_small'], parts: 1 },
  { kind: 'pair', label: 'Phonetics + translation', roles: ['phonetics', 'translation'], parts: 2 },
  { kind: 'integrated', label: 'Tibetan + phonetics + translation', roles: ['tibetan_inline', 'phonetics', 'translation'], parts: 3 },
  { kind: 'mantra', label: 'Mantra', roles: ['mantra'], parts: 1 },
  { kind: 'small', label: 'Small letters / homage', roles: ['small'], parts: 1 },
  { kind: 'copyright', label: 'Copyright', roles: ['copyright'], parts: 1 },
  { kind: 'toc', label: 'Table-of-contents entry', roles: ['toc'], parts: 2 },
  { kind: 'folio', label: 'Page number (folio)', roles: ['folio'], parts: 1 },
  { kind: 'image_caption', label: 'Image caption', roles: ['image_caption'], parts: 1 },
];
const KIND = Object.fromEntries(KINDS.map(k => [k.kind, k]));

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()));

/** Selectable point sizes for the role size dropdown (an existing off-list value is
 *  preserved as its own option so imported/legacy sizes are never silently dropped). */
const SIZES = ['8pt', '9pt', '10pt', '11pt', '12pt', '13pt', '14pt', '16pt', '18pt',
  '20pt', '24pt', '28pt', '32pt', '36pt', '48pt'];

/** Selectable left-indents for the role indent dropdown (an off-list value is likewise
 *  preserved as its own option). */
const INDENTS = ['0', '2mm', '4mm', '6mm', '8mm', '10mm', '12mm', '15mm', '20mm', '25mm', '30mm'];

// The FULL content of the reference template.docx, mapped to specimen blocks so every
// style is exercised on real liturgical text (verso pairs and integrated Tibetan+phonetics
// +translation are grouped; standalone Tibetan/sections/mantra/small map one-to-one).
const DEFAULT_BLOCKS: Block[] = [
  { id: uid(), kind: "title", parts: ["༄༅། རང་བྱུང་པདྨའི་སྙིང་ཐིག་ལས། ཕྲིན་ལས་འབྲིང་པོ་དངོས་གྲུབ་ཀུན་འབྱུང་བཞུགས་སོ།།", "", ""] },
  { id: uid(), kind: "tibetan_inline", parts: ["ཧཱུྃ༔ ཨོ་རྒྱན་ཡུལ་གྱི་ནུབ་བྱང་མཚམས༔\nཔདྨ་གེ་སར་སྡོང་པོ་ལ༔\nཡ་མཚན་མཆོག་གི་དངོས་གྲུབ་བརྙེས༔\nཔདྨ་འབྱུང་གནས་ཞེས་སུ་གྲགས༔"] },
  { id: uid(), kind: "tibetan_inline", parts: ["\nའཁོར་དུ་མཁའ་འགྲོ་མང་པོས་བསྐོར༔\nཁྱེད་ཀྱི་རྗེས་སུ་བདག་སྒྲུབ་ཀྱིས༔\nབྱིན་གྱིས་བརླབ་ཕྱིར་གཤེགས་སུ་གསོལ༔"] },
  { id: uid(), kind: "tibetan_inline", parts: ["གུ་རུ་པདྨ་སིདྡྷི་ཧཱུྃ༔"] },
  { id: uid(), kind: "tibetan_inline", parts: ["ཨོཾ་ཨཱཿཧཱུྃ་བཛྲ་གུ་རུ་པདྨ་དྷེ་ཝ་དྷཱ་ཀི་ནི་དྷརྨ་པཱ་ལ་མཎྜ་ལ་ས་པ་རི་ཝཱ་ར་བཛྲ་ས་མ་ཛ་ཛཿ ཛཿཧཱུྃ་བཾ་ཧོཿ ཞེས་བརྗོད་པས་ཡེ་ཤེས་ཀྱི་འཁོར་ལོ་མདུན་དུ་བྱོན་པ་ལ།"] },
  { id: uid(), kind: "tibetan_title", parts: ["གསུམ་པ་ཡན་ལག་བརྒྱད་པ་ནི།"] },
  { id: uid(), kind: "tibetan_inline", parts: ["བླ་མ་རྩ་གསུམ་ལྷ་ཚོགས་ལ༔\nསྒོ་གསུམ་གུས་པས་ཕྱག་འཚལ་ལོ༔\nཀུན་བཟང་སྒྱུ་འཕྲུལ་དྲྭ་བས་མཆོད༔\nསྡིག་ལྟུང་ཉེས་པར་བྱས་ཀུན་བཤགས༔\nརྣམ་གྲོལ་དགེ་ལ་རྗེས་ཡི་རང༔\nཟབ་རྒྱས་ཆོས་འཁོར་བསྐོར་བར་བསྐུལ༔\nམྱ་ངན་མི་འདའ་བཞུགས་གསོལ་འདེབས༔\nདགེ་ཚོགས་བྱང་ཆུབ་ཆེན་པོར་བསྔོ༔\nཀུན་ཀྱང་བླ་མའི་གནས་ཐོབ་ཤོག༔ །ལན་གསུམ།"] },
  { id: uid(), kind: "tibetan_title", parts: ["བཞི་པ་བཀའ་བསྒོ་བ་ནི།"] },
  { id: uid(), kind: "tibetan_inline", parts: ["ཧྲཱིཿ ང་ནི་དབང་ཆེན་ཧེ་རུ་ཀ༔\nའཁོར་འདས་ཡོངས་ཀྱི་སྤྱི་དཔལ་ཡིན༔\nཉོན་ཅིག་བགེགས་དང་ལོག་འདྲེན་ཚོགས༔\nཆོས་ཉིད་སྐྱེ་མེད་དབྱིངས་སུ་སོང༔"] },
  { id: uid(), kind: "tibetan_inline", parts: ["ཧཱུྃ་བཞིའི་སྔགས་བརྗོད།"] },
  { id: uid(), kind: "tibetan_title", parts: ["ལྔ་པ་སྲུང་འཁོར་ནི།"] },
  { id: uid(), kind: "tibetan_inline", parts: ["ཧྲཱིཿ དཔལ་གྱི་ཐུགས་ལས་ཡེ་ཤེས་འོད༔\nམཚོན་ཆ་རྣམ་ལྔའི་སྤྲིན་དུ་སྤྲོས༔\nཕྱོགས་མཚམས་སྟེང་འོག་སྲུང་བའི་གུར༔\nགཞོམ་གཞིག་བྲལ་བར་ལྷུན་གྱིས་གྲུབ༔"] },
  { id: uid(), kind: "tibetan_inline", parts: ["ཛྙཱ་ན་བཛྲ་རཀྵ་བྷྲཱུྃ༔"] },
  { id: uid(), kind: "section_1", parts: ["Concluding Activities.\nThe Preliminary. One, refuge:"] },
  { id: uid(), kind: "pair", parts: ["namo lama sangye rinpoche", "5Namo To the Lama, precious Buddha,"] },
  { id: uid(), kind: "pair", parts: ["kyabné gyatsö yeshe ku", "Wisdom kaya of myriad refuges,"] },
  { id: uid(), kind: "pair", parts: ["khyen tsé nü pé daknyi la", "The very embodiment of knowledge, love, and capability,"] },
  { id: uid(), kind: "pair", parts: ["miché depé kyab su chi", "With unshakable faith, I go for refuge. X3"] },
  { id: uid(), kind: "small", parts: ["Le refuge, qui commence la préparation."] },
  { id: uid(), kind: "integrated", parts: ["ན་མོ༔ བླ་མ་སངས་རྒྱས་རིན་པོ་ཆེ༔", "namo lama sangyé rinpoché", "Namo ! Lama, précieux Bouddha,"] },
  { id: uid(), kind: "integrated", parts: ["སྐྱབས་གནས་རྒྱ་མཚོའི་ཡེ་ཤེས་སྐུ༔", "kyabné gyatsö yéshé kou", "Corps de sagesse de l’océan des objets de refuge,"] },
  { id: uid(), kind: "mantra", parts: ["Om Ah Hung Vajra Guru Padma Thotrengsal Vajra Samaya Dza Siddhi Phala Hung Ah"] },
  { id: uid(), kind: "integrated", parts: ["མཁྱེན་བརྩེ་ནུས་པའི་བདག་ཉིད་ལ༔", "k'yen tsé nu pé daknyi la", "Personnification de la connaissance, de l'amour et des capacités,"] },
  { id: uid(), kind: "integrated", parts: ["མི་ཕྱེད་དད་པས་སྐྱབས་སུ་མཆི༔", "miché dépé kyab sou chi", "Avec une foi inébranlable, je prends refuge.   X3"] },
];

/** An uncontrolled editable region — innerHTML is set once so the caret never jumps. */
const Editable: React.FC<{ className: string; html: string; onChange: (h: string) => void }> =
  ({ className, html, onChange }) => {
    const ref = useRef<HTMLDivElement>(null);
    useEffect(() => { if (ref.current) ref.current.innerHTML = html; /* once */ }, []); // eslint-disable-line
    return <div ref={ref} className={`${className} bk-editable`} contentEditable suppressContentEditableWarning
                onInput={() => onChange(ref.current!.innerHTML)} />;
  };

export const StyleStudio: React.FC<{ documentId: number; onClose: () => void }> = ({ documentId, onClose }) => {
  const [scope, setScope] = useState<Scope>('doc');
  const [layout, setLayout] = useState<StudioFormat>('twopage');
  const [org, setOrg] = useState<StyleMap>({});
  const [doc, setDoc] = useState<StyleMap>({});
  const [fonts, setFonts] = useState<OrgFont[]>([]);
  const [fam, setFam] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [blocks, setBlocks] = useState<Block[]>(DEFAULT_BLOCKS);
  const [activeRoles, setActiveRoles] = useState<string[]>([]);
  const saveTimer = useRef<number>(0);

  useEffect(() => {
    void Promise.all([getOrgStyles(), getDocStyles(documentId), getOrgFonts(), getStyleSample()])
      .then(([o, d, f, s]) => {
        setOrg(o as StyleMap); setDoc(d as StyleMap); setFonts(f);
        try {
          const parsed = JSON.parse(s.content || '[]');
          if (Array.isArray(parsed) && parsed.length) setBlocks(parsed);
        } catch { /* keep default */ }
      }).catch(() => {});
  }, [documentId]);

  const styleCss = useMemo(() => compileStyleCss(resolveStyles(org, doc), fonts), [org, doc, fonts]);
  const scopeMap = scope === 'org' ? org : doc;
  const setScopeMap = scope === 'org' ? setOrg : setDoc;
  const fontOptions = useMemo(
    () => [...BUNDLED_FONTS, ...fonts.map(f => f.family)].filter((v, i, a) => a.indexOf(v) === i), [fonts]);

  // ── specimen persistence (debounced) ──
  const saveBlocks = (next: Block[]) => {
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => void putStyleSample(JSON.stringify(next)).catch(() => {}), 600);
  };
  const editPart = (id: string, i: number, html: string) => {
    // mutate in place (Editable is uncontrolled) and persist — no re-render needed.
    const b = blocks.find(x => x.id === id); if (!b) return;
    b.parts[i] = html; saveBlocks(blocks);
  };
  const mutate = (next: Block[]) => { setBlocks(next); saveBlocks(next); };
  // Replace the (persisted) specimen with the built-in template content — fresh ids +
  // copied parts so the module-level DEFAULT_BLOCKS are never mutated in place.
  const resetSpecimen = () =>
    mutate(DEFAULT_BLOCKS.map(b => ({ id: uid(), kind: b.kind, parts: [...b.parts] })));
  const retag = (id: string, kind: string) => mutate(blocks.map(b =>
    b.id === id ? { ...b, kind, parts: Array.from({ length: KIND[kind].parts }, (_, i) => b.parts[i] ?? 'Sample text') } : b));
  const addAfter = (id: string) => {
    const i = blocks.findIndex(b => b.id === id);
    const n: Block = { id: uid(), kind: 'pair', parts: ['sample phonetics', 'sample translation'] };
    mutate([...blocks.slice(0, i + 1), n, ...blocks.slice(i + 1)]);
  };
  const duplicate = (id: string) => {
    const i = blocks.findIndex(b => b.id === id);
    mutate([...blocks.slice(0, i + 1), { ...blocks[i], id: uid(), parts: [...blocks[i].parts] }, ...blocks.slice(i + 1)]);
  };
  const remove = (id: string) => mutate(blocks.filter(b => b.id !== id));

  // ── role styling ──
  const own = (role: string): StyleProps => scopeMap[role] ?? {};
  const setProp = async (role: string, key: keyof StyleProps, value: unknown) => {
    const next: StyleProps = { ...own(role) };
    if (value === '' || value == null) delete next[key]; else (next as any)[key] = value;
    setScopeMap(m => ({ ...m, [role]: next }));
    try {
      if (Object.keys(next).length === 0) scope === 'org' ? await deleteOrgStyle(role) : await deleteDocStyle(documentId, role);
      else scope === 'org' ? await putOrgStyle(role, next as any) : await putDocStyle(documentId, role, next as any);
    } catch { /* ignore */ }
  };
  const resetRole = async (role: string) => {
    setScopeMap(m => { const n = { ...m }; delete n[role]; return n; });
    try { scope === 'org' ? await deleteOrgStyle(role) : await deleteDocStyle(documentId, role); } catch { /* ignore */ }
  };

  const doUpload = async (file?: File) => {
    if (!file || !fam.trim()) return;
    setBusy(true);
    try { await uploadOrgFont(file, fam.trim()); setFonts(await getOrgFonts()); setFam(''); }
    catch { /* ignore */ } finally { setBusy(false); }
  };
  const scopeTarget = scope === 'org' ? 'org' : 'document';
  const doImport = async (file?: File) => {
    if (!file) return;
    setBusy(true); setMsg('Importing…');
    try {
      const r = await importStyleTemplate(file, scopeTarget, scope === 'doc' ? documentId : undefined);
      const [o, d] = await Promise.all([getOrgStyles(), getDocStyles(documentId)]);
      setOrg(o as StyleMap); setDoc(d as StyleMap);
      setMsg(`Imported ${r.count} roles: ${r.applied.join(', ')}`);
    } catch (e) { setMsg(`Import failed: ${(e as Error).message}`.slice(0, 140)); }
    finally { setBusy(false); }
  };
  const fmt = (cmd: 'bold' | 'italic') => document.execCommand(cmd);

  const border = { border: '1px solid var(--cline)' } as const;
  const sel = "px-1 py-0.5 rounded bg-white text-xs";

  const renderBlock = (b: Block) => {
    const E = (i: number, cls: string) =>
      <Editable key={i} className={cls} html={b.parts[i] ?? ''} onChange={h => editPart(b.id, i, h)} />;
    switch (b.kind) {
      case 'title': return <div className="bk-titlepage"><div className="bk-seal">ༀ</div>{E(0, 'bk-tibetan bk-title-tib')}{E(1, 'bk-title-main')}{E(2, 'bk-title-sub')}</div>;
      case 'section_1': return <div className="bk-line">{E(0, 'bk-section bk-section-l1')}</div>;
      case 'section_2': return <div className="bk-line">{E(0, 'bk-section bk-section-l2')}</div>;
      case 'section_3': return <div className="bk-line">{E(0, 'bk-section bk-section-l3')}</div>;
      case 'tibetan_title': return <div className="bk-line bk-role-title">{E(0, 'bk-tibetan')}</div>;
      case 'tibetan_body': return <div className="bk-line">{E(0, 'bk-tibetan')}</div>;
      case 'tibetan_inline': return <div className="bk-line">{E(0, 'bk-tibetan-inline')}</div>;
      case 'tibetan_small': return <div className="bk-line">{E(0, 'bk-tibetan-small')}</div>;
      case 'pair': return <div className="bk-line bk-pair">{E(0, 'bk-phonetics')}{E(1, 'bk-translation')}</div>;
      case 'integrated': return <div className="bk-line bk-integrated">{E(0, 'bk-tibetan-inline')}{E(1, 'bk-phonetics')}{E(2, 'bk-translation')}</div>;
      case 'mantra': return <div className="bk-line bk-role-mantra">{E(0, 'bk-phonetics')}</div>;
      case 'small': return <div className="bk-line bk-role-small">{E(0, 'bk-translation')}</div>;
      case 'copyright': return E(0, 'bk-copyright');
      case 'toc': return <div className="bk-toc"><div className="bk-toc-entry">{E(0, 'bk-toc-title')}<span className="bk-toc-dots" />{E(1, 'bk-toc-page')}</div></div>;
      case 'folio': return <div className="bk-foliobox">{E(0, 'booklet-folio')}</div>;
      case 'image_caption': return E(0, 'bk-image-caption');
      default: return null;
    }
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-cream-hi">
      <div className="px-4 py-2 flex items-center gap-3 text-xs shrink-0" style={{ borderBottom: '1px solid var(--cline)' }}>
        <span className="font-display text-base text-lapis">Style studio</span>
        <div className="flex rounded-md overflow-hidden" style={border}>
          <button type="button" onClick={() => setScope('org')} className={`px-2 py-0.5 ${scope === 'org' ? 'bg-lapis text-cream-hi' : 'text-ink-soft'}`}>Organization</button>
          <button type="button" onClick={() => setScope('doc')} className={`px-2 py-0.5 ${scope === 'doc' ? 'bg-lapis text-cream-hi' : 'text-ink-soft'}`}>This document</button>
        </div>
        <span className="text-ink-soft">
          {scope === 'org' ? 'editing the org-wide template' : 'editing this booklet’s overrides'}
        </span>
        {/* format — which layout's roles the panel groups by */}
        <div className="flex rounded-md overflow-hidden" style={border} title="Group the styles by booklet layout">
          <button type="button" onClick={() => setLayout('twopage')} className={`px-2 py-0.5 ${layout === 'twopage' ? 'bg-lapis text-cream-hi' : 'text-ink-soft'}`}>Two-page</button>
          <button type="button" onClick={() => setLayout('running')} className={`px-2 py-0.5 ${layout === 'running' ? 'bg-lapis text-cream-hi' : 'text-ink-soft'}`}>Running</button>
        </div>
        {/* inline formatting */}
        <div className="flex items-center gap-1" onMouseDown={e => e.preventDefault()}>
          <button type="button" onClick={() => fmt('bold')} className="p-1 rounded hover:bg-cream" style={border} title="Bold selection"><Bold size={13} /></button>
          <button type="button" onClick={() => fmt('italic')} className="p-1 rounded hover:bg-cream" style={border} title="Italic selection"><Italic size={13} /></button>
        </div>
        <div className="flex-1" />
        <button type="button" onClick={resetSpecimen} className="px-2 py-1 rounded-md hover:bg-cream" style={border}
                title="Replace the specimen with the built-in template content (from template.docx)">Reset content</button>
        <button type="button" onClick={onClose} className="px-2 py-1 rounded-md flex items-center gap-1 hover:bg-cream" style={border}><X size={13} /> done</button>
      </div>

      <div className="flex-1 flex overflow-hidden">
        {/* Specimen */}
        <div className="flex-1 overflow-auto p-6" style={{ background: 'var(--cream)' }}>
          <div className="booklet-root style-specimen mx-auto bg-white" style={{ maxWidth: '148mm', padding: '12mm 16mm' }}>
            <style dangerouslySetInnerHTML={{ __html: styleCss }} />
            {blocks.map(b => (
              <div key={`${b.id}:${b.kind}`} className="specimen-block"
                   onFocusCapture={() => setActiveRoles(KIND[b.kind].roles)}>
                <div className="specimen-gutter" contentEditable={false}>
                  <select value={b.kind} onChange={e => retag(b.id, e.target.value)} className={sel} style={border} title="Style for this block">
                    {KINDS.map(k => <option key={k.kind} value={k.kind}>{k.label}</option>)}
                  </select>
                  <button type="button" onClick={() => addAfter(b.id)} title="Add block below"><Plus size={12} /></button>
                  <button type="button" onClick={() => duplicate(b.id)} title="Duplicate"><Copy size={12} /></button>
                  <button type="button" onClick={() => remove(b.id)} title="Remove"><Trash2 size={12} /></button>
                </div>
                <div className="specimen-body">{renderBlock(b)}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Roles + template panel */}
        <div className="w-96 shrink-0 flex flex-col overflow-hidden" style={{ borderLeft: '1px solid var(--cline)' }}>
          <div className="px-3 py-2 flex flex-col gap-1.5 text-xs shrink-0" style={{ borderBottom: '1px solid var(--cline)' }}>
            <div className="flex items-center gap-2">
              <a href={styleTemplateUrl(scopeTarget, scope === 'doc' ? documentId : undefined)}
                 className="px-2 py-1 rounded-md inline-flex items-center gap-1 text-lapis hover:bg-cream" style={border}>
                <FileDown size={12} /> template
              </a>
              <label className={`px-2 py-1 rounded-md inline-flex items-center gap-1 cursor-pointer text-lapis hover:bg-cream ${busy ? 'opacity-40 pointer-events-none' : ''}`} style={border}>
                <FileUp size={12} /> import docx
                <input type="file" accept=".docx" className="hidden" onChange={e => { void doImport(e.target.files?.[0]); e.currentTarget.value = ''; }} />
              </label>
            </div>
            <div className="flex items-center gap-2">
              <input value={fam} onChange={e => setFam(e.target.value)} placeholder="New font family name…" className="flex-1 px-2 py-1 rounded bg-white" style={border} />
              <label className={`px-2 py-1 rounded-md inline-flex items-center gap-1 cursor-pointer text-lapis hover:bg-cream ${(!fam.trim() || busy) ? 'opacity-40 pointer-events-none' : ''}`} style={border}>
                <Upload size={12} /> font
                <input type="file" accept=".ttf,.otf,.woff,.woff2" className="hidden" onChange={e => { void doUpload(e.target.files?.[0]); e.currentTarget.value = ''; }} />
              </label>
            </div>
            {msg && <div className="text-[10px] text-ink-soft">{msg}</div>}
          </div>

          <div className="flex-1 overflow-auto px-3 py-2 flex flex-col gap-3">
            {(() => {
              // Group the selected format's roles by their header, preserving ROLE_DEFS order.
              const groups: { header: string; roles: RoleDef[] }[] = [];
              for (const rd of ROLE_DEFS) {
                const header = rd.place[layout];
                if (!header) continue;
                let g = groups.find(x => x.header === header);
                if (!g) { g = { header, roles: [] }; groups.push(g); }
                g.roles.push(rd);
              }
              const card = (rd: RoleDef) => {
              const p = own(rd.role);
              const dirty = Object.keys(p).length > 0;
              const active = activeRoles.includes(rd.role);
              return (
                <div key={rd.role} className="rounded-md bg-white p-2"
                     style={{ border: active ? '1px solid var(--lapis, #2f6f9f)' : '1px solid var(--cline)' }}>
                  <div className="flex items-center gap-1 mb-1">
                    <span className={`text-xs flex-1 ${dirty ? 'text-lapis font-medium' : 'text-ink'}`}>{rd.label}</span>
                    {dirty && <button type="button" onClick={() => void resetRole(rd.role)} className="p-0.5 text-ink-soft hover:text-vermilion" title="Reset (inherit)"><RotateCcw size={12} /></button>}
                  </div>
                  <div className="grid grid-cols-2 gap-1">
                    <select className={sel} style={border} value={p.fontFamily ?? ''} onChange={e => void setProp(rd.role, 'fontFamily', e.target.value)}>
                      <option value="">font: inherit</option>
                      {fontOptions.map(f => <option key={f} value={f}>{f}</option>)}
                    </select>
                    <select className={sel} style={border} value={p.fontSize ?? ''} onChange={e => void setProp(rd.role, 'fontSize', e.target.value)}>
                      <option value="">size: inherit</option>
                      {p.fontSize && !SIZES.includes(p.fontSize) && <option value={p.fontSize}>{p.fontSize}</option>}
                      {SIZES.map(s => <option key={s} value={s}>{s}</option>)}
                    </select>
                    <select className={sel} style={border} value={p.fontWeight ?? ''} onChange={e => void setProp(rd.role, 'fontWeight', e.target.value ? Number(e.target.value) : '')}>
                      <option value="">weight: inherit</option>
                      {[300, 400, 500, 600, 700, 800].map(w => <option key={w} value={w}>{w}</option>)}
                    </select>
                    <select className={sel} style={border} value={p.italic == null ? '' : (p.italic ? 'italic' : 'upright')} onChange={e => void setProp(rd.role, 'italic', e.target.value === '' ? '' : e.target.value === 'italic')}>
                      <option value="">style: inherit</option><option value="italic">italic</option><option value="upright">upright</option>
                    </select>
                    <select className={sel} style={border} value={p.align ?? ''} onChange={e => void setProp(rd.role, 'align', e.target.value)}>
                      <option value="">align: inherit</option>
                      {['left', 'center', 'right', 'justify'].map(a => <option key={a} value={a}>{a}</option>)}
                    </select>
                    <input className={sel} style={border} value={p.color ?? ''} placeholder="colour (#hex)" onChange={e => void setProp(rd.role, 'color', e.target.value)} />
                    <select className={sel} style={border} value={p.indent ?? ''} onChange={e => void setProp(rd.role, 'indent', e.target.value)}>
                      <option value="">indent: inherit</option>
                      {p.indent && !INDENTS.includes(p.indent) && <option value={p.indent}>{p.indent}</option>}
                      {INDENTS.map(i => <option key={i} value={i}>{i}</option>)}
                    </select>
                  </div>
                </div>
              );
              };
              return groups.map(g => (
                <div key={g.header} className="flex flex-col gap-2">
                  <div className="text-[10px] uppercase tracking-wide text-ink-soft font-medium px-0.5">{g.header}</div>
                  {g.roles.map(card)}
                </div>
              ));
            })()}
          </div>
        </div>
      </div>
    </div>
  );
};

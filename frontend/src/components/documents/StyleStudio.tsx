import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  X, Upload, RotateCcw, FileDown, FileUp, Bold, Italic, Plus, Copy, Trash2,
  Image as ImageIcon,
} from 'lucide-react';
import {
  getOrgStyles, getDocStyles, getOrgFonts, putOrgStyle, deleteOrgStyle,
  putDocStyle, deleteDocStyle, uploadOrgFont, styleTemplateUrl, importStyleTemplate,
  getStyleSample, putStyleSample, getOrgSeal, uploadOrgSeal, deleteOrgSeal, setOrgSealSize,
  orgSealUrl, getDocumentLayout, type OrgFont, type OrgSeal, type LayoutConfig,
} from '../../api/client';
import {
  ROLE_DEFS, BUNDLED_FONTS, resolveStyles, compileStyleCss,
  type StyleProps, type RoleDef, type StudioFormat,
} from './bookletStyles';
import { MM_PX, rootVars } from './bookletRender';
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

/** The specimen carries CONTENT, never typography: the roles own font/size/weight, so the
 *  specimen previews them faithfully. contentEditable, left alone, disagrees — it freezes the
 *  computed font into an inline `<span style="font-size: …">` when a block is edited, and an
 *  inline style beats every role rule, so that line stops responding to its style forever.
 *  Keep the marks the studio's own B/I buttons produce (and line breaks), drop everything else
 *  — every attribute included. */
const KEEP: Record<string, string> = { STRONG: 'strong', B: 'strong', EM: 'em', I: 'em' };

export function cleanSpecimenHtml(html: string): string {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  const walk = (node: Node): Node[] => {
    const out: Node[] = [];
    node.childNodes.forEach(child => {
      if (child.nodeType === Node.TEXT_NODE) { out.push(doc.importNode(child, false)); return; }
      if (child.nodeType !== Node.ELEMENT_NODE) return;
      const el = child as HTMLElement;
      if (el.tagName === 'BR') { out.push(doc.createElement('br')); return; }
      const inner = walk(el);
      const keep = KEEP[el.tagName];
      if (keep) {
        const wrap = doc.createElement(keep);          // re-created: no attributes survive
        inner.forEach(n => wrap.appendChild(n));
        out.push(wrap);
      } else {
        out.push(...inner);                            // unwrap (div/span/font/…)
      }
    });
    return out;
  };
  const host = doc.createElement('div');
  walk(doc.body).forEach(n => host.appendChild(n));
  return host.innerHTML;
}

/** Strip the attributes contentEditable just added, IN PLACE — removing an attribute leaves the
 *  nodes (and so the caret) alone, whereas re-writing innerHTML would jump it. The stored copy is
 *  sanitized properly (spans unwrapped) by `cleanSpecimenHtml`; this only stops the freeze from
 *  showing in the live specimen. */
function stripAttrs(root: HTMLElement): void {
  root.querySelectorAll('*').forEach(el => {
    for (const a of [...el.attributes]) el.removeAttribute(a.name);
  });
}

/** An uncontrolled editable region — innerHTML is set once so the caret never jumps. */
const Editable: React.FC<{ className: string; html: string; onChange: (h: string) => void }> =
  ({ className, html, onChange }) => {
    const ref = useRef<HTMLDivElement>(null);
    useEffect(() => { if (ref.current) ref.current.innerHTML = html; /* once */ }, []); // eslint-disable-line
    return <div ref={ref} className={`${className} bk-editable`} contentEditable suppressContentEditableWarning
                onInput={() => { stripAttrs(ref.current!); onChange(cleanSpecimenHtml(ref.current!.innerHTML)); }} />;
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
  const [seal, setSeal] = useState<OrgSeal | null>(null);
  const [sealBust, setSealBust] = useState(0);   // cache-buster for the seal preview
  // The booklet's page geometry — the specimen is laid out on it, so what you style here is
  // measured by the page it prints on.
  const [config, setConfig] = useState<LayoutConfig | null>(null);
  const [pageCount, setPageCount] = useState(1);
  const specimenRef = useRef<HTMLDivElement>(null);
  const saveTimer = useRef<number>(0);

  useEffect(() => { void getOrgSeal().then(setSeal).catch(() => {}); }, []);

  useEffect(() => {
    void getDocumentLayout(documentId).then(l => setConfig(l.config)).catch(() => {});
  }, [documentId]);

  // How many page frames the guides need. The specimen grows as you type — and `Editable` is
  // uncontrolled, so typing does not re-render — hence a ResizeObserver rather than a render count.
  useEffect(() => {
    const el = specimenRef.current;
    if (!el || !config) return;
    const pageH = config.page_height_mm * MM_PX;
    const recount = () => setPageCount(Math.max(1, Math.ceil(el.scrollHeight / pageH)));
    recount();
    const ro = new ResizeObserver(recount);
    ro.observe(el);
    return () => ro.disconnect();
  }, [config, blocks]);

  useEffect(() => {
    void Promise.all([getOrgStyles(), getDocStyles(documentId), getOrgFonts(), getStyleSample()])
      .then(([o, d, f, s]) => {
        setOrg(o as StyleMap); setDoc(d as StyleMap); setFonts(f);
        try {
          const parsed = JSON.parse(s.content || '[]');
          if (!Array.isArray(parsed) || !parsed.length) return;
          // Sanitize what an earlier session stored: any inline typography frozen in by
          // contentEditable would outrank the roles the specimen exists to preview. Rewrite
          // the sample once so it stays clean.
          const clean: Block[] = parsed.map((b: Block) => ({ ...b, parts: b.parts.map(cleanSpecimenHtml) }));
          setBlocks(clean);
          if (JSON.stringify(clean) !== JSON.stringify(parsed)) {
            void putStyleSample(JSON.stringify(clean)).catch(() => {});
          }
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
  // ── the org's cover seal: the image that prints where the ༀ ornament sits ──
  const doSeal = async (file?: File) => {
    if (!file) return;
    setBusy(true);
    try { setSeal(await uploadOrgSeal(file)); setSealBust(n => n + 1); }
    catch (e) { setMsg(`Seal upload failed: ${(e as Error).message}`.slice(0, 140)); }
    finally { setBusy(false); }
  };
  const dropSeal = async () => {
    setBusy(true);
    try { await deleteOrgSeal(); setSeal({ has_image: false, width_mm: null, height_mm: null }); }
    catch { /* ignore */ } finally { setBusy(false); }
  };
  const sizeSeal = (w: number | null, h: number | null) => {
    setSeal(s => (s ? { ...s, width_mm: w, height_mm: h } : s));
    void setOrgSealSize(w, h).catch(() => {});
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
  const miniBtn = "px-1.5 py-0.5 rounded-md text-xs hover:bg-cream inline-flex items-center gap-1 disabled:opacity-40";

  /** The cover ornament — the org's seal image if one is uploaded, else the ༀ glyph. It sits at
   *  the top of the title page and prints on EVERY booklet's cover; a booklet can still override
   *  it with its own cover image (Documents tab). The loader lives right here, in its place. */
  const sealSlot = () => {
    const sized = seal?.width_mm != null || seal?.height_mm != null;
    return (
      <div className="specimen-seal">
        {seal?.has_image ? (
          <img className={`bk-image${sized ? '' : ' bk-image-nat'}`}
               src={`${orgSealUrl()}&v=${sealBust}`} alt=""
               style={{ width: seal.width_mm ? `${seal.width_mm}mm` : undefined,
                        height: seal.height_mm ? `${seal.height_mm}mm` : undefined }} />
        ) : (
          <div className="bk-seal">ༀ</div>
        )}
        <div className="specimen-seal-tools" contentEditable={false}>
          <label className={`${miniBtn} text-lapis cursor-pointer`} style={border}>
            <ImageIcon size={11} /> {seal?.has_image ? 'replace' : 'seal image'}
            <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" className="hidden"
                   disabled={busy}
                   onChange={e => { void doSeal(e.target.files?.[0]); e.target.value = ''; }} />
          </label>
          {seal?.has_image && (
            <>
              <span className="text-[10px] text-ink-soft" title="Print size in mm; leave height blank to keep the aspect ratio">size</span>
              <input type="number" min={0} step={1} defaultValue={seal.width_mm ?? ''} placeholder="w"
                     className="w-11 px-1 py-0.5 rounded bg-white text-xs" style={border}
                     onChange={e => sizeSeal(e.target.value === '' ? null : Number(e.target.value), seal.height_mm ?? null)} />
              <span className="text-[10px] text-ink-soft">×</span>
              <input type="number" min={0} step={1} defaultValue={seal.height_mm ?? ''} placeholder="h"
                     className="w-11 px-1 py-0.5 rounded bg-white text-xs" style={border}
                     onChange={e => sizeSeal(seal.width_mm ?? null, e.target.value === '' ? null : Number(e.target.value))} />
              <button type="button" onClick={() => void dropSeal()} disabled={busy}
                      className={`${miniBtn} text-vermilion`} style={border} title="Remove the seal — the ༀ glyph returns">
                <Trash2 size={11} />
              </button>
            </>
          )}
        </div>
      </div>
    );
  };

  const renderBlock = (b: Block) => {
    const E = (i: number, cls: string) =>
      <Editable key={i} className={cls} html={b.parts[i] ?? ''} onChange={h => editPart(b.id, i, h)} />;
    switch (b.kind) {
      case 'title': return <div className="bk-titlepage">{sealSlot()}{E(0, 'bk-tibetan bk-title-tib')}{E(1, 'bk-title-main')}{E(2, 'bk-title-sub')}</div>;
      case 'section_1': return <div className="bk-line">{E(0, 'bk-section bk-section-l1')}</div>;
      case 'section_2': return <div className="bk-line">{E(0, 'bk-section bk-section-l2')}</div>;
      case 'section_3': return <div className="bk-line">{E(0, 'bk-section bk-section-l3')}</div>;
      case 'tibetan_title': return <div className="bk-line bk-role-title">{E(0, 'bk-tibetan')}</div>;
      case 'tibetan_body': return <div className="bk-line">{E(0, 'bk-tibetan')}</div>;
      case 'tibetan_inline': return <div className="bk-line">{E(0, 'bk-tibetan-inline')}</div>;
      // The booklet's own markup for a small-letters Tibetan line (bookletRender emits
      // `.bk-tibetan` under `.bk-role-small`), so the specimen previews what prints.
      case 'tibetan_small': return <div className="bk-line bk-role-small">{E(0, 'bk-tibetan')}</div>;
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
          {/* The booklet's REAL geometry (layout_config): page width, and the margins of a recto
              page (spine on the left). The specimen flows past one page, so the guides are drawn
              by page-tall frames laid behind the content — see `.specimen-page`. */}
          <div ref={specimenRef}
               className="booklet-root style-specimen bk-guides mx-auto bg-white"
               style={{ ...(config ? rootVars(config) : {}),
                        width: 'var(--page-w)',
                        padding: 'var(--m-top) var(--m-outer) var(--m-bottom) var(--m-bind)' }}>
            <div className="specimen-pages" aria-hidden="true">
              {Array.from({ length: pageCount }, (_, i) => (
                <div key={i} className="specimen-page" style={{ top: `calc(${i} * var(--page-h))` }}>
                  <span className="specimen-folio" />
                </div>
              ))}
            </div>
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

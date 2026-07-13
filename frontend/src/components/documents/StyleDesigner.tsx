import React, { useEffect, useMemo, useState } from 'react';
import { X, Upload, RotateCcw } from 'lucide-react';
import {
  getOrgStyles, getDocStyles, getOrgFonts, putOrgStyle, deleteOrgStyle,
  putDocStyle, deleteDocStyle, uploadOrgFont, type OrgFont,
} from '../../api/client';
import { ROLE_DEFS, BUNDLED_FONTS, type StyleProps } from './bookletStyles';

type Scope = 'org' | 'doc';
type StyleMap = Record<string, StyleProps>;

/**
 * Style designer (Phase 4 D). Edit each booklet role's typography at the ORGANIZATION
 * level (templates, shared by every document) or as a per-DOCUMENT override. A blank
 * field inherits (default ← org ← document). Every change saves immediately and calls
 * `onChange` so the bench re-injects the compiled CSS — a live preview.
 */
export const StyleDesigner: React.FC<{
  documentId: number; onChange: () => void; onClose: () => void;
}> = ({ documentId, onChange, onClose }) => {
  const [scope, setScope] = useState<Scope>('doc');
  const [org, setOrg] = useState<StyleMap>({});
  const [doc, setDoc] = useState<StyleMap>({});
  const [fonts, setFonts] = useState<OrgFont[]>([]);
  const [fam, setFam] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void Promise.all([getOrgStyles(), getDocStyles(documentId), getOrgFonts()])
      .then(([o, d, f]) => { setOrg(o as StyleMap); setDoc(d as StyleMap); setFonts(f); })
      .catch(() => {});
  }, [documentId]);

  const scopeMap = scope === 'org' ? org : doc;
  const setScopeMap = scope === 'org' ? setOrg : setDoc;
  const fontOptions = useMemo(
    () => [...BUNDLED_FONTS, ...fonts.map(f => f.family)].filter((v, i, a) => a.indexOf(v) === i),
    [fonts]);

  const own = (role: string): StyleProps => scopeMap[role] ?? {};

  const setProp = async (role: string, key: keyof StyleProps, value: unknown) => {
    const next: StyleProps = { ...own(role) };
    if (value === '' || value == null) delete next[key];
    else (next as any)[key] = value;
    setScopeMap(m => ({ ...m, [role]: next }));
    try {
      if (Object.keys(next).length === 0) {
        scope === 'org' ? await deleteOrgStyle(role) : await deleteDocStyle(documentId, role);
      } else {
        scope === 'org'
          ? await putOrgStyle(role, next as Record<string, unknown>)
          : await putDocStyle(documentId, role, next as Record<string, unknown>);
      }
      onChange();
    } catch { /* ignore */ }
  };

  const resetRole = async (role: string) => {
    setScopeMap(m => { const n = { ...m }; delete n[role]; return n; });
    try {
      scope === 'org' ? await deleteOrgStyle(role) : await deleteDocStyle(documentId, role);
      onChange();
    } catch { /* ignore */ }
  };

  const doUpload = async (file: File | undefined) => {
    if (!file || !fam.trim()) return;
    setBusy(true);
    try {
      await uploadOrgFont(file, fam.trim());
      setFonts(await getOrgFonts());
      setFam('');
      onChange();
    } catch { /* ignore */ }
    finally { setBusy(false); }
  };

  const sel = "px-1 py-0.5 rounded bg-white text-xs";
  const border = { border: '1px solid var(--cline)' } as const;

  return (
    <div className="w-96 shrink-0 flex flex-col bg-cream-hi overflow-hidden"
         style={{ borderLeft: '1px solid var(--cline)' }}>
      <div className="px-3 py-2 flex items-center gap-2 text-xs" style={{ borderBottom: '1px solid var(--cline)' }}>
        <span className="font-display text-sm text-lapis flex-1">Booklet styles</span>
        <div className="flex rounded-md overflow-hidden" style={border}>
          <button type="button" onClick={() => setScope('org')}
                  className={`px-2 py-0.5 ${scope === 'org' ? 'bg-lapis text-cream-hi' : 'text-ink-soft'}`}>Org</button>
          <button type="button" onClick={() => setScope('doc')}
                  className={`px-2 py-0.5 ${scope === 'doc' ? 'bg-lapis text-cream-hi' : 'text-ink-soft'}`}>Document</button>
        </div>
        <button type="button" onClick={onClose} className="p-1 text-ink-soft hover:text-lapis"><X size={14} /></button>
      </div>

      <div className="px-3 py-2 text-[11px] text-ink-soft" style={{ borderBottom: '1px solid var(--cline)' }}>
        {scope === 'org'
          ? 'Organization template — applies to every booklet unless a document overrides it.'
          : 'Per-document override — wins over the organization template. Blank = inherit.'}
      </div>

      {/* Font upload */}
      <div className="px-3 py-2 flex items-center gap-2 text-xs" style={{ borderBottom: '1px solid var(--cline)' }}>
        <input value={fam} onChange={e => setFam(e.target.value)} placeholder="New font family name…"
               className="flex-1 px-2 py-1 rounded bg-white" style={border} />
        <label className={`px-2 py-1 rounded-md inline-flex items-center gap-1 cursor-pointer text-lapis hover:bg-cream ${(!fam.trim() || busy) ? 'opacity-40 pointer-events-none' : ''}`} style={border}>
          <Upload size={12} /> font
          <input type="file" accept=".ttf,.otf,.woff,.woff2,font/ttf,font/otf,font/woff,font/woff2"
                 className="hidden" onChange={e => { void doUpload(e.target.files?.[0]); e.target.value = ''; }} />
        </label>
      </div>

      {/* Roles */}
      <div className="flex-1 overflow-auto px-3 py-2 flex flex-col gap-2">
        {ROLE_DEFS.map(rd => {
          const p = own(rd.role);
          const dirty = Object.keys(p).length > 0;
          return (
            <div key={rd.role} className="rounded-md bg-white p-2" style={border}>
              <div className="flex items-center gap-1 mb-1">
                <span className={`text-xs flex-1 ${dirty ? 'text-lapis font-medium' : 'text-ink'}`}>{rd.label}</span>
                {dirty && (
                  <button type="button" onClick={() => void resetRole(rd.role)}
                          className="p-0.5 text-ink-soft hover:text-vermilion" title="Reset (inherit)">
                    <RotateCcw size={12} />
                  </button>
                )}
              </div>
              <div className="grid grid-cols-2 gap-1">
                <select className={sel} style={border} value={p.fontFamily ?? ''}
                        onChange={e => void setProp(rd.role, 'fontFamily', e.target.value)}>
                  <option value="">font: inherit</option>
                  {fontOptions.map(f => <option key={f} value={f}>{f}</option>)}
                </select>
                <input className={sel} style={border} value={p.fontSize ?? ''} placeholder="size (e.g. 12pt)"
                       onChange={e => void setProp(rd.role, 'fontSize', e.target.value)} />
                <select className={sel} style={border} value={p.fontWeight ?? ''}
                        onChange={e => void setProp(rd.role, 'fontWeight', e.target.value ? Number(e.target.value) : '')}>
                  <option value="">weight: inherit</option>
                  {[300, 400, 500, 600, 700, 800].map(w => <option key={w} value={w}>{w}</option>)}
                </select>
                <select className={sel} style={border}
                        value={p.italic == null ? '' : (p.italic ? 'italic' : 'upright')}
                        onChange={e => void setProp(rd.role, 'italic', e.target.value === '' ? '' : e.target.value === 'italic')}>
                  <option value="">style: inherit</option>
                  <option value="italic">italic</option>
                  <option value="upright">upright</option>
                </select>
                <select className={sel} style={border} value={p.align ?? ''}
                        onChange={e => void setProp(rd.role, 'align', e.target.value)}>
                  <option value="">align: inherit</option>
                  {['left', 'center', 'right', 'justify'].map(a => <option key={a} value={a}>{a}</option>)}
                </select>
                <input className={sel} style={border} value={p.color ?? ''} placeholder="colour (#hex)"
                       onChange={e => void setProp(rd.role, 'color', e.target.value)} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

import React, { useEffect, useState } from 'react';
import { Image as ImageIcon, Trash2 } from 'lucide-react';
import {
  getOrgImages, uploadOrgImage, patchOrgImage, deleteOrgImage, orgImageUrl, withUrlAuth,
  type OrgImage,
} from '../../api/client';
import { detail } from './MembersPanel';

/**
 * THE ORG'S IMAGE LIBRARY — the seals, logos and marks the whole house prints.
 *
 * A house keeps several, and any cover or back cover picks the one it wants (in the Documents
 * tab, on the page itself). What is set here is the library, and which image stands in for a
 * page that picks nothing — one per role, which is how the single org seal behaved before
 * there was a choice to make.
 *
 * These are INHERITED, not copied: replacing an image here changes every booklet that prints
 * it, at once. That is the opposite of the copyright template alongside, and deliberately — a
 * house mark is the same mark everywhere, while a copyright names a translator.
 */
const ROLES: { role: 'cover' | 'backcover'; label: string }[] = [
  { role: 'cover', label: 'covers' },
  { role: 'backcover', label: 'back covers' },
];

export const ImagesPanel: React.FC = () => {
  const [images, setImages] = useState<OrgImage[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [bust, setBust] = useState(0);       // cache-buster for the previews
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    void getOrgImages()
      .then(l => { if (alive) { setImages(l); setLoaded(true); } })
      .catch(e => { if (alive) { setError(detail(e)); setLoaded(true); } });
    return () => { alive = false; };
  }, []);

  const add = async (file?: File) => {
    if (!file) return;
    setBusy(true); setError('');
    // Named from the file to begin with — a library of "Image", "Image", "Image" is no
    // library at all, and the field beside it is there to correct the guess.
    try { await uploadOrgImage(file, file.name.replace(/\.[^.]+$/, '')); setImages(await getOrgImages()); }
    catch (e) { setError(detail(e)); }
    finally { setBusy(false); }
  };

  const patch = async (id: number, body: Parameters<typeof patchOrgImage>[1]) => {
    setError('');
    try {
      const row = await patchOrgImage(id, body);
      // A claimed role is taken off whoever held it, so the whole list is re-read rather than
      // the one row patched in place — otherwise two images would both show as the default.
      setImages(body.default_for !== undefined
        ? await getOrgImages()
        : images.map(i => (i.id === id ? row : i)));
      if (body.set_size) setBust(n => n + 1);
    } catch (e) { setError(detail(e)); }
  };

  const drop = async (img: OrgImage) => {
    if (!confirm(`Delete “${img.name}”? Any page that prints it falls back to the default.`)) return;
    setBusy(true); setError('');
    try { await deleteOrgImage(img.id); setImages(await getOrgImages()); }
    catch (e) { setError(detail(e)); }
    finally { setBusy(false); }
  };

  return (
    <div className="max-w-3xl">
      <h2 className="font-display text-lg mb-1">Cover &amp; back cover images</h2>
      <p className="text-xs text-ink-soft mb-4">
        The seals, logos and marks this organization prints. Any cover or back cover picks one
        of these — on the page itself, in the Documents tab. Mark one for <em>covers</em> and
        one for <em>back covers</em> to say what a page that picks nothing gets; a booklet that
        uploads its own image still overrides both. Sizes are in millimetres; leave one blank to
        keep the picture’s own proportions.
      </p>
      {error && <div className="text-sm text-red-700 mb-3">{error}</div>}
      <label className={`px-3 py-1.5 mb-3 rounded-md text-sm inline-flex items-center gap-1.5 cursor-pointer hover:bg-black/5 ${busy ? 'opacity-40 pointer-events-none' : ''}`}
             style={{ boxShadow: 'inset 0 0 0 1px var(--gline-soft)' }}>
        <ImageIcon size={14} /> Add an image
        <input type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
               className="hidden" disabled={busy}
               onChange={e => { void add(e.target.files?.[0]); e.currentTarget.value = ''; }} />
      </label>
      {loaded && images.length === 0 && (
        <div className="text-sm text-ink-soft">
          No images yet. The first one you add becomes the default for covers.
        </div>
      )}
      <div className="flex flex-col gap-3">
        {images.map(img => (
          <div key={img.id} className="px-4 py-3 rounded-lg bg-white flex gap-4"
               style={{ boxShadow: '0 0 0 1px var(--gline-soft)' }}>
            <img src={withUrlAuth(`${orgImageUrl(img.id)}?v=${bust}`)} alt=""
                 className="h-24 w-24 object-contain shrink-0 rounded"
                 style={{ boxShadow: 'inset 0 0 0 1px var(--gline-soft)' }} />
            <div className="flex-1 min-w-0 flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <input defaultValue={img.name} placeholder="Name this image"
                       className="flex-1 px-2 py-1 rounded text-sm"
                       style={{ boxShadow: 'inset 0 0 0 1px var(--gline-soft)' }}
                       onBlur={e => {
                         if (e.target.value.trim() !== img.name) {
                           void patch(img.id, { name: e.target.value });
                         }
                       }} />
                <button type="button" onClick={() => void drop(img)} disabled={busy}
                        className="p-1 rounded opacity-50 hover:opacity-100 hover:text-red-700 disabled:opacity-30"
                        title="Delete this image">
                  <Trash2 size={14} />
                </button>
              </div>
              <div className="flex items-center gap-3 flex-wrap text-[11px]">
                <span className="text-ink-soft">stands in for</span>
                {ROLES.map(r => {
                  const on = img.default_for === r.role;
                  return (
                    <button key={r.role} type="button"
                            onClick={() => void patch(img.id, { default_for: on ? '' : r.role })}
                            className={`px-2 py-0.5 rounded-full transition-colors ${
                              on ? 'text-sky-deep font-semibold' : 'text-ink-soft hover:bg-black/5'}`}
                            style={on ? {
                              background: 'linear-gradient(180deg, var(--gold-soft), var(--gold))',
                              boxShadow: '0 0 0 1px var(--gline)',
                            } : { boxShadow: 'inset 0 0 0 1px var(--gline-soft)' }}
                            title={on ? `Stop standing in for ${r.label}`
                                      : `Print this on every ${r.label.replace(/s$/, '')} that picks nothing`}>
                      {r.label}
                    </button>
                  );
                })}
                <span className="inline-flex items-center gap-1 text-ink-soft ml-auto">
                  <span>size</span>
                  <input type="number" min={0} step={1} placeholder="w"
                         defaultValue={img.width_mm ?? ''} className="w-14 px-1 py-0.5 rounded"
                         style={{ boxShadow: 'inset 0 0 0 1px var(--gline-soft)' }}
                         onBlur={e => void patch(img.id, {
                           width_mm: e.target.value === '' ? null : Number(e.target.value),
                           height_mm: img.height_mm, set_size: true })} />
                  <span>×</span>
                  <input type="number" min={0} step={1} placeholder="h"
                         defaultValue={img.height_mm ?? ''} className="w-14 px-1 py-0.5 rounded"
                         style={{ boxShadow: 'inset 0 0 0 1px var(--gline-soft)' }}
                         onBlur={e => void patch(img.id, {
                           width_mm: img.width_mm,
                           height_mm: e.target.value === '' ? null : Number(e.target.value),
                           set_size: true })} />
                  <span>mm</span>
                </span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

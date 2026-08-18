import React, { useEffect, useState } from 'react';
import { Image as ImageIcon, Trash2, Check } from 'lucide-react';
import {
  getOrgImages, uploadOrgImage, patchOrgImage, deleteOrgImage, orgImageUrl, withUrlAuth,
  type OrgImage,
} from '../../api/client';
import { detail } from './MembersPanel';

/**
 * THE ORG'S TWO IMAGE LISTS — its cover seals, and its back-cover images.
 *
 * Kept apart on purpose: a cover page is offered cover seals and nothing else, so the lists a
 * house builds are the lists it will be choosing from. Both are shown even when empty, because
 * an empty list is a place to put something rather than a thing to hide.
 *
 * These are INHERITED, not copied: replacing an image here changes every booklet that prints
 * it, at once. That is the opposite of the copyright template alongside, and deliberately — a
 * house mark is the same mark everywhere, while a copyright names a translator.
 */
const LISTS: { kind: 'cover' | 'backcover'; title: string; note: string }[] = [
  { kind: 'cover', title: 'Cover seals',
    note: 'Offered on every booklet’s cover page. The one marked ✓ prints where the ༀ ornament '
        + 'sits on any cover that chooses none; with no ✓ at all, the ༀ glyph shows.' },
  { kind: 'backcover', title: 'Back-cover images',
    note: 'Offered on every booklet’s back cover. The one marked ✓ prints on any back cover '
        + 'that chooses none; with no ✓ at all, the page carries no image.' },
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

  const add = async (kind: 'cover' | 'backcover', file?: File) => {
    if (!file) return;
    setBusy(true); setError('');
    // Named from the file to begin with — a list of "Image", "Image", "Image" is no list at
    // all, and the field beside it is there to correct the guess.
    try {
      await uploadOrgImage(file, file.name.replace(/\.[^.]+$/, ''), kind);
      setImages(await getOrgImages());
    } catch (e) { setError(detail(e)); }
    finally { setBusy(false); }
  };

  const patch = async (id: number, body: Parameters<typeof patchOrgImage>[1]) => {
    setError('');
    try {
      const row = await patchOrgImage(id, body);
      // Claiming the ✓ takes it off whoever held it, so the list is re-read rather than the
      // one row patched in place — otherwise two images would both show as the stand-in.
      setImages(body.is_default !== undefined
        ? await getOrgImages()
        : images.map(i => (i.id === id ? row : i)));
      if (body.set_size) setBust(n => n + 1);
    } catch (e) { setError(detail(e)); }
  };

  const drop = async (img: OrgImage) => {
    if (!confirm(`Delete “${img.name}”? Any page that prints it falls back to this list’s ✓.`)) return;
    setBusy(true); setError('');
    try { await deleteOrgImage(img.id); setImages(await getOrgImages()); }
    catch (e) { setError(detail(e)); }
    finally { setBusy(false); }
  };

  return (
    <div className="max-w-3xl">
      <h2 className="font-display text-lg mb-1">Cover &amp; back cover images</h2>
      <p className="text-xs text-ink-soft mb-5">
        Two lists the whole organization prints from. A booklet’s cover chooses from the seals
        and its back cover from the back-cover images — on the page itself, in the Documents
        tab. Sizes are in millimetres; leave one blank to keep the picture’s own proportions.
      </p>
      {error && <div className="text-sm text-red-700 mb-3">{error}</div>}
      {LISTS.map(list => {
        const rows = images.filter(i => i.kind === list.kind);
        return (
          <section key={list.kind} className="mb-7">
            <div className="flex items-center gap-3 mb-1">
              <h3 className="font-display text-base">{list.title}</h3>
              <span className="text-[11px] text-ink-soft">{rows.length || 'none'}</span>
              <div className="flex-1" />
              <label className={`px-2 py-1 rounded-md text-xs inline-flex items-center gap-1.5 cursor-pointer hover:bg-black/5 ${busy ? 'opacity-40 pointer-events-none' : ''}`}
                     style={{ boxShadow: 'inset 0 0 0 1px var(--gline-soft)' }}>
                <ImageIcon size={13} /> Add
                <input type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
                       className="hidden" disabled={busy}
                       onChange={e => { void add(list.kind, e.target.files?.[0]); e.currentTarget.value = ''; }} />
              </label>
            </div>
            <p className="text-[11px] text-ink-soft mb-2">{list.note}</p>
            {loaded && rows.length === 0 && (
              <div className="px-4 py-3 rounded-lg text-xs text-ink-soft"
                   style={{ boxShadow: 'inset 0 0 0 1px var(--gline-soft)' }}>
                Nothing here yet. The first image you add becomes this list’s ✓.
              </div>
            )}
            <div className="flex flex-col gap-3">
              {rows.map(img => (
                <div key={img.id} className="px-4 py-3 rounded-lg bg-white flex gap-4"
                     style={{ boxShadow: '0 0 0 1px var(--gline-soft)' }}>
                  <img src={withUrlAuth(`${orgImageUrl(img.id)}?v=${bust}`)} alt=""
                       className="h-20 w-20 object-contain shrink-0 rounded"
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
                      <button type="button"
                              onClick={() => void patch(img.id, { is_default: !img.is_default })}
                              className={`px-2 py-0.5 rounded-full inline-flex items-center gap-1 transition-colors ${
                                img.is_default ? 'text-sky-deep font-semibold' : 'text-ink-soft hover:bg-black/5'}`}
                              style={img.is_default ? {
                                background: 'linear-gradient(180deg, var(--gold-soft), var(--gold))',
                                boxShadow: '0 0 0 1px var(--gline)',
                              } : { boxShadow: 'inset 0 0 0 1px var(--gline-soft)' }}
                              title={img.is_default
                                ? 'Stop standing in for pages that choose none'
                                : 'Print this on every page of this kind that chooses none'}>
                        <Check size={11} /> {img.is_default ? 'the default' : 'make default'}
                      </button>
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
          </section>
        );
      })}
    </div>
  );
};

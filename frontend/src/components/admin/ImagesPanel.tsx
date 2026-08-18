import React, { useEffect, useState } from 'react';
import { Image as ImageIcon, Trash2 } from 'lucide-react';
import {
  getOrgSeal, uploadOrgSeal, deleteOrgSeal, setOrgSealSize, orgSealUrl, withUrlAuth,
  type OrgSeal, type SealSlot,
} from '../../api/client';
import { detail } from './MembersPanel';

/**
 * THE ORG'S FURNITURE IMAGES — the cover ornament and the back-cover mark.
 *
 * These are INHERITED, not copied: they print on every booklet that has not uploaded one of
 * its own, so replacing one here changes every booklet at once. That is the opposite of the
 * copyright template alongside, and deliberately — a house mark is the same mark everywhere,
 * while a copyright names a translator.
 */
const SLOTS: { slot: SealSlot; label: string; note: string }[] = [
  { slot: 'cover', label: 'Cover seal',
    note: 'Prints where the ༀ ornament sits on every booklet’s cover. A booklet that uploads '
        + 'its own cover image overrides it; with neither, the ༀ glyph shows.' },
  { slot: 'backcover', label: 'Back-cover image',
    note: 'The same arrangement on the back cover, which has no ornament to fall back to: a '
        + 'booklet with its own image overrides it, and with neither the page carries none.' },
];

export const ImagesPanel: React.FC = () => (
  <div className="max-w-3xl">
    <h2 className="font-display text-lg mb-1">Cover &amp; back cover</h2>
    <p className="text-xs text-ink-soft mb-4">
      The images every booklet in this organization prints unless it carries one of its own.
      Sizes are in millimetres; leave one blank to keep the picture’s own proportions.
    </p>
    <div className="flex flex-col gap-3">
      {SLOTS.map(s => <SlotCard key={s.slot} {...s} />)}
    </div>
  </div>
);

const SlotCard: React.FC<{ slot: SealSlot; label: string; note: string }> = ({ slot, label, note }) => {
  const [seal, setSeal] = useState<OrgSeal | null>(null);
  const [bust, setBust] = useState(0);          // cache-buster for the preview
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    void getOrgSeal(slot).then(s => { if (alive) setSeal(s); }).catch(() => {});
    return () => { alive = false; };
  }, [slot]);

  const upload = async (file?: File) => {
    if (!file) return;
    setBusy(true); setError('');
    try { setSeal(await uploadOrgSeal(file, slot)); setBust(n => n + 1); }
    catch (e) { setError(detail(e)); }
    finally { setBusy(false); }
  };
  const drop = async () => {
    setBusy(true); setError('');
    try { await deleteOrgSeal(slot); setSeal({ has_image: false, width_mm: null, height_mm: null }); }
    catch (e) { setError(detail(e)); }
    finally { setBusy(false); }
  };
  // Optimistic: the size is a display property, so the field must not wait on the round trip
  // to show what it will print at.
  const resize = (w: number | null, h: number | null) => {
    setSeal(s => (s ? { ...s, width_mm: w, height_mm: h } : s));
    void setOrgSealSize(w, h, slot).catch(e => setError(detail(e)));
  };

  const num = (v: string) => (v === '' ? null : Number(v));

  return (
    <div className="px-4 py-3 rounded-lg bg-white flex gap-4"
         style={{ boxShadow: '0 0 0 1px var(--gline-soft)' }}>
      {seal?.has_image ? (
        <img src={withUrlAuth(`${orgSealUrl(slot)}&v=${bust}`)} alt=""
             className="h-24 w-24 object-contain shrink-0 rounded"
             style={{ boxShadow: 'inset 0 0 0 1px var(--gline-soft)' }} />
      ) : (
        <div className="h-24 w-24 shrink-0 rounded flex items-center justify-center text-[11px] text-ink-soft"
             style={{ boxShadow: 'inset 0 0 0 1px var(--gline-soft)' }}>no image</div>
      )}
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium">{label}</div>
        <div className="text-xs text-ink-soft mt-0.5 mb-2">{note}</div>
        {error && <div className="text-xs text-red-700 mb-2">{error}</div>}
        <div className="flex items-center gap-2 flex-wrap">
          <label className={`px-2 py-1 rounded-md text-xs inline-flex items-center gap-1 cursor-pointer hover:bg-black/5 ${busy ? 'opacity-40 pointer-events-none' : ''}`}
                 style={{ boxShadow: 'inset 0 0 0 1px var(--gline-soft)' }}>
            <ImageIcon size={12} /> {seal?.has_image ? 'Replace' : 'Upload'}
            <input type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
                   className="hidden" disabled={busy}
                   onChange={e => { void upload(e.target.files?.[0]); e.currentTarget.value = ''; }} />
          </label>
          {seal?.has_image && (<>
            <button type="button" onClick={() => void drop()} disabled={busy}
                    className="px-2 py-1 rounded-md text-xs inline-flex items-center gap-1 hover:bg-black/5 hover:text-red-700 disabled:opacity-40"
                    style={{ boxShadow: 'inset 0 0 0 1px var(--gline-soft)' }}>
              <Trash2 size={12} /> Remove
            </button>
            <span className="inline-flex items-center gap-1 text-[11px] text-ink-soft ml-1">
              <span>size</span>
              <input type="number" min={0} step={1} placeholder="w"
                     defaultValue={seal.width_mm ?? ''} className="w-14 px-1 py-0.5 rounded"
                     style={{ boxShadow: 'inset 0 0 0 1px var(--gline-soft)' }}
                     onBlur={e => resize(num(e.target.value), seal.height_mm)} />
              <span>×</span>
              <input type="number" min={0} step={1} placeholder="h"
                     defaultValue={seal.height_mm ?? ''} className="w-14 px-1 py-0.5 rounded"
                     style={{ boxShadow: 'inset 0 0 0 1px var(--gline-soft)' }}
                     onBlur={e => resize(seal.width_mm, num(e.target.value))} />
              <span>mm</span>
            </span>
          </>)}
        </div>
      </div>
    </div>
  );
};

import React from 'react';
import { createPortal } from 'react-dom';
import type { Tag } from '../../store/useTagStore';

interface Props {
  tags: Tag[];
  anchorRect: DOMRect;
}

/**
 * Read-only popover that lists every tag applying at the hovered fragment.
 * Anchored just below the fragment's bounding rect, clipped to viewport.
 */
export const HoverTagPopover: React.FC<Props> = ({ tags, anchorRect }) => {
  if (tags.length === 0) return null;
  const PW = 220;
  const left = Math.max(8, Math.min(window.innerWidth - PW - 8, anchorRect.left));
  const top = anchorRect.bottom + 6;
  return createPortal(
    <div
      className="fixed z-50 shadow-lg rounded-md p-1.5 pointer-events-none text-mist-100"
      style={{
        top, left, width: PW,
        background: 'linear-gradient(180deg, var(--sky-deep), var(--sky-night))',
        border: '1px solid var(--gline-soft)',
      }}
    >
      <ul className="flex flex-col gap-0.5">
        {tags.map(t => (
          <li key={t.id} className="flex items-center gap-1.5 text-xs px-1.5 py-0.5">
            <span
              className="inline-block w-2.5 h-2.5 rounded-full shrink-0"
              style={{ backgroundColor: t.color, boxShadow: '0 0 0 1px var(--gline-soft)' }}
            />
            <span className="truncate">{t.name}</span>
            {t.tag_kind === 'session' && (
              <span className="ml-auto text-[9px] uppercase tracking-wider text-gold-soft shrink-0">session</span>
            )}
          </li>
        ))}
      </ul>
    </div>,
    document.body,
  );
};

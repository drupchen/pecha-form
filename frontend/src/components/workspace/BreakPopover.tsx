import React from 'react';
import { createPortal } from 'react-dom';
import { useDisplayBreakStore } from '../../store/useDisplayBreakStore';

/** What a clicked ↵ break icon points at: the anchor token, the AUTOMATIC count the
 *  rules give that position (to decide "no break" = clear vs explicit 0), and the
 *  currently effective count (to mark the active option). */
export interface BreakTarget {
  sylId: string;
  auto: 0 | 1;
  count: number;
  anchor: DOMRect;
}

/** Mini popover for one break position: 1 line / empty line / no break. "No break"
 *  on a pure-manual position (auto 0) deletes the override row; on an automatic
 *  position it writes an explicit 0 so the auto break stays suppressed. */
export const BreakPopover: React.FC<{
  textId: number;
  target: BreakTarget;
  onClose: () => void;
}> = ({ textId, target, onClose }) => {
  const setBreak = useDisplayBreakStore(s => s.setBreak);
  const clearBreak = useDisplayBreakStore(s => s.clearBreak);

  const choose = async (count: 0 | 1 | 2) => {
    if (count === 0 && target.auto === 0) await clearBreak(textId, target.sylId);
    else if (count === target.auto) await clearBreak(textId, target.sylId);  // back to auto
    else await setBreak(textId, target.sylId, count);
    onClose();
  };

  const options: { count: 0 | 1 | 2; label: string }[] = [
    { count: 1, label: '↵ 1 line' },
    { count: 2, label: '↵ empty line' },
    { count: 0, label: 'no break' },
  ];

  return createPortal(
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div
        className="fixed z-50 bg-cream-hi rounded-lg shadow-xl p-1 flex flex-col"
        style={{
          border: '1px solid var(--cline)',
          left: Math.min(target.anchor.left, window.innerWidth - 140),
          top: target.anchor.bottom + 4,
        }}
      >
        {options.map(o => (
          <button
            key={o.count}
            type="button"
            onClick={() => choose(o.count)}
            className={`px-3 py-1 text-xs text-left rounded-md transition-colors ${
              target.count === o.count
                ? 'bg-lapis text-cream-hi'
                : 'text-ink hover:bg-cream'
            }`}
          >
            {o.label}
          </button>
        ))}
      </div>
    </>,
    document.body,
  );
};

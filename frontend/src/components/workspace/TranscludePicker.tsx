import React from 'react';
import { FileText } from 'lucide-react';
import { useTextStore } from '../../store/useTextStore';

/**
 * The list of texts a transclusion can pull in — a live range LINK, not a copy.
 *
 * Shared by the two ways in: the selection popover ("insert a whole text after the
 * selection") and the `+` on a separator ("add one here, as its own segment"). One list, so
 * the two entry points cannot drift in what they offer or how they name it.
 */
export const TranscludePicker: React.FC<{
  onPick: (textId: number) => void;
  /** The text being edited — never offered as its own source. */
  excludeTextId: number;
  emptyHint?: string;
}> = ({ onPick, excludeTextId, emptyHint = 'No other texts available.' }) => {
  const texts = useTextStore(s => s.texts);
  const options = texts.filter(t => t.id !== excludeTextId);

  if (options.length === 0) {
    return <p className="text-xs text-ink-soft italic">{emptyHint}</p>;
  }
  return (
    <ul className="flex flex-col gap-0.5 max-h-56 overflow-y-auto rounded"
        style={{ border: '1px solid var(--cline)' }}>
      {options.map(t => (
        <li key={t.id}>
          <button
            type="button"
            onClick={() => onPick(t.id)}
            className="w-full text-left text-xs px-2 py-1.5 hover:bg-cream flex items-center gap-2 min-w-0"
            title={t.title}
          >
            <FileText size={12} className="text-bronze shrink-0" />
            <span className="tibetan-text-sm text-ink truncate min-w-0" style={{ fontSize: '13px' }}>
              {t.title}
            </span>
            <span className={
              'text-[9px] uppercase tracking-wide px-1 py-px rounded font-mono shrink-0 ml-auto '
              + (t.text_type === 'secondary' ? 'bg-lapis/10 text-lapis' : 'bg-bronze/10 text-bronze')
            }>
              {t.text_type}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
};

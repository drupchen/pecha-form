import React, { useEffect, useRef, useState } from 'react';
import { cleanSpecimenHtml, stripAttrs } from './StyleStudio';

/**
 * One title slot's text, edited as it will PRINT rather than as the markup behind it.
 *
 * A title page's slots carry emphasis (a work's name inside "From …") and deliberate line
 * breaks. Typed as source those are `<em>` and `<br>` — which is asking someone setting a
 * title page to read HTML, and to spot the difference between the two when the whole point
 * of the field is how the line looks.
 *
 * Uncontrolled: `innerHTML` is written once, or the caret jumps to the front on every
 * keystroke. The parent re-`key`s the element when the override appears or goes, which is
 * what re-seeds it.
 *
 * `cleanSpecimenHtml` is the Style Studio's sanitizer, reused deliberately rather than
 * copied: it keeps exactly `<strong>`/`<em>`/`<br>` and unwraps everything else — including
 * the inline `style` contentEditable freezes the computed font into, which would otherwise
 * outrank the block's role and pin this line's size forever.
 */
export const RichLine: React.FC<{
  html: string; placeholder?: string; onCommit: (html: string) => void;
}> = ({ html, placeholder, onCommit }) => {
  const ref = useRef<HTMLDivElement>(null);
  const [focused, setFocused] = useState(false);
  useEffect(() => { if (ref.current) ref.current.innerHTML = html; }, []); // eslint-disable-line

  /**
   * Commit while typing, not only on the way out.
   *
   * Blur alone is not enough to be safe: collapsing the panel unmounts the field, and an
   * unmount is not a blur — the edit would simply be gone, with nothing to say so. The
   * debounce keeps that from being a write per keystroke, and `commit` is idempotent
   * (`saveFurniture` returns early when the value has not moved), so the blur and the unmount
   * below can both call it without writing twice.
   */
  const timer = useRef<number>(0);
  const commit = () => {
    if (!ref.current) return;
    onCommit(cleanSpecimenHtml(ref.current.innerHTML));
  };
  const commitSoon = () => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(commit, 600);
  };
  // Flush on the way out — the debounce may still be pending when the panel closes.
  useEffect(() => () => { window.clearTimeout(timer.current); commit(); }, []); // eslint-disable-line

  const exec = (cmd: 'bold' | 'italic') => {
    ref.current?.focus();
    document.execCommand(cmd);
    stripAttrs(ref.current!);
    commitSoon();
  };
  return (
    <span className="flex-1 flex items-start gap-1">
      <div
        ref={ref}
        contentEditable
        suppressContentEditableWarning
        data-placeholder={placeholder}
        className="flex-1 px-2 py-1 rounded-md bg-white text-xs bk-richline"
        style={{ border: '1px solid var(--cline)', minHeight: '1.75rem' }}
        onFocus={() => setFocused(true)}
        onInput={() => { stripAttrs(ref.current!); commitSoon(); }}
        onKeyDown={e => {
          // Enter is a LINE BREAK here, never a new paragraph: a slot is one block, and its
          // breaks are where the type turns, not where a new block starts.
          if (e.key === 'Enter') { e.preventDefault(); document.execCommand('insertLineBreak'); }
        }}
        onBlur={() => { setFocused(false); window.clearTimeout(timer.current); commit(); }}
      />
      {/* Shown only while the field has focus — six slots times four languages would be a
          wall of buttons otherwise. `onMouseDown` preventDefault keeps the caret (and the
          selection the command applies to) instead of blurring the field. */}
      {focused && (
        <span className="flex gap-0.5 shrink-0 pt-0.5">
          {(['bold', 'italic'] as const).map(cmd => (
            <button key={cmd} type="button"
                    onMouseDown={e => e.preventDefault()}
                    onClick={() => exec(cmd)}
                    title={cmd === 'bold' ? 'Bold (Ctrl+B)' : 'Italic (Ctrl+I)'}
                    className="w-5 h-5 rounded text-[11px] text-ink-soft hover:text-lapis hover:bg-cream"
                    style={{ border: '1px solid var(--cline)',
                             fontWeight: cmd === 'bold' ? 700 : 400,
                             fontStyle: cmd === 'italic' ? 'italic' : 'normal' }}>
              {cmd === 'bold' ? 'B' : 'I'}
            </button>
          ))}
        </span>
      )}
    </span>
  );
};

/** A furniture body was authored as `<p>`-delimited paragraphs; the rich editor (like the title
 *  slots) speaks `<br>`. Convert paragraph boundaries to line breaks so opening a legacy body in
 *  `RichLine` shows its lines and re-saves them as `<br>` rather than joining them. `splitParagraphs`
 *  renders a `<br>`-only body as one centred block, so the page is unchanged. */
export function bodyToRich(html: string): string {
  if (!html) return '';
  return html
    .replace(/<\/p>\s*<p[^>]*>/gi, '<br>')
    .replace(/<\/?p[^>]*>/gi, '')
    .trim();
}

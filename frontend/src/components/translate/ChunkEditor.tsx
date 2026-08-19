import React, { useEffect, useRef, useState } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Mark, mergeAttributes } from '@tiptap/core';
import { Fragment, Slice } from '@tiptap/pm/model';
import { Bold, Italic, MessageSquarePlus } from 'lucide-react';
import { sanitizeTranslationHtml } from './sanitize';
import { blurOutcome } from './blur';
import { useCan } from '../../store/usePermissions';

/**
 * Per-chunk translation editor. Inactive chunks render their body as static
 * HTML (216 live ProseMirror instances would be heavy); clicking mounts the one
 * active TipTap editor with a mini-toolbar: Bold, Italic, and Note° — a note
 * rides the text as `span.fn[data-note]` and becomes a per-page FOOTNOTE in the
 * paginated booklet (numbering assigned at pagination, never stored).
 *
 * The toolbar itself shows on EVERY editable chunk, active or not: the buttons
 * were invisible until you had already clicked into a box, so nothing announced
 * that translations could carry formatting or footnotes at all. Only the
 * ProseMirror instance is lazy — pressing a button on a resting chunk mounts the
 * editor and runs the command as the first thing it does.
 */

type Cmd = 'bold' | 'italic' | 'note';

const FnNote = Mark.create({
  name: 'fnNote',
  addAttributes() {
    return {
      note: {
        default: '',
        parseHTML: (el: HTMLElement) => el.getAttribute('data-note') ?? '',
        renderHTML: (attrs: { note: string }) => ({ 'data-note': attrs.note, title: attrs.note }),
      },
    };
  },
  parseHTML() {
    return [{ tag: 'span.fn' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes({ class: 'fn' }, HTMLAttributes), 0];
  },
});

const EXTENSIONS = [
  StarterKit.configure({
    heading: false,
    blockquote: false,
    bulletList: false,
    orderedList: false,
    listItem: false,
    code: false,
    codeBlock: false,
    horizontalRule: false,
    link: false,
    underline: false,
  }),
  FnNote,
];

/** Move keyboard focus to the previous/next translation box (marked `data-tbox`),
 *  in document (top-to-bottom) order. Focusing a box opens it for editing. */
function focusAdjacentTbox(from: HTMLElement, dir: 1 | -1) {
  const boxes = Array.from(document.querySelectorAll<HTMLElement>('[data-tbox]'));
  const cur = from.closest<HTMLElement>('[data-tbox]');
  const i = cur ? boxes.indexOf(cur) : -1;
  boxes[i + dir]?.focus();
}

/** The mini-toolbar, rendered in both states. `isActive` reports the mark under the
 *  caret; a resting chunk has no editor and no caret, so it answers false for all
 *  three and the buttons render in their neutral state. */
const Toolbar: React.FC<{
  isActive: (mark: Cmd) => boolean;
  onCommand: (cmd: Cmd) => void;
}> = ({ isActive, onCommand }) => (
  <div className="flex items-center gap-1">
    <button
      type="button"
      onMouseDown={e => e.preventDefault()}
      onClick={() => onCommand('bold')}
      className={`p-1 rounded ${isActive('bold') ? 'bg-lapis text-cream-hi' : 'text-ink-soft hover:bg-cream'}`}
      title="Bold (Ctrl+B)"
    >
      <Bold size={12} />
    </button>
    <button
      type="button"
      onMouseDown={e => e.preventDefault()}
      onClick={() => onCommand('italic')}
      className={`p-1 rounded ${isActive('italic') ? 'bg-lapis text-cream-hi' : 'text-ink-soft hover:bg-cream'}`}
      title="Italic (Ctrl+I)"
    >
      <Italic size={12} />
    </button>
    <button
      type="button"
      onMouseDown={e => e.preventDefault()}
      onClick={() => onCommand('note')}
      className={`p-1 rounded flex items-center gap-1 text-[10px] ${isActive('note') ? 'bg-gold/30 text-amber-robe' : 'text-ink-soft hover:bg-cream'}`}
      title="Note on the selection — becomes a footnote on the printed page"
    >
      <MessageSquarePlus size={12} /> note°
    </button>
  </div>
);

const InnerEditor: React.FC<{
  initial: string;
  onDone: (html: string) => void;
  /** A toolbar button pressed while the chunk was resting: run it once mounted. */
  pending: Cmd | null;
}> = ({ initial, onDone, pending }) => {
  const [notePopover, setNotePopover] = useState<{ existing: string } | null>(null);
  const [noteText, setNoteText] = useState('');
  const wrapRef = useRef<HTMLDivElement>(null);
  // Did the user actually change anything in this editing session? `content:` does not fire
  // `onUpdate`, so this is true only after a real keystroke, paste or formatting command. It
  // is what tells a DELIBERATE clear apart from an editor that simply never received data.
  const touched = useRef(false);

  const editor = useEditor({
    extensions: EXTENSIONS,
    content: sanitizeTranslationHtml(initial),
    autofocus: false,
    onUpdate: () => { touched.current = true; },
    editorProps: {
      // A spreadsheet copy ships an HTML <table>; ProseMirror (no table extension) would
      // flatten it onto one line. Turn each row into a paragraph while KEEPING the cell's
      // inline bold/italic, so a multi-line paste preserves both newlines AND styling.
      // One <p> per line = one translation line (paginator pairs the i-th <p> with the
      // i-th Tibetan line). Non-table HTML is left alone (ProseMirror already keeps its
      // blocks + marks).
      transformPastedHTML(html) {
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const rows = Array.from(doc.querySelectorAll('tr'));
        if (!rows.length) return html;
        const cellHtml = (cell: Element) => {
          const style = cell.getAttribute('style') || '';
          const inner = cell.innerHTML;
          const bold = /font-weight\s*:\s*(bold|[5-9]\d\d)/i.test(style);
          const ital = /font-style\s*:\s*italic/i.test(style);
          return bold || ital ? `<span style="${style}">${inner}</span>` : inner;
        };
        return rows.map((tr) => {
          const cells = Array.from(tr.children).filter((c) => /^(td|th)$/i.test(c.tagName));
          return `<p>${cells.map(cellHtml).join(' ')}</p>`;
        }).join('');
      },
      // Plain-text-only paste (no HTML on the clipboard): split newlines into paragraphs.
      handlePaste(view, event) {
        if (event.clipboardData?.getData('text/html')?.trim()) return false; // HTML path handles it
        const text = event.clipboardData?.getData('text/plain') ?? '';
        const lines = text.replace(/\r\n?/g, '\n').split('\n');
        while (lines.length > 1 && lines[lines.length - 1].trim() === '') lines.pop();
        if (lines.length <= 1) return false;
        const { paragraph } = view.state.schema.nodes;
        const nodes = lines.map((l) =>
          l ? paragraph.create(null, view.state.schema.text(l)) : paragraph.create());
        const slice = new Slice(Fragment.fromArray(nodes), 1, 1);
        view.dispatch(view.state.tr.replaceSelection(slice).scrollIntoView());
        return true;
      },
      // Tab / Shift+Tab move to the next / previous translation box (committing this
      // one on the way, via focusout) so the translator can work down without the mouse.
      handleKeyDown(view, event) {
        if (event.key === 'Tab') {
          event.preventDefault();
          focusAdjacentTbox(view.dom as HTMLElement, event.shiftKey ? -1 : 1);
          return true;
        }
        return false;
      },
    },
  });

  const runCmd = (cmd: Cmd) => {
    if (!editor) return;
    if (cmd === 'bold') { editor.chain().focus().toggleBold().run(); return; }
    if (cmd === 'italic') { editor.chain().focus().toggleItalic().run(); return; }
    const existing = editor.getAttributes('fnNote').note as string | undefined;
    setNoteText(existing ?? '');
    setNotePopover({ existing: existing ?? '' });
  };

  // Place the caret at the end WITHOUT scrolling: TipTap's built-in autofocus
  // scrolls the freshly-mounted box into view, jumping the page on every click.
  // ProseMirror's focus() already uses preventScroll on the DOM node, so with
  // scrollIntoView:false the caret lands with no page movement.
  useEffect(() => {
    editor?.commands.focus('end', { scrollIntoView: false });
  }, [editor]);

  // The press that mounted this editor. It runs after the caret lands, so bold/italic
  // set the stored mark the next keystroke picks up — the same as pressing the button
  // with the caret parked in an empty selection.
  useEffect(() => {
    if (editor && pending) runCmd(pending);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, pending]);

  // Commit when focus leaves the editor+toolbar+popover entirely. An empty result commits
  // only when the user EMPTIED the box themselves: clearing a translation is a legitimate
  // edit (a segment may be deliberately blank), while an empty box that was never touched is
  // almost always an editor that mounted before its data arrived — committing that would
  // silently wipe the stored translation.
  useEffect(() => {
    const onFocusOut = (e: FocusEvent) => {
      const wrap = wrapRef.current;
      if (!wrap || !editor) return;
      const next = e.relatedTarget as Node | null;
      if (next && wrap.contains(next)) return;
      const html = sanitizeTranslationHtml(editor.getHTML());
      const div = document.createElement('div');
      div.innerHTML = html;
      onDone(blurOutcome({
        blank: !(div.textContent ?? '').trim(),
        touched: touched.current,
        initial: sanitizeTranslationHtml(initial),
        html,
      }));
    };
    const wrap = wrapRef.current;
    wrap?.addEventListener('focusout', onFocusOut);
    return () => wrap?.removeEventListener('focusout', onFocusOut);
  }, [editor, onDone, initial]);

  if (!editor) return null;

  const applyNote = () => {
    if (noteText.trim()) {
      editor.chain().focus().extendMarkRange('fnNote')
        .setMark('fnNote', { note: noteText.trim() }).run();
    } else {
      editor.chain().focus().extendMarkRange('fnNote').unsetMark('fnNote').run();
    }
    setNotePopover(null);
  };

  return (
    <div ref={wrapRef} data-tbox className="flex flex-col gap-1">
      <Toolbar
        isActive={m => editor.isActive(m === 'note' ? 'fnNote' : m)}
        onCommand={runCmd}
      />
      {notePopover && (
        <div
          className="flex items-center gap-1 p-1.5 rounded-md bg-cream-hi"
          style={{ border: '1px solid var(--cline)' }}
        >
          <input
            autoFocus
            type="text"
            value={noteText}
            onChange={e => setNoteText(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') { e.preventDefault(); applyNote(); }
              if (e.key === 'Escape') { e.preventDefault(); setNotePopover(null); }
            }}
            placeholder="footnote text… (empty = remove)"
            className="flex-1 text-xs px-2 py-1 rounded bg-white outline-none"
            style={{ border: '1px solid var(--cline)' }}
          />
          <button
            type="button"
            onMouseDown={e => e.preventDefault()}
            onClick={applyNote}
            className="text-xs px-2 py-1 rounded bg-lapis text-cream-hi"
          >
            OK
          </button>
        </div>
      )}
      <EditorContent
        editor={editor}
        className="chunk-editor flex-1 min-h-[72px] w-full text-sm p-2 rounded-md bg-white outline-none"
        style={{ border: '1px solid var(--lapis, #2b4a8b)' }}
      />
    </div>
  );
};

export const ChunkEditor: React.FC<{
  value: string;
  placeholder: string;
  onSave: (html: string) => void;
}> = ({ value, placeholder, onSave }) => {
  const [editing, setEditing] = useState(false);
  // Set by a toolbar press on the resting box, consumed by the editor it mounts.
  const [pending, setPending] = useState<Cmd | null>(null);
  // Permission-read on Translate: the box never activates — the static body
  // renders exactly as it would while inactive. Gated here (not at the call
  // sites) so every mount of the editor is covered at once.
  const canEdit = useCan('translate').canModify;
  if (editing && canEdit) {
    return (
      <InnerEditor
        initial={value}
        pending={pending}
        onDone={(html) => { setEditing(false); setPending(null); onSave(html); }}
      />
    );
  }
  const html = sanitizeTranslationHtml(value);
  const box = (
    <div
      {...(canEdit ? { 'data-tbox': true, role: 'button', tabIndex: 0 } : {})}
      onClick={() => canEdit && setEditing(true)}
      onFocus={() => canEdit && setEditing(true)}
      className={`chunk-editor flex-1 min-h-[72px] w-full text-sm p-2 rounded-md bg-cream-hi/50 transition-colors ${
        canEdit ? 'cursor-text hover:bg-white' : ''
      }`}
      style={{ border: '1px solid var(--cline)' }}
    >
      {html
        ? <div dangerouslySetInnerHTML={{ __html: html }} />
        : <span className="text-ink-soft/60">{placeholder}</span>}
    </div>
  );
  if (!canEdit) return box;
  // Same wrapper the active editor uses, so activating a chunk swaps the box in place
  // instead of pushing everything below it down by the height of a toolbar.
  return (
    <div className="flex flex-col gap-1">
      <Toolbar isActive={() => false} onCommand={(cmd) => { setPending(cmd); setEditing(true); }} />
      {box}
    </div>
  );
};

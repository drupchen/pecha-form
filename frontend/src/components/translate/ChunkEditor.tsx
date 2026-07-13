import React, { useEffect, useRef, useState } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Mark, mergeAttributes } from '@tiptap/core';
import { Fragment, Slice } from '@tiptap/pm/model';
import { Bold, Italic, MessageSquarePlus } from 'lucide-react';
import { sanitizeTranslationHtml } from './sanitize';

/**
 * Per-chunk translation editor. Inactive chunks render their body as static
 * HTML (216 live ProseMirror instances would be heavy); clicking mounts the one
 * active TipTap editor with a mini-toolbar: Bold, Italic, and Note° — a note
 * rides the text as `span.fn[data-note]` and becomes a per-page FOOTNOTE in the
 * paginated booklet (numbering assigned at pagination, never stored).
 */

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

const InnerEditor: React.FC<{
  initial: string;
  onDone: (html: string) => void;
}> = ({ initial, onDone }) => {
  const [notePopover, setNotePopover] = useState<{ existing: string } | null>(null);
  const [noteText, setNoteText] = useState('');
  const wrapRef = useRef<HTMLDivElement>(null);

  const editor = useEditor({
    extensions: EXTENSIONS,
    content: sanitizeTranslationHtml(initial),
    autofocus: false,
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
    },
  });

  // Place the caret at the end WITHOUT scrolling: TipTap's built-in autofocus
  // scrolls the freshly-mounted box into view, jumping the page on every click.
  // ProseMirror's focus() already uses preventScroll on the DOM node, so with
  // scrollIntoView:false the caret lands with no page movement.
  useEffect(() => {
    editor?.commands.focus('end', { scrollIntoView: false });
  }, [editor]);

  // Commit when focus leaves the editor+toolbar+popover entirely. An EMPTY result
  // never commits: it is almost always an editor that mounted before the data
  // loaded (a blur would silently wipe the stored translation). Clearing a
  // translation is a deliberate action, not an empty blur.
  useEffect(() => {
    const onFocusOut = (e: FocusEvent) => {
      const wrap = wrapRef.current;
      if (!wrap || !editor) return;
      const next = e.relatedTarget as Node | null;
      if (next && wrap.contains(next)) return;
      const html = sanitizeTranslationHtml(editor.getHTML());
      const div = document.createElement('div');
      div.innerHTML = html;
      if (!(div.textContent ?? '').trim()) { onDone(sanitizeTranslationHtml(initial)); return; }
      onDone(html);
    };
    const wrap = wrapRef.current;
    wrap?.addEventListener('focusout', onFocusOut);
    return () => wrap?.removeEventListener('focusout', onFocusOut);
  }, [editor, onDone, initial]);

  if (!editor) return null;

  const openNotePopover = () => {
    const existing = editor.getAttributes('fnNote').note as string | undefined;
    setNoteText(existing ?? '');
    setNotePopover({ existing: existing ?? '' });
  };

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
    <div ref={wrapRef} className="flex flex-col gap-1">
      <div className="flex items-center gap-1">
        <button
          type="button"
          onMouseDown={e => e.preventDefault()}
          onClick={() => editor.chain().focus().toggleBold().run()}
          className={`p-1 rounded ${editor.isActive('bold') ? 'bg-lapis text-cream-hi' : 'text-ink-soft hover:bg-cream'}`}
          title="Bold (Ctrl+B)"
        >
          <Bold size={12} />
        </button>
        <button
          type="button"
          onMouseDown={e => e.preventDefault()}
          onClick={() => editor.chain().focus().toggleItalic().run()}
          className={`p-1 rounded ${editor.isActive('italic') ? 'bg-lapis text-cream-hi' : 'text-ink-soft hover:bg-cream'}`}
          title="Italic (Ctrl+I)"
        >
          <Italic size={12} />
        </button>
        <button
          type="button"
          onMouseDown={e => e.preventDefault()}
          onClick={openNotePopover}
          className={`p-1 rounded flex items-center gap-1 text-[10px] ${editor.isActive('fnNote') ? 'bg-gold/30 text-amber-robe' : 'text-ink-soft hover:bg-cream'}`}
          title="Note on the selection — becomes a footnote on the printed page"
        >
          <MessageSquarePlus size={12} /> note°
        </button>
      </div>
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
  if (editing) {
    return (
      <InnerEditor
        initial={value}
        onDone={(html) => { setEditing(false); onSave(html); }}
      />
    );
  }
  const html = sanitizeTranslationHtml(value);
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => setEditing(true)}
      onFocus={() => setEditing(true)}
      className="chunk-editor flex-1 min-h-[72px] w-full text-sm p-2 rounded-md bg-cream-hi/50 cursor-text hover:bg-white transition-colors"
      style={{ border: '1px solid var(--cline)' }}
    >
      {html
        ? <div dangerouslySetInnerHTML={{ __html: html }} />
        : <span className="text-ink-soft/60">{placeholder}</span>}
    </div>
  );
};

/**
 * Translation bodies are a SMALL sanitized HTML subset — the same fragment flows
 * untransformed into the paginated booklet page, where `span.fn[data-note]`
 * becomes a per-page footnote (numbering assigned at pagination, never stored).
 * Allowlist: p, br, strong, em (b/i normalized), span.fn[data-note].
 */

const BLOCK_OK = new Set(['P']);
const INLINE_OK: Record<string, string> = { STRONG: 'strong', B: 'strong', EM: 'em', I: 'em' };

function walk(node: Node, doc: Document): Node[] {
  const out: Node[] = [];
  node.childNodes.forEach(child => {
    if (child.nodeType === Node.TEXT_NODE) {
      out.push(doc.importNode(child, false));
      return;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) return;
    const el = child as HTMLElement;
    const tag = el.tagName;
    if (tag === 'BR') {
      out.push(doc.createElement('br'));
      return;
    }
    const inner = walk(el, doc);
    if (BLOCK_OK.has(tag)) {
      const p = doc.createElement('p');
      inner.forEach(n => p.appendChild(n));
      out.push(p);
    } else if (INLINE_OK[tag]) {
      const m = doc.createElement(INLINE_OK[tag]);
      inner.forEach(n => m.appendChild(n));
      out.push(m);
    } else if (tag === 'SPAN' && el.classList.contains('fn') && el.getAttribute('data-note') != null) {
      const span = doc.createElement('span');
      span.className = 'fn';
      span.setAttribute('data-note', el.getAttribute('data-note') ?? '');
      // Hover affordance everywhere the body renders; regenerated on each sanitize.
      span.setAttribute('title', el.getAttribute('data-note') ?? '');
      inner.forEach(n => span.appendChild(n));
      out.push(span);
    } else {
      // Unknown element: unwrap — keep its (sanitized) children, drop the tag.
      out.push(...inner);
    }
  });
  return out;
}

/** Sanitize a stored/edited body to the allowed subset. Plain text (no tags AND no
 *  entities) passes through escaped, so pre-rich T1 bodies render unchanged. A string
 *  carrying an entity like `&#x27;` (an apostrophe from a title paragraph split out of its
 *  `<p>` wrapper) must go through the parser instead — the fast path would escape its `&`
 *  and double-encode it to a literal `&#x27;`. The parser decodes real entities and still
 *  escapes bare ampersands, so both cases render correctly. */
export function sanitizeTranslationHtml(html: string): string {
  if (!html) return '';
  if (!/[<>&]/.test(html)) {
    const div = document.createElement('div');
    div.textContent = html;
    return div.innerHTML;
  }
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const container = doc.createElement('div');
  walk(doc.body, doc).forEach(n => container.appendChild(n));
  return container.innerHTML;
}

/** The plain-text projection (dirty checks, "is it empty" tests). */
export function translationText(html: string): string {
  if (!/[<>]/.test(html)) return html;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return doc.body.textContent ?? '';
}

/**
 * What a translation editor commits when focus leaves it.
 *
 * The rule looks trivial and is not: an empty box means two opposite things.
 *
 *  - The translator selected the text and deleted it — a segment may legitimately be blank,
 *    and forcing them to leave a dot behind (which then prints) is exactly the workaround
 *    this rule exists to remove. That must SAVE the empty body.
 *  - The box was opened before its data arrived, so it mounted empty and was never touched.
 *    Committing that would silently wipe a stored translation on a stray click.
 *
 * `touched` is what tells them apart: it is set from the editor's own `onUpdate`, which fires
 * on a real edit and never on the initial `content:`.
 */
export function blurOutcome(
  { blank, touched, initial, html }: {
    blank: boolean; touched: boolean; initial: string; html: string;
  },
): string {
  if (!blank) return html;
  return touched ? '' : initial;
}

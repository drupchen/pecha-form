import {
  transclude, listDerivationOps, deleteDerivationOp,
} from '../../api/client';
import { useUndoStore } from '../../store/useUndoStore';

/**
 * Bring another text in, from either entry point: the selection popover ("after this
 * selection") or the `+` on a separator ("here, as its own segment").
 *
 * One helper because the two must behave the same afterwards — a transclusion splices a whole
 * text in at once, and the first thing anyone reaches for after a mistaken one is Undo. The
 * endpoint answers with the recomposed text rather than the op it created, so the row is read
 * back: the newest transclude op of this text is the one just made.
 */
export async function transcludeInto(args: {
  textId: number;
  srcTextId: number;
  anchorSylId: string | null;
  anchorOpId?: number | null;
  /** Give the run a boundary at its head, scoped to this occurrence (the separator's `+`). */
  asSegment?: boolean;
  reload: (textId: number) => Promise<unknown> | unknown;
}): Promise<void> {
  const { textId, srcTextId, anchorSylId, anchorOpId, asSegment, reload } = args;
  await transclude(textId, {
    anchor_syl_id: anchorSylId,
    src_text_id: srcTextId,
    ...(anchorOpId != null ? { anchor_op_id: anchorOpId } : {}),
    ...(asSegment ? { as_segment: true } : {}),
  });
  const ops = await listDerivationOps(textId).catch(() => []);
  const mine = ops.filter(o => o.op_kind === 'transclude');
  const op = mine.length ? mine[mine.length - 1] : null;
  if (op) {
    useUndoStore.getState().push({
      description: op.summary || 'Transclusion',
      undo: async () => { await deleteDerivationOp(op.id); await reload(textId); },
    });
  }
  await reload(textId);
}

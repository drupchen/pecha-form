import { createContext } from 'react';

/** Forces the sapche tree read-only regardless of the workspace edit mode — the
 *  Translate tab embeds the pane for ORIENTATION only. Consumed by TreeNodeCard
 *  and SiblingInsertSlot alongside the store's consult mode. Own module: TreePane
 *  and TreeNodeCard import each other, so the context must not live in either. */
export const TreeConsultContext = createContext(false);

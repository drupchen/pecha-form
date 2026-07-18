import React, { useContext } from 'react';
import { Plus } from 'lucide-react';
import { useTreeNodeStore } from '../../store/useTreeNodeStore';
import { useTextStore } from '../../store/useTextStore';
import { useUIStore } from '../../store/useUIStore';
import { TreeConsultContext } from './treeConsult';

interface Props {
  /** parent_id for the inserted node; null inserts at root level */
  parentId: number | null;
  /** index in the sibling list where the new node should land */
  position: number;
}

/**
 * Thin hover affordance rendered between adjacent siblings in the tree pane.
 * Invisible until hovered, then shows a horizontal indigo rule with a `+`
 * pill in the middle. Clicking creates a placeholder node at exactly this
 * position (siblings >= `position` shift down by one, handled by the backend
 * via _shift_siblings).
 */
export const SiblingInsertSlot: React.FC<Props> = ({ parentId, position }) => {
  const currentText = useTextStore(s => s.currentText);
  const createNode = useTreeNodeStore(s => s.createNode);
  const setActiveNode = useTreeNodeStore(s => s.setActiveNode);
  const sessionMode = useUIStore(s => s.sessionMode);
  const consultMode = useUIStore(s => s.editMode === 'consult') || useContext(TreeConsultContext);

  if (!currentText) return null;
  if (sessionMode || consultMode) return <div className="h-1.5 -my-0.5" />;

  const handleClick = async () => {
    try {
      const node = await createNode(currentText.id, {
        parent_id: parentId,
        position,
        title: 'New section',
      });
      setActiveNode(node.id);
    } catch (err: any) {
      alert(err.message);
    }
  };

  return (
    <div
      role="button"
      onClick={handleClick}
      className="group relative h-1.5 -my-0.5 cursor-pointer flex items-center"
      title="Insert section here"
    >
      <div className="w-full h-px bg-gold opacity-0 group-hover:opacity-100 transition-opacity" />
      <span
        className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-20 inline-flex items-center justify-center w-7 h-7 rounded-full bg-gold text-sky-deep opacity-0 group-hover:opacity-100 transition-opacity shadow-md"
        style={{ boxShadow: '0 0 0 1px var(--gline), 0 4px 12px rgba(236,179,32,0.3)' }}
      >
        <Plus size={16} />
      </span>
    </div>
  );
};

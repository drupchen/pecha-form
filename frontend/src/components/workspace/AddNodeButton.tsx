import React from 'react';
import { Plus } from 'lucide-react';
import { useTreeNodeStore } from '../../store/useTreeNodeStore';
import { useTextStore } from '../../store/useTextStore';

interface Props {
  /** parent_id for the new node; null means "add at root" */
  parentId: number | null;
  label?: string;
}

/**
 * One-click creates a placeholder tree node (title 'New section') and sets
 * it active. The user can then either:
 *   - click the title to rename it manually, or
 *   - select text in the tagger to auto-fill the title (Phase 16 flow,
 *     which only triggers when the title is still in the placeholder set).
 */
export const AddNodeButton: React.FC<Props> = ({ parentId, label = '+ Add section' }) => {
  const currentText = useTextStore(s => s.currentText);
  const createNode = useTreeNodeStore(s => s.createNode);
  const setActiveNode = useTreeNodeStore(s => s.setActiveNode);

  if (!currentText) return null;

  const handleClick = async () => {
    try {
      const node = await createNode(currentText.id, {
        parent_id: parentId,
        title: 'New section',
      });
      setActiveNode(node.id);
    } catch (err: any) {
      alert(err.message);
    }
  };

  return (
    <button
      onClick={handleClick}
      className="text-xs text-bronze hover:text-gold px-2 py-1 rounded-md w-full text-left flex items-center gap-1 transition-colors"
      style={{ border: '1px dashed var(--cline)' }}
    >
      <Plus size={12} />
      {label}
    </button>
  );
};

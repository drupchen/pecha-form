import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

/** The app's first real modal primitive (admin flows; native confirm() elsewhere
 *  predates it). Portal + scrim, Esc/overlay close, design-token card. */
export const Modal: React.FC<{
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  width?: number;
}> = ({ title, onClose, children, width = 420 }) => {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return createPortal(
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center"
      style={{ background: 'rgba(10, 18, 36, 0.55)' }}
      onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="rounded-xl bg-cream-hi text-ink flex flex-col max-h-[85vh]"
        style={{ width, boxShadow: '0 0 0 1px var(--gline), 0 24px 60px rgba(0,0,0,0.45)' }}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b"
             style={{ borderColor: 'var(--gline-soft)' }}>
          <div className="font-display text-base">{title}</div>
          <button onClick={onClose} className="opacity-60 hover:opacity-100">
            <X size={16} />
          </button>
        </div>
        <div className="px-5 py-4 overflow-y-auto">{children}</div>
      </div>
    </div>,
    document.body,
  );
};

export const ConfirmDialog: React.FC<{
  title: string;
  message: React.ReactNode;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}> = ({ title, message, confirmLabel = 'Confirm', onConfirm, onCancel }) => (
  <Modal title={title} onClose={onCancel} width={360}>
    <div className="text-sm mb-4">{message}</div>
    <div className="flex justify-end gap-2">
      <button onClick={onCancel}
              className="px-3 py-1.5 rounded-md text-sm border"
              style={{ borderColor: 'var(--gline-soft)' }}>
        Cancel
      </button>
      <button onClick={onConfirm}
              className="px-3 py-1.5 rounded-md text-sm font-semibold text-white bg-red-700 hover:bg-red-800">
        {confirmLabel}
      </button>
    </div>
  </Modal>
);

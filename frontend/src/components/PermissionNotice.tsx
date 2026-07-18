import React, { useEffect } from 'react';
import { ShieldAlert, X } from 'lucide-react';
import { useAuthStore } from '../store/useAuthStore';

/** Transient banner for 403s: an action the UI offered was refused by the server
 *  (permissions changed under us, or a gap in the read-only gating). */
export const PermissionNotice: React.FC = () => {
  const notice = useAuthStore(s => s.permissionNotice);
  const clear = useAuthStore(s => s.clearPermissionNotice);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(clear, 6000);
    return () => clearTimeout(t);
  }, [notice, clear]);

  if (!notice) return null;
  return (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[100]">
      <div
        className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm text-cream-hi"
        style={{
          background: 'linear-gradient(180deg, var(--sky-night), var(--sky-deep))',
          boxShadow: '0 0 0 1px var(--gline), 0 8px 24px rgba(0,0,0,0.4)',
        }}
      >
        <ShieldAlert size={16} className="text-gold" />
        <span>{notice}</span>
        <button onClick={clear} className="ml-1 opacity-70 hover:opacity-100">
          <X size={14} />
        </button>
      </div>
    </div>
  );
};

import React from 'react';

/** Shared chrome for the pre-app screens (login, invite, splash): the header's
 *  night-sky gradient with the gold seal, one centered card. */
export const AuthShell: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div
    className="h-screen flex flex-col items-center justify-center gap-6"
    style={{ background: 'linear-gradient(180deg, var(--sky-night) 0%, var(--sky-deep) 100%)' }}
  >
    <div className="flex items-center gap-3">
      <div
        className="h-12 w-12 rounded-full flex items-center justify-center text-sky-deep text-xl font-display"
        style={{
          background: 'radial-gradient(circle at 38% 32%, var(--gold-soft), var(--gold) 60%, var(--bronze))',
          boxShadow: '0 0 0 1px var(--gline), 0 0 18px rgba(236,179,32,0.4)',
        }}
        aria-hidden
      >
        ༀ
      </div>
      <span className="font-display text-3xl text-cream-hi tracking-tight">Sapche</span>
    </div>
    {children}
  </div>
);

export const AuthCard: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div
    className="w-[340px] rounded-xl p-6 flex flex-col gap-4 bg-cream-hi text-ink shadow-2xl"
    style={{ boxShadow: '0 0 0 1px var(--gline), 0 24px 60px rgba(0,0,0,0.45)' }}
  >
    {children}
  </div>
);

export const AuthInput: React.FC<React.InputHTMLAttributes<HTMLInputElement>> = (props) => (
  <input
    {...props}
    className="w-full px-3 py-2 rounded-md border bg-white text-sm outline-none focus:ring-2"
    style={{ borderColor: 'var(--gline-soft)' }}
  />
);

export const AuthButton: React.FC<React.ButtonHTMLAttributes<HTMLButtonElement>> = (props) => (
  <button
    {...props}
    className="w-full py-2 rounded-md text-sm font-semibold text-sky-deep transition-opacity disabled:opacity-50"
    style={{
      background: 'linear-gradient(180deg, var(--gold-soft), var(--gold))',
      boxShadow: '0 0 0 1px var(--gline)',
    }}
  />
);

export const AuthError: React.FC<{ children: React.ReactNode }> = ({ children }) =>
  children ? (
    <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2">
      {children}
    </div>
  ) : null;

import React, { useEffect, useRef, useState } from 'react';

/** "Continue with Google" via Google Identity Services: loads the GIS script once,
 *  renders the official button, and hands the ID-token credential to the caller.
 *  Renders nothing when VITE_GOOGLE_CLIENT_ID is not configured. */

const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined;

declare global {
  interface Window {
    google?: any;
  }
}

let gisLoading: Promise<void> | null = null;
function loadGis(): Promise<void> {
  if (window.google?.accounts?.id) return Promise.resolve();
  if (!gisLoading) {
    gisLoading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('Failed to load Google sign-in'));
      document.head.appendChild(s);
    });
  }
  return gisLoading;
}

export const GoogleButton: React.FC<{ onCredential: (credential: string) => void }> = ({
  onCredential,
}) => {
  const slot = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!CLIENT_ID) return;
    let cancelled = false;
    loadGis().then(() => {
      if (cancelled || !slot.current) return;
      window.google.accounts.id.initialize({
        client_id: CLIENT_ID,
        callback: (resp: { credential: string }) => onCredential(resp.credential),
      });
      window.google.accounts.id.renderButton(slot.current, {
        theme: 'outline', size: 'large', text: 'continue_with', width: 280,
      });
    }).catch(() => setFailed(true));
    return () => { cancelled = true; };
  }, [onCredential]);

  if (!CLIENT_ID || failed) return null;
  return <div ref={slot} className="flex justify-center" />;
};

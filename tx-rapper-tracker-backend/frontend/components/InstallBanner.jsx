import { useEffect, useState } from 'react';
import { triggerInstallPrompt, isInstalled } from '../../src/pwa/pwaService';

export default function InstallBanner() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (isInstalled()) return;
    const onInstallable = () => setShow(true);
    const onInstalled = () => setShow(false);
    document.addEventListener('pwa:installable', onInstallable);
    document.addEventListener('pwa:installed', onInstalled);
    return () => {
      document.removeEventListener('pwa:installable', onInstallable);
      document.removeEventListener('pwa:installed', onInstalled);
    };
  }, []);

  if (!show) return null;

  return (
    <button
      onClick={async () => { const ok = await triggerInstallPrompt(); if (ok) setShow(false); }}
      style={{ padding: '6px 12px', fontSize: '13px', cursor: 'pointer' }}
    >
      📲 Install App
    </button>
  );
}

import { useEffect, useState } from 'react';
import { isInstalled, triggerInstallPrompt } from '../../src/pwa/pwaService';

export function usePWA() {
  const [installable, setInstallable] = useState(false);
  const [installed, setInstalled] = useState(isInstalled());
  const [offline, setOffline] = useState(!navigator.onLine);

  useEffect(() => {
    document.addEventListener('pwa:installable', () => setInstallable(true));
    document.addEventListener('pwa:installed', () => { setInstalled(true); setInstallable(false); });
    window.addEventListener('offline', () => setOffline(true));
    window.addEventListener('online', () => setOffline(false));
  }, []);

  return { installable, installed, offline, triggerInstallPrompt };
}

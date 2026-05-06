let deferredPrompt = null;

export function initPWA() {
  incrementVisitCount();
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    deferredPrompt = e;
    if (getVisitCount() >= 2 && !isInstalled()) {
      document.dispatchEvent(new CustomEvent('pwa:installable'));
    }
  });
  window.addEventListener('appinstalled', () => {
    localStorage.setItem('txrt-installed', 'true');
    deferredPrompt = null;
    document.dispatchEvent(new CustomEvent('pwa:installed'));
  });
}

export async function triggerInstallPrompt() {
  if (!deferredPrompt) return false;
  deferredPrompt.prompt();
  const { outcome } = await deferredPrompt.userChoice;
  deferredPrompt = null;
  return outcome === 'accepted';
}

export function isInstalled() {
  return localStorage.getItem('txrt-installed') === 'true'
    || window.matchMedia('(display-mode: standalone)').matches;
}

function incrementVisitCount() {
  localStorage.setItem('txrt-visit-count', String(getVisitCount() + 1));
}

function getVisitCount() {
  return parseInt(localStorage.getItem('txrt-visit-count') || '0', 10);
}

export function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js')
        .catch(err => console.warn('SW registration failed:', err));
    });
  }
}

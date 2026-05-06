import { useEffect, useState } from 'react';

export default function StaleDataBanner() {
  const [stale, setStale] = useState(false);

  useEffect(() => {
    window.addEventListener('offline', () => setStale(true));
    window.addEventListener('online', () => setStale(false));
  }, []);

  if (!stale) return null;

  return (
    <div style={{ background: '#f59e0b', color: '#1a1a2e', padding: '8px 16px', textAlign: 'center', fontSize: '13px', fontWeight: 600 }}>
      You are offline — showing last saved data
    </div>
  );
}

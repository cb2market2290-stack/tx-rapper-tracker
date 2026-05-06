import fetch from 'node-fetch';

const BASE = process.env.BASE_URL || 'http://localhost:3000';

async function run() {
  let passed = 0;

  try {
    const res = await fetch(BASE + '/manifest.json');
    const json = await res.json();
    if (res.ok && json.start_url) { console.log('PASS 56: manifest_reachable'); passed++; }
    else throw new Error('bad manifest');
  } catch (e) { console.error('FAIL 56: manifest_reachable', e.message); }

  try {
    const res = await fetch(BASE + '/sw.js');
    const ct = res.headers.get('content-type') || '';
    if (res.ok && ct.includes('javascript')) { console.log('PASS 57: sw_served'); passed++; }
    else throw new Error('bad sw response');
  } catch (e) { console.error('FAIL 57: sw_served', e.message); }

  try {
    const res = await fetch(BASE + '/api/pwa/status');
    const json = await res.json();
    if (res.ok && json.cacheVersion) { console.log('PASS 58: pwa_status_route'); passed++; }
    else throw new Error('bad status response');
  } catch (e) { console.error('FAIL 58: pwa_status_route', e.message); }

  console.log(passed + '/3 PWA smokes passed');
  process.exit(passed === 3 ? 0 : 1);
}

run();

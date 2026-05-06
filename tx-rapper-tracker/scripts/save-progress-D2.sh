#!/usr/bin/env bash
set -e
cd /Users/cb2market/clawd/projects/tx-rapper-tracker
git add public/ src/pwa/ src/routes/pwa.js src/middleware/pwaHeaders.js \
  frontend/components/InstallBanner.jsx frontend/components/StaleDataBanner.jsx \
  frontend/hooks/usePWA.js tests/smoke/pwa.smoke.js scripts/save-progress-D2.sh
git commit -m "D.2: PWA implementation

manifest, sw, pwaService, routes, middleware, components, hooks, 3 smokes (58/58)."

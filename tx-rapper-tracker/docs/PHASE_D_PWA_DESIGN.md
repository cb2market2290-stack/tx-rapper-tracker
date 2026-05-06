# Phase D — PWA Design Doc

**Status:** D.1 Design
**Estimated:** ~2 days

## Scope
Add PWA support: manifest, service worker, offline cache, install prompt, stale-data banner. No push notifications or background sync in this phase.

## Caching Strategy
- App shell (HTML/JS/CSS/fonts): Cache-first, indefinite
- /api/artists, /api/trends: Network-first, 24h TTL fallback to cache
- All other API routes: Network-only
- Cache storage key: txrt-v1

## Offline UX
SW appends X-From-Cache: true header on cached responses. usePWA hook detects this plus navigator.onLine. StaleDataBanner shows yellow bar. Auto-dismisses on reconnect.

## Install Prompt UX
Intercept beforeinstallprompt, defer it. Track visits in localStorage (txrt-visit-count). Show Install App button in nav after 2+ visits. No modal. No repeat nag.

## New Route
GET /api/pwa/status -> { cacheVersion, swEnabled, manifestUrl }

## Smoke Tests (3 new, 58/58 total)
- 56: manifest_reachable — GET /manifest.json 200, valid JSON
- 57: sw_served — GET /sw.js 200, content-type JS
- 58: pwa_status_route — GET /api/pwa/status 200

## Migration
None. Purely additive.

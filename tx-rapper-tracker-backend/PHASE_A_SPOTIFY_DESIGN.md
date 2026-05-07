# Phase A — Spotify Integration
**Status:** A.1 Design

## Auth
Client Credentials flow. No user OAuth.
Env vars: SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET
Token cached, refreshed at 55 min.

## Data Collected
followers.total, popularity, genres — every 6 hours per artist.

## Files
migrations/016_spotify.sql
src/services/spotifyAuth.js
src/services/spotifyCollector.js
src/services/spotifyScheduler.js
src/routes/spotify.js
test/spotify.smoke.js

## Database
ALTER TABLE artists ADD COLUMN spotify_id TEXT.
New table: spotify_stats (id, artist_id FK, collected_at, followers, popularity, genres, monthly_listeners).

## Routes
GET /api/spotify/status -> enabled, tokenExpiry, artistsTracked
GET /api/spotify/artist/:id -> latest stats (requireUser)

## Smokes (5 new, 68/68 total)
64: spotify_status_route
65: spotify_disabled_safe
66: spotify_artist_requires_auth
67: spotify_id_column_exists
68: spotify_stats_table_exists

Generated: Phase A.1 | 2026-05-06

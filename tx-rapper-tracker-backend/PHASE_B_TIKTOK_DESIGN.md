# Phase B — TikTok Integration
**Status:** B.1 Design

## Approach
RapidAPI TikTok provider — clean REST, no scraping, same pattern as Spotify.

## Env Vars
TIKTOK_RAPIDAPI_KEY
TIKTOK_RAPIDAPI_HOST

## Data Collected
followers, following, total_likes, video_count, verified
Collected every 6 hours per artist with tiktok_handle set.

## Files
migrations/017_tiktok.sql
src/services/tiktokClient.js
src/services/tiktokCollector.js
src/services/tiktokScheduler.js
src/routes/tiktok.js
test/tiktok.smoke.js

## Database
ALTER TABLE artists ADD COLUMN tiktok_handle TEXT.
tiktok_stats: id SERIAL PK, artist_id UUID FK, collected_at TIMESTAMPTZ,
followers INTEGER, following INTEGER, total_likes INTEGER,
video_count INTEGER, verified BOOLEAN.

## Routes
GET /api/tiktok/status         public
GET /api/tiktok/artist/:id     requireUser

## Smokes (5 new, 73/73 total)
69: tiktok_status_route
70: tiktok_disabled_safe
71: tiktok_artist_requires_auth
72: tiktok_handle_column_exists
73: tiktok_stats_table_exists

Generated: Phase B.1 | 2026-05-06

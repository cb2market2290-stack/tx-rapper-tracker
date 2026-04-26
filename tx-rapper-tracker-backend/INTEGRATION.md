# Front-end integration — `app.html` → proxy

Goal: stop the browser from ever seeing the YouTube API key. Instead of
calling `https://www.googleapis.com/youtube/v3/...` directly with the key in
the URL, `app.html` calls the local proxy, which adds the key server-side.

> This is a small, mechanical patch — a good fit for OpenClaw. See
> `TASK.md` for the scoped instructions.

## 1. Add a proxy base constant

Near the top of the `<script>` block in `app.html`, add:

```js
// Where the backend proxy lives. In local dev this is the Node server on :8787.
// In production, point this at your Cloudflare Tunnel hostname
// (e.g. "https://api.txrappertracker.com").
const PROXY_BASE = "http://127.0.0.1:8787";
```

## 2. Remove every reference to the YouTube API key in the browser

Search `app.html` for each of these — delete all matches:

- `localStorage.getItem('ytApiKey')` / `localStorage.setItem('ytApiKey', ...)`
- any variable named `ytApiKey`, `YT_API_KEY`, `apiKey`
- any input field where the user pastes an API key (the whole block — label,
  input, save button)
- any `&key=${...}` in a template string

The browser must not store, request, or transmit the key. Full stop.

## 3. Replace direct YouTube URLs with proxy URLs

| Old (delete) | New (use) |
|---|---|
| `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${q}&maxResults=10&key=${key}` | `${PROXY_BASE}/api/youtube/search?q=${encodeURIComponent(q)}&maxResults=10` |
| `https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics&id=${ids}&key=${key}` | `${PROXY_BASE}/api/youtube/videos?ids=${encodeURIComponent(ids)}` |
| `https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&id=${id}&key=${key}` | `${PROXY_BASE}/api/youtube/channel?id=${encodeURIComponent(id)}` |
| `https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&forUsername=${u}&key=${key}` | `${PROXY_BASE}/api/youtube/channel?username=${encodeURIComponent(u)}` |
| Any "latest uploads" logic that fetched the `uploads` playlist and then `playlistItems` | `${PROXY_BASE}/api/youtube/channel/uploads?channelId=${encodeURIComponent(id)}&maxResults=10` |

The response shape is the same shape Google returns, wrapped:

```json
{ "kind": "youtube.search", "query": {...}, "items": [ /* same as before */ ] }
```

So anything that previously did `data.items.forEach(...)` still works — just
read from `data.items`.

## 4. Channel-stats chart (replaces the old Trends chart)

The Google-Trends endpoint was removed in phase 2b.9 (upstream was bot-blocking
every request). In its place, `/api/stats/history` serves real YouTube
subscriber counts from the daily `snapshot-stats.js` job:

```js
const r = await fetch(
  `${PROXY_BASE}/api/stats/history?artist=${encodeURIComponent(artist)}&days=365`,
  { credentials: 'include' }
);
const data = await r.json();
// data.rows is [{ day: '2026-04-18', subs: 488000, lifetime_views: 86000000 }, ...]
renderTrendsChart(data.rows);
```

The endpoint is behind `requireUser()`, so the fetch needs `credentials: 'include'`.
An empty `rows` array means the snapshot job hasn't populated history yet —
callers should fall back to a cold-start message.

## 5. Handle errors consistently

The proxy returns JSON errors like:

```json
{ "error": "rate_limited", "message": "Too many requests" }
```

```json
{ "error": "upstream_youtube_error", "message": "YouTube API 403" }
```

So wrap fetches:

```js
async function proxyGet(path) {
  const r = await fetch(`${PROXY_BASE}${path}`);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.message || `HTTP ${r.status}`);
  return body;
}
```

## 6. Smoke-test the patch

With the backend running (`npm start` in the backend folder):

1. Open `app.html` in Chrome. Open DevTools → Network.
2. Trigger the "latest videos" feed.
3. Confirm the request goes to `127.0.0.1:8787`, not `googleapis.com`.
4. Confirm no `AIza...` string appears anywhere in the page source, network
   headers, or DevTools → Application → Local Storage.
5. Confirm the videos still render.

If any of those fail, the patch is incomplete.

## 7. Known caveats

- **CORS for file://.** If you open `app.html` by double-clicking it, its
  origin is `null`. The backend's allow-list already includes `null` in
  `.env.example` — do not remove it. In production, swap it for the real
  hostname.
- **No keys in URLs.** Even the proxy URL must not carry secrets. Never add
  `?apiKey=...` to a proxy call "for convenience."
- **Rate limits.** Default is 60 requests per minute per IP. If the UI loops
  aggressively, back off — don't raise the limit to hide a bug.

# TASK for OpenClaw — Patch `app.html` to use the proxy

> Scope: small, mechanical edit. No new features. No architectural changes.
> This is the right size for OpenClaw (qwen2.5-coder:1.5b via Ollama).
>
> If any step feels larger than "find-and-replace plus a constant," stop and
> leave it for the next Claude session.

## The goal in one sentence

Make `app.html` fetch YouTube (and Trends, if present) from the local proxy
at `http://127.0.0.1:8787` instead of calling `googleapis.com` directly with
an API key in the URL.

## Prereqs

- Backend is running: `cd tx-rapper-tracker-backend && npm start`
- `app.html` is at `~/clawd/projects/tx-rapper-tracker/app.html`

## Exact edits

### 1. Add proxy base constant

At the **top of the first `<script>` block** in `app.html`, add:

```js
const PROXY_BASE = "http://127.0.0.1:8787";
```

### 2. Delete every reference to the YouTube API key

Delete — do not comment out — every line that matches any of these:

- Anything reading or writing `ytApiKey` to `localStorage`
- Any variable named `ytApiKey`, `YT_API_KEY`, or `apiKey`
- The HTML input field + label + save button for "YouTube API Key"
- Any `&key=${...}` inside a template string

After this step, grep the file for `AIza` and for `ytApiKey` — both should
return zero matches.

### 3. Rewrite these fetch URLs

Change each old URL to the matching new URL.

| Old | New |
|---|---|
| `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${q}&maxResults=10&key=${key}` | `` `${PROXY_BASE}/api/youtube/search?q=${encodeURIComponent(q)}&maxResults=10` `` |
| `https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics&id=${ids}&key=${key}` | `` `${PROXY_BASE}/api/youtube/videos?ids=${encodeURIComponent(ids)}` `` |
| `https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&id=${id}&key=${key}` | `` `${PROXY_BASE}/api/youtube/channel?id=${encodeURIComponent(id)}` `` |
| `https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&forUsername=${u}&key=${key}` | `` `${PROXY_BASE}/api/youtube/channel?username=${encodeURIComponent(u)}` `` |

If the page has a "latest uploads" feed that does two calls (channel → playlistItems), replace both with **one** call:

```js
const r = await fetch(`${PROXY_BASE}/api/youtube/channel/uploads?channelId=${encodeURIComponent(id)}&maxResults=10`);
```

### 4. Verify

1. Save `app.html`.
2. Open it in Chrome, open DevTools → Network.
3. Click one artist card that triggers the YouTube feed.
4. In the Network tab, the request should go to `127.0.0.1:8787`.
5. In DevTools → Application → Local Storage, there must be no `ytApiKey`.
6. The videos should still render.

If any of those four checks fails, revert the file and leave a note —
don't guess at fixes.

## What NOT to do

- Do not rewrite large chunks of the file.
- Do not change the UI, CSS, or unrelated JS.
- Do not "improve" error handling or caching in `app.html` — the proxy
  already handles both.
- Do not add new endpoints — only use the ones in the table above.
- Do not bump `PROXY_BASE` to a production URL; that swap happens later.

## When done

Add a short line to the Obsidian Build Log:

```
- [x] Phase 2a frontend patch — app.html now calls proxy at 127.0.0.1:8787; API key no longer in browser.
```

and hand back to Claude for Phase 2b (Postgres + auth).

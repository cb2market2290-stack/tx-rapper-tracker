#!/usr/bin/env python3
"""Obsidian backfill for the edge-cache + power-resilience commit
(60ba140). One Build Log row covering both pieces, one Error Log row
recording the heredoc nested-quote pitfall recurrence."""
from pathlib import Path

path = Path.home() / 'Documents' / 'Obsidian Vault' / 'tx-rapper-tracker.md'
text = path.read_text()
lines = text.split('\n')

DATE = '2026-04-28'

BUILD_ROWS = [
    '| __DATE__ | Claude (Cowork) | Edge-cache headers on public routes + POWER_RESILIENCE.md runbook. Two changes shipped together because they both target Mac-hosted-site capacity. (1) src/routes/public.js — Cache-Control on the four public routes (no code-flow changes; just res.set on the way out). /a/:slug + /compare/:slugs get public, s-maxage=300, max-age=60, stale-while-revalidate=600 — Cloudflare edge caches for 5 minutes (snapshots refresh daily so 5 min is well inside the freshness window), browsers cache 1 minute, swr=600 lets clients serve stale while a background fetch refreshes. /robots.txt gets public, max-age=3600 (static; 1 hour). /sitemap.xml gets public, s-maxage=3600, max-age=600 (refreshes when an artist is added/hidden; 1 hour edge, 10 min browser). 4xx responses deliberately do NOT carry Cache-Control — short Cloudflare default caching prevents temporarily-hidden artists from staying 404-d at the edge past when admin flips is_public back. Live-verified via curl -D - on all four routes. Practical impact: anonymous public-page traffic is now effectively unlimited from the Mac-s perspective; home upload sees only the first hit per artist per 5 minutes plus signed-in refreshes. (2) POWER_RESILIENCE.md runbook — three failure modes covered: power outage (APC Back-UPS BE600M1 USD 80 + System Settings auto-boot-on-power-restore), internet outage (manual phone-tether fallback; permanent 5G failover deferred to Hetzner-when-revenue-justifies), Mac sleep / auto-update reboot (System Settings flags to disable both, launchd plist from Phase 3.5.1 already auto-restarts backend on the boot that follows). Plus monitoring (UptimeRobot / Better Stack / Cloudflare Health Checks all free), ISP TOS reality check (Cloudflare Tunnel protects against most enforcement triggers), 5-line verification checklist for every network change, and a Mac-hardware-failure section with Postgres backup recipe + 30-min path to a new machine via git + Hetzner runbook. | src/routes/public.js, POWER_RESILIENCE.md, scripts/save-progress-edge-cache-and-resilience.sh | 0 |',
]

ERROR_ROWS = [
    '| __DATE__ | infra | save-progress-edge-cache-and-resilience.sh first run failed with git pathspec errors because the commit message body contained nested double-quoted phrases (e.g. how does this Mac-hosted site hold up). Bash split the message at those quotes; git treated the suffixes as separate file paths. Fix: rewrite the affected sentences without nested double quotes — pattern was already documented in the 3d.3a error-log row but slipped through. Reinforces the rule: every save-progress-*.sh commit message body must avoid double-quoted phrases. Single quotes inside a double-quoted git -m argument are fine; the trap is specifically nested doubles. | Pass — fix in tree, pattern reinforced |',
]


def ensure_row(all_lines, row, section_header):
    if row in all_lines:
        return all_lines, False
    try:
        i = all_lines.index(section_header)
    except ValueError:
        return all_lines, False
    j = i
    last_table_row = i
    while j < len(all_lines):
        ln = all_lines[j]
        if ln.startswith('|') and not ln.startswith('|--') and not ln.startswith('|------'):
            last_table_row = j
        if j > i and (ln.startswith('##') or ln.strip() == '---'):
            break
        j += 1
    insert_at = last_table_row + 1
    return all_lines[:insert_at] + [row] + all_lines[insert_at:], True


BUILD_ROWS = [r.replace('__DATE__', DATE) for r in BUILD_ROWS]
ERROR_ROWS = [r.replace('__DATE__', DATE) for r in ERROR_ROWS]

inserted_build = 0
for row in BUILD_ROWS:
    lines, ok = ensure_row(lines, row, '## Build Log')
    if ok:
        inserted_build += 1

inserted_err = 0
for row in ERROR_ROWS:
    lines, ok = ensure_row(lines, row, '## Error Log')
    if ok:
        inserted_err += 1

seen = {}
out = []
removed = 0
for ln in lines:
    if ln.startswith(f'| {DATE} |'):
        if seen.get(ln):
            removed += 1
            continue
        seen[ln] = True
    out.append(ln)

if inserted_build or inserted_err or removed:
    path.write_text('\n'.join(out))
    print(f'build-log: +{inserted_build} row(s)')
    print(f'error-log: +{inserted_err} row(s)')
    print(f'duplicates removed: {removed}')
else:
    print('no changes needed — everything already in place')
print('Obsidian:', path)

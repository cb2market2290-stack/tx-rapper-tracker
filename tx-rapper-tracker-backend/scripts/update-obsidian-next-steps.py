#!/usr/bin/env python3
"""Idempotent updater for the '## Next Steps' section of the Obsidian
vault file.

The section was last touched mid-Phase-2b and still listed Phase 2c +
TOTP + Cloudflare deploy as "next." All of those shipped long ago, and
the post-Phase-3b reality is: Phase 3a + 3b are closed, 3c (public
profile pages + shareable compare) is the next concrete deliverable,
and 3d (weekly digest + referral) is the optional follow-on.

Strategy: replace the entire section between '## Next Steps' and the
next top-level header (or the next '---' divider). Idempotent — running
it twice produces the same file.

Run:
    python3 scripts/update-obsidian-next-steps.py
"""
from pathlib import Path

path = Path.home() / 'Documents' / 'Obsidian Vault' / 'tx-rapper-tracker.md'
text = path.read_text()

NEW_SECTION = """## Next Steps

Closed since the last refresh of this section (mid-Phase-2b):

1. ~~**SMTP + password-reset flow**~~ — **DONE in 2b.6 / 2b.7**: ConsoleMailer (dev) + ResendMailer stub + full UI.
2. ~~**Cloudflare Tunnel deploy**~~ — **DONE in 2d / 2e verify**: bundle 3279513 verified end-to-end through a quick tunnel; DEPLOY.md + DEPLOY_LOG.md + scripts/test-tunnel-pinned.sh in tree.
3. ~~**2FA**~~ — **DONE in 2b.13 (TOTP) + 2b.14 (WebAuthn)**: full enroll + sign-in flow + recovery codes + admin disable.
4. ~~**Admin read-only UI**~~ — **DONE in 2b.3**: admin.html + /api/admin/stats|sessions|audit shipped, write surface added in 2b.4 (revoke / disable / enable), audio extraction surface added in 2e.B.
5. ~~**Phase 2c**~~ — **DONE**: librosa worker + GET /api/artists/:id/features + Premium gate + multi-tier pricing (Phase 2e.A).
6. ~~**Phase 3a**~~ — **DONE**: breakout signals matview + saved-search alerts evaluator + cron-driven email + frontend alerts modal.
7. ~~**Phase 3b**~~ — **DONE**: Premium-only AI artist briefs (Claude Haiku 4.5) with sha256 fingerprint cache, 25s timeout, 29 unit tests + curl smoke + detail-page surface.

Now:

8. **Phase 3c — Public profile pages + shareable compare** (≈1 week, per PHASE_3_BRAINSTORM.md). New mount `/a/:slug` and `/compare/:hash` that bypass `requireUser`, serve a stripped-down read-only view of the snapshot chart + a "Sign up to track this artist" CTA. Server-renders the snapshot table so crawlers see the data; chart hydrates client-side. Robots policy is open question 3 from PHASE_3_BRAINSTORM.md — default opt-in feels right but it's a real choice (some artists might object). SEO win + funnel surface.

9. **Phase 3d — Weekly digest + referral** (≈1 week, optional follow-on). Cron-driven digest email keyed on the breakout_signals matview ("Top 5 movers this week, plus 1 emerging artist we noticed"); free-tier opt-in so the email IS the funnel. Stripe coupon issued via the existing webhook on a referred signup that converts to paid (1 month of Pro for the referrer). Open questions 4 + 5 from PHASE_3_BRAINSTORM.md (digest mailer cap; coupon shape — fixed-amount vs percentage).

Explicitly deferred (not on the immediate roadmap):

* **Phase 4 — Platform expansion** (TikTok / Spotify / Apple Music / SoundCloud). Pick one based on whichever data we MOST miss when building the 3a breakout-signal insights against YouTube-only.
* **PWA + push notifications** — covers ~80% of native mobile; skip native unless the iOS-Safari-PWA push path breaks down.
* **Community surface** — comments, fan profiles, "I called this artist first" badges. High moderation cost, slow bootstrap, easy to undercut by a Twitter thread instead. Out of scope until the data side feels finished.

"""

START = '## Next Steps'

# Find the start of the section.
i = text.find(START)
if i < 0:
    raise SystemExit('No "## Next Steps" section found in vault file.')

# Find the end: the next top-level header or '---' divider after START.
rest = text[i + len(START):]
end_offsets = []
for marker in ('\n## ', '\n---'):
    j = rest.find(marker)
    if j >= 0:
        end_offsets.append(j)
if not end_offsets:
    raise SystemExit('Could not find end of Next Steps section.')
end = i + len(START) + min(end_offsets)

old_section = text[i:end]
if old_section.rstrip() == NEW_SECTION.rstrip():
    print('no changes needed — Next Steps section already up to date')
    print('Obsidian:', path)
    raise SystemExit(0)

new_text = text[:i] + NEW_SECTION + text[end:]
# Collapse any accidental triple+ newlines we may have introduced.
while '\n\n\n\n' in new_text:
    new_text = new_text.replace('\n\n\n\n', '\n\n\n')

path.write_text(new_text)
print(f'updated: replaced {len(old_section)} chars with {len(NEW_SECTION)} chars')
print('Obsidian:', path)

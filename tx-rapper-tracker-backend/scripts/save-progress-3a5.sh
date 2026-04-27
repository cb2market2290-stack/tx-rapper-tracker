#!/usr/bin/env bash
# scripts/save-progress-3a5.sh
# One-shot stage + commit for Phase 3a.5 — the saved-searches frontend
# (alerts modal + alerts panel in the auth widget header). Closes the
# loop on Phase 3a: until 3a.5 the alerts evaluator was real, fired
# real emails, but the only way to create a saved search was a curl
# round-trip. With 3a.5 the user can manage alerts entirely from the UI.
#
# Run from anywhere (the script self-anchors via BASH_SOURCE).
#
# After the commit, prints the new HEAD ref.

set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
REPO_ROOT="$( cd "$SCRIPT_DIR/../.." && pwd )"
cd "$REPO_ROOT"

git add \
  tx-rapper-tracker/app.html \
  tx-rapper-tracker-backend/scripts/save-progress-3a5.sh

git commit -m "Phase 3a.5: saved-searches frontend — alerts modal + auth-widget button

Closes the loop on Phase 3a. Until this commit the saved_searches CRUD
endpoints (3a.2) and the email evaluator (3a.3) were real, but the
only way to create or manage a saved search was via curl. With 3a.5,
signed-in users get an 'Alerts' button next to Security and Sign out
that opens a modal with full CRUD over their alerts.

Frontend changes (single-file app.html — no build step):

* Auth widget header (line ~698)
  New btnAlerts ('Alerts') button. Mirrors btnSecurity's
  signed-in/out lifecycle in renderAuthWidget so it's hidden when
  the user is signed out.

* Alerts overlay (#alertsOverlay)
  Two views, toggled by id, to keep modal state simple:
  - #alertsViewList: pill-style 'Free plan / 1 of 1 alerts'
    summary, list of existing rules with Enable/Disable, Edit, and
    Delete buttons per row, an empty-state, a '+ New alert' button,
    and a cap nudge that links to /upgrade when the user is at-cap
    on a non-Premium plan.
  - #alertsViewForm: name, metric (4 options), comparator (4 options),
    threshold (number), scope (Any artist | dropdown of roster
    artists pulled from /api/artists), enabled checkbox, Save / Cancel.
    Doubles as both create (POST) and edit (PATCH) — the hidden
    alFormId field carries the row id when editing.

* Dispatcher cases at line ~1395 (body-level [data-action] switch)
  Eight new cases — alerts-open, alerts-close, alerts-overlay-bg,
  alerts-new, alerts-edit, alerts-delete, alerts-toggle,
  alerts-cancel-edit. Mirrors the security-* pattern.

* JS module at line ~2511 (≈350 lines)
  alertsState global ({rows, planSlug, cap, count, atCap, editingId,
  rosterLoaded}) + openAlerts / closeAlerts / refreshAlertsList /
  renderAlertsSummary / renderAlertsList / startNewAlert /
  startEditAlert / submitAlertForm / deleteAlertRow /
  toggleAlertEnabled / fetchArtistsForScope. POST and PATCH share
  submitAlertForm; the 403 tier_cap response surfaces an inline
  'Upgrade for more' error and routes the row's Upgrade link into
  the existing plan-upgrade dispatcher.

* CSS additions (≈45 lines under the existing .auth-modal scope)
  .al-summary / .al-list / .al-row (with flex-wrap so the row
  collapses cleanly on mobile) / .al-name / .al-rule / .al-grow /
  .al-empty / .al-cap-nudge / .al-form-toggle / a generic .auth-modal
  select rule. .al-row.disabled greys out rules that are paused.

Backend integration notes:

* The list endpoint already returns rows sorted DESC by created_at,
  so newest alerts surface first.
* artistName is resolved frontend-side from the existing artistData
  cache (the service only carries artistId). If the artist was
  removed from the roster after the alert was saved, the row falls
  back to a truncated id rather than 'any artist' so the user
  doesn't think the scope is wrong.
* Pct-growth thresholds are stored as decimal ratios (0.05 = 5%).
  The form display shows the raw number (round-trippable for edit)
  and the list view formats it as a percentage. A guard rejects
  pct thresholds with |n|>50 to catch users typing 5 instead of 0.05.

No backend changes — Phase 3a.2's contract was already complete.
No new tests beyond the already-passing 41 + 14 + 26 = 81 saved-search
tests; live-verify in Chrome covers the UI surface.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"

git rev-parse HEAD

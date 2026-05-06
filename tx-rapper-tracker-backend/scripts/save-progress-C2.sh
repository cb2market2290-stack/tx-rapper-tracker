#!/usr/bin/env bash
set -e
cd /Users/cb2market/clawd/projects/tx-rapper-tracker-backend
git add migrations/015_api_tokens.js src/services/apiTokens.js \
  src/routes/apiTokens.js src/routes/export.js \
  src/middleware/apiKeyAuth.js test/export.smoke.js \
  scripts/save-progress-C2.sh
git commit -m "C.2: B2B implementation

api_tokens migration, token service, export route, apiKeyAuth middleware, 5 smokes (63/63)."

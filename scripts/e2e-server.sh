#!/usr/bin/env bash
# Starts an isolated, freshly seeded TQMS for browser tests (fictional data only).
set -euo pipefail
cd "$(dirname "$0")/.."
export APP_ENV=test
export DATABASE_URL="${E2E_DATABASE_URL:-postgres://tqms:tqms_local_dev@localhost:5432/tqms_e2e}"
export STORAGE_ROOT="$PWD/var/e2e-evidence"
export DISPLAY_TIMEZONE=America/Chicago
export PORT="${E2E_PORT:-3100}"
export LOG_LEVEL=warn
export TQMS_DEMO_PASSWORD="${E2E_PASSWORD:-E2E-Only-Password-2026}"
psql "$DATABASE_URL" -q -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;'
rm -rf "$STORAGE_ROOT"
npx tsx src/server/cli/migrate.ts
npx tsx src/server/cli/storage-init.ts
npx tsx src/server/cli/seed-demo.ts
exec npx tsx src/server/index.ts

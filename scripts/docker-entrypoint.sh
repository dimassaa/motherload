#!/bin/sh
# Container startup: wait for PostgreSQL, bring the schema up to date, seed demo
# data when SEED_DEMO is on, then hand PID 1 to the server so it receives
# SIGTERM directly. Seeding is idempotent: `src/db/seed.js` skips a database
# that already holds components, so restarts and `docker compose up` are safe.
set -eu

node scripts/wait-for-db.js
node src/db/migrate.js

if [ "${SEED_DEMO:-false}" = "true" ] || [ "${SEED_DEMO:-false}" = "1" ]; then
  node src/db/seed.js
else
  echo "SEED_DEMO is off; starting with the existing database contents"
fi

exec node src/server.js

#!/bin/sh
# Container startup: wait for PostgreSQL, bring the schema up to date, then hand
# PID 1 to the server so it receives SIGTERM directly. Demo seeding is added in
# Task 23, once src/db/seed.js exists.
set -eu

node scripts/wait-for-db.js
node src/db/migrate.js
exec node src/server.js

#!/usr/bin/env bash
# README examples against the Postgres and Redis that with-postgres.sh / with-redis.sh provide
# (the examples read the conventional DATABASE_URL and REDIS_URL).
set -euo pipefail
export DATABASE_URL="${PG_TEST_URL:?PG_TEST_URL is not set: run through scripts/with-postgres.sh}"
export REDIS_URL="${REDIS_TEST_URL:?REDIS_TEST_URL is not set: run through scripts/with-redis.sh}"
node_modules/.bin/jest-groups --out .jest-report-examples.json -- node_modules/.bin/jest -c jest.examples.config.js
node_modules/.bin/jest-assert-no-skipped .jest-report-examples.json

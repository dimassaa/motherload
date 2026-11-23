/**
 * Pin the analytics reference date before any module reads `src/config/env.js`.
 *
 * ESM evaluates imports in source order, so a test file that imports this
 * helper first cannot inherit a developer's `.env` value. dotenv does not
 * override an existing process variable, so this value wins for that test
 * process only. Keeping the date explicit makes the May–October 2026 window
 * assertions independent of ambient configuration.
 */
process.env.ANALYTICS_REFERENCE_DATE = '2026-11-22';

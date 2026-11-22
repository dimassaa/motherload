import request from 'supertest';
import { createApp } from '../../src/app.js';

/**
 * Build an isolated application instance with an agent that keeps cookies.
 *
 * Every call creates fresh rate-limit stores inside `createApp`, so a 429 from
 * one test cannot leak into the next test that builds its own app.
 * @returns {{ app: import('express').Express, agent: request.TestAgent }}
 */
export function createTestApp() {
  const app = createApp();
  return { app, agent: request.agent(app) };
}

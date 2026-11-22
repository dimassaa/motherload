import assert from 'node:assert/strict';

const CSRF_INPUT_PATTERN = /name="_csrf" value="([^"]+)"/;

/**
 * Read the session-bound CSRF token from a rendered form.
 * @param {import('supertest').TestAgent} agent
 * @param {string} [path] page that renders a form
 * @returns {Promise<string>}
 */
export async function getCsrf(agent, path = '/') {
  const response = await agent.get(path);
  assert.equal(response.status, 200, `GET ${path} should render a form with a CSRF token`);

  const match = CSRF_INPUT_PATTERN.exec(response.text);
  assert.ok(match, `GET ${path} did not render a CSRF input`);
  return match[1];
}

/**
 * Sign in through the real login form so the session and cookie behaviour is
 * exercised exactly as a browser would exercise it.
 * @param {import('supertest').TestAgent} agent
 * @param {string} email
 * @param {string} password
 * @returns {Promise<import('supertest').Response>}
 */
export async function loginAs(agent, email, password) {
  const token = await getCsrf(agent, '/');
  const response = await agent
    .post('/login')
    .set('User-Agent', 'motherload-test')
    .type('form')
    .send({ email, password, _csrf: token });

  assert.equal(response.status, 302, 'login should redirect after success');
  assert.equal(response.headers.location, '/dashboard');
  return response;
}

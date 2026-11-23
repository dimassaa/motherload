import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import ejs from 'ejs';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { closePool } from '../../src/db/pool.js';
import * as helpers from '../../src/views/helpers.js';

const baseLayoutPath = fileURLToPath(new URL('../../src/views/layouts/base.ejs', import.meta.url));
const flashPartialPath = fileURLToPath(
  new URL('../../src/views/partials/flash.ejs', import.meta.url),
);

/**
 * Render the authenticated chrome without inventing a Task 4 auth flow.
 * The partials only read res.locals-shaped values, so direct locals are enough.
 */
function renderAppLayout() {
  return ejs.renderFile(baseLayoutPath, {
    title: 'Обзор — Motherload',
    body: '<p>Обзор</p>',
    currentUser: { role: 'storekeeper', fullName: 'Марина Сидорова' },
    currentPath: '/stock',
    alertCount: 3,
    flash: null,
    ...helpers,
    csrfField: () => '<input type="hidden" name="_csrf" value="test-token">',
  });
}

/** Extract the CSS block that follows `selector`, counting nested braces. */
function extractCssBlock(css, selector) {
  const selectorIndex = css.indexOf(selector);
  if (selectorIndex === -1) return '';
  const start = css.indexOf('{', selectorIndex);
  let depth = 0;
  for (let index = start; index < css.length; index += 1) {
    if (css[index] === '{') depth += 1;
    if (css[index] === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(start, index + 1);
    }
  }
  return '';
}

test('GET / renders the public landing inside the base layout', async () => {
  const res = await request(createApp()).get('/');

  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /text\/html/);
  assert.match(res.text, /<html lang="ru">/);
  assert.match(res.text, /MOTHERLOAD/);
  assert.match(res.text, /Складской терминал для комплектующих/);
  assert.match(res.text, /href="\/css\/app\.css"/);
  assert.match(res.text, /rel="icon"/);
});

test('GET / ships no inline style attributes or blocks', async () => {
  const res = await request(createApp()).get('/');

  assert.doesNotMatch(res.text, /\sstyle="/);
  assert.doesNotMatch(res.text, /<style[\s>]/);
});

test('GET / keeps public pages indexable and sends no inline scripts', async () => {
  const res = await request(createApp()).get('/');

  assert.doesNotMatch(res.text, /noindex/);
  assert.doesNotMatch(res.text, /<script(?![^>]*\bsrc=)/);
});

test('app layout renders role-aware links and logout inside the no-JS burger', async () => {
  const html = await renderAppLayout();

  assert.match(html, /<details class="app-nav__burger">/);
  assert.match(html, /<summary class="app-nav__burger-summary">/);
  assert.match(html, /aria-label="Мобильная навигация"/);
  assert.match(html, /app-nav__burger-logout" method="post" action="\/logout"/);
  assert.match(html, /aria-current="page"/);
  assert.match(html, /Инвентаризация/);
  assert.doesNotMatch(html, /Администрирование/);
});

test('authenticated header links the identity and the burger account to the profile', async () => {
  const html = await renderAppLayout();

  assert.match(html, /<a class="app-header__identity" href="\/profile">/);
  assert.doesNotMatch(html, /<p class="app-header__identity"/);

  const burgerStart = html.indexOf('app-nav__burger-panel');
  assert.ok(burgerStart > -1, 'the burger panel must render');
  assert.match(
    html.slice(burgerStart),
    /<a class="btn btn--ghost btn--sm" href="\/profile">Профиль<\/a>/,
  );
});

test('mobile breakpoint hides the desktop nav and shows the burger', async () => {
  const css = await readFile(new URL('../../public/css/app.css', import.meta.url), 'utf8');
  const mobileBlock = extractCssBlock(css, '@media (max-width: 1023px)');

  assert.match(mobileBlock, /\.app-nav \{\s*display: none;/);
  assert.match(mobileBlock, /\.app-nav__burger \{\s*display: block;/);
});

test('danger flashes are announced as alerts, other flashes politely', async () => {
  const danger = await ejs.renderFile(flashPartialPath, {
    flash: { type: 'error', message: 'Не хватает 4 шт.' },
  });
  const success = await ejs.renderFile(flashPartialPath, {
    flash: { type: 'success', message: 'Готово' },
  });

  assert.match(danger, /role="alert"/);
  assert.doesNotMatch(danger, /aria-live="polite"/);
  assert.match(success, /role="status"/);
  assert.match(success, /aria-live="polite"/);
});

test.after(async () => {
  await closePool();
});

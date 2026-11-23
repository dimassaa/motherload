import { env } from '../config/env.js';

const PUBLIC_PAGE_URL = new URL('/', env.appUrl).toString();
const SITEMAP_URL = new URL('/sitemap.xml', env.appUrl).toString();

// Crawlers share one rule set. The catalogue and operational screens are behind
// authentication, so they are listed explicitly instead of relying on a 302:
// a crawler that receives a redirect may still keep the URL in its index.
const ROBOTS_TXT = [
  'User-agent: *',
  'Allow: /',
  'Disallow: /dashboard',
  'Disallow: /components',
  'Disallow: /stock',
  'Disallow: /inventory',
  'Disallow: /analytics',
  'Disallow: /alerts',
  'Disallow: /reports',
  'Disallow: /admin',
  'Disallow: /profile',
  'Disallow: /api',
  `Sitemap: ${SITEMAP_URL}`,
  '',
].join('\n');

const SITEMAP_XML = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
  '  <url>',
  `    <loc>${PUBLIC_PAGE_URL}</loc>`,
  '  </url>',
  '</urlset>',
  '',
].join('\n');

/** `GET /robots.txt` — allow the landing, keep every authenticated area out. */
export function showRobots(req, res) {
  res.type('text/plain').send(ROBOTS_TXT);
}

/** `GET /sitemap.xml` — the internal app exposes exactly one public URL. */
export function showSitemap(req, res) {
  res.type('application/xml').send(SITEMAP_XML);
}

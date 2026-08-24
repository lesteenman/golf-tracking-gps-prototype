/*
 * End-to-end check against the deployed site with NOTHING stubbed: real PDOK
 * tiles, real AHN heights, real Overpass. This is the test that proves the
 * prototype works, as opposed to proving the wiring is consistent.
 *
 *   SITE_URL=https://lesteenman.github.io/golf-tracking-gps-prototype/ \
 *     node --test tests/live.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const SITE = (process.env.SITE_URL || process.argv[2] || '').replace(/\/?$/, '/');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = process.env.SHOT_DIR || path.join(ROOT, 'test-results');
const LONG = 180000;      // Overpass mirrors can take a while to fail over

if (!SITE) {
  console.error('SITE_URL is required');
  process.exit(2);
}

function chromiumExecutable() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!base || !fs.existsSync(base)) return undefined;
  for (const dir of fs.readdirSync(base).filter(d => /^chromium-\d+$/.test(d)).sort().reverse()) {
    const exe = path.join(base, dir, 'chrome-linux', 'chrome');
    if (fs.existsSync(exe)) return exe;
  }
  return undefined;
}

let browser, page, tiles = 0, tileFails = 0;

test.before(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  browser = await chromium.launch({ executablePath: chromiumExecutable() });
  page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('response', r => {
    if (!r.url().includes('service.pdok.nl/hwh/')) return;
    if (r.status() === 200) tiles++; else tileFails++;
  });
  page.on('pageerror', e => console.error('page error:', String(e)));
  await page.goto(SITE, { waitUntil: 'load', timeout: 60000 });
});

test.after(async () => { await browser.close(); });

test('the deployed page boots and loads Leaflet from the CDN', async () => {
  await page.waitForFunction(() => window.L && window.GOLF && window.APP, null, { timeout: 30000 });
  assert.equal(await page.title(), 'Course data inspection map — NL');
});

test('real PDOK imagery tiles load', async () => {
  await page.waitForFunction(() => true);
  await page.waitForTimeout(6000);
  console.log(`    tiles: ${tiles} ok, ${tileFails} failed`);
  assert.ok(tiles > 4, `expected aerial tiles to load, got ${tiles} ok / ${tileFails} failed`);
});

test('real Overpass returns the greens at De Scherpenbergh', async () => {
  await page.waitForFunction(() => window.APP.parsed && window.APP.parsed.areas.length > 0,
    null, { timeout: LONG });
  const parsed = await page.evaluate(() => ({
    greens: window.APP.parsed.greenCount,
    areas: window.APP.parsed.areas.length,
    holes: window.APP.parsed.holes.length,
    drawn: window.APP.count('course')
  }));
  console.log(`    OSM: ${parsed.greens} greens, ${parsed.areas} polygons, ${parsed.holes} hole lines`);
  assert.ok(parsed.greens > 0, 'greens loaded');
  assert.equal(parsed.drawn, parsed.areas, 'every parsed polygon is drawn');
  await page.screenshot({ path: path.join(SHOTS, 'live-01-course.png') });
});

test('real AHN answers with a height on hover', async () => {
  await page.mouse.move(640, 450);
  await page.mouse.move(660, 455);
  await page.waitForFunction(() => /^-?\d+\.\d\d$/.test(document.querySelector('#r-height').textContent),
    null, { timeout: 30000 });
  const h = await page.textContent('#r-height');
  console.log(`    AHN height under cursor: ${h} m NAP`);
  assert.match(h, /^-?\d+\.\d\d$/);
});

test('the built-in service check reports all three services up', async () => {
  await page.click('#btn-legend');
  await page.click('#btn-diag');
  await page.waitForFunction(() => document.querySelectorAll('#diag-list .ok, #diag-list .bad').length === 3,
    null, { timeout: LONG });
  const rows = await page.locator('#diag-list li').allTextContents();
  rows.forEach(r => console.log('    ' + r));
  await page.screenshot({ path: path.join(SHOTS, 'live-02-diagnostics.png') });
  assert.equal(rows.filter(r => r.startsWith('✓')).length, 3, JSON.stringify(rows));
});

test('a green can be selected and its relief scanned against live AHN', async () => {
  // Move first, settle, and only then translate the centroid to a screen
  // point: a coordinate computed before the view change is stale by the time
  // the click lands.
  await page.evaluate(() => {
    const g = window.APP.parsed.areas.find(a => a.kind === 'green');
    window.__green = GOLF.centroid(g.rings[0]);
    window.APP.map.setView(window.__green, 19, { animate: false });
  });
  await page.waitForTimeout(2500);
  const pt = await page.evaluate(() => {
    const p = window.APP.map.latLngToContainerPoint(window.__green);
    return { x: Math.round(p.x), y: Math.round(p.y) };
  });
  await page.mouse.click(pt.x, pt.y);
  await page.waitForFunction(() => window.APP.selected, null, { timeout: 30000 });

  await page.click('#btn-scan');
  await page.waitForFunction(() => !window.APP.scanning && window.APP.count('relief') > 0,
    null, { timeout: LONG });
  const status = await page.textContent('#scan-status');
  console.log(`    ${status}`);
  assert.match(status, /fall \d+\.\d\d m over \d+ m/);
  await page.screenshot({ path: path.join(SHOTS, 'live-03-relief.png') });
  // A small JPEG as well: CI logs are the only channel out of some sandboxes.
  await page.screenshot({
    path: path.join(SHOTS, 'live-compact.jpg'), type: 'jpeg', quality: 40,
    clip: { x: 0, y: 0, width: 900, height: 620 }
  });
});

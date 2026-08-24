/*
 * Drives index.html in a real Chromium with PDOK, AHN and Overpass stubbed out,
 * so the wiring can be checked without depending on (or hammering) the live
 * services. Run with:  npm run test:browser
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';

const require = createRequire(import.meta.url);
const F = require('./fixtures.cjs');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = process.env.SHOT_DIR || path.join(ROOT, 'test-results');

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

function serve() {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(fs.readFileSync(file));
  });
  return new Promise(r => server.listen(0, () => r({ server, port: server.address().port })));
}

const TILE = F.tilePng();
const LEAFLET_JS = fs.readFileSync(path.join(ROOT, 'tests/vendor/leaflet.js'));
const LEAFLET_CSS = fs.readFileSync(path.join(ROOT, 'tests/vendor/leaflet.css'));

async function stub(page, opts = {}) {
  const seen = { tiles: [], overpass: [], ahn: 0 };

  await page.route(/cdnjs\.cloudflare\.com/, route => {
    const url = route.request().url();
    if (url.endsWith('.css')) return route.fulfill({ contentType: 'text/css', body: LEAFLET_CSS });
    return route.fulfill({ contentType: 'text/javascript', body: LEAFLET_JS });
  });

  await page.route(/service\.pdok\.nl\/hwh\//, route => {
    seen.tiles.push(route.request().url());
    return route.fulfill({ contentType: 'image/png', body: TILE });
  });

  await page.route(/service\.pdok\.nl\/rws\/ahn\//, route => {
    seen.ahn++;
    if (opts.ahnFails) return route.abort('failed');
    return route.fulfill({ contentType: 'application/json',
      body: JSON.stringify(F.ahnResponse(route.request().url())) });
  });

  for (const host of ['overpass-api.de', 'overpass.kumi.systems', 'overpass.private.coffee', 'maps.mail.ru']) {
    await page.route(new RegExp(host.replace(/\./g, '\\.')), route => {
      seen.overpass.push(host);
      if (opts.overpassFails) return route.abort('failed');
      if (opts.overpassEmpty) {
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ elements: [] }) });
      }
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(F.OVERPASS_FIXTURE) });
    });
  }
  return seen;
}

async function open(browser, port, opts = {}) {
  const page = await browser.newPage({
    viewport: opts.viewport || { width: 1280, height: 900 },
    hasTouch: !!opts.touch, isMobile: !!opts.touch,
    deviceScaleFactor: 1
  });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  const seen = await stub(page, opts);
  await page.goto(`http://127.0.0.1:${port}/${opts.hash || ''}`, { waitUntil: 'load' });
  return { page, seen, errors };
}

const loaded = page => page.waitForFunction(() => window.APP && window.APP.parsed, null, { timeout: 15000 });

// Some sandboxes ship a Chromium that does not match the pinned Playwright
// revision; use whatever build is actually on disk when that happens.
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

let ctx, browser;
test.before(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  ctx = await serve();
  browser = await chromium.launch({ executablePath: chromiumExecutable() });
});
test.after(async () => { await browser.close(); ctx.server.close(); });

/* ---------------------------------------------------------------- */

test('page loads, auto-queries Overpass and draws the course', async () => {
  const { page, seen, errors } = await open(browser, ctx.port);
  await loaded(page);

  const parsed = await page.evaluate(() => ({
    areas: window.APP.parsed.areas.length,
    greens: window.APP.parsed.greenCount,
    holes: window.APP.parsed.holes.length,
    derived: window.APP.parsed.derivedCount,
    pins: window.APP.parsed.pins.length,
    drawn: window.APP.count('course'),
    routes: window.APP.count('routes')
  }));

  assert.equal(parsed.greens, 2);
  assert.equal(parsed.areas, 7, 'clubhouse is not an area kind we draw');
  assert.equal(parsed.holes, 1, 'one mapped golf=hole way');
  assert.equal(parsed.derived, 1, 'hole 2 has no line, so its route is derived');
  assert.equal(parsed.pins, 1);
  assert.equal(parsed.drawn, 7);
  assert.equal(parsed.routes, 2);
  assert.ok(seen.tiles.length > 0, 'imagery requested');
  assert.deepEqual(errors, []);

  await page.screenshot({ path: path.join(SHOTS, '01-desktop.png') });
  await page.close();
});

test('the WMTS path zero-pads the zoom level below 10', async () => {
  const { page, seen } = await open(browser, ctx.port, { hash: '#8/52.14699/6.02040' });
  await page.waitForFunction(() => window.APP, null, { timeout: 10000 });
  await page.waitForTimeout(600);
  const low = seen.tiles.filter(u => /GoogleMapsCompatible\/0\d\//.test(u));
  assert.ok(low.length > 0, 'expected 08 in the path, got e.g. ' + seen.tiles[0]);
  await page.close();
});

test('hovering reports a terrain height and stale answers do not win', async () => {
  const { page } = await open(browser, ctx.port);
  await loaded(page);
  await page.mouse.move(640, 450);
  await page.mouse.move(660, 460);
  await page.waitForFunction(() => /\d/.test(document.querySelector('#probe b').textContent),
    null, { timeout: 10000 });
  const probe = await page.textContent('#probe b');
  const hud = await page.textContent('#r-height');
  assert.match(probe, /^\d+\.\d\d$/);
  assert.equal(probe, hud);
  await page.close();
});

test('tapping the map places a marker and reports height (touch device)', async () => {
  const { page } = await open(browser, ctx.port, { touch: true, viewport: { width: 412, height: 915 } });
  await loaded(page);
  await page.locator('#map').tap({ position: { x: 200, y: 430 } });
  await page.waitForFunction(() => /\d/.test(document.querySelector('#r-height').textContent),
    null, { timeout: 10000 });
  assert.match(await page.textContent('#r-height'), /^-?\d+\.\d\d$/);
  await page.screenshot({ path: path.join(SHOTS, '02-phone.png') });
  await page.close();
});

test('hole routes are labelled with number and par', async () => {
  const { page } = await open(browser, ctx.port);
  await loaded(page);
  const labels = await page.locator('.hole-label').allTextContents();
  assert.ok(labels.includes('#1 · par 4'), JSON.stringify(labels));
  assert.ok(labels.some(l => l.endsWith('*')), 'derived routes are marked');
  await page.close();
});

test('selecting a green and scanning it draws contours', async () => {
  const { page } = await open(browser, ctx.port);
  await loaded(page);

  // Click the centre of green 1 through the map, in pixel space.
  const pt = await page.evaluate(() => {
    const g = window.APP.parsed.areas.find(a => a.kind === 'green' && a.ref === '1');
    const c = GOLF.centroid(g.rings[0]);
    const p = window.APP.map.latLngToContainerPoint(c);
    return { x: p.x, y: p.y };
  });
  await page.mouse.click(pt.x, pt.y);
  await page.waitForFunction(() => window.APP.selected && window.APP.selected.kind === 'green',
    null, { timeout: 5000 });

  await page.click('#btn-scan');
  await page.waitForFunction(() => !window.APP.scanning && window.APP.count('relief') > 0,
    null, { timeout: 60000 });

  const status = await page.textContent('#scan-status');
  assert.match(status, /fall \d+\.\d\d m over \d+ m/);
  // One multi-polyline per contour level, plus a label marker on every other one.
  const relief = await page.evaluate(() => ({
    layers: window.APP.count('relief'),
    levels: window.APP.layers.relief.getLayers().filter(l => l.getLatLngs).length
  }));
  assert.ok(relief.levels >= 3, 'several contour levels drawn, got ' + relief.levels);
  assert.ok(relief.layers > relief.levels, 'contours are labelled');
  await page.screenshot({ path: path.join(SHOTS, '03-relief.png') });
  await page.close();
});

test('coverage panel summarises the survey, filters and flies', async () => {
  const { page } = await open(browser, ctx.port);
  await loaded(page);
  await page.click('#btn-coverage');
  await page.waitForFunction(() => document.querySelectorAll('#cov-list li').length > 0, null, { timeout: 10000 });

  const summary = await page.textContent('#cov-summary');
  assert.match(summary, /296 courses tagged/);
  assert.match(summary, /178 \(60%\) with 9\+ greens/);

  await page.fill('#cov-search', 'scherpenbergh');
  await page.waitForFunction(() => document.querySelectorAll('#cov-list li').length === 1, null, { timeout: 5000 });
  await page.screenshot({ path: path.join(SHOTS, '04-coverage.png') });

  await page.click('#cov-list li button');
  await page.waitForFunction(() => Math.abs(window.APP.map.getCenter().lat - 52.14699) < 0.01,
    null, { timeout: 5000 });
  await page.close();
});

test('sorting the coverage list by name reorders it', async () => {
  const { page } = await open(browser, ctx.port);
  await loaded(page);
  await page.click('#btn-coverage');
  await page.waitForFunction(() => document.querySelectorAll('#cov-list li').length > 0, null, { timeout: 10000 });
  const byGreens = await page.locator('#cov-list .cname').first().textContent();
  await page.click('.cov-sort button[data-key="name"]');
  const byName = await page.locator('#cov-list .cname').first().textContent();
  assert.notEqual(byGreens, byName);
  await page.close();
});

test('imagery toggle switches to the 25 cm summer layer', async () => {
  const { page, seen } = await open(browser, ctx.port);
  await loaded(page);
  await page.click('#btn-imagery');
  await page.waitForTimeout(700);
  assert.ok(seen.tiles.some(u => u.includes('Actueel_ortho25')), 'summer tiles requested');
  assert.match(await page.textContent('#btn-imagery'), /Summer/);
  await page.close();
});

test('the diagnostics panel reports each service separately', async () => {
  const { page } = await open(browser, ctx.port);
  await loaded(page);
  await page.click('#btn-legend');
  await page.click('#btn-diag');
  await page.waitForFunction(() => document.querySelectorAll('#diag-list .ok, #diag-list .bad').length === 3,
    null, { timeout: 20000 });
  const marks = await page.locator('#diag-list li').allTextContents();
  assert.equal(marks.filter(t => t.startsWith('✓')).length, 3, JSON.stringify(marks));
  assert.ok(marks.some(t => /m NAP/.test(t)), 'height probe reports a value: ' + JSON.stringify(marks));
  await page.screenshot({ path: path.join(SHOTS, '06-diagnostics.png') });
  await page.close();
});

test('diagnostics single out the service that is actually down', async () => {
  const { page } = await open(browser, ctx.port, { ahnFails: true });
  await loaded(page);
  await page.click('#btn-legend');
  await page.click('#btn-diag');
  await page.waitForFunction(() => document.querySelectorAll('#diag-list .ok, #diag-list .bad').length === 3,
    null, { timeout: 20000 });
  const marks = await page.locator('#diag-list li').allTextContents();
  assert.equal(marks.filter(t => t.startsWith('✓')).length, 2, JSON.stringify(marks));
  assert.ok(marks.some(t => t.startsWith('✗') && t.includes('height')), JSON.stringify(marks));
  await page.close();
});

test('a total Overpass outage names the endpoints it tried', async () => {
  const { page, seen } = await open(browser, ctx.port, { overpassFails: true });
  await page.waitForFunction(() => document.querySelector('#note').classList.contains('err'),
    null, { timeout: 30000 });
  const note = await page.textContent('#note');
  assert.match(note, /Could not reach any Overpass endpoint/);
  assert.match(note, /overpass-api\.de/);
  assert.equal(new Set(seen.overpass).size, 4, 'every mirror was tried');
  await page.screenshot({ path: path.join(SHOTS, '05-overpass-down.png') });
  await page.close();
});

test('an unmapped area says so instead of looking broken', async () => {
  const { page } = await open(browser, ctx.port, { overpassEmpty: true });
  await loaded(page);
  assert.match(await page.textContent('#note'), /No golf features here in OpenStreetMap/);
  await page.close();
});

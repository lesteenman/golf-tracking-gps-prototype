#!/usr/bin/env node
/*
 * Hits the three live services and checks they behave the way the page assumes.
 * Run it anywhere with real network access:
 *
 *   node scripts/check-live-services.mjs
 *
 * It uses the same URL builders as the page (lib.js), so a passing run is
 * evidence about the actual requests the browser will make — layer names,
 * the zero-padded WMTS zoom, the AHN BBOX axis order, and CORS.
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const G = require('../lib.js');

const CENTRE = { lat: 52.14699, lon: 6.0204 };     // De Scherpenbergh, Apeldoorn
const results = [];

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(42)} ${detail}`);
}

function tileXY(lat, lon, z) {
  const n = 2 ** z;
  const x = Math.floor((lon + 180) / 360 * n);
  const rad = lat * Math.PI / 180;
  const y = Math.floor((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2 * n);
  return { x, y };
}

async function head(url) {
  const r = await fetch(url, { headers: { Origin: 'https://lesteenman.github.io' } });
  const buf = await r.arrayBuffer();
  return { status: r.status, type: r.headers.get('content-type'), bytes: buf.byteLength,
           cors: r.headers.get('access-control-allow-origin') };
}

/* ---------- 1. imagery ---------- */

for (const [layer, label] of [['Actueel_orthoHR', '8 cm winter'], ['Actueel_ortho25', '25 cm summer']]) {
  const z = 17, { x, y } = tileXY(CENTRE.lat, CENTRE.lon, z);
  const url = G.pdokTileUrl(layer, z, x, y);
  try {
    const r = await head(url);
    record(`imagery ${layer} (${label})`,
      r.status === 200 && /image/.test(r.type || '') && r.bytes > 1000,
      `HTTP ${r.status} ${r.type} ${r.bytes} B, CORS ${r.cors || 'none'}`);
  } catch (e) {
    record(`imagery ${layer} (${label})`, false, e.message);
  }
}

// The whole point of overriding getTileUrl: the zoom is zero-padded in the path.
{
  const z = 8, { x, y } = tileXY(CENTRE.lat, CENTRE.lon, z);
  const padded = G.pdokTileUrl('Actueel_orthoHR', z, x, y);
  const plain = padded.replace('/08/', '/8/');
  try {
    const a = await head(padded), b = await head(plain);
    record('zero-padded zoom is required at z<10',
      a.status === 200 && b.status !== 200,
      `padded HTTP ${a.status}, unpadded HTTP ${b.status}`);
  } catch (e) {
    record('zero-padded zoom is required at z<10', false, e.message);
  }
}

/* ---------- 2. terrain height ---------- */

for (const model of ['dtm_05m', 'dsm_05m']) {
  const url = G.ahnFeatureInfoUrl(CENTRE.lat, CENTRE.lon, model);
  try {
    const r = await fetch(url, { headers: { Origin: 'https://lesteenman.github.io' } });
    const cors = r.headers.get('access-control-allow-origin');
    const json = await r.json();
    const v = G.parseAhnValue(json);
    record(`height ${model} at Apeldoorn`,
      r.status === 200 && v !== null,
      `HTTP ${r.status} → ${v === null ? JSON.stringify(json).slice(0, 120) : v.toFixed(2) + ' m NAP'}, CORS ${cors || 'none'}`);
  } catch (e) {
    record(`height ${model} at Apeldoorn`, false, e.message);
  }
}

// A point below sea level: negative values must survive parsing, not be nulled.
{
  const url = G.ahnFeatureInfoUrl(52.4600, 4.6100, 'dtm_05m');   // Haarlemmermeer polder
  try {
    const v = G.parseAhnValue(await (await fetch(url)).json());
    record('height parses negative NAP values', v !== null && v < 0, `${v} m NAP`);
  } catch (e) {
    record('height parses negative NAP values', false, e.message);
  }
}

/* ---------- 3. course geometry ---------- */

const query = G.overpassQuery({
  south: CENTRE.lat - 0.006, west: CENTRE.lon - 0.010,
  north: CENTRE.lat + 0.006, east: CENTRE.lon + 0.010
});

let anyOverpass = false;
for (const endpoint of [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter'
]) {
  const host = new URL(endpoint).host;
  try {
    const ctl = AbortSignal.timeout(60000);
    const r = await fetch(endpoint, {
      method: 'POST', body: 'data=' + encodeURIComponent(query),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://lesteenman.github.io' },
      signal: ctl
    });
    const cors = r.headers.get('access-control-allow-origin');
    const json = await r.json();
    const parsed = G.parseGolfElements(json.elements);
    const ok = r.status === 200 && parsed.greenCount > 0;
    if (ok) anyOverpass = true;
    record(`course data via ${host}`, ok,
      `HTTP ${r.status} → ${parsed.greenCount} greens, ${parsed.areas.length} polygons, ` +
      `${parsed.holes.length} hole lines, ${parsed.pins.length} pins, CORS ${cors || 'none'}`);
  } catch (e) {
    record(`course data via ${host}`, false, e.name === 'TimeoutError' ? 'timed out' : e.message);
  }
}

/* ---------- verdict ---------- */

const required = results.filter(r => !/course data via/.test(r.name));
const failed = required.filter(r => !r.ok);
console.log('');
if (!anyOverpass) {
  console.log('FAIL  no Overpass endpoint returned course data');
}
if (failed.length || !anyOverpass) {
  console.log(`${failed.length + (anyOverpass ? 0 : 1)} check(s) failed`);
  process.exit(1);
}
console.log(`all ${results.length} checks passed (${results.filter(r => r.ok).length} ok)`);

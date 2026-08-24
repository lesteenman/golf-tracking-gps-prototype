#!/usr/bin/env node
/*
 * Regenerates data/nl-course-coverage.json from OpenStreetMap.
 *
 *   node scripts/build-coverage.mjs                 # whole country, slow (minutes)
 *   node scripts/build-coverage.mjs --bbox 52.0,5.9,52.3,6.2
 *   node scripts/build-coverage.mjs --out /tmp/x.json --area '["ISO3166-1"="NL"]'
 *
 * Method, kept deliberately identical to the survey committed in the repo:
 *   1. find golf course polygons (leisure=golf_course) and take their centres,
 *   2. fetch every golf=* feature centre in the same area,
 *   3. assign each feature to the nearest course centre within 2 km.
 *
 * That last step is why multi-course facilities can merge into one entry: two
 * 18-hole loops sharing a clubhouse sit well inside 2 km of each other.
 *
 * Note the default area is the OSM relation for the Netherlands, which includes
 * the Caribbean municipalities — and, depending on which relation Overpass
 * resolves, courses on Aruba, Curacao and Sint Maarten. They are kept in the
 * output and flagged in the UI, because PDOK imagery and AHN heights stop at
 * the European coast.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter'
];

const KINDS = ['green', 'fairway', 'tee', 'hole', 'pin', 'bunker'];
const MAX_ASSIGN_M = 2000;

export function metres(a, b) {
  const R = 6371008.8, f1 = a[0] * Math.PI / 180, f2 = b[0] * Math.PI / 180;
  const df = f2 - f1, dl = (b[1] - a[1]) * Math.PI / 180;
  const h = Math.sin(df / 2) ** 2 + Math.cos(f1) * Math.cos(f2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Centre of an Overpass element, whether it came back as `center` or a node. */
export function elementCentre(el) {
  if (el.center) return [el.center.lat, el.center.lon];
  if (typeof el.lat === 'number') return [el.lat, el.lon];
  return null;
}

/**
 * Assign golf features to the nearest course centroid within 2 km.
 * Returns one row per course, plus the number of features that matched nothing.
 */
export function assignToCourses(courses, features, maxM = MAX_ASSIGN_M) {
  const rows = courses.map(c => {
    const row = { osm: c.osm, name: c.name || '(unnamed)', lat: round(c.lat), lon: round(c.lon) };
    for (const k of KINDS) row[k] = 0;
    return row;
  });
  let orphans = 0;

  for (const f of features) {
    if (!KINDS.includes(f.kind)) continue;
    let best = -1, bestD = Infinity;
    for (let i = 0; i < courses.length; i++) {
      const d = metres([f.lat, f.lon], [courses[i].lat, courses[i].lon]);
      if (d < bestD) { bestD = d; best = i; }
    }
    if (best === -1 || bestD > maxM) { orphans++; continue; }
    rows[best][f.kind]++;
  }

  rows.sort((a, b) => b.green - a.green || a.name.localeCompare(b.name));
  return { rows, orphans };
}

function round(v) { return Math.round(v * 1e5) / 1e5; }

/* ---------------- Overpass plumbing ---------------- */

async function overpass(query, { timeoutMs = 900000 } = {}) {
  let lastErr;
  for (const url of ENDPOINTS) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      process.stderr.write(`  → ${new URL(url).host} … `);
      const r = await fetch(url, {
        method: 'POST',
        body: 'data=' + encodeURIComponent(query),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        signal: ctl.signal
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const json = await r.json();
      process.stderr.write(`${json.elements.length} elements\n`);
      return json;
    } catch (err) {
      process.stderr.write(`failed (${err.message})\n`);
      lastErr = err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error('every Overpass endpoint failed: ' + lastErr?.message);
}

function scope(opts) {
  // Either a bbox (fast, for testing) or an area filter (the real survey).
  return opts.bbox
    ? { prefix: '', suffix: `(${opts.bbox})` }
    : { prefix: `area${opts.area}->.nl;`, suffix: '(area.nl)' };
}

export async function build(opts) {
  const { prefix, suffix } = scope(opts);

  process.stderr.write('Course polygons…\n');
  const courseData = await overpass(
    `[out:json][timeout:600];${prefix}` +
    `(way["leisure"="golf_course"]${suffix};relation["leisure"="golf_course"]${suffix};);out center tags;`
  );
  const courses = courseData.elements.map(el => {
    const c = elementCentre(el);
    return c && { osm: `${el.type}/${el.id}`, name: (el.tags && el.tags.name) || '(unnamed)', lat: c[0], lon: c[1] };
  }).filter(Boolean);
  process.stderr.write(`${courses.length} course polygons\n`);

  process.stderr.write('Golf features…\n');
  const featureData = await overpass(
    `[out:json][timeout:600];${prefix}` +
    `(way["golf"]${suffix};relation["golf"]${suffix};node["golf"]${suffix};);out center tags;`
  );
  const features = featureData.elements.map(el => {
    const c = elementCentre(el);
    return c && { kind: el.tags && el.tags.golf, lat: c[0], lon: c[1] };
  }).filter(f => f && f.kind);
  process.stderr.write(`${features.length} golf features\n`);

  const { rows, orphans } = assignToCourses(courses, features);
  process.stderr.write(`${orphans} features matched no course within 2 km\n`);

  return {
    source: 'OpenStreetMap via Overpass',
    generated: opts.today,
    note: 'counts assigned to nearest course centroid within 2 km; multi-course facilities may be merged',
    courses: rows
  };
}

/* ---------------- CLI ---------------- */

function parseArgs(argv) {
  const opts = {
    out: path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'nl-course-coverage.json'),
    area: '["ISO3166-1"="NL"][admin_level=2]',
    bbox: null,
    today: new Date().toISOString().slice(0, 10)
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') opts.out = argv[++i];
    else if (argv[i] === '--bbox') opts.bbox = argv[++i];
    else if (argv[i] === '--area') opts.area = argv[++i];
  }
  return opts;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const opts = parseArgs(process.argv.slice(2));
  build(opts).then(result => {
    fs.writeFileSync(opts.out, JSON.stringify(result, null, 1) + '\n');
    const nine = result.courses.filter(c => c.green >= 9).length;
    process.stderr.write(
      `\nWrote ${opts.out}\n${result.courses.length} courses, ` +
      `${nine} with 9+ greens (${Math.round(nine / result.courses.length * 100)}%)\n`);
  }).catch(err => {
    process.stderr.write('\n' + err.message + '\n');
    process.exit(1);
  });
}

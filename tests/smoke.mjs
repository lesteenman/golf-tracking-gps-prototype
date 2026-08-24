#!/usr/bin/env node
/*
 * Checks that the deployed site is actually serving — a green Actions run is
 * not proof of that. Retries, because Pages takes a minute to publish.
 *
 *   node tests/smoke.mjs https://lesteenman.github.io/golf-tracking-gps-prototype/
 *   SITE_URL=... node tests/smoke.mjs
 */
const url = (process.argv[2] || process.env.SITE_URL || '').replace(/\/?$/, '/');
if (!url) {
  console.error('usage: node tests/smoke.mjs <site-url>');
  process.exit(2);
}

const ASSETS = ['', 'lib.js', 'app.js', 'styles.css', 'data/nl-course-coverage.json'];
const MUST_CONTAIN = ['id="map"', 'lib.js', 'app.js', 'Load course here'];
const ATTEMPTS = Number(process.env.SMOKE_ATTEMPTS || 10);

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function get(u) {
  const r = await fetch(u, { redirect: 'follow' });
  return { status: r.status, body: await r.text() };
}

let failed = false;
for (const asset of ASSETS) {
  const target = url + asset;
  let res = null;
  for (let i = 1; i <= ATTEMPTS; i++) {
    try {
      res = await get(target);
      if (res.status === 200) break;
    } catch (err) {
      res = { status: 0, body: String(err) };
    }
    if (i < ATTEMPTS) await sleep(Math.min(30000, 2000 * i));
  }
  if (!res || res.status !== 200) {
    console.error(`FAIL ${target} → ${res ? res.status : 'no response'}`);
    failed = true;
    continue;
  }
  console.log(`ok   ${target} → 200 (${res.body.length} bytes)`);

  if (asset === '') {
    for (const needle of MUST_CONTAIN) {
      if (!res.body.includes(needle)) {
        console.error(`FAIL index.html does not contain ${JSON.stringify(needle)}`);
        failed = true;
      }
    }
  }
  if (asset.endsWith('.json')) {
    const data = JSON.parse(res.body);
    if (!Array.isArray(data.courses) || data.courses.length < 100) {
      console.error('FAIL coverage json looks wrong: ' + res.body.slice(0, 120));
      failed = true;
    }
  }
}

console.log(failed ? '\nsmoke test FAILED' : '\nsmoke test passed');
process.exit(failed ? 1 : 0);

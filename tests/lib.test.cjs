'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../lib.js');

/* ---------- PDOK WMTS tile URLs ---------- */

test('tile URL zero-pads the zoom level below 10', () => {
  assert.equal(
    G.pdokTileUrl('Actueel_orthoHR', 8, 132, 84),
    'https://service.pdok.nl/hwh/luchtfotorgb/wmts/v1_0/Actueel_orthoHR/OGC:1.0:GoogleMapsCompatible/08/132/84.jpeg'
  );
});

test('tile URL leaves two-digit zoom levels alone', () => {
  assert.match(G.pdokTileUrl('Actueel_ortho25', 17, 1, 2), /GoogleMapsCompatible\/17\/1\/2\.jpeg$/);
  assert.match(G.pdokTileUrl('Actueel_ortho25', 21, 1, 2), /GoogleMapsCompatible\/21\/1\/2\.jpeg$/);
});

/* ---------- Overpass ---------- */

test('overpass query asks for ways and relations in south,west,north,east order', () => {
  const q = G.overpassQuery({ south: 52.1, west: 6.0, north: 52.2, east: 6.1 });
  assert.match(q, /\[out:json\]/);
  assert.ok(q.includes('way["golf"](52.10000,6.00000,52.20000,6.10000)'), q);
  assert.ok(q.includes('relation["golf"](52.10000,6.00000,52.20000,6.10000)'), q);
  assert.ok(q.includes('node["golf"](52.10000,6.00000,52.20000,6.10000)'), q);
  assert.match(q, /out geom;/);
});

test('overpass query clamps an oversized bbox so the request stays sane', () => {
  const q = G.overpassQuery({ south: 40, west: 0, north: 60, east: 20 }, { maxSpan: 0.5 });
  const m = q.match(/way\["golf"\]\(([-\d.]+),([-\d.]+),([-\d.]+),([-\d.]+)\)/);
  assert.ok(m, q);
  assert.ok(Number(m[3]) - Number(m[1]) <= 0.5 + 1e-9);
  assert.ok(Number(m[4]) - Number(m[2]) <= 0.5 + 1e-9);
});

/* ---------- parsing Overpass results ---------- */

const SAMPLE = [
  { type: 'way', id: 1, tags: { golf: 'green', ref: '1' },
    geometry: [{ lat: 0, lon: 0 }, { lat: 0, lon: 1 }, { lat: 1, lon: 1 }, { lat: 0, lon: 0 }] },
  { type: 'way', id: 2, tags: { golf: 'hole', ref: '1', par: '4', name: 'Eik' },
    geometry: [{ lat: 0, lon: 0 }, { lat: 0.5, lon: 0.5 }, { lat: 1, lon: 1 }] },
  { type: 'node', id: 3, tags: { golf: 'pin', ref: '1' }, lat: 0.9, lon: 0.9 },
  { type: 'relation', id: 4, tags: { golf: 'water_hazard' },
    members: [
      { type: 'way', role: 'outer', geometry: [{ lat: 2, lon: 2 }, { lat: 2, lon: 3 }, { lat: 3, lon: 3 }] },
      { type: 'way', role: 'inner', geometry: [{ lat: 2.4, lon: 2.4 }, { lat: 2.4, lon: 2.6 }, { lat: 2.6, lon: 2.6 }] }
    ] },
  { type: 'way', id: 5, tags: { golf: 'clubhouse' }, geometry: [{ lat: 0, lon: 0 }, { lat: 0, lon: 1 }] },
  { type: 'way', id: 6, tags: { golf: 'green' }, geometry: [] }
];

test('parse splits areas, hole routes and pins', () => {
  const p = G.parseGolfElements(SAMPLE);
  assert.equal(p.areas.length, 2);
  assert.equal(p.holes.length, 1);
  assert.equal(p.pins.length, 1);
  assert.equal(p.greenCount, 1);
});

test('parse keeps hole number and par off the golf=hole way', () => {
  const hole = G.parseGolfElements(SAMPLE).holes[0];
  assert.equal(hole.ref, '1');
  assert.equal(hole.par, 4);
  assert.equal(hole.points.length, 3);
  assert.equal(hole.derived, false);
});

test('parse keeps relation outer and inner rings apart', () => {
  const water = G.parseGolfElements(SAMPLE).areas.find(a => a.kind === 'water_hazard');
  assert.equal(water.rings.length, 1);
  assert.equal(water.holes.length, 1);
});

test('parse drops unstyled kinds and empty geometry', () => {
  const kinds = G.parseGolfElements(SAMPLE).areas.map(a => a.kind);
  assert.deepEqual(kinds.sort(), ['green', 'water_hazard']);
});

test('parse survives a null or malformed element list', () => {
  assert.equal(G.parseGolfElements(null).areas.length, 0);
  assert.equal(G.parseGolfElements([{ type: 'way' }]).areas.length, 0);
});

/* ---------- hole routing fallback ---------- */

test('derived routes connect tee to green when golf=hole is missing', () => {
  const areas = [
    { kind: 'tee', ref: '7', rings: [[[52.0, 6.0], [52.0, 6.0002], [52.0002, 6.0002]]] },
    { kind: 'green', ref: '7', rings: [[[52.004, 6.004], [52.004, 6.0042], [52.0042, 6.0042]]] }
  ];
  const routes = G.deriveHoleRoutes(areas, []);
  assert.equal(routes.length, 1);
  assert.equal(routes[0].ref, '7');
  assert.equal(routes[0].derived, true);
  assert.equal(routes[0].points.length, 2);
});

test('no derived route where a mapped hole line already exists', () => {
  const areas = [
    { kind: 'tee', ref: '7', rings: [[[52.0, 6.0], [52.0, 6.0002], [52.0002, 6.0002]]] },
    { kind: 'green', ref: '7', rings: [[[52.004, 6.004], [52.004, 6.0042], [52.0042, 6.0042]]] }
  ];
  assert.equal(G.deriveHoleRoutes(areas, [{ ref: '7', points: [[52, 6], [52.004, 6.004]] }]).length, 0);
});

/* ---------- geometry ---------- */

test('haversine matches a known one-degree-of-latitude distance', () => {
  const d = G.metres([52, 6], [53, 6]);
  assert.ok(Math.abs(d - 111195) < 200, `got ${d}`);
});

test('polygon centroid of a square is its middle, not vertex-weighted', () => {
  const c = G.centroid([[0, 0], [0, 2], [2, 2], [2, 0], [0, 0]]);
  assert.ok(Math.abs(c[0] - 1) < 1e-9 && Math.abs(c[1] - 1) < 1e-9, JSON.stringify(c));
});

test('point in ring', () => {
  const ring = [[0, 0], [0, 2], [2, 2], [2, 0]];
  assert.equal(G.pointInRing([1, 1], ring), true);
  assert.equal(G.pointInRing([3, 1], ring), false);
});

/* ---------- AHN ---------- */

test('AHN GetFeatureInfo url is WMS 1.3.0 with a lat,lon bbox around the point', () => {
  const u = new URL(G.ahnFeatureInfoUrl(52.147, 6.0186));
  const p = u.searchParams;
  assert.equal(p.get('REQUEST'), 'GetFeatureInfo');
  assert.equal(p.get('VERSION'), '1.3.0');
  assert.equal(p.get('CRS'), 'EPSG:4326');
  assert.equal(p.get('QUERY_LAYERS'), 'dtm_05m');
  assert.equal(p.get('INFO_FORMAT'), 'application/json');
  const [s, w, n, e] = p.get('BBOX').split(',').map(Number);
  assert.ok(s < 52.147 && 52.147 < n, 'latitude first');
  assert.ok(w < 6.0186 && 6.0186 < e, 'longitude second');
  assert.equal(Number(p.get('I')), Math.floor(Number(p.get('WIDTH')) / 2));
  assert.equal(Number(p.get('J')), Math.floor(Number(p.get('HEIGHT')) / 2));
});

test('AHN url can query the surface model instead', () => {
  assert.match(G.ahnFeatureInfoUrl(52, 6, 'dsm_05m'), /QUERY_LAYERS=dsm_05m/);
});

test('AHN value parsing handles the documented shape, negatives and nodata', () => {
  assert.equal(G.parseAhnValue({ features: [{ properties: { value_list: '15.3571' } }] }), 15.3571);
  assert.equal(G.parseAhnValue({ features: [{ properties: { value_list: '-4.2' } }] }), -4.2);
  assert.equal(G.parseAhnValue({ features: [{ properties: { value_list: ['3.5'] } }] }), 3.5);
  assert.equal(G.parseAhnValue({ features: [] }), null);
  assert.equal(G.parseAhnValue({ features: [{ properties: { value_list: 'nodata' } }] }), null);
  assert.equal(G.parseAhnValue({ features: [{ properties: { value_list: '-9999' } }] }), null);
  assert.equal(G.parseAhnValue(null), null);
});

/* ---------- green relief sampling ---------- */

test('sample grid covers the bounds and masks to the ring', () => {
  const ring = [[52.0, 6.0], [52.0, 6.001], [52.001, 6.001], [52.001, 6.0]];
  const g = G.sampleGrid(ring, 5);
  assert.equal(g.n, 5);
  assert.equal(g.points.length, 25);
  assert.ok(g.points.every(p => p.lat >= 51.9999 && p.lat <= 52.0011));
  assert.ok(g.points.filter(p => p.inside).length >= 9);
});

test('marching squares traces one closed-ish isoline through a cone', () => {
  const n = 9, v = [];
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    v.push(10 - Math.hypot(i - 4, j - 4) / 4);
  }
  const segs = G.isolines(v, n, [9.5]);
  assert.ok(segs.length > 8, `expected a ring of segments, got ${segs.length}`);
  assert.ok(segs.every(s => s.level === 9.5));
});

test('marching squares skips cells with missing samples', () => {
  const n = 3;
  const v = [0, 1, 2, 1, null, 3, 2, 3, 4];
  assert.equal(G.isolines(v, n, [2]).some(s => !isFinite(s.a[0])), false);
});

test('contour levels step through the range without exploding', () => {
  assert.deepEqual(G.contourLevels(1.02, 1.6, 0.25), [1.25, 1.5]);
  assert.ok(G.contourLevels(0, 500, 0.25).length <= 40);
  assert.deepEqual(G.contourLevels(3, 3, 0.25), []);
});

/* ---------- coverage list ---------- */

const COURSES = [
  { name: 'Alpha', green: 22, hole: 18, pin: 18, fairway: 20, bunker: 5, lat: 52.1, lon: 6.0 },
  { name: 'Beta', green: 4, hole: 0, pin: 0, fairway: 0, bunker: 0, lat: 52.2, lon: 5.0 },
  { name: 'Gamma', green: 0, hole: 18, pin: 18, fairway: 0, bunker: 0, lat: 12.06, lon: -68.84 }
];

test('coverage classification follows the 9-green threshold', () => {
  assert.equal(G.classifyCoverage(COURSES[0]), 'full');
  assert.equal(G.classifyCoverage(COURSES[1]), 'partial');
  assert.equal(G.classifyCoverage(COURSES[2]), 'none');
});

test('coverage summary counts courses, not features', () => {
  const s = G.summarizeCoverage(COURSES);
  assert.equal(s.total, 3);
  assert.equal(s.full, 1);
  assert.equal(s.partial, 1);
  assert.equal(s.none, 1);
  assert.equal(s.withHoles, 1);   // full courses that also have hole lines
  assert.equal(s.offshore, 1);    // outside the AHN / PDOK imagery footprint
});

test('courses outside the Dutch mainland are flagged, since PDOK has no imagery there', () => {
  assert.equal(G.hasDutchImagery(52.147, 6.018), true);
  assert.equal(G.hasDutchImagery(12.06, -68.84), false);
});

test('sorting is stable and reversible', () => {
  assert.deepEqual(G.sortCourses(COURSES, 'green', 'desc').map(c => c.name), ['Alpha', 'Beta', 'Gamma']);
  assert.deepEqual(G.sortCourses(COURSES, 'green', 'asc').map(c => c.name), ['Gamma', 'Beta', 'Alpha']);
  assert.deepEqual(G.sortCourses(COURSES, 'name', 'asc').map(c => c.name), ['Alpha', 'Beta', 'Gamma']);
});

test('filtering is case and accent insensitive', () => {
  assert.equal(G.filterCourses(COURSES, 'alp').length, 1);
  assert.equal(G.filterCourses([{ name: 'Golfsociëteit De Lage Vuursche' }], 'societeit').length, 1);
  assert.equal(G.filterCourses(COURSES, '').length, 3);
});

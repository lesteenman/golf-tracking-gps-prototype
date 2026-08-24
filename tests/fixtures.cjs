'use strict';
/* Fake responses for the three services, so the page can be driven in a real
   browser without touching PDOK, AHN or Overpass. Geometry sits on top of
   De Scherpenbergh near Apeldoorn, the app's default view. */

const zlib = require('node:zlib');

const CENTRE = { lat: 52.14699, lon: 6.0204 };
const DLAT = 1 / 111000, DLON = 1 / 68000;      // metres -> degrees at 52 N

function rect(latM, lonM, wM, hM) {             // metres offset from CENTRE
  const s = CENTRE.lat + latM * DLAT, n = CENTRE.lat + (latM + hM) * DLAT;
  const w = CENTRE.lon + lonM * DLON, e = CENTRE.lon + (lonM + wM) * DLON;
  return [{ lat: s, lon: w }, { lat: s, lon: e }, { lat: n, lon: e }, { lat: n, lon: w }, { lat: s, lon: w }];
}

// Hole 1: tee, fairway, green, bunker and a mapped golf=hole line.
// Hole 2: tee and green only, so the app has to derive the route itself.
const OVERPASS_FIXTURE = {
  version: 0.6,
  elements: [
    { type: 'way', id: 101, tags: { golf: 'green', ref: '1' }, geometry: rect(60, 20, 32, 30) },
    { type: 'way', id: 102, tags: { golf: 'fairway', ref: '1' }, geometry: rect(-40, -10, 60, 100) },
    { type: 'way', id: 103, tags: { golf: 'tee', ref: '1' }, geometry: rect(-60, 10, 14, 10) },
    { type: 'way', id: 104, tags: { golf: 'bunker' }, geometry: rect(40, 5, 12, 9) },
    { type: 'way', id: 105, tags: { golf: 'hole', ref: '1', par: '4', dist: '340' },
      geometry: [{ lat: CENTRE.lat - 55 * DLAT, lon: CENTRE.lon + 16 * DLON },
                 { lat: CENTRE.lat + 10 * DLAT, lon: CENTRE.lon + 25 * DLON },
                 { lat: CENTRE.lat + 74 * DLAT, lon: CENTRE.lon + 35 * DLON }] },
    { type: 'node', id: 106, tags: { golf: 'pin', ref: '1' },
      lat: CENTRE.lat + 74 * DLAT, lon: CENTRE.lon + 35 * DLON },

    { type: 'way', id: 201, tags: { golf: 'green', ref: '2' }, geometry: rect(60, -120, 28, 26) },
    { type: 'way', id: 202, tags: { golf: 'tee', ref: '2' }, geometry: rect(-30, -110, 12, 9) },

    { type: 'relation', id: 301, tags: { golf: 'water_hazard' }, members: [
      { type: 'way', role: 'outer', geometry: rect(0, 60, 40, 40) },
      { type: 'way', role: 'inner', geometry: rect(15, 75, 10, 10) }
    ] },
    { type: 'way', id: 401, tags: { golf: 'clubhouse' }, geometry: rect(-120, -40, 20, 15) }
  ]
};

// A cone centred just off green 1, so a relief scan produces real contours.
const PEAK = { lat: CENTRE.lat + 74 * DLAT, lon: CENTRE.lon + 32 * DLON };
function ahnHeight(lat, lon) {
  const dy = (lat - PEAK.lat) / DLAT, dx = (lon - PEAK.lon) / DLON;
  return 21.5 - Math.hypot(dx, dy) / 18;
}

function ahnResponse(url) {
  const bbox = (new URL(url)).searchParams.get('BBOX').split(',').map(Number);
  const lat = (bbox[0] + bbox[2]) / 2, lon = (bbox[1] + bbox[3]) / 2;
  return { type: 'FeatureCollection',
    features: [{ type: 'Feature', properties: { value_list: ahnHeight(lat, lon).toFixed(4) } }] };
}

/* --- a real PNG so tiles look like imagery in screenshots --- */
function crc32(buf) {
  let c, table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function tilePng(size) {
  size = size || 256;
  const raw = [];
  for (let y = 0; y < size; y++) {
    const row = [0];
    for (let x = 0; x < size; x++) {
      const grass = ((x >> 5) + (y >> 5)) % 2 === 0;      // faint mowing-line check
      row.push(grass ? 74 : 88, grass ? 92 : 104, grass ? 58 : 66);
    }
    raw.push(Buffer.from(row));
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(raw))),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

module.exports = { CENTRE, OVERPASS_FIXTURE, ahnResponse, ahnHeight, tilePng, rect };

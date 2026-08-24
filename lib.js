/*
 * lib.js — pure helpers for the course data inspection map.
 *
 * Everything in here is free of Leaflet and the DOM so it can be unit tested
 * in Node (see tests/lib.test.cjs). Loaded in the browser as a plain <script>,
 * which puts GOLF in the shared script scope; the tail below also makes it
 * require()-able. No build step, no modules, so the file still opens over
 * file:// as well as over https.
 */
var GOLF = (function () {
  'use strict';

  /* ---------------- PDOK aerial imagery (WMTS) ---------------- */

  var PDOK_WMTS = 'https://service.pdok.nl/hwh/luchtfotorgb/wmts/v1_0/';

  // The zoom level in the WMTS path is zero-padded to two digits. A plain
  // Leaflet {z} template produces ".../8/..." and silently 404s below zoom 10.
  function pdokTileUrl(layer, z, x, y) {
    return PDOK_WMTS + layer + '/OGC:1.0:GoogleMapsCompatible/' +
      String(z).padStart(2, '0') + '/' + x + '/' + y + '.jpeg';
  }

  /* ---------------- Overpass ---------------- */

  function clampBbox(b, maxSpan) {
    var s = b.south, w = b.west, n = b.north, e = b.east;
    if (n - s > maxSpan) {
      var cy = (n + s) / 2; s = cy - maxSpan / 2; n = cy + maxSpan / 2;
    }
    if (e - w > maxSpan) {
      var cx = (e + w) / 2; w = cx - maxSpan / 2; e = cx + maxSpan / 2;
    }
    return { south: s, west: w, north: n, east: e };
  }

  // Overpass wants south,west,north,east. `out geom;` inlines way geometry so
  // we never have to resolve node references ourselves.
  function overpassQuery(bounds, opts) {
    var maxSpan = (opts && opts.maxSpan) || 0.25;   // ~28 km, keeps queries quick
    var b = clampBbox(bounds, maxSpan);
    var bbox = [b.south, b.west, b.north, b.east].map(function (v) { return v.toFixed(5); }).join(',');
    return '[out:json][timeout:45];(' +
      'way["golf"](' + bbox + ');' +
      'relation["golf"](' + bbox + ');' +
      'node["golf"](' + bbox + ');' +
      ');out geom;';
  }

  /* ---------------- Overpass result parsing ---------------- */

  // golf=* values that are drawn as filled areas. Anything else (clubhouse,
  // cartpath, practice buildings) is skipped rather than drawn in a fallback
  // colour, so what you see on the map is only what OSM actually tagged.
  var AREA_KINDS = ['green', 'fairway', 'tee', 'bunker', 'water_hazard',
    'lateral_water_hazard', 'rough', 'driving_range', 'fringe', 'bunker_face'];

  function ringOf(geometry) {
    if (!Array.isArray(geometry) || geometry.length < 3) return null;
    var pts = [];
    for (var i = 0; i < geometry.length; i++) {
      var p = geometry[i];
      if (!p || typeof p.lat !== 'number' || typeof p.lon !== 'number') return null;
      pts.push([p.lat, p.lon]);
    }
    return pts;
  }

  function lineOf(geometry) {
    if (!Array.isArray(geometry) || geometry.length < 2) return null;
    var pts = [];
    for (var i = 0; i < geometry.length; i++) {
      var p = geometry[i];
      if (!p || typeof p.lat !== 'number' || typeof p.lon !== 'number') return null;
      pts.push([p.lat, p.lon]);
    }
    return pts;
  }

  function parseGolfElements(elements) {
    var out = { areas: [], holes: [], pins: [], greenCount: 0, skipped: 0 };
    if (!Array.isArray(elements)) return out;

    for (var i = 0; i < elements.length; i++) {
      var el = elements[i];
      var tags = (el && el.tags) || {};
      var kind = tags.golf;
      if (!kind) continue;

      if (kind === 'pin') {
        if (el.type === 'node' && typeof el.lat === 'number') {
          out.pins.push({ id: el.type + '/' + el.id, ref: tags.ref || null, lat: el.lat, lon: el.lon });
        }
        continue;
      }

      if (kind === 'hole') {
        var line = el.type === 'way' ? lineOf(el.geometry) : null;
        if (!line && el.type === 'relation' && Array.isArray(el.members)) {
          for (var m = 0; m < el.members.length && !line; m++) line = lineOf(el.members[m].geometry);
        }
        if (line) {
          out.holes.push({
            id: el.type + '/' + el.id,
            ref: tags.ref || null,
            par: tags.par ? parseInt(tags.par, 10) : null,
            name: tags.name || null,
            dist: tags.dist ? parseInt(tags.dist, 10) : null,
            points: line,
            derived: false
          });
        }
        continue;
      }

      if (AREA_KINDS.indexOf(kind) === -1) { out.skipped++; continue; }

      var rings = [], holesIn = [];
      if (el.type === 'way') {
        var r = ringOf(el.geometry);
        if (r) rings.push(r);
      } else if (el.type === 'relation' && Array.isArray(el.members)) {
        for (var k = 0; k < el.members.length; k++) {
          var mem = el.members[k];
          var mr = ringOf(mem && mem.geometry);
          if (!mr) continue;
          if (mem.role === 'inner') holesIn.push(mr); else rings.push(mr);
        }
      }
      if (!rings.length) continue;

      out.areas.push({
        id: el.type + '/' + el.id,
        kind: kind,
        ref: tags.ref || null,
        name: tags.name || null,
        rings: rings,
        holes: holesIn
      });
      if (kind === 'green') out.greenCount++;
    }
    return out;
  }

  /* ---------------- geometry ---------------- */

  var R = 6371008.8;

  function metres(a, b) {
    var f1 = a[0] * Math.PI / 180, f2 = b[0] * Math.PI / 180;
    var df = f2 - f1, dl = (b[1] - a[1]) * Math.PI / 180;
    var h = Math.sin(df / 2) * Math.sin(df / 2) +
      Math.cos(f1) * Math.cos(f2) * Math.sin(dl / 2) * Math.sin(dl / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  // Area centroid (shoelace), so a label sits in the middle of a shape rather
  // than being pulled towards whichever edge has the most mapped vertices.
  function centroid(pts) {
    if (!pts || !pts.length) return null;
    var a = 0, cy = 0, cx = 0;
    for (var i = 0; i < pts.length; i++) {
      var p = pts[i], q = pts[(i + 1) % pts.length];
      var cross = p[0] * q[1] - q[0] * p[1];
      a += cross; cy += (p[0] + q[0]) * cross; cx += (p[1] + q[1]) * cross;
    }
    if (Math.abs(a) < 1e-14) {   // degenerate / collinear — fall back to the mean
      var sy = 0, sx = 0;
      for (var j = 0; j < pts.length; j++) { sy += pts[j][0]; sx += pts[j][1]; }
      return [sy / pts.length, sx / pts.length];
    }
    a *= 0.5;
    return [cy / (6 * a), cx / (6 * a)];
  }

  function bboxOf(pts) {
    var s = Infinity, w = Infinity, n = -Infinity, e = -Infinity;
    for (var i = 0; i < pts.length; i++) {
      s = Math.min(s, pts[i][0]); n = Math.max(n, pts[i][0]);
      w = Math.min(w, pts[i][1]); e = Math.max(e, pts[i][1]);
    }
    return { south: s, west: w, north: n, east: e };
  }

  function pointInRing(pt, ring) {
    var y = pt[0], x = pt[1], inside = false;
    for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      var yi = ring[i][0], xi = ring[i][1], yj = ring[j][0], xj = ring[j][1];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  /* ---------------- hole routing fallback ---------------- */

  // 156 of the 178 well-mapped Dutch courses carry golf=hole ways. Where they
  // are missing we draw tee centroid -> green centroid instead, matched on the
  // ref tag, and mark the result as derived so the map can dash it.
  function deriveHoleRoutes(areas, holes, opts) {
    var maxDerivedM = (opts && opts.maxDerivedM) || 700;
    var have = {};
    (holes || []).forEach(function (h) { if (h.ref) have[h.ref] = true; });

    var tees = [], greens = [];
    areas.forEach(function (a) {
      var c = centroid(a.rings[0]);
      if (!c) return;
      if (a.kind === 'tee') tees.push({ ref: a.ref, c: c });
      if (a.kind === 'green') greens.push({ ref: a.ref, c: c });
    });

    var routes = [];
    greens.forEach(function (g) {
      if (g.ref && have[g.ref]) return;
      var best = null, bestD = Infinity;
      for (var i = 0; i < tees.length; i++) {
        var t = tees[i];
        if (g.ref && t.ref && t.ref !== g.ref) continue;      // refs disagree: not this hole
        if (g.ref && !t.ref) continue;                        // prefer an explicit match
        var d = metres(t.c, g.c);
        if (d < bestD) { bestD = d; best = t; }
      }
      if (!best && !g.ref) {                                   // unreffed green: nearest tee
        for (var k = 0; k < tees.length; k++) {
          var d2 = metres(tees[k].c, g.c);
          if (d2 < bestD) { bestD = d2; best = tees[k]; }
        }
      }
      if (best && bestD <= maxDerivedM) {
        routes.push({ ref: g.ref || best.ref || null, par: null, points: [best.c, g.c], derived: true });
      }
    });
    return routes;
  }

  /* ---------------- AHN terrain height ---------------- */

  var AHN_WMS = 'https://service.pdok.nl/rws/ahn/wms/v1_0';

  // WMS 1.3.0 with CRS=EPSG:4326 means the BBOX axis order is lat,lon.
  // We ask for a small box and query its centre pixel.
  function ahnFeatureInfoUrl(lat, lon, layer, span) {
    var l = layer || 'dtm_05m';
    var d = (typeof span === 'number' ? span : 0.0002);
    var size = 101, mid = Math.floor(size / 2);
    return AHN_WMS + '?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetFeatureInfo' +
      '&LAYERS=' + l + '&QUERY_LAYERS=' + l +
      '&CRS=EPSG:4326&INFO_FORMAT=application%2Fjson&STYLES=' +
      '&BBOX=' + (lat - d) + ',' + (lon - d) + ',' + (lat + d) + ',' + (lon + d) +
      '&WIDTH=' + size + '&HEIGHT=' + size + '&I=' + mid + '&J=' + mid;
  }

  // Heights are metres relative to NAP and are legitimately negative over much
  // of the country, so only obvious sentinels and absurd magnitudes are nulled.
  function parseAhnValue(json) {
    try {
      var f = json && json.features && json.features[0];
      if (!f || !f.properties) return null;
      var raw = f.properties.value_list;
      if (Array.isArray(raw)) raw = raw[0];
      if (raw === null || raw === undefined) return null;
      var v = parseFloat(String(raw).trim().split(/[\s,;]+/)[0]);
      if (!isFinite(v)) return null;
      if (v <= -999 || Math.abs(v) >= 1000) return null;
      return v;
    } catch (e) { return null; }
  }

  /* ---------------- green relief: sampling + contours ---------------- */

  function sampleGrid(ring, n) {
    var b = bboxOf(ring);
    var pts = [];
    for (var j = 0; j < n; j++) {
      for (var i = 0; i < n; i++) {
        var lat = b.south + (b.north - b.south) * (n === 1 ? 0.5 : j / (n - 1));
        var lon = b.west + (b.east - b.west) * (n === 1 ? 0.5 : i / (n - 1));
        pts.push({ i: i, j: j, lat: lat, lon: lon, inside: pointInRing([lat, lon], ring), value: null });
      }
    }
    return { n: n, bounds: b, points: pts };
  }

  function contourLevels(min, max, step) {
    if (!isFinite(min) || !isFinite(max) || max <= min) return [];
    var s = step || 0.25, maxLevels = 40;
    while ((max - min) / s > maxLevels) s *= 2;
    var levels = [], v = Math.ceil(min / s) * s;
    for (; v < max - 1e-9; v += s) {
      if (v > min + 1e-9) levels.push(Math.round(v * 1e6) / 1e6);
    }
    return levels;
  }

  // Marching squares over a row-major n x n grid. Cells touching a missing
  // sample are skipped, which is what happens around the edge of a green where
  // points fall outside the polygon.
  function isolines(values, n, levels) {
    var segs = [];
    var num = function (v) { return typeof v === 'number' && isFinite(v); };

    for (var li = 0; li < levels.length; li++) {
      var level = levels[li];
      for (var j = 0; j < n - 1; j++) {
        for (var i = 0; i < n - 1; i++) {
          var tl = values[j * n + i], tr = values[j * n + i + 1];
          var bl = values[(j + 1) * n + i], br = values[(j + 1) * n + i + 1];
          if (!num(tl) || !num(tr) || !num(bl) || !num(br)) continue;

          var idx = 0;
          if (tl >= level) idx |= 8;
          if (tr >= level) idx |= 4;
          if (br >= level) idx |= 2;
          if (bl >= level) idx |= 1;
          if (idx === 0 || idx === 15) continue;

          var t = function (a, b) {
            var d = b - a;
            if (Math.abs(d) < 1e-12) return 0.5;
            return Math.max(0, Math.min(1, (level - a) / d));
          };
          var T = [i + t(tl, tr), j];
          var Rr = [i + 1, j + t(tr, br)];
          var B = [i + t(bl, br), j + 1];
          var Lf = [i, j + t(tl, bl)];

          var pairs;
          switch (idx) {
            case 1: case 14: pairs = [[Lf, B]]; break;
            case 2: case 13: pairs = [[B, Rr]]; break;
            case 3: case 12: pairs = [[Lf, Rr]]; break;
            case 4: case 11: pairs = [[T, Rr]]; break;
            case 6: case 9: pairs = [[T, B]]; break;
            case 7: case 8: pairs = [[T, Lf]]; break;
            case 5: pairs = ((tl + tr + bl + br) / 4 >= level) ? [[T, Lf], [B, Rr]] : [[T, Rr], [Lf, B]]; break;
            case 10: pairs = ((tl + tr + bl + br) / 4 >= level) ? [[T, Rr], [Lf, B]] : [[T, Lf], [B, Rr]]; break;
            default: pairs = [];
          }
          for (var p = 0; p < pairs.length; p++) {
            segs.push({ a: pairs[p][0], b: pairs[p][1], level: level });
          }
        }
      }
    }
    return segs;
  }

  // Grid coordinates (i,j) -> lat/lon, for drawing the isolines on the map.
  function gridToLatLng(pt, bounds, n) {
    var lat = bounds.south + (bounds.north - bounds.south) * (pt[1] / (n - 1));
    var lon = bounds.west + (bounds.east - bounds.west) * (pt[0] / (n - 1));
    return [lat, lon];
  }

  /* ---------------- coverage survey ---------------- */

  // PDOK aerial imagery and AHN heights cover the European Netherlands only.
  // The OSM query for "the Netherlands" also returns Caribbean courses, which
  // will show as blank imagery — flag them rather than let them look broken.
  function hasDutchImagery(lat, lon) {
    return lat >= 50.6 && lat <= 53.8 && lon >= 3.0 && lon <= 7.4;
  }

  function classifyCoverage(c) {
    var g = c.green || 0;
    if (g >= 9) return 'full';
    if (g >= 1) return 'partial';
    return 'none';
  }

  function summarizeCoverage(list) {
    var s = { total: 0, full: 0, partial: 0, none: 0, withHoles: 0, withPins: 0, withFairways: 0, offshore: 0 };
    (list || []).forEach(function (c) {
      s.total++;
      var cls = classifyCoverage(c);
      s[cls]++;
      if (cls === 'full') {
        if ((c.hole || 0) > 0) s.withHoles++;
        if ((c.pin || 0) > 0) s.withPins++;
        if ((c.fairway || 0) > 0) s.withFairways++;
      }
      if (!hasDutchImagery(c.lat, c.lon)) s.offshore++;
    });
    return s;
  }

  function normalise(s) {
    return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  }

  function filterCourses(list, q) {
    var needle = normalise(q).trim();
    if (!needle) return (list || []).slice();
    return (list || []).filter(function (c) { return normalise(c.name).indexOf(needle) !== -1; });
  }

  function sortCourses(list, key, dir) {
    var sign = dir === 'asc' ? 1 : -1;
    return (list || []).map(function (c, i) { return { c: c, i: i }; })
      .sort(function (a, b) {
        var x = a.c[key], y = b.c[key], cmp;
        if (typeof x === 'string' || typeof y === 'string') {
          cmp = normalise(x).localeCompare(normalise(y));
          if (key === 'name') cmp = cmp;              // names read best A->Z under "asc"
        } else {
          cmp = (x || 0) - (y || 0);
        }
        if (cmp === 0) return a.i - b.i;              // stable
        return key === 'name' ? cmp * (dir === 'asc' ? 1 : -1) : cmp * sign;
      })
      .map(function (o) { return o.c; });
  }

  return {
    PDOK_WMTS: PDOK_WMTS, AHN_WMS: AHN_WMS, AREA_KINDS: AREA_KINDS,
    pdokTileUrl: pdokTileUrl,
    overpassQuery: overpassQuery, clampBbox: clampBbox,
    parseGolfElements: parseGolfElements, deriveHoleRoutes: deriveHoleRoutes,
    metres: metres, centroid: centroid, bboxOf: bboxOf, pointInRing: pointInRing,
    ahnFeatureInfoUrl: ahnFeatureInfoUrl, parseAhnValue: parseAhnValue,
    sampleGrid: sampleGrid, contourLevels: contourLevels, isolines: isolines, gridToLatLng: gridToLatLng,
    hasDutchImagery: hasDutchImagery, classifyCoverage: classifyCoverage,
    summarizeCoverage: summarizeCoverage, filterCourses: filterCourses, sortCourses: sortCourses
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = GOLF;

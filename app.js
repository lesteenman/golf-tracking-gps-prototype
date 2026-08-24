/*
 * app.js — wiring for the course data inspection map.
 *
 * Three open datasets on one map so a human can judge whether they line up:
 *   imagery   PDOK aerial WMTS      (CC BY 4.0)
 *   height    AHN 0.5 m DTM/DSM WMS (CC0)
 *   course    OpenStreetMap/Overpass(ODbL)
 *
 * Pure helpers live in lib.js (GOLF) and are unit tested; this file is the
 * Leaflet and DOM half.
 */
(function () {
  'use strict';

  var G = GOLF;
  var $ = function (id) { return document.getElementById(id); };

  /* ================= configuration ================= */

  // De Scherpenbergh, Apeldoorn — 22 greens, 21 hole lines in the survey.
  var DEFAULT_VIEW = { lat: 52.14699, lon: 6.0204, zoom: 17 };

  // overpass-api.de first, then mirrors. Whichever answers gets remembered, so
  // a phone on a bad connection does not re-walk the whole list every time.
  var OVERPASS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass.private.coffee/api/interpreter',
    'https://maps.mail.ru/osm/tools/overpass/api/interpreter'
  ];
  var OVERPASS_TIMEOUT_MS = 30000;

  var STYLE = {
    green:                { color: '#eaffea', fillColor: '#7dd87d', weight: 2,   fillOpacity: .45 },
    fairway:              { color: '#bfe8c4', fillColor: '#4e9b57', weight: 1,   fillOpacity: .22 },
    tee:                  { color: '#d9fff7', fillColor: '#5ee0c8', weight: 1.5, fillOpacity: .40 },
    bunker:               { color: '#fff3d6', fillColor: '#e8c87a', weight: 1.5, fillOpacity: .60 },
    water_hazard:         { color: '#d6ecff', fillColor: '#5aa9e6', weight: 1.5, fillOpacity: .50 },
    lateral_water_hazard: { color: '#d6ecff', fillColor: '#5aa9e6', weight: 1.5, fillOpacity: .50 },
    rough:                { color: '#c3d6c5', fillColor: '#5c7a5f', weight: 1,   fillOpacity: .16 },
    driving_range:        { color: '#cfd8ff', fillColor: '#8f9bd8', weight: 1,   fillOpacity: .18 },
    fringe:               { color: '#dff5df', fillColor: '#8fc98f', weight: 1,   fillOpacity: .25 },
    bunker_face:          { color: '#fff3d6', fillColor: '#d9b96a', weight: 1,   fillOpacity: .45 }
  };
  var SELECTED = { color: '#ff5c3a', fillColor: '#ff5c3a', weight: 3, fillOpacity: .35 };

  /* ================= map ================= */

  function pdokLayer(layer) {
    var Padded = L.TileLayer.extend({
      getTileUrl: function (c) { return G.pdokTileUrl(layer, this._getZoomForUrl(), c.x, c.y); }
    });
    return new Padded('', {
      minZoom: 6, maxZoom: 21, maxNativeZoom: 21, crossOrigin: true,
      attribution: 'PDOK / AHN / OpenStreetMap'
    });
  }

  var imagery = { winter: pdokLayer('Actueel_orthoHR'), summer: pdokLayer('Actueel_ortho25') };
  var showingWinter = true;

  var start = readHash() || DEFAULT_VIEW;
  // SVG rendering, deliberately: with a canvas renderer the topmost pane's
  // canvas swallows clicks meant for polygons in the panes below it, so greens
  // stop being selectable once hole routes are drawn over them.
  var map = L.map('map', { zoomControl: false, layers: [imagery.winter] })
    .setView([start.lat, start.lon], start.zoom);
  L.control.zoom({ position: 'bottomleft' }).addTo(map);
  L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(map);

  map.createPane('areas');  map.getPane('areas').style.zIndex = 410;
  map.createPane('relief'); map.getPane('relief').style.zIndex = 420;
  map.createPane('routes'); map.getPane('routes').style.zIndex = 430;
  map.createPane('labels'); map.getPane('labels').style.zIndex = 440;
  map.getPane('labels').style.pointerEvents = 'none';
  map.getPane('relief').style.pointerEvents = 'none';   // contours are decoration, not targets

  var greenPolys = [];
  var courseLayer = L.layerGroup().addTo(map);
  var routeLayer = L.layerGroup().addTo(map);
  var labelLayer = L.layerGroup().addTo(map);
  var reliefLayer = L.layerGroup().addTo(map);
  var probeMarker = null;

  /* ================= status line ================= */

  var noteEl = $('note');
  function note(html, kind) {
    noteEl.innerHTML = html;
    noteEl.className = kind || '';
    noteEl.hidden = false;
  }

  /* ================= imagery toggle ================= */

  $('btn-imagery').addEventListener('click', function () {
    showingWinter = !showingWinter;
    map.removeLayer(showingWinter ? imagery.summer : imagery.winter);
    map.addLayer(showingWinter ? imagery.winter : imagery.summer);
    this.innerHTML = showingWinter
      ? '<span class="sw">Winter</span> 8&nbsp;cm'
      : '<span class="sw">Summer</span> 25&nbsp;cm';
    this.setAttribute('aria-pressed', String(showingWinter));
    this.title = showingWinter
      ? 'Actueel_orthoHR — 8 cm, leaf-off winter flight'
      : 'Actueel_ortho25 — 25 cm, summer, mowing lines visible';
  });

  // If the imagery service is unreachable the map is just black, which looks
  // like a bug in the page rather than a network problem. Say which it is.
  var tileErrors = 0, tileOk = 0;
  ['winter', 'summer'].forEach(function (k) {
    imagery[k].on('tileerror', function () {
      tileErrors++;
      if (tileErrors === 12 && tileOk === 0) {
        note('No aerial tiles are loading from <b>service.pdok.nl</b>. Check the connection — ' +
             'course data and heights come from the same host family.', 'err');
      }
    });
    imagery[k].on('tileload', function () { tileOk++; });
  });

  /* ================= hash state ================= */

  function readHash() {
    var m = /^#(\d{1,2})\/(-?\d+\.?\d*)\/(-?\d+\.?\d*)$/.exec(location.hash || '');
    if (!m) return null;
    return { zoom: +m[1], lat: +m[2], lon: +m[3] };
  }
  var hashTimer = null;
  function writeHash() {
    clearTimeout(hashTimer);
    hashTimer = setTimeout(function () {
      var c = map.getCenter();
      var h = '#' + map.getZoom() + '/' + c.lat.toFixed(5) + '/' + c.lng.toFixed(5);
      if (h !== location.hash) history.replaceState(null, '', h);
    }, 400);
  }
  map.on('moveend zoomend', writeHash);

  /* ================= Overpass ================= */

  var preferred = 0;
  try { preferred = parseInt(localStorage.getItem('overpassIdx') || '0', 10) || 0; } catch (e) { preferred = 0; }

  function endpointsInOrder() {
    var list = OVERPASS.slice();
    if (preferred > 0 && preferred < list.length) {
      list = list.slice(preferred).concat(list.slice(0, preferred));
    }
    return list;
  }

  function fetchOverpass(query) {
    var order = endpointsInOrder(), tried = [];
    function attempt(i) {
      if (i >= order.length) {
        return Promise.reject(new Error('all endpoints failed: ' + tried.join(', ')));
      }
      var url = order[i];
      var ctl = new AbortController();
      var timer = setTimeout(function () { ctl.abort(); }, OVERPASS_TIMEOUT_MS);
      return fetch(url, {
        method: 'POST',
        body: 'data=' + encodeURIComponent(query),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        signal: ctl.signal
      }).then(function (r) {
        clearTimeout(timer);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      }).then(function (json) {
        var idx = OVERPASS.indexOf(url);
        if (idx > -1) { preferred = idx; try { localStorage.setItem('overpassIdx', String(idx)); } catch (e) {} }
        return json;
      }).catch(function (err) {
        clearTimeout(timer);
        tried.push(host(url) + ' (' + (err.name === 'AbortError' ? 'timeout' : err.message) + ')');
        return attempt(i + 1);
      });
    }
    return attempt(0);
  }

  function host(u) { try { return new URL(u).host; } catch (e) { return u; } }

  /* ================= drawing the course ================= */

  var loading = false;
  var lastParse = null;

  function loadCourse() {
    if (loading) return;
    var b = map.getBounds();
    var centre = map.getCenter();

    if (map.getZoom() < 13) {
      note('Zoom in a little first — below zoom 13 the query area is too big to be useful.', 'warn');
      return;
    }
    if (!G.hasDutchImagery(centre.lat, centre.lng)) {
      note('Outside the Netherlands: PDOK imagery and AHN heights stop at the coast, ' +
           'though OpenStreetMap course data will still load.', 'warn');
    }

    loading = true;
    $('btn-load').disabled = true;
    note('Querying OpenStreetMap for golf features in view…', 'busy');

    var query = G.overpassQuery({
      south: b.getSouth(), west: b.getWest(), north: b.getNorth(), east: b.getEast()
    });

    fetchOverpass(query).then(function (data) {
      var parsed = G.parseGolfElements(data && data.elements);
      lastParse = parsed;
      render(parsed);

      var derived = parsed.derivedCount;
      if (!parsed.areas.length && !parsed.holes.length) {
        note('No golf features here in OpenStreetMap. Either this course is not mapped, ' +
             'or the mapped part is outside the current view.', 'warn');
      } else {
        note('<b>' + parsed.greenCount + '</b> greens, <b>' + parsed.areas.length + '</b> polygons, ' +
             '<b>' + parsed.holes.length + '</b> mapped hole line' + (parsed.holes.length === 1 ? '' : 's') +
             (derived ? ' + <b>' + derived + '</b> derived tee&rarr;green' : '') +
             '. Tap a green to select it, then scan its relief.');
      }
    }).catch(function (err) {
      note('Could not reach any Overpass endpoint.<br><span class="fine">' + escapeHtml(err.message) +
           '</span><br>Try again in a moment — mirrors rate-limit, and this fails quietly on a weak signal.', 'err');
    }).then(function () {
      loading = false;
      $('btn-load').disabled = false;
    });
  }

  function render(parsed) {
    courseLayer.clearLayers(); routeLayer.clearLayers(); labelLayer.clearLayers();
    greenPolys = [];
    clearRelief();
    selectGreen(null);

    // Larger areas first so a bunker inside a fairway stays clickable.
    var areas = parsed.areas.slice().sort(function (a, b) { return ringArea(b.rings[0]) - ringArea(a.rings[0]); });

    areas.forEach(function (a) {
      var style = STYLE[a.kind];
      if (!style) return;
      var latlngs = [a.rings[0]].concat(a.holes || []);
      var poly = L.polygon(latlngs, Object.assign({ pane: 'areas' }, style));
      poly.feature_ = a;
      poly.addTo(courseLayer);
      if (a.kind === 'green') greenPolys.push(poly);
      poly.on('click', function (e) { L.DomEvent.stop(e); handleClick(e.latlng); });
      poly.bindPopup(function () { return areaPopup(a); });
    });

    var derivedRoutes = G.deriveHoleRoutes(parsed.areas, parsed.holes);
    parsed.derivedCount = derivedRoutes.length;

    parsed.holes.concat(derivedRoutes).forEach(function (h) {
      var line = L.polyline(h.points, {
        pane: 'routes',
        color: h.derived ? '#ff9d3a' : '#ff5c3a',
        weight: h.derived ? 2 : 3,
        opacity: .95,
        dashArray: h.derived ? '6 5' : null
      }).addTo(routeLayer);
      line.on('click', function (e) { handleClick(e.latlng); });
      line.bindPopup(holePopup(h));

      var label = h.ref ? ('#' + h.ref) : 'hole';
      if (h.par) label += ' · par ' + h.par;
      if (h.derived) label += ' *';
      L.marker(midpoint(h.points), {
        pane: 'labels', interactive: false,
        icon: L.divIcon({ className: 'hole-label', html: escapeHtml(label), iconSize: null })
      }).addTo(labelLayer);
    });

    // Pins are drawn as decoration only. Interactive markers would sit exactly
    // over the middle of a green and swallow the tap that selects it.
    parsed.pins.forEach(function (p) {
      L.circleMarker([p.lat, p.lon], {
        pane: 'labels', interactive: false, radius: 4, color: '#0b0f0c', weight: 1.5,
        fillColor: '#ffffff', fillOpacity: 1
      }).addTo(labelLayer);
    });

    $('r-greens').textContent = parsed.greenCount;
    $('r-holes').textContent = parsed.holes.length + (parsed.derivedCount ? '+' + parsed.derivedCount : '');
  }

  function areaPopup(a) {
    var m2 = Math.round(ringAreaM2(a.rings[0]));
    return '<h3>' + escapeHtml(a.kind.replace(/_/g, ' ')) + '</h3><dl>' +
      (a.name ? '<dt>name</dt><dd>' + escapeHtml(a.name) + '</dd>' : '') +
      (a.ref ? '<dt>hole</dt><dd>' + escapeHtml(a.ref) + '</dd>' : '') +
      '<dt>area</dt><dd>' + m2.toLocaleString('en') + ' m²</dd>' +
      '<dt>vertices</dt><dd>' + a.rings[0].length + '</dd>' +
      '<dt>OSM</dt><dd>' + escapeHtml(a.id) + '</dd></dl>';
  }

  function holePopup(h) {
    var len = 0;
    for (var i = 1; i < h.points.length; i++) len += G.metres(h.points[i - 1], h.points[i]);
    return '<h3>Hole ' + escapeHtml(h.ref || '?') + (h.par ? ' · par ' + h.par : '') + '</h3><dl>' +
      '<dt>routed length</dt><dd>' + Math.round(len) + ' m</dd>' +
      '<dt>vertices</dt><dd>' + h.points.length + '</dd>' +
      '<dt>source</dt><dd>' + (h.derived ? 'derived tee → green' : 'OSM golf=hole') + '</dd>' +
      '</dl><p class="fine">Vertices sit roughly where a scratch golfer would land, by mapping ' +
      'convention — treat the length as indicative, not surveyed.</p>';
  }

  /* ================= green selection ================= */

  var selected = null;

  function selectGreen(poly) {
    if (selected && selected !== poly && courseLayer.hasLayer(selected)) {
      selected.setStyle(STYLE.green);
    }
    selected = poly;
    clearRelief();
    if (!poly) {
      $('r-sel').textContent = 'no green selected';
      $('r-sel-sub').textContent = 'tap a green to select it';
      $('btn-scan').disabled = true;
      return;
    }
    poly.setStyle(SELECTED);
    var a = poly.feature_;
    $('r-sel').textContent = (a.ref ? 'Green ' + a.ref : 'Green') + ' · ' + Math.round(ringAreaM2(a.rings[0])) + ' m²';
    $('r-sel-sub').textContent = a.id;
    $('btn-scan').disabled = false;
  }

  /* ================= terrain height ================= */

  var model = 'dtm_05m';
  $('btn-model').addEventListener('click', function () {
    model = model === 'dtm_05m' ? 'dsm_05m' : 'dtm_05m';
    this.textContent = model === 'dtm_05m' ? 'DTM' : 'DSM';
    this.classList.toggle('on', model === 'dsm_05m');
    $('r-height-label').textContent = model === 'dtm_05m' ? 'height NAP' : 'surface NAP';
    note(model === 'dtm_05m'
      ? 'Terrain model: bare earth, trees and buildings removed.'
      : 'Surface model: includes trees and buildings, so canopy reads as height.');
  });

  var heightSeq = 0, heightCtl = null;

  function queryHeight(lat, lon) {
    var my = ++heightSeq;
    if (heightCtl) heightCtl.abort();
    heightCtl = new AbortController();
    return fetch(G.ahnFeatureInfoUrl(lat, lon, model), { signal: heightCtl.signal })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (my !== heightSeq) return undefined;      // a newer request has overtaken this one
        return G.parseAhnValue(j);
      })
      .catch(function (err) {
        if (err.name === 'AbortError' || my !== heightSeq) return undefined;
        return null;
      });
  }

  function showHeight(v) {
    if (v === undefined) return;
    $('r-height').textContent = v === null ? '–' : v.toFixed(2);
  }

  // Hover on a real pointer; tap everywhere. Debounced, and stale responses are
  // dropped so a fast mouse cannot render an out-of-order value.
  var hoverTimer = null;
  var fine = window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches;

  if (fine) {
    map.on('mousemove', function (e) {
      var pt = e.containerPoint;
      var probe = $('probe');
      probe.hidden = false;
      probe.style.left = pt.x + 'px';
      probe.style.top = pt.y + 'px';
      probe.querySelector('b').textContent = '…';
      clearTimeout(hoverTimer);
      hoverTimer = setTimeout(function () {
        queryHeight(e.latlng.lat, e.latlng.lng).then(function (v) {
          if (v === undefined) return;
          probe.querySelector('b').textContent = v === null ? '–' : v.toFixed(2);
          showHeight(v);
        });
      }, 180);
    });
    map.on('mouseout', function () { $('probe').hidden = true; clearTimeout(hoverTimer); });
  }

  // Taps on a course polygon do not reach the map's own click handler on a
  // touch device, so the probe is called from here and from every feature.
  function probeAt(latlng) {
    if (!probeMarker) {
      probeMarker = L.circleMarker(latlng, {
        pane: 'labels', radius: 7, color: '#fff', weight: 2, fillColor: '#ff5c3a', fillOpacity: 1
      }).addTo(map);
    }
    probeMarker.setLatLng(latlng);
    $('r-height').textContent = '…';
    return queryHeight(latlng.lat, latlng.lng).then(function (v) {
      if (v === undefined) return;
      showHeight(v);
      probeMarker.bindPopup('<h3>' + (v === null ? 'No height here' : v.toFixed(2) + ' m NAP') + '</h3><dl>' +
        '<dt>model</dt><dd>' + (model === 'dtm_05m' ? 'AHN DTM 0.5 m' : 'AHN DSM 0.5 m') + '</dd>' +
        '<dt>lat, lon</dt><dd>' + latlng.lat.toFixed(5) + ', ' + latlng.lng.toFixed(5) + '</dd></dl>');
    });
  }

  // Whichever layer happens to intercept the tap — a fairway, a hole line that
  // ends on the green, the map itself — a click means the same two things:
  // read the height here, and select the green this point falls inside.
  function handleClick(latlng) {
    probeAt(latlng);
    var hit = null;
    for (var i = 0; i < greenPolys.length; i++) {
      var a = greenPolys[i].feature_;
      if (G.pointInRing([latlng.lat, latlng.lng], a.rings[0])) { hit = greenPolys[i]; break; }
    }
    if (hit) selectGreen(hit);
  }

  map.on('click', function (e) { handleClick(e.latlng); });

  /* ================= green relief scan ================= */

  var scan = { running: false, cancel: false };
  var GRID_N = 15;                 // 15 x 15 over the green's bounding box
  var CONCURRENCY = 6;

  function clearRelief() { reliefLayer.clearLayers(); $('scan-status').textContent = ''; }

  $('btn-scan').addEventListener('click', function () {
    if (scan.running) { scan.cancel = true; return; }
    if (!selected) return;
    runScan(selected.feature_);
  });

  function runScan(area) {
    var ring = area.rings[0];
    var grid = G.sampleGrid(ring, GRID_N);
    var todo = grid.points.filter(function (p) { return p.inside; });
    if (todo.length < 6) {
      $('scan-status').textContent = 'green too small to sample at this grid size';
      return;
    }

    clearRelief();
    scan.running = true; scan.cancel = false;
    $('btn-scan').textContent = 'Cancel scan';
    var done = 0, failed = 0;

    // AHN GetFeatureInfo answers one point per request, so this is genuinely
    // ~150 requests. Kept to a handful in flight to stay polite to PDOK.
    function worker() {
      if (scan.cancel) return Promise.resolve();
      var p = todo.pop();
      if (!p) return Promise.resolve();
      return fetch(G.ahnFeatureInfoUrl(p.lat, p.lon, model, 0.00005))
        .then(function (r) { return r.json(); })
        .then(function (j) { p.value = G.parseAhnValue(j); })
        .catch(function () { failed++; p.value = null; })
        .then(function () {
          done++;
          $('scan-status').textContent = 'sampling AHN ' + done + '/' + (done + todo.length) + '…';
          return worker();
        });
    }

    var workers = [];
    for (var i = 0; i < CONCURRENCY; i++) workers.push(worker());

    Promise.all(workers).then(function () {
      scan.running = false;
      $('btn-scan').textContent = 'Scan green relief';
      if (scan.cancel) { $('scan-status').textContent = 'scan cancelled'; return; }
      drawRelief(grid, failed);
    });
  }

  function drawRelief(grid, failed) {
    var values = grid.points.map(function (p) { return p.inside ? p.value : null; });
    var got = values.filter(function (v) { return typeof v === 'number'; });
    if (got.length < 6) {
      $('scan-status').textContent = 'AHN returned no usable heights for this green' +
        (failed ? ' (' + failed + ' requests failed)' : '');
      return;
    }
    var min = Math.min.apply(null, got), max = Math.max.apply(null, got);
    var levels = G.contourLevels(min, max, 0.25);
    var segs = G.isolines(values, grid.n, levels);

    // One multi-polyline per level rather than one path per segment.
    var byLevel = {};
    segs.forEach(function (s) {
      (byLevel[s.level] = byLevel[s.level] || []).push([
        G.gridToLatLng(s.a, grid.bounds, grid.n),
        G.gridToLatLng(s.b, grid.bounds, grid.n)
      ]);
    });
    Object.keys(byLevel).forEach(function (lv) {
      var t = (max - min) < 1e-6 ? .5 : (Number(lv) - min) / (max - min);
      L.polyline(byLevel[lv], {
        pane: 'relief', color: rampColour(t), weight: 2, opacity: .95, interactive: false
      }).addTo(reliefLayer);
    });

    // Label every other level once, at its westernmost point, so the labels
    // spread around the green instead of stacking where each ring starts.
    Object.keys(byLevel).forEach(function (lv, i) {
      if (i % 2 !== 0) return;
      var west = null;
      byLevel[lv].forEach(function (seg) {
        seg.forEach(function (ll) { if (!west || ll[1] < west[1]) west = ll; });
      });
      if (!west) return;
      L.marker(west, {
        pane: 'labels', interactive: false,
        icon: L.divIcon({ className: 'contour-label', html: Number(lv).toFixed(2), iconSize: null })
      }).addTo(reliefLayer);
    });

    var span = G.bboxOf(grid.points.map(function (p) { return [p.lat, p.lon]; }));
    var across = G.metres([span.south, span.west], [span.north, span.east]);
    var fall = max - min;
    $('scan-status').textContent =
      'fall ' + fall.toFixed(2) + ' m over ' + Math.round(across) + ' m (' +
      (fall / Math.max(across, 1) * 100).toFixed(1) + '% mean) · ' +
      got.length + ' samples · contours every ' + (levels.length > 1
        ? (levels[1] - levels[0]).toFixed(2) : '0.25') + ' m' +
      (failed ? ' · ' + failed + ' failed' : '');

    note('Green relief sampled: <b>' + min.toFixed(2) + '</b> to <b>' + max.toFixed(2) + '</b> m NAP, ' +
         'a fall of <b>' + fall.toFixed(2) + ' m</b>. This is the thing no free app shows you.');
  }

  function rampColour(t) {
    var h = 190 - 145 * Math.max(0, Math.min(1, t));    // cyan (low) → amber (high)
    return 'hsl(' + h.toFixed(0) + ',85%,60%)';
  }

  /* ================= locate ================= */

  var locMarker = null;
  $('btn-locate').addEventListener('click', function () {
    if (!navigator.geolocation || !window.isSecureContext) {
      note('Location needs https (or localhost). Open the deployed URL rather than the file.', 'warn');
      return;
    }
    note('Waiting for a GPS fix…', 'busy');
    navigator.geolocation.getCurrentPosition(function (pos) {
      var ll = [pos.coords.latitude, pos.coords.longitude];
      if (!locMarker) {
        locMarker = L.circleMarker(ll, { pane: 'labels', radius: 8, color: '#fff', weight: 2,
          fillColor: '#5aa9e6', fillOpacity: 1 }).addTo(map);
      }
      locMarker.setLatLng(ll);
      map.setView(ll, Math.max(map.getZoom(), 17));
      note('Fix: ±' + Math.round(pos.coords.accuracy) + ' m. ' +
           (G.hasDutchImagery(ll[0], ll[1]) ? 'Press <b>Load course here</b>.' : 'Outside the PDOK imagery area.'));
    }, function (err) {
      note('No GPS fix: ' + escapeHtml(err.message), 'err');
    }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 5000 });
  });

  /* ================= legend ================= */

  $('btn-legend').addEventListener('click', function () {
    var el = $('legend');
    el.hidden = !el.hidden;
    this.setAttribute('aria-expanded', String(!el.hidden));
    this.classList.toggle('on', !el.hidden);
  });

  /* ================= coverage panel ================= */

  var coverage = null, covSort = { key: 'green', dir: 'desc' };

  function openCoverage() {
    $('coverage').hidden = false;
    if (coverage) return;
    fetch('data/nl-course-coverage.json').then(function (r) { return r.json(); }).then(function (d) {
      coverage = d;
      var s = G.summarizeCoverage(d.courses);
      $('cov-summary').innerHTML =
        '<b>' + s.total + '</b> courses tagged · <b>' + s.full + '</b> (' +
        Math.round(s.full / s.total * 100) + '%) with 9+ greens · <b>' + s.partial + '</b> partial · <b>' +
        s.none + '</b> with none. Of the well-mapped: <b>' + s.withHoles + '</b> have hole lines, <b>' +
        s.withPins + '</b> pins, <b>' + s.withFairways + '</b> fairways.' +
        (s.offshore ? ' <b>' + s.offshore + '</b> lie outside the PDOK/AHN footprint (Caribbean NL).' : '');
      $('cov-generated').textContent = d.generated || 'unknown';
      renderCoverage();
    }).catch(function () {
      $('cov-summary').textContent = 'Could not load data/nl-course-coverage.json.';
    });
  }

  function renderCoverage() {
    if (!coverage) return;
    var list = G.sortCourses(G.filterCourses(coverage.courses, $('cov-search').value), covSort.key, covSort.dir);
    var ol = $('cov-list');
    ol.innerHTML = '';
    var frag = document.createDocumentFragment();
    list.slice(0, 400).forEach(function (c) {
      var li = document.createElement('li');
      var b = document.createElement('button');
      b.type = 'button';
      b.innerHTML =
        '<i class="dot ' + G.classifyCoverage(c) + '"></i>' +
        '<span class="cname">' + escapeHtml(c.name || '(unnamed)') + '</span>' +
        (G.hasDutchImagery(c.lat, c.lon) ? '' : '<span class="flag">no imagery</span>') +
        '<span class="cnums"><em>' + (c.green || 0) + '</em>g ' + (c.hole || 0) + 'h ' + (c.fairway || 0) + 'f</span>';
      b.addEventListener('click', function () { flyToCourse(c); });
      li.appendChild(b);
      frag.appendChild(li);
    });
    ol.appendChild(frag);
  }

  function flyToCourse(c) {
    if (window.innerWidth < 700) $('coverage').hidden = true;
    map.setView([c.lat, c.lon], 16);
    note('Flew to <b>' + escapeHtml(c.name || '(unnamed)') + '</b> — ' + (c.green || 0) + ' greens, ' +
         (c.hole || 0) + ' hole lines in the survey. Loading features…', 'busy');
    setTimeout(loadCourse, 350);
  }

  $('btn-coverage').addEventListener('click', openCoverage);
  $('btn-cov-close').addEventListener('click', function () { $('coverage').hidden = true; });
  $('cov-search').addEventListener('input', renderCoverage);
  Array.prototype.forEach.call(document.querySelectorAll('.cov-sort button'), function (b) {
    b.addEventListener('click', function () {
      var key = b.dataset.key;
      if (covSort.key === key) covSort.dir = covSort.dir === 'desc' ? 'asc' : 'desc';
      else covSort = { key: key, dir: key === 'name' ? 'asc' : 'desc' };
      Array.prototype.forEach.call(document.querySelectorAll('.cov-sort button'), function (o) {
        o.classList.toggle('on', o === b);
      });
      renderCoverage();
    });
  });

  /* ================= holes toggle ================= */

  $('btn-holes').addEventListener('click', function () {
    var on = !map.hasLayer(routeLayer);
    if (on) { map.addLayer(routeLayer); map.addLayer(labelLayer); }
    else { map.removeLayer(routeLayer); map.removeLayer(labelLayer); }
    this.classList.toggle('on', on);
    this.setAttribute('aria-pressed', String(on));
  });

  $('btn-load').addEventListener('click', loadCourse);

  /* ================= helpers ================= */

  function midpoint(pts) {
    if (pts.length === 2) return [(pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2];
    return pts[Math.floor(pts.length / 2)];
  }

  function ringArea(ring) {                 // relative, for draw ordering only
    var b = G.bboxOf(ring);
    return (b.north - b.south) * (b.east - b.west);
  }

  function ringAreaM2(ring) {               // local planar approximation
    var lat0 = ring[0][0] * Math.PI / 180;
    var mx = 111320 * Math.cos(lat0), my = 110540;
    var a = 0;
    for (var i = 0; i < ring.length; i++) {
      var p = ring[i], q = ring[(i + 1) % ring.length];
      a += (p[1] * mx) * (q[0] * my) - (q[1] * mx) * (p[0] * my);
    }
    return Math.abs(a / 2);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }

  /* ================= go ================= */

  // Load the default view straight away so the page proves itself without a tap.
  map.whenReady(function () { setTimeout(loadCourse, 600); });

  // Exposed for the browser test in tests/browser.test.mjs.
  window.APP = {
    map: map, loadCourse: loadCourse,
    layers: { course: courseLayer, routes: routeLayer, labels: labelLayer, relief: reliefLayer },
    count: function (name) { return this.layers[name].getLayers().length; },
    get parsed() { return lastParse; },
    get selected() { return selected && selected.feature_; },
    get scanning() { return scan.running; }
  };
})();

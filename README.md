# Course data inspection map — Netherlands

One page that puts three open datasets on top of each other so a human can
decide whether they are good enough to build a golf app on:

| dataset | source | licence |
| --- | --- | --- |
| aerial imagery | PDOK `luchtfotorgb` WMTS — `Actueel_orthoHR` (8 cm, leaf-off winter) and `Actueel_ortho25` (25 cm, summer, mowing lines) | CC BY 4.0 |
| terrain height | AHN 0.5 m `dtm_05m` / `dsm_05m` WMS `GetFeatureInfo` | CC0 |
| course geometry | OpenStreetMap `golf=*` via Overpass | ODbL |

This is an inspection tool, not a product. Nobody is going to play a round with
it. It exists to answer three questions:

1. **Do the datasets combine usefully?** — imagery, polygons and height in
   register with each other.
2. **Is the imagery detailed enough** to see individual greens, bunkers and
   mowing lines? Toggle between the 8 cm and 25 cm layers and judge.
3. **Is OpenStreetMap coverage good enough** across Dutch courses to depend on?
   The **Coverage** panel answers this from a committed survey.

No bundler, no framework, no build step: `index.html`, `styles.css`, `app.js`
and `lib.js`, with Leaflet from cdnjs. Open the file directly and hack on it.

## Deploying it (one manual step, then it is live)

The repository is public and everything is committed. GitHub Pages has to be
switched on once by hand — creating a Pages site needs repository-admin rights
that no automation token (including a workflow's `GITHUB_TOKEN`) can hold:

> **Settings → Pages → Build and deployment → Source: _Deploy from a branch_ →
> Branch: `claude/prototype-build-mk8zm2`, folder `/ (root)` → Save**

A minute later the site is at
`https://lesteenman.github.io/golf-tracking-gps-prototype/`. Verify it is really
serving — a green Actions run is not proof:

```sh
node tests/smoke.mjs https://lesteenman.github.io/golf-tracking-gps-prototype/
```

It fetches the page and every asset, retrying while Pages publishes, and checks
the markup is what it should be. After merging to `main`, point the same setting
at `main` — or switch Source to _GitHub Actions_ and run the dispatch-only
`deploy pages` workflow instead.

Asset paths are relative on purpose: the site lives under a repository
sub-path, so `/app.js` would 404.

## Running it locally

```sh
python3 -m http.server 8000     # then open http://localhost:8000
```

`file://` works too, except for the browser geolocation button, which needs
https or localhost.

## What it does

- **Aerial imagery** with a winter/summer toggle. The zoom level in the WMTS
  path is zero-padded to two digits (`08`, not `8`); a plain Leaflet `{z}`
  template silently fails below zoom 10, so `getTileUrl` is overridden.
- **Course polygons** for whatever the map is currently showing. `Load course
  here` queries Overpass for the visible bounds with `out geom;`, so way
  geometry arrives inline. Four endpoints are tried in turn and the one that
  answers is remembered; if all four fail the error names them rather than
  saying "try again".
- **Terrain height** on hover (desktop, debounced, stale responses dropped so a
  fast mouse cannot render an out-of-order value) and on tap (touch). Switch
  between the terrain model and the surface model with `DTM`/`DSM`. Heights are
  metres relative to NAP and are legitimately negative in much of the country.
- **Hole routing** from `golf=hole` ways, labelled with hole number and par.
  156 of the 178 well-mapped Dutch courses have these; where they are missing
  the route is derived from tee centroid to green centroid and drawn dashed
  with a `*`. Vertices sit roughly where a scratch golfer's shots would land —
  that is a drawing convention, not distance data.
- **Green relief scan.** Select a green, press `Scan green relief`, and the app
  samples a 15 × 15 AHN grid inside the polygon and draws client-side contours
  every 0.25 m, reporting the fall across the green. At 0.5 m grid spacing and
  5 cm vertical accuracy, green undulation is genuinely resolvable — this is
  the thing no free app shows you. It costs roughly 150–200 `GetFeatureInfo`
  requests per green, six in flight at a time, and is cancellable.
- **Service check.** `Legend → Check data services` probes all three
  independently — a tile, one `GetFeatureInfo`, one small Overpass query — and
  reports which answered. When the map looks wrong, the first question is which
  of the three is down, and this answers it without opening devtools.
- **Coverage panel** over the committed survey: sortable, searchable, and
  clicking a course flies the map there and loads it.

## Coverage survey

`data/nl-course-coverage.json`, queried against the Netherlands on 2026-08-24:

- **296** golf courses tagged in OpenStreetMap
- **178 (60%)** have 9 or more greens mapped
- **30 (10%)** are partially mapped, 1–8 greens
- **88 (30%)** have no greens at all
- of the 178 well-mapped: 156 have hole routing lines, 149 pin nodes, 118 fairways
  (counted on the same 9-or-more threshold as the greens; a unit test pins these
  numbers against the committed JSON so a refreshed survey cannot silently drift)

Carry the caveats rather than hiding them: counts were assigned to the nearest
course centroid within 2 km, so multi-course facilities may be merged into one
entry, and some zero-green entries are driving ranges or pitch-and-putt rather
than genuinely unmapped courses. Verify a handful by eye before treating 60% as
gospel. A few entries sit in the Caribbean Netherlands, outside the PDOK and
AHN footprint; the UI flags those as **no imagery**.

The honest reading: good enough to build on for a handful of home courses, not
good enough to assume an arbitrary Dutch course will work. An app will need a
graceful "this course is not mapped" path either way.

Regenerate with:

```sh
node scripts/build-coverage.mjs                      # whole country, minutes
node scripts/build-coverage.mjs --bbox 52.0,5.9,52.3,6.2   # quick check
```

## Tests

```sh
npm test            # 32 unit tests, no network, no browser
npm run test:browser # 13 tests driving Chromium with the three services stubbed
npm run smoke -- https://lesteenman.github.io/golf-tracking-gps-prototype/
```

The browser tests replay recorded-shape responses for PDOK, AHN and Overpass
(`tests/fixtures.cjs`) against a real Chromium, so the wiring — polygons drawn,
height on hover and on tap, hole labels, contours, coverage filtering, and the
all-endpoints-down error — is checked without hammering the live services.
Leaflet is vendored under `tests/vendor/` to keep them hermetic.

## What was verified

The build sandbox cannot reach any of the three services, so the live checks run
on a GitHub runner instead — `node scripts/check-live-services.mjs`, using the
page's own URL builders. Last run, against the real services:

| check | result |
| --- | --- |
| `Actueel_orthoHR` tile (8 cm winter) | HTTP 200, `image/jpeg`, 18.9 kB, CORS `*` |
| `Actueel_ortho25` tile (25 cm summer) | HTTP 200, `image/jpeg`, 21.3 kB, CORS `*` |
| zero-padded zoom below z10 | padded serves 27 kB — **and the unpadded path is accepted too** |
| AHN `dtm_05m` at Apeldoorn | 18.25 m NAP, CORS `*` |
| AHN `dsm_05m` at Apeldoorn | 28.10 m NAP (canopy, ~10 m above terrain) |
| AHN below sea level (Zuidplaspolder) | −6.58 m NAP — negatives survive parsing |
| Overpass `overpass-api.de` | HTML body under HTTP 200 — unusable |
| Overpass `overpass.kumi.systems` | HTTP 500 |
| Overpass `overpass.private.coffee` | HTTP 500 |
| Overpass `maps.mail.ru` | 28 greens, 176 polygons, 28 hole lines, 26 pins at De Scherpenbergh, CORS `*` |

Two things worth carrying forward. The brief said a plain Leaflet `{z}` template
silently fails at low zoom; measured, the service accepts both forms, so the
`getTileUrl` override is correct-by-documentation rather than load-bearing.
And the Overpass fallback list is not defensive padding — three of four mirrors
failed from a datacentre IP, one of them by returning an HTML error page under
HTTP 200, which is exactly the case that breaks a naive `await r.json()`. From a
domestic connection `overpass-api.de` is likely to answer first; the app
remembers whichever one did.

The page itself was then served on a runner and driven in a real browser with
nothing stubbed — `npm run test:live` — which is as close to the deployed
article as it gets without Pages. All six checks pass:

| check | result |
| --- | --- |
| boots, Leaflet loads from cdnjs | title renders, `window.APP` present |
| real PDOK tiles | 24 loaded, 0 failed |
| real Overpass at De Scherpenbergh | 22 greens, 139 polygons, 22 hole lines — the survey says 22 greens, 21 hole lines |
| real AHN on hover | 17.83 m NAP under the cursor |
| in-page service check | imagery ✓, height ✓ (18.25 m NAP), course data ✓ (261 features) |
| relief scan on a real green | 543 m² green, **fall 0.54 m over 45 m**, 124 live AHN samples, contours every 0.25 m |

That last row is the answer to the question the brief cared most about: AHN does
resolve green undulation, and half a metre of fall across a green shows up as
readable contours over the aerial photograph.

The remaining unverified step is the deployed site itself, because Pages has not
been enabled yet. `.github/workflows/verify-site.yml` runs the moment Pages
first publishes (`on: page_build`): it fetches every asset and then drives the
live site in a real browser — real tiles, real heights, real Overpass — and
uploads screenshots. It can also be dispatched by hand at any time.

## Structure

```
index.html      markup
styles.css      dark chrome, 44 px touch targets, sunlight contrast
lib.js          pure helpers — tile URLs, Overpass parsing, geometry,
                marching squares, coverage maths. No DOM, no Leaflet.
app.js          Leaflet and DOM wiring
data/           the committed coverage survey
scripts/        survey regeneration
tests/          unit, browser and smoke tests
```

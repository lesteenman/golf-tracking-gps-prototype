import test from 'node:test';
import assert from 'node:assert/strict';
import { assignToCourses, elementCentre, metres } from '../scripts/build-coverage.mjs';

test('element centre comes from center for ways, lat/lon for nodes', () => {
  assert.deepEqual(elementCentre({ type: 'way', center: { lat: 52, lon: 6 } }), [52, 6]);
  assert.deepEqual(elementCentre({ type: 'node', lat: 52, lon: 6 }), [52, 6]);
  assert.equal(elementCentre({ type: 'way' }), null);
});

test('features go to the nearest course centroid', () => {
  const courses = [
    { osm: 'way/1', name: 'Near', lat: 52.0, lon: 6.0 },
    { osm: 'way/2', name: 'Far', lat: 52.5, lon: 6.0 }
  ];
  const features = [
    { kind: 'green', lat: 52.001, lon: 6.001 },
    { kind: 'green', lat: 52.499, lon: 6.001 },
    { kind: 'bunker', lat: 52.002, lon: 6.002 },
    { kind: 'clubhouse', lat: 52.0, lon: 6.0 }        // not a counted kind
  ];
  const { rows, orphans } = assignToCourses(courses, features);
  const near = rows.find(r => r.name === 'Near');
  assert.equal(near.green, 1);
  assert.equal(near.bunker, 1);
  assert.equal(rows.find(r => r.name === 'Far').green, 1);
  assert.equal(orphans, 0);
});

test('features further than 2 km from any course are dropped, not misfiled', () => {
  const courses = [{ osm: 'way/1', name: 'Only', lat: 52.0, lon: 6.0 }];
  const { rows, orphans } = assignToCourses(courses, [{ kind: 'green', lat: 52.1, lon: 6.0 }]);
  assert.equal(rows[0].green, 0);
  assert.equal(orphans, 1);
  assert.ok(metres([52.0, 6.0], [52.1, 6.0]) > 2000);
});

test('rows come out sorted by green count, as the committed survey is', () => {
  const courses = [
    { osm: 'w/1', name: 'A', lat: 52.0, lon: 6.0 },
    { osm: 'w/2', name: 'B', lat: 52.02, lon: 6.0 }
  ];
  const features = [
    { kind: 'green', lat: 52.02, lon: 6.0 },
    { kind: 'green', lat: 52.021, lon: 6.0 }
  ];
  assert.deepEqual(assignToCourses(courses, features).rows.map(r => r.name), ['B', 'A']);
});

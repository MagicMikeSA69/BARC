import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeFare, fareRange, validateRates } from '../src/fare.ts';
import { estimateRoadKm, haversineKm, estimateEtaMinutes, isValidLatLng } from '../src/geo.ts';
import { NETWORK_TAKE_RATE, MAX_COMMUNITY_CONTRIBUTION_RATE, suggestedRatesFor } from '../src/protocol.ts';

const rates = { base: 15, perKm: 9, perMin: 1.2, minimum: 35, currency: 'ZAR' };

test('fare is base + distance + time with no surge or margin', () => {
  const f = computeFare(rates, 10, 20);
  assert.equal(f.base, 15);
  assert.equal(f.distance, 90);
  assert.equal(f.time, 24);
  assert.equal(f.subtotal, 129);
  assert.equal(f.total, 129);
  assert.equal(f.minimumTopUp, 0);
});

test('driver minimum applies to short trips', () => {
  const f = computeFare(rates, 0.5, 2);
  assert.equal(f.subtotal, 21.9);
  assert.equal(f.total, 35);
  assert.equal(f.minimumTopUp, 13.1);
});

test('negative inputs are rejected', () => {
  assert.throws(() => computeFare(rates, -1, 0), RangeError);
  assert.throws(() => computeFare(rates, 1, Number.NaN), RangeError);
});

test('fare range spans the cheapest and dearest rate cards', () => {
  const cheap = { ...rates, perKm: 5 };
  const dear = { ...rates, perKm: 14 };
  const r = fareRange([cheap, rates, dear], 10, 10);
  assert.deepEqual(r, { min: 77, max: 167 });
  assert.equal(fareRange([], 10, 10), null);
});

test('rate validation', () => {
  assert.ok(validateRates(rates));
  assert.ok(!validateRates({ ...rates, currency: 'rand' }));
  assert.ok(!validateRates({ ...rates, perKm: -1 }));
  assert.ok(!validateRates(null));
});

test('haversine distance Cape Town to Johannesburg is about 1260 km', () => {
  const d = haversineKm({ lat: -33.9249, lng: 18.4241 }, { lat: -26.2041, lng: 28.0473 });
  assert.ok(d > 1250 && d < 1275, `got ${d}`);
});

test('road estimate adds a detour factor and eta is at least a minute', () => {
  const a = { lat: 0, lng: 0 };
  const b = { lat: 0, lng: 0.01 };
  assert.ok(estimateRoadKm(a, b) > haversineKm(a, b));
  assert.equal(estimateEtaMinutes(a, a), 1);
});

test('latlng validation', () => {
  assert.ok(isValidLatLng({ lat: 10, lng: 20 }));
  assert.ok(!isValidLatLng({ lat: 91, lng: 20 }));
  assert.ok(!isValidLatLng({ lat: '1', lng: 2 }));
});

test('protocol constants: zero take, capped contribution, sensible suggested rates', () => {
  assert.equal(NETWORK_TAKE_RATE, 0);
  assert.ok(MAX_COMMUNITY_CONTRIBUTION_RATE <= 0.05);
  assert.equal(suggestedRatesFor('ZAR').currency, 'ZAR');
  assert.equal(suggestedRatesFor('KES').currency, 'KES');
});

test('relative description names distance and compass direction', async () => {
  const { describeRelative, bearingDeg } = await import('../src/geo.ts');
  const c = { lat: -33.9249, lng: 18.4241 };
  assert.equal(describeRelative(c, c), 'centre');
  assert.match(describeRelative({ lat: -33.9249, lng: 18.4441 }, c), /^1\.\d km E of centre$/);
  assert.ok(Math.abs(bearingDeg(c, { lat: -33.9, lng: 18.4241 }) - 0) < 1);
});

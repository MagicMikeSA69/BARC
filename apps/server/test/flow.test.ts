import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { buildNode, type BarcNode } from '../src/app.ts';

let node: BarcNode;
let baseUrl: string;

const CAPE_TOWN = { lat: -33.9249, lng: 18.4241, label: 'Cape Town CBD' };
const SEA_POINT = { lat: -33.9169, lng: 18.3891, label: 'Sea Point' };
const CAMPS_BAY = { lat: -33.9509, lng: 18.3776, label: 'Camps Bay' };

async function api(path: string, opts: { method?: string; token?: string; body?: unknown } = {}) {
  const res = await node.app.inject({
    method: (opts.method ?? 'GET') as 'GET',
    url: path,
    headers: opts.token ? { authorization: `Bearer ${opts.token}` } : {},
    payload: opts.body as Record<string, unknown> | undefined,
  });
  return { status: res.statusCode, json: res.json() };
}

async function register(handle: string, role: string) {
  const r = await api('/auth/register', { method: 'POST', body: { handle, displayName: handle, role } });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return r.json as { token: string; user: { id: string } };
}

before(async () => {
  node = await buildNode({ nodeName: 'Test Town', currency: 'ZAR' });
  await node.app.listen({ port: 0, host: '127.0.0.1' });
  const addr = node.app.server.address();
  assert.ok(addr && typeof addr === 'object');
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  await node.close();
});

test('node advertises zero take rate publicly', async () => {
  const r = await api('/');
  assert.equal(r.status, 200);
  assert.equal(r.json.networkTakeRate, 0);
  assert.equal(r.json.name, 'Test Town');
  assert.equal(r.json.currency, 'ZAR');
});

test('registration validates input and rejects duplicate handles', async () => {
  const bad = await api('/auth/register', { method: 'POST', body: { handle: 'x', displayName: 'X', role: 'rider' } });
  assert.equal(bad.status, 400);
  await register('dupe', 'rider');
  const again = await api('/auth/register', { method: 'POST', body: { handle: 'dupe', displayName: 'D', role: 'rider' } });
  assert.equal(again.status, 409);
  const noauth = await api('/me');
  assert.equal(noauth.status, 401);
});

test('full ride: quote, request, offer, accept, drive, complete, rate, export', async () => {
  const rider = await register('thandi', 'rider');
  const driver = await register('sipho', 'driver');
  const driver2 = await register('lerato', 'both');

  // Drivers publish their own rate cards. The node never edits them.
  const rates = await api('/me', {
    method: 'PATCH',
    token: driver.token,
    body: {
      rates: { base: 15, perKm: 9, perMin: 1.2, minimum: 35, currency: 'ZAR' },
      vehicle: { make: 'Toyota', model: 'Corolla', colour: 'white', plate: 'CA 123', seats: 4 },
      paymentHandle: 'Cash or SnapScan',
    },
  });
  assert.equal(rates.status, 200);
  assert.equal(rates.json.user.rates.perKm, 9);
  const badRates = await api('/me', { method: 'PATCH', token: driver.token, body: { rates: { base: -1 } } });
  assert.equal(badRates.status, 400);
  await api('/me', {
    method: 'PATCH',
    token: driver2.token,
    body: { rates: { base: 20, perKm: 12, perMin: 1.5, minimum: 40, currency: 'ZAR' } },
  });

  // Drivers go online at a location. Riders may not publish presence.
  const riderPresence = await api('/me/presence', { method: 'POST', token: rider.token, body: { online: true } });
  assert.equal(riderPresence.status, 403);
  for (const d of [driver, driver2]) {
    const p = await api('/me/presence', { method: 'POST', token: d.token, body: { online: true, location: CAPE_TOWN } });
    assert.equal(p.status, 200);
  }
  const info = await api('/');
  assert.equal(info.json.driversOnline, 2);

  // Rider previews what nearby drivers would charge, cheapest first.
  const quote = await api('/quotes', { method: 'POST', token: rider.token, body: { pickup: SEA_POINT, dropoff: CAMPS_BAY } });
  assert.equal(quote.status, 200);
  assert.equal(quote.json.driversNearby, 2);
  assert.equal(quote.json.quotes.length, 2);
  assert.equal(quote.json.quotes[0].driverId, driver.user.id);
  assert.ok(quote.json.quotes[0].fare.total <= quote.json.quotes[1].fare.total);
  assert.ok(quote.json.range.min <= quote.json.range.max);

  // Driver connects over WebSocket so we can check the push.
  const ws = new WebSocket(`${baseUrl.replace('http', 'ws')}/ws?token=${driver.token}`);
  const events: Array<{ type: string }> = [];
  await new Promise<void>((resolve, reject) => {
    ws.on('message', (raw) => {
      const ev = JSON.parse(String(raw));
      events.push(ev);
      if (ev.type === 'hello') resolve();
    });
    ws.on('error', reject);
  });
  ws.send(JSON.stringify({ type: 'presence', online: true, location: CAPE_TOWN, heading: 90 }));

  // Rider posts a request.
  const created = await api('/rides', {
    method: 'POST',
    token: rider.token,
    body: { pickup: SEA_POINT, dropoff: CAMPS_BAY, seats: 1, note: 'two bags' },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const rideId = created.json.ride.id as string;
  assert.equal(created.json.ride.status, 'open');
  assert.equal(created.json.ride.currency, 'ZAR');
  const dupReq = await api('/rides', { method: 'POST', token: rider.token, body: { pickup: SEA_POINT, dropoff: CAMPS_BAY } });
  assert.equal(dupReq.status, 409);

  await new Promise((r) => setTimeout(r, 50));
  assert.ok(events.some((e) => e.type === 'ride.new'), `driver should be told about the new ride, got ${JSON.stringify(events)}`);

  // Drivers see open requests near them with a suggested fare from their own card.
  const open = await api(`/rides/open?lat=${CAPE_TOWN.lat}&lng=${CAPE_TOWN.lng}`, { token: driver.token });
  assert.equal(open.status, 200);
  assert.equal(open.json.rides.length, 1);
  assert.ok(open.json.rides[0].suggestedFare > 0);
  assert.equal(open.json.rides[0].myOffer, null);
  const riderOpen = await api('/rides/open', { token: rider.token });
  assert.equal(riderOpen.status, 403);

  // Both drivers make offers. The rider sees them all.
  const offer1 = await api(`/rides/${rideId}/offers`, { method: 'POST', token: driver.token, body: { fare: 80, etaMin: 6, message: 'On my way' } });
  assert.equal(offer1.status, 201, JSON.stringify(offer1.json));
  const offer2 = await api(`/rides/${rideId}/offers`, { method: 'POST', token: driver2.token, body: { fare: 70, etaMin: 12 } });
  assert.equal(offer2.status, 201);
  // Revising an offer replaces it rather than adding a second one.
  const revised = await api(`/rides/${rideId}/offers`, { method: 'POST', token: driver.token, body: { fare: 75, etaMin: 5 } });
  assert.equal(revised.status, 201);
  assert.equal(revised.json.offer.id, offer1.json.offer.id);

  const detail = await api(`/rides/${rideId}`, { token: rider.token });
  assert.equal(detail.json.offers.length, 2);
  assert.equal(detail.json.offers[0].fare, 70); // cheapest first
  assert.equal(detail.json.driver, null);

  // A driver cannot accept on the rider's behalf; the rider picks.
  const notRider = await api(`/rides/${rideId}/accept`, { method: 'POST', token: driver.token, body: { offerId: offer1.json.offer.id } });
  assert.equal(notRider.status, 403);
  const accept = await api(`/rides/${rideId}/accept`, { method: 'POST', token: rider.token, body: { offerId: offer1.json.offer.id } });
  assert.equal(accept.status, 200, JSON.stringify(accept.json));
  assert.equal(accept.json.ride.status, 'accepted');
  assert.equal(accept.json.ride.driverId, driver.user.id);
  assert.equal(accept.json.ride.agreedFare, 75);

  await new Promise((r) => setTimeout(r, 50));
  assert.ok(events.some((e) => e.type === 'ride.updated'));
  assert.ok(events.some((e) => e.type === 'offer.updated'));

  // Losing offer was declined; the request is gone from the open list.
  const afterAccept = await api(`/rides/${rideId}`, { token: rider.token });
  const losing = afterAccept.json.offers.find((o: { id: string }) => o.id === offer2.json.offer.id);
  assert.equal(losing.status, 'declined');
  assert.equal(afterAccept.json.driver.paymentHandle, 'Cash or SnapScan');
  const openAfter = await api('/rides/open', { token: driver2.token });
  assert.equal(openAfter.json.rides.length, 0);

  // Only the driver advances the trip; the rider cannot mark it in progress.
  const riderProgress = await api(`/rides/${rideId}/status`, { method: 'POST', token: rider.token, body: { status: 'arrived' } });
  assert.equal(riderProgress.status, 403);
  const loc = await api(`/rides/${rideId}/location`, { method: 'POST', token: driver.token, body: { location: SEA_POINT, heading: 45 } });
  assert.equal(loc.status, 200);
  for (const status of ['arrived', 'in_progress']) {
    const r = await api(`/rides/${rideId}/status`, { method: 'POST', token: driver.token, body: { status } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
  }
  const cancelUnderway = await api(`/rides/${rideId}/status`, { method: 'POST', token: rider.token, body: { status: 'cancelled' } });
  assert.equal(cancelUnderway.status, 409);
  const done = await api(`/rides/${rideId}/status`, { method: 'POST', token: driver.token, body: { status: 'completed' } });
  assert.equal(done.json.ride.status, 'completed');

  // Mutual ratings, once each.
  const rate1 = await api(`/rides/${rideId}/rate`, { method: 'POST', token: rider.token, body: { stars: 5 } });
  assert.equal(rate1.status, 200);
  const rateAgain = await api(`/rides/${rideId}/rate`, { method: 'POST', token: rider.token, body: { stars: 1 } });
  assert.equal(rateAgain.status, 409);
  const rate2 = await api(`/rides/${rideId}/rate`, { method: 'POST', token: driver.token, body: { stars: 4 } });
  assert.equal(rate2.status, 200);

  const driverMe = await api('/me', { token: driver.token });
  assert.equal(driverMe.json.user.ratingAvg, 5);
  assert.equal(driverMe.json.user.ridesCompleted, 1);
  const riderMe = await api('/me', { token: rider.token });
  assert.equal(riderMe.json.user.ratingAvg, 4);

  // Reputation is portable: the member can export everything.
  const exp = await api('/me/export', { token: driver.token });
  assert.equal(exp.status, 200);
  assert.equal(exp.json.rides.length, 1);
  assert.equal(exp.json.user.ratingAvg, 5);

  // Closing the socket takes the driver offline.
  ws.close();
  await new Promise((r) => setTimeout(r, 50));
  const infoAfter = await api('/');
  assert.equal(infoAfter.json.driversOnline, 1);
});

test('rider can cancel an open request and drivers cannot offer on a closed one', async () => {
  const rider = await register('naledi', 'rider');
  const driver = await register('bongani', 'driver');
  const created = await api('/rides', { method: 'POST', token: rider.token, body: { pickup: SEA_POINT, dropoff: CAMPS_BAY } });
  const id = created.json.ride.id;
  const cancel = await api(`/rides/${id}/status`, { method: 'POST', token: rider.token, body: { status: 'cancelled' } });
  assert.equal(cancel.status, 200);
  const offer = await api(`/rides/${id}/offers`, { method: 'POST', token: driver.token, body: { fare: 50, etaMin: 5 } });
  assert.equal(offer.status, 409);
});

test('governance: one member one vote, revisable, closed proposals reject votes', async () => {
  const a = await register('gov_a', 'driver');
  const b = await register('gov_b', 'rider');
  const created = await api('/proposals', {
    method: 'POST',
    token: a.token,
    body: { title: 'Hosting contribution of 1%', body: 'Fund the server with a 1% voluntary contribution, reviewed quarterly.', days: 7 },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const id = created.json.proposal.id;
  assert.equal(created.json.proposal.yes, 1); // proposer's yes
  assert.equal(created.json.proposal.myVote, 'yes');

  const vote = await api(`/proposals/${id}/vote`, { method: 'POST', token: b.token, body: { choice: 'no' } });
  assert.equal(vote.status, 200);
  assert.equal(vote.json.proposal.no, 1);
  const revote = await api(`/proposals/${id}/vote`, { method: 'POST', token: b.token, body: { choice: 'yes' } });
  assert.equal(revote.json.proposal.yes, 2);
  assert.equal(revote.json.proposal.no, 0);

  const list = await api('/proposals', { token: b.token });
  assert.ok(list.json.members >= 2);
  assert.equal(list.json.proposals.find((p: { id: string }) => p.id === id).myVote, 'yes');

  // Force the proposal closed and check votes are refused.
  node.store.db.prepare('UPDATE proposals SET closes_at = ? WHERE id = ?').run(new Date(0).toISOString(), id);
  const late = await api(`/proposals/${id}/vote`, { method: 'POST', token: a.token, body: { choice: 'no' } });
  assert.equal(late.status, 409);
});

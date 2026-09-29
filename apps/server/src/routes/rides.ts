import type { FastifyInstance } from 'fastify';
import {
  DEFAULT_MATCH_RADIUS_KM,
  computeFare,
  estimateEtaMinutes,
  estimateMinutes,
  estimateRoadKm,
  fareRange,
  isValidLatLng,
  withinKm,
  type LatLng,
  type Offer,
  type Place,
  type RideRequest,
  type RideStatus,
} from '@barc/shared';
import { currentUser, newId, requireUser } from '../auth.ts';
import type { Store } from '../db.ts';
import type { Hub } from '../realtime.ts';

function cleanPlace(p: unknown): Place | null {
  if (!isValidLatLng(p)) return null;
  const rawLabel = (p as Partial<Place>).label;
  const label = typeof rawLabel === 'string' ? rawLabel.trim().slice(0, 120) : '';
  return { lat: p.lat, lng: p.lng, label: label || `${p.lat.toFixed(4)}, ${p.lng.toFixed(4)}` };
}

const TRANSITIONS: Record<RideStatus, RideStatus[]> = {
  open: ['cancelled'],
  accepted: ['arrived', 'cancelled'],
  arrived: ['in_progress', 'cancelled'],
  in_progress: ['completed'],
  completed: [],
  cancelled: [],
};

export function rideRoutes(app: FastifyInstance, store: Store, hub: Hub): void {
  const auth = { preHandler: requireUser(store) };

  /** Drivers near a point, with what each would charge — the rider's price preview. */
  app.post('/quotes', auth, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const pickup = cleanPlace(body.pickup);
    const dropoff = cleanPlace(body.dropoff);
    if (!pickup || !dropoff) return reply.code(400).send({ error: 'pickup and dropoff are required' });
    const km = estimateRoadKm(pickup, dropoff);
    const min = estimateMinutes(km);
    const nearby = store.onlineDrivers().filter((d) => withinKm(pickup, d, DEFAULT_MATCH_RADIUS_KM) && d.user.rates);
    const quotes = nearby.map((d) => ({
      driverId: d.userId,
      displayName: d.user.displayName,
      ratingAvg: d.user.ratingAvg,
      ratingCount: d.user.ratingCount,
      etaMin: estimateEtaMinutes(d, pickup),
      fare: computeFare(d.user.rates!, km, min),
    }));
    quotes.sort((a, b) => a.fare.total - b.fare.total);
    return {
      estimatedKm: Math.round(km * 10) / 10,
      estimatedMin: Math.round(min),
      driversNearby: nearby.length,
      range: fareRange(
        nearby.map((d) => d.user.rates!),
        km,
        min,
      ),
      quotes,
    };
  });

  app.post('/rides', auth, async (req, reply) => {
    const me = currentUser(req);
    if (store.activeRideForUser(me.id)) return reply.code(409).send({ error: 'you already have an active ride' });
    const body = (req.body ?? {}) as Record<string, unknown>;
    const pickup = cleanPlace(body.pickup);
    const dropoff = cleanPlace(body.dropoff);
    if (!pickup || !dropoff) return reply.code(400).send({ error: 'pickup and dropoff are required' });
    const maxFare = typeof body.maxFare === 'number' && body.maxFare > 0 ? body.maxFare : null;
    const seats = Number.isInteger(body.seats) && (body.seats as number) > 0 ? (body.seats as number) : 1;
    const km = estimateRoadKm(pickup, dropoff);
    const now = new Date().toISOString();
    const ride = store.createRide({
      id: newId('ride'),
      riderId: me.id,
      pickup,
      dropoff,
      estimatedKm: Math.round(km * 10) / 10,
      estimatedMin: Math.round(estimateMinutes(km)),
      maxFare,
      currency: String(body.currency ?? store.getSetting('currency', 'USD')).toUpperCase().slice(0, 3),
      seats: Math.min(seats, 8),
      note: String(body.note ?? '').slice(0, 280),
      status: 'open',
      driverId: null,
      acceptedOfferId: null,
      agreedFare: null,
      riderRating: null,
      driverRating: null,
      createdAt: now,
      updatedAt: now,
    });
    // Tell every online driver in range. They decide whether to offer.
    const drivers = store.onlineDrivers().filter((d) => withinKm(pickup, d, DEFAULT_MATCH_RADIUS_KM));
    hub.sendMany(
      drivers.map((d) => d.userId),
      { type: 'ride.new', ride },
    );
    return reply.code(201).send({ ride });
  });

  app.get('/rides', auth, async (req) => {
    const me = currentUser(req);
    return { rides: store.ridesForUser(me.id), active: store.activeRideForUser(me.id) };
  });

  /** Open requests near a driver. */
  app.get('/rides/open', auth, async (req, reply) => {
    const me = currentUser(req);
    if (me.role === 'rider') return reply.code(403).send({ error: 'drivers only' });
    const q = req.query as Record<string, string | undefined>;
    const lat = Number(q.lat);
    const lng = Number(q.lng);
    const here: LatLng | null = Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
    const rides = store
      .openRides()
      .filter((r) => !here || withinKm(here, r.pickup, DEFAULT_MATCH_RADIUS_KM))
      .map((r) => ({
        ...r,
        myOffer: store.offerByDriverForRide(r.id, me.id),
        suggestedFare: me.rates ? computeFare(me.rates, r.estimatedKm, r.estimatedMin).total : null,
        etaMin: here ? estimateEtaMinutes(here, r.pickup) : null,
      }));
    return { rides };
  });

  app.get('/rides/:id', auth, async (req, reply) => {
    const me = currentUser(req);
    const { id } = req.params as { id: string };
    const ride = store.getRide(id);
    if (!ride) return reply.code(404).send({ error: 'no such ride' });
    const isParty = ride.riderId === me.id || ride.driverId === me.id;
    const isDriverCandidate = me.role !== 'rider' && ride.status === 'open';
    if (!isParty && !isDriverCandidate) return reply.code(403).send({ error: 'not your ride' });
    const offers = ride.riderId === me.id ? store.offersForRide(id) : store.offersForRide(id).filter((o) => o.driverId === me.id);
    const rider = store.getUser(ride.riderId);
    const driver = ride.driverId ? store.getUser(ride.driverId) : null;
    // Payment details are shared only once the two have agreed to ride together.
    const pub = (u: ReturnType<typeof store.getUser>) =>
      u
        ? {
            id: u.id,
            displayName: u.displayName,
            ratingAvg: u.ratingAvg,
            ratingCount: u.ratingCount,
            ridesCompleted: u.ridesCompleted,
            vehicle: u.vehicle,
            paymentHandle: isParty && ride.status !== 'open' ? u.paymentHandle : '',
          }
        : null;
    return { ride, offers, rider: pub(rider), driver: pub(driver) };
  });

  app.post('/rides/:id/offers', auth, async (req, reply) => {
    const me = currentUser(req);
    if (me.role === 'rider') return reply.code(403).send({ error: 'drivers only' });
    const { id } = req.params as { id: string };
    const ride = store.getRide(id);
    if (!ride) return reply.code(404).send({ error: 'no such ride' });
    if (ride.status !== 'open') return reply.code(409).send({ error: 'this request is no longer open' });
    if (ride.riderId === me.id) return reply.code(400).send({ error: 'you cannot offer on your own request' });
    if (store.activeRideForUser(me.id)) return reply.code(409).send({ error: 'finish your current ride first' });
    const body = (req.body ?? {}) as Record<string, unknown>;
    const fare = Number(body.fare);
    const etaMin = Number(body.etaMin);
    if (!Number.isFinite(fare) || fare <= 0) return reply.code(400).send({ error: 'fare must be a positive number' });
    if (!Number.isInteger(etaMin) || etaMin < 0 || etaMin > 240) return reply.code(400).send({ error: 'eta must be 0-240 minutes' });
    const existing = store.offerByDriverForRide(id, me.id);
    let offer: Offer;
    if (existing) {
      // A driver may revise their offer; there is one live offer per driver per ride.
      store.db
        .prepare("UPDATE offers SET fare = ?, eta_min = ?, message = ?, status = 'pending', created_at = ? WHERE id = ?")
        .run(Math.round(fare * 100) / 100, etaMin, String(body.message ?? '').slice(0, 200), new Date().toISOString(), existing.id);
      offer = store.getOffer(existing.id)!;
      hub.send(ride.riderId, { type: 'offer.updated', offer });
    } else {
      offer = store.createOffer({
        id: newId('off'),
        rideId: id,
        driverId: me.id,
        fare: Math.round(fare * 100) / 100,
        currency: ride.currency,
        etaMin,
        message: String(body.message ?? '').slice(0, 200),
        status: 'pending',
        createdAt: new Date().toISOString(),
      });
      hub.send(ride.riderId, { type: 'offer.new', offer });
    }
    return reply.code(201).send({ offer });
  });

  app.post('/rides/:id/offers/:offerId/withdraw', auth, async (req, reply) => {
    const me = currentUser(req);
    const { id, offerId } = req.params as { id: string; offerId: string };
    const offer = store.getOffer(offerId);
    if (!offer || offer.rideId !== id || offer.driverId !== me.id) return reply.code(404).send({ error: 'no such offer' });
    if (offer.status !== 'pending') return reply.code(409).send({ error: 'offer is not pending' });
    const updated = store.setOfferStatus(offerId, 'withdrawn');
    const ride = store.getRide(id)!;
    hub.send(ride.riderId, { type: 'offer.updated', offer: updated });
    return { offer: updated };
  });

  /** The rider picks. This is the moment of agreement between two people. */
  app.post('/rides/:id/accept', auth, async (req, reply) => {
    const me = currentUser(req);
    const { id } = req.params as { id: string };
    const ride = store.getRide(id);
    if (!ride) return reply.code(404).send({ error: 'no such ride' });
    if (ride.riderId !== me.id) return reply.code(403).send({ error: 'only the rider can accept an offer' });
    if (ride.status !== 'open') return reply.code(409).send({ error: 'ride is not open' });
    const { offerId } = (req.body ?? {}) as { offerId?: string };
    const offer = offerId ? store.getOffer(offerId) : null;
    if (!offer || offer.rideId !== id || offer.status !== 'pending') return reply.code(400).send({ error: 'offer is not available' });
    if (store.activeRideForUser(offer.driverId)) {
      store.setOfferStatus(offer.id, 'withdrawn');
      return reply.code(409).send({ error: 'that driver just took another ride' });
    }
    const accepted = store.setOfferStatus(offer.id, 'accepted');
    const others = store.declineOtherOffers(id, offer.id);
    const updated = store.updateRide(id, {
      status: 'accepted',
      driverId: offer.driverId,
      acceptedOfferId: offer.id,
      agreedFare: offer.fare,
    });
    hub.send(offer.driverId, { type: 'offer.updated', offer: accepted });
    for (const o of others) hub.send(o.driverId, { type: 'offer.updated', offer: o });
    hub.sendMany([updated.riderId, offer.driverId], { type: 'ride.updated', ride: updated });
    // Other drivers no longer need to see the request.
    hub.broadcast({ type: 'ride.updated', ride: updated });
    return { ride: updated };
  });

  app.post('/rides/:id/status', auth, async (req, reply) => {
    const me = currentUser(req);
    const { id } = req.params as { id: string };
    const ride = store.getRide(id);
    if (!ride) return reply.code(404).send({ error: 'no such ride' });
    const { status } = (req.body ?? {}) as { status?: RideStatus };
    if (!status || !TRANSITIONS[ride.status]?.includes(status)) {
      return reply.code(409).send({ error: `cannot go from ${ride.status} to ${status}` });
    }
    const isRider = ride.riderId === me.id;
    const isDriver = ride.driverId === me.id;
    if (!isRider && !isDriver) return reply.code(403).send({ error: 'not your ride' });
    // Progress (arrived, in_progress, completed) is the driver's call. Either side may cancel.
    if (status !== 'cancelled' && !isDriver) return reply.code(403).send({ error: 'only the driver can update trip progress' });
    if (status === 'cancelled' && ride.status === 'in_progress') return reply.code(409).send({ error: 'cannot cancel a trip underway' });

    const updated = store.updateRide(id, { status });
    if (status === 'completed') {
      store.incrementRides(ride.riderId);
      if (ride.driverId) store.incrementRides(ride.driverId);
    }
    if (status === 'cancelled' && ride.status === 'open') {
      hub.broadcast({ type: 'ride.updated', ride: updated });
    } else {
      hub.sendMany([updated.riderId, updated.driverId ?? ''].filter(Boolean), { type: 'ride.updated', ride: updated });
    }
    return { ride: updated };
  });

  /** Mutual rating after a completed trip. Each side rates the other once. */
  app.post('/rides/:id/rate', auth, async (req, reply) => {
    const me = currentUser(req);
    const { id } = req.params as { id: string };
    const ride = store.getRide(id);
    if (!ride) return reply.code(404).send({ error: 'no such ride' });
    if (ride.status !== 'completed') return reply.code(409).send({ error: 'rate after the trip is completed' });
    const { stars } = (req.body ?? {}) as { stars?: number };
    if (!Number.isInteger(stars) || stars! < 1 || stars! > 5) return reply.code(400).send({ error: 'stars must be 1-5' });
    if (ride.riderId === me.id) {
      if (ride.driverRating != null) return reply.code(409).send({ error: 'already rated' });
      store.addRating(ride.driverId!, stars!);
      return { ride: store.updateRide(id, { driverRating: stars! }) };
    }
    if (ride.driverId === me.id) {
      if (ride.riderRating != null) return reply.code(409).send({ error: 'already rated' });
      store.addRating(ride.riderId, stars!);
      return { ride: store.updateRide(id, { riderRating: stars! }) };
    }
    return reply.code(403).send({ error: 'not your ride' });
  });

  /** Driver shares live position with the rider during an accepted trip. */
  app.post('/rides/:id/location', auth, async (req, reply) => {
    const me = currentUser(req);
    const { id } = req.params as { id: string };
    const ride = store.getRide(id);
    if (!ride || ride.driverId !== me.id) return reply.code(403).send({ error: 'not your ride' });
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (!isValidLatLng(body.location)) return reply.code(400).send({ error: 'invalid location' });
    const heading = typeof body.heading === 'number' ? body.heading : null;
    store.setPresence(me.id, true, body.location.lat, body.location.lng, heading);
    hub.send(ride.riderId, { type: 'driver.location', rideId: id, location: body.location, heading });
    return { ok: true };
  });
}

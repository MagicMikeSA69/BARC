import {
  DEFAULT_MATCH_RADIUS_KM,
  PROTOCOL_VERSION,
  computeFare,
  estimateEtaMinutes,
  estimateMinutes,
  estimateRoadKm,
  fareRange,
  suggestedRatesFor,
  withinKm,
  type LatLng,
  type NodeInfo,
  type Offer,
  type Place,
  type Proposal,
  type RideRequest,
  type RideStatus,
  type ServerEvent,
  type User,
  type VoteChoice,
} from '@barc/shared';
import { Api, ApiError, DEMO_NODE_URL, type Channel, type NodeApi, type OpenRide, type PublicProfile, type QuoteResponse, type RideDetail } from './api.ts';

/**
 * A simulated node that runs entirely on the device. It exists so anyone
 * can feel the flow (offers arriving, choosing a driver, watching them
 * approach) without hosting a server first. Nothing here leaves the phone.
 *
 * Demo drivers make offers from their own rate cards a few seconds after a
 * request, and the chosen one drives the trip through arrived, on the road
 * and completed. If you sign in as a driver, a demo rider posts a request
 * near you and accepts your offer.
 */

export function createApi(nodeUrl: string, token: string | null = null, user: User | null = null): NodeApi {
  if (nodeUrl === DEMO_NODE_URL) return new DemoApi(user);
  return new Api(nodeUrl, token);
}

const CENTRE: LatLng = { lat: -33.9249, lng: 18.4241 }; // Cape Town CBD
const CURRENCY = 'ZAR';

interface DemoDriver {
  user: User;
  offset: LatLng;
  personality: { priceFactor: number; delayMs: number; message: string };
}

let seq = 0;
const id = (p: string) => `${p}_demo${(++seq).toString(36)}${Date.now().toString(36).slice(-3)}`;
const now = () => new Date().toISOString();
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function mkUser(handle: string, displayName: string, role: User['role'], extra: Partial<User> = {}): User {
  return {
    id: id('usr'),
    handle,
    displayName,
    role,
    paymentHandle: '',
    rates: null,
    vehicle: null,
    ratingAvg: 0,
    ratingCount: 0,
    ridesCompleted: 0,
    createdAt: now(),
    ...extra,
  };
}

export class DemoApi implements NodeApi {
  baseUrl = DEMO_NODE_URL;
  token: string | null = null;
  defaultCentre: LatLng = CENTRE;

  private self: User | null;
  private anchor: LatLng = CENTRE;
  private drivers: DemoDriver[];
  private demoRider: User;
  private rides = new Map<string, RideRequest>();
  private offers = new Map<string, Offer>();
  private props: Proposal[];
  private votes = new Map<string, Map<string, VoteChoice>>();
  private listeners = new Set<(e: ServerEvent) => void>();
  private online = false;
  private riderSpawnTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(user: User | null) {
    this.self = user;
    if (user) this.token = 'demo';
    const base = suggestedRatesFor(CURRENCY);
    const card = (f: number) => ({
      base: Math.round(base.base * f * 100) / 100,
      perKm: Math.round(base.perKm * f * 100) / 100,
      perMin: Math.round(base.perMin * f * 100) / 100,
      minimum: Math.round(base.minimum * f * 100) / 100,
      currency: CURRENCY,
    });
    this.drivers = [
      {
        user: mkUser('sipho', 'Sipho', 'driver', {
          paymentHandle: 'Cash or SnapScan',
          rates: card(1),
          vehicle: { make: 'Toyota', model: 'Corolla', colour: 'white', plate: 'CA 123-456', seats: 4 },
          ratingAvg: 4.9,
          ratingCount: 212,
          ridesCompleted: 640,
        }),
        offset: { lat: 0.012, lng: 0.009 },
        personality: { priceFactor: 1, delayMs: 2500, message: 'On my way, white Corolla.' },
      },
      {
        user: mkUser('lerato', 'Lerato', 'driver', {
          paymentHandle: 'Bank transfer or cash',
          rates: card(0.85),
          vehicle: { make: 'VW', model: 'Polo', colour: 'blue', plate: 'CA 987-654', seats: 4 },
          ratingAvg: 4.7,
          ratingCount: 58,
          ridesCompleted: 131,
        }),
        offset: { lat: -0.018, lng: 0.004 },
        personality: { priceFactor: 0.95, delayMs: 4500, message: 'Happy to do it for a bit less.' },
      },
      {
        user: mkUser('ahmed', 'Ahmed', 'driver', {
          paymentHandle: 'Cash',
          rates: card(1.2),
          vehicle: { make: 'Hyundai', model: 'H1', colour: 'silver', plate: 'CA 555-111', seats: 7 },
          ratingAvg: 5,
          ratingCount: 19,
          ridesCompleted: 44,
        }),
        offset: { lat: 0.006, lng: -0.02 },
        personality: { priceFactor: 1.05, delayMs: 6500, message: '7 seats, room for luggage.' },
      },
    ];
    this.demoRider = mkUser('naledi', 'Naledi', 'rider', { paymentHandle: 'Cash', ratingAvg: 4.8, ratingCount: 31, ridesCompleted: 31 });
    const closes = new Date(Date.now() + 5 * 86_400_000).toISOString();
    this.props = [
      {
        id: id('prop'),
        authorId: this.drivers[1].user.id,
        authorName: 'Lerato',
        title: 'Fund hosting with a 1% contribution',
        body: 'The server costs about R180 a month. A 1% contribution on completed fares would cover it with a little spare for a backup. Reviewed every quarter; we can vote it down any time.',
        closesAt: closes,
        yes: 2,
        no: 1,
        abstain: 0,
        myVote: null,
        createdAt: now(),
      },
      {
        id: id('prop'),
        authorId: this.demoRider.id,
        authorName: 'Naledi',
        title: 'Vouching for new drivers',
        body: 'New drivers should be vouched for by two existing members before they can go online. Keeps the node trusted without handing identity checks to a company.',
        closesAt: closes,
        yes: 3,
        no: 0,
        abstain: 1,
        myVote: null,
        createdAt: now(),
      },
    ];
  }

  // ---- helpers ---------------------------------------------------------

  private emit(e: ServerEvent): void {
    for (const l of this.listeners) l(e);
  }

  private requireMe(): User {
    if (!this.self) throw new ApiError(401, 'sign in first');
    return this.self;
  }

  private driverPos(d: DemoDriver): LatLng {
    return { lat: this.anchor.lat + d.offset.lat, lng: this.anchor.lng + d.offset.lng };
  }

  private userById(uid: string): User | null {
    if (this.self?.id === uid) return this.self;
    if (this.demoRider.id === uid) return this.demoRider;
    return this.drivers.find((d) => d.user.id === uid)?.user ?? null;
  }

  private pub(u: User | null, showPayment: boolean): PublicProfile | null {
    return u
      ? {
          id: u.id,
          displayName: u.displayName,
          ratingAvg: u.ratingAvg,
          ratingCount: u.ratingCount,
          ridesCompleted: u.ridesCompleted,
          vehicle: u.vehicle,
          paymentHandle: showPayment ? u.paymentHandle : '',
        }
      : null;
  }

  private update(rideId: string, patch: Partial<RideRequest>): RideRequest {
    const ride = { ...this.rides.get(rideId)!, ...patch, updatedAt: now() };
    this.rides.set(rideId, ride);
    this.emit({ type: 'ride.updated', ride });
    return ride;
  }

  private activeFor(uid: string): RideRequest | null {
    for (const r of [...this.rides.values()].reverse()) {
      if ((r.riderId === uid || r.driverId === uid) && !['completed', 'cancelled'].includes(r.status)) return r;
    }
    return null;
  }

  private bumpRating(uid: string, stars: number): void {
    const u = this.userById(uid);
    if (!u) return;
    const sum = u.ratingAvg * u.ratingCount + stars;
    u.ratingCount += 1;
    u.ratingAvg = Math.round((sum / u.ratingCount) * 100) / 100;
  }

  private complete(ride: RideRequest): void {
    for (const uid of [ride.riderId, ride.driverId]) {
      const u = uid ? this.userById(uid) : null;
      if (u) u.ridesCompleted += 1;
    }
  }

  // ---- node & profile --------------------------------------------------

  async nodeInfo(): Promise<NodeInfo> {
    return {
      name: 'Demo Town',
      description: 'A simulated node running inside the app. Three demo drivers and one demo rider live here. Nothing leaves your device.',
      networkTakeRate: 0,
      communityContributionRate: 0,
      currency: CURRENCY,
      members: 4 + (this.self ? 1 : 0),
      driversOnline: this.drivers.length,
      protocolVersion: PROTOCOL_VERSION,
    };
  }

  async register(body: { handle: string; displayName: string; role: User['role'] }) {
    this.self = mkUser(body.handle, body.displayName, body.role);
    this.token = 'demo';
    return { token: this.token, user: this.self };
  }

  async me() {
    return { user: this.requireMe() };
  }

  async updateMe(body: Partial<Pick<User, 'displayName' | 'role' | 'paymentHandle' | 'rates' | 'vehicle'>>) {
    const me = this.requireMe();
    this.self = { ...me, ...body };
    return { user: this.self };
  }

  async exportMe() {
    const me = this.requireMe();
    return { exportedAt: now(), node: 'Demo Town', user: me, rides: (await this.myRides()).rides };
  }

  async setPresence(online: boolean, location: LatLng | null) {
    const me = this.requireMe();
    this.online = online;
    if (location) this.anchor = location;
    if (online && me.role !== 'rider') this.scheduleDemoRider();
    return { ok: true as const };
  }

  /** When a member drives, a demo rider posts a request near them. */
  private scheduleDemoRider(): void {
    if (this.riderSpawnTimer || this.activeFor(this.demoRider.id)) return;
    this.riderSpawnTimer = setTimeout(() => {
      this.riderSpawnTimer = null;
      if (!this.online || !this.self || this.activeFor(this.demoRider.id)) return;
      const pickup: Place = { lat: this.anchor.lat + 0.01, lng: this.anchor.lng - 0.006, label: 'Naledi, near the station' };
      const dropoff: Place = { lat: this.anchor.lat - 0.035, lng: this.anchor.lng + 0.028, label: 'Community clinic' };
      const km = estimateRoadKm(pickup, dropoff);
      const ride: RideRequest = {
        id: id('ride'),
        riderId: this.demoRider.id,
        pickup,
        dropoff,
        estimatedKm: Math.round(km * 10) / 10,
        estimatedMin: Math.round(estimateMinutes(km)),
        maxFare: null,
        currency: CURRENCY,
        seats: 1,
        note: 'One bag, no rush.',
        status: 'open',
        driverId: null,
        acceptedOfferId: null,
        agreedFare: null,
        riderRating: null,
        driverRating: null,
        createdAt: now(),
        updatedAt: now(),
      };
      this.rides.set(ride.id, ride);
      this.emit({ type: 'ride.new', ride });
    }, 4000);
  }

  // ---- rides -----------------------------------------------------------

  async quotes(pickup: Place, dropoff: Place): Promise<QuoteResponse> {
    this.requireMe();
    this.anchor = pickup;
    const km = estimateRoadKm(pickup, dropoff);
    const min = estimateMinutes(km);
    const quotes = this.drivers
      .map((d) => ({
        driverId: d.user.id,
        displayName: d.user.displayName,
        ratingAvg: d.user.ratingAvg,
        ratingCount: d.user.ratingCount,
        etaMin: estimateEtaMinutes(this.driverPos(d), pickup),
        fare: computeFare(d.user.rates!, km, min),
      }))
      .sort((a, b) => a.fare.total - b.fare.total);
    return {
      estimatedKm: Math.round(km * 10) / 10,
      estimatedMin: Math.round(min),
      driversNearby: this.drivers.length,
      range: fareRange(
        this.drivers.map((d) => d.user.rates!),
        km,
        min,
      ),
      quotes,
    };
  }

  async createRide(body: { pickup: Place; dropoff: Place; seats: number; note: string; maxFare: number | null; currency: string }) {
    const me = this.requireMe();
    if (this.activeFor(me.id)) throw new ApiError(409, 'you already have an active ride');
    this.anchor = body.pickup;
    const km = estimateRoadKm(body.pickup, body.dropoff);
    const ride: RideRequest = {
      id: id('ride'),
      riderId: me.id,
      pickup: body.pickup,
      dropoff: body.dropoff,
      estimatedKm: Math.round(km * 10) / 10,
      estimatedMin: Math.round(estimateMinutes(km)),
      maxFare: body.maxFare,
      currency: CURRENCY,
      seats: body.seats,
      note: body.note,
      status: 'open',
      driverId: null,
      acceptedOfferId: null,
      agreedFare: null,
      riderRating: null,
      driverRating: null,
      createdAt: now(),
      updatedAt: now(),
    };
    this.rides.set(ride.id, ride);
    for (const d of this.drivers) this.demoDriverOffers(d, ride);
    return { ride };
  }

  private demoDriverOffers(d: DemoDriver, ride: RideRequest): void {
    setTimeout(() => {
      const cur = this.rides.get(ride.id);
      if (!cur || cur.status !== 'open' || ride.seats > (d.user.vehicle?.seats ?? 4)) return;
      let fare = computeFare(d.user.rates!, cur.estimatedKm, cur.estimatedMin).total * d.personality.priceFactor;
      // Demo drivers respect a rider's ceiling when it is within reason, like real people haggling.
      if (cur.maxFare != null && fare > cur.maxFare) {
        if (fare > cur.maxFare * 1.25) return;
        fare = cur.maxFare;
      }
      const offer: Offer = {
        id: id('off'),
        rideId: cur.id,
        driverId: d.user.id,
        fare: Math.round(fare),
        currency: CURRENCY,
        etaMin: estimateEtaMinutes(this.driverPos(d), cur.pickup),
        message: d.personality.message,
        status: 'pending',
        createdAt: now(),
        driver: this.pub(d.user, false)!,
      };
      this.offers.set(offer.id, offer);
      this.emit({ type: 'offer.new', offer });
    }, d.personality.delayMs);
  }

  async myRides() {
    const me = this.requireMe();
    const rides = [...this.rides.values()].filter((r) => r.riderId === me.id || r.driverId === me.id).reverse();
    return { rides, active: this.activeFor(me.id) };
  }

  async openRides(here: LatLng | null): Promise<{ rides: OpenRide[] }> {
    const me = this.requireMe();
    if (me.role === 'rider') throw new ApiError(403, 'drivers only');
    const at = here ?? this.anchor;
    const rides = [...this.rides.values()]
      .filter((r) => r.status === 'open' && r.riderId !== me.id && withinKm(at, r.pickup, DEFAULT_MATCH_RADIUS_KM))
      .map((r) => ({
        ...r,
        myOffer: [...this.offers.values()].find((o) => o.rideId === r.id && o.driverId === me.id) ?? null,
        suggestedFare: me.rates ? computeFare(me.rates, r.estimatedKm, r.estimatedMin).total : null,
        etaMin: estimateEtaMinutes(at, r.pickup),
      }));
    return { rides };
  }

  async ride(rideId: string): Promise<RideDetail> {
    const me = this.requireMe();
    const ride = this.rides.get(rideId);
    if (!ride) throw new ApiError(404, 'no such ride');
    const isParty = ride.riderId === me.id || ride.driverId === me.id;
    const all = [...this.offers.values()].filter((o) => o.rideId === rideId).sort((a, b) => a.fare - b.fare || a.etaMin - b.etaMin);
    const offers = ride.riderId === me.id ? all : all.filter((o) => o.driverId === me.id);
    const showPay = isParty && ride.status !== 'open';
    return {
      ride,
      offers,
      rider: this.pub(this.userById(ride.riderId), showPay),
      driver: ride.driverId ? this.pub(this.userById(ride.driverId), showPay) : null,
    };
  }

  async makeOffer(rideId: string, body: { fare: number; etaMin: number; message: string }) {
    const me = this.requireMe();
    const ride = this.rides.get(rideId);
    if (!ride) throw new ApiError(404, 'no such ride');
    if (ride.status !== 'open') throw new ApiError(409, 'this request is no longer open');
    if (this.activeFor(me.id)) throw new ApiError(409, 'finish your current ride first');
    const existing = [...this.offers.values()].find((o) => o.rideId === rideId && o.driverId === me.id);
    const offer: Offer = {
      id: existing?.id ?? id('off'),
      rideId,
      driverId: me.id,
      fare: Math.round(body.fare * 100) / 100,
      currency: CURRENCY,
      etaMin: body.etaMin,
      message: body.message,
      status: 'pending',
      createdAt: now(),
      driver: this.pub(me, false)!,
    };
    this.offers.set(offer.id, offer);
    // The demo rider likes a fair price and accepts after a moment.
    if (ride.riderId === this.demoRider.id) {
      setTimeout(() => {
        const cur = this.rides.get(rideId);
        const o = this.offers.get(offer.id);
        if (!cur || cur.status !== 'open' || !o || o.status !== 'pending') return;
        this.offers.set(o.id, { ...o, status: 'accepted' });
        this.emit({ type: 'offer.updated', offer: this.offers.get(o.id)! });
        this.update(rideId, { status: 'accepted', driverId: me.id, acceptedOfferId: o.id, agreedFare: o.fare });
      }, 2500);
    }
    return { offer };
  }

  async withdrawOffer(rideId: string, offerId: string) {
    const me = this.requireMe();
    const o = this.offers.get(offerId);
    if (!o || o.rideId !== rideId || o.driverId !== me.id) throw new ApiError(404, 'no such offer');
    const updated = { ...o, status: 'withdrawn' as const };
    this.offers.set(offerId, updated);
    return { offer: updated };
  }

  async acceptOffer(rideId: string, offerId: string) {
    const me = this.requireMe();
    const ride = this.rides.get(rideId);
    if (!ride || ride.riderId !== me.id) throw new ApiError(403, 'only the rider can accept an offer');
    if (ride.status !== 'open') throw new ApiError(409, 'ride is not open');
    const offer = this.offers.get(offerId);
    if (!offer || offer.status !== 'pending') throw new ApiError(400, 'offer is not available');
    for (const o of this.offers.values()) {
      if (o.rideId === rideId && o.id !== offerId && o.status === 'pending') this.offers.set(o.id, { ...o, status: 'declined' });
    }
    this.offers.set(offerId, { ...offer, status: 'accepted' });
    const updated = this.update(rideId, { status: 'accepted', driverId: offer.driverId, acceptedOfferId: offerId, agreedFare: offer.fare });
    const d = this.drivers.find((x) => x.user.id === offer.driverId);
    if (d) this.driveTrip(d, rideId);
    return { ride: updated };
  }

  /** The chosen demo driver approaches, picks up, drives and completes. */
  private async driveTrip(d: DemoDriver, rideId: string): Promise<void> {
    const alive = () => {
      const r = this.rides.get(rideId);
      return r && !['completed', 'cancelled'].includes(r.status) ? r : null;
    };
    const move = async (from: LatLng, to: LatLng, steps: number, stepMs: number) => {
      for (let i = 1; i <= steps; i++) {
        await wait(stepMs);
        if (!alive()) return false;
        const location = { lat: from.lat + ((to.lat - from.lat) * i) / steps, lng: from.lng + ((to.lng - from.lng) * i) / steps };
        this.emit({ type: 'driver.location', rideId, location, heading: null });
      }
      return true;
    };
    const ride = alive();
    if (!ride) return;
    if (!(await move(this.driverPos(d), ride.pickup, 10, 900))) return;
    this.update(rideId, { status: 'arrived' });
    await wait(3500);
    if (!alive()) return;
    this.update(rideId, { status: 'in_progress' });
    if (!(await move(ride.pickup, ride.dropoff, 12, 1000))) return;
    const done = this.update(rideId, { status: 'completed' });
    this.complete(done);
    await wait(2000);
    if (done.riderRating == null) {
      this.bumpRating(done.riderId, 5);
      this.update(rideId, { riderRating: 5 });
    }
  }

  async setStatus(rideId: string, status: RideStatus) {
    const me = this.requireMe();
    const ride = this.rides.get(rideId);
    if (!ride) throw new ApiError(404, 'no such ride');
    const isRider = ride.riderId === me.id;
    const isDriver = ride.driverId === me.id;
    if (!isRider && !isDriver) throw new ApiError(403, 'not your ride');
    if (status !== 'cancelled' && !isDriver) throw new ApiError(403, 'only the driver can update trip progress');
    if (status === 'cancelled' && ride.status === 'in_progress') throw new ApiError(409, 'cannot cancel a trip underway');
    const updated = this.update(rideId, { status });
    if (status === 'completed') {
      this.complete(updated);
      // The demo rider rates promptly.
      if (updated.riderId === this.demoRider.id) {
        setTimeout(() => {
          this.bumpRating(me.id, 5);
          this.update(rideId, { driverRating: 5 });
        }, 2000);
      }
    }
    return { ride: updated };
  }

  async rate(rideId: string, stars: number) {
    const me = this.requireMe();
    const ride = this.rides.get(rideId);
    if (!ride || ride.status !== 'completed') throw new ApiError(409, 'rate after the trip is completed');
    if (ride.riderId === me.id) {
      if (ride.driverRating != null) throw new ApiError(409, 'already rated');
      this.bumpRating(ride.driverId!, stars);
      return { ride: this.update(rideId, { driverRating: stars }) };
    }
    if (ride.riderRating != null) throw new ApiError(409, 'already rated');
    this.bumpRating(ride.riderId, stars);
    return { ride: this.update(rideId, { riderRating: stars }) };
  }

  async shareLocation() {
    return { ok: true as const };
  }

  // ---- governance -----------------------------------------------------

  private withMyVote(p: Proposal): Proposal {
    const me = this.self;
    return { ...p, myVote: me ? (this.votes.get(p.id)?.get(me.id) ?? null) : null };
  }

  async proposals() {
    this.requireMe();
    return { proposals: this.props.map((p) => this.withMyVote(p)), members: 5 };
  }

  async createProposal(body: { title: string; body: string; days: number }) {
    const me = this.requireMe();
    const p: Proposal = {
      id: id('prop'),
      authorId: me.id,
      authorName: me.displayName,
      title: body.title,
      body: body.body,
      closesAt: new Date(Date.now() + body.days * 86_400_000).toISOString(),
      yes: 0,
      no: 0,
      abstain: 0,
      myVote: null,
      createdAt: now(),
    };
    this.props.unshift(p);
    return this.vote(p.id, 'yes');
  }

  async vote(proposalId: string, choice: VoteChoice) {
    const me = this.requireMe();
    const p = this.props.find((x) => x.id === proposalId);
    if (!p) throw new ApiError(404, 'no such proposal');
    let m = this.votes.get(proposalId);
    if (!m) {
      m = new Map();
      this.votes.set(proposalId, m);
    }
    const prev = m.get(me.id);
    if (prev) p[prev] -= 1;
    m.set(me.id, choice);
    p[choice] += 1;
    return { proposal: this.withMyVote(p) };
  }

  // ---- realtime --------------------------------------------------------

  connect(onEvent: (e: ServerEvent) => void): Channel {
    this.listeners.add(onEvent);
    if (this.self) setTimeout(() => onEvent({ type: 'hello', userId: this.self!.id, nodeName: 'Demo Town' }), 0);
    return {
      send: (e) => {
        if (e.type === 'presence') this.setPresence(e.online, e.location).catch(() => undefined);
      },
      close: () => {
        this.listeners.delete(onEvent);
      },
    };
  }
}

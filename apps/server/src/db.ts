import { DatabaseSync } from 'node:sqlite';
import type { DriverRates, Offer, Proposal, RideRequest, User, Vehicle, VoteChoice } from '@barc/shared';

/**
 * Storage for a BARC node. SQLite keeps a node trivially self-hostable:
 * one file, no database server, easy to back up and easy to hand over to
 * another operator if the community decides to move.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  handle TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL,
  payment_handle TEXT NOT NULL DEFAULT '',
  rates_json TEXT,
  vehicle_json TEXT,
  rating_sum REAL NOT NULL DEFAULT 0,
  rating_count INTEGER NOT NULL DEFAULT 0,
  rides_completed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tokens (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS presence (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  online INTEGER NOT NULL DEFAULT 0,
  lat REAL,
  lng REAL,
  heading REAL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS rides (
  id TEXT PRIMARY KEY,
  rider_id TEXT NOT NULL REFERENCES users(id),
  pickup_json TEXT NOT NULL,
  dropoff_json TEXT NOT NULL,
  estimated_km REAL NOT NULL,
  estimated_min REAL NOT NULL,
  max_fare REAL,
  currency TEXT NOT NULL,
  seats INTEGER NOT NULL DEFAULT 1,
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  driver_id TEXT REFERENCES users(id),
  accepted_offer_id TEXT,
  agreed_fare REAL,
  rider_rating INTEGER,
  driver_rating INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS rides_status ON rides(status);
CREATE TABLE IF NOT EXISTS offers (
  id TEXT PRIMARY KEY,
  ride_id TEXT NOT NULL REFERENCES rides(id),
  driver_id TEXT NOT NULL REFERENCES users(id),
  fare REAL NOT NULL,
  currency TEXT NOT NULL,
  eta_min INTEGER NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(ride_id, driver_id)
);
CREATE TABLE IF NOT EXISTS proposals (
  id TEXT PRIMARY KEY,
  author_id TEXT NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  closes_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS votes (
  proposal_id TEXT NOT NULL REFERENCES proposals(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  choice TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (proposal_id, user_id)
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

type Row = Record<string, unknown>;

export class Store {
  readonly db: DatabaseSync;

  constructor(path = ':memory:') {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  // ---- users -----------------------------------------------------------

  toUser(r: Row): User {
    const count = Number(r.rating_count);
    return {
      id: String(r.id),
      handle: String(r.handle),
      displayName: String(r.display_name),
      role: r.role as User['role'],
      paymentHandle: String(r.payment_handle),
      rates: r.rates_json ? (JSON.parse(String(r.rates_json)) as DriverRates) : null,
      vehicle: r.vehicle_json ? (JSON.parse(String(r.vehicle_json)) as Vehicle) : null,
      ratingAvg: count ? Math.round((Number(r.rating_sum) / count) * 100) / 100 : 0,
      ratingCount: count,
      ridesCompleted: Number(r.rides_completed),
      createdAt: String(r.created_at),
    };
  }

  getUser(id: string): User | null {
    const r = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as Row | undefined;
    return r ? this.toUser(r) : null;
  }

  getUserByHandle(handle: string): User | null {
    const r = this.db.prepare('SELECT * FROM users WHERE handle = ?').get(handle) as Row | undefined;
    return r ? this.toUser(r) : null;
  }

  createUser(u: Pick<User, 'id' | 'handle' | 'displayName' | 'role'>): User {
    this.db
      .prepare(
        'INSERT INTO users (id, handle, display_name, role, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(u.id, u.handle, u.displayName, u.role, new Date().toISOString());
    return this.getUser(u.id)!;
  }

  updateUser(
    id: string,
    patch: Partial<Pick<User, 'displayName' | 'role' | 'paymentHandle' | 'rates' | 'vehicle'>>,
  ): User {
    const cur = this.getUser(id);
    if (!cur) throw new Error('user not found');
    const next = { ...cur, ...patch };
    this.db
      .prepare(
        'UPDATE users SET display_name = ?, role = ?, payment_handle = ?, rates_json = ?, vehicle_json = ? WHERE id = ?',
      )
      .run(
        next.displayName,
        next.role,
        next.paymentHandle,
        next.rates ? JSON.stringify(next.rates) : null,
        next.vehicle ? JSON.stringify(next.vehicle) : null,
        id,
      );
    return this.getUser(id)!;
  }

  addRating(userId: string, stars: number): void {
    this.db
      .prepare('UPDATE users SET rating_sum = rating_sum + ?, rating_count = rating_count + 1 WHERE id = ?')
      .run(stars, userId);
  }

  incrementRides(userId: string): void {
    this.db.prepare('UPDATE users SET rides_completed = rides_completed + 1 WHERE id = ?').run(userId);
  }

  countUsers(): number {
    const r = this.db.prepare('SELECT COUNT(*) AS n FROM users').get() as Row;
    return Number(r.n);
  }

  // ---- tokens ----------------------------------------------------------

  createToken(token: string, userId: string): void {
    this.db
      .prepare('INSERT INTO tokens (token, user_id, created_at) VALUES (?, ?, ?)')
      .run(token, userId, new Date().toISOString());
  }

  userIdForToken(token: string): string | null {
    const r = this.db.prepare('SELECT user_id FROM tokens WHERE token = ?').get(token) as Row | undefined;
    return r ? String(r.user_id) : null;
  }

  // ---- presence --------------------------------------------------------

  setPresence(userId: string, online: boolean, lat: number | null, lng: number | null, heading: number | null): void {
    this.db
      .prepare(
        `INSERT INTO presence (user_id, online, lat, lng, heading, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET online = excluded.online, lat = excluded.lat, lng = excluded.lng,
         heading = excluded.heading, updated_at = excluded.updated_at`,
      )
      .run(userId, online ? 1 : 0, lat, lng, heading, new Date().toISOString());
  }

  onlineDrivers(): Array<{ userId: string; lat: number; lng: number; heading: number | null; user: User }> {
    const rows = this.db
      .prepare(
        `SELECT p.user_id, p.lat, p.lng, p.heading, u.* FROM presence p JOIN users u ON u.id = p.user_id
         WHERE p.online = 1 AND p.lat IS NOT NULL AND u.role IN ('driver', 'both')`,
      )
      .all() as Row[];
    return rows.map((r) => ({
      userId: String(r.user_id),
      lat: Number(r.lat),
      lng: Number(r.lng),
      heading: r.heading == null ? null : Number(r.heading),
      user: this.toUser(r),
    }));
  }

  // ---- rides -----------------------------------------------------------

  private toRide(r: Row): RideRequest {
    return {
      id: String(r.id),
      riderId: String(r.rider_id),
      pickup: JSON.parse(String(r.pickup_json)),
      dropoff: JSON.parse(String(r.dropoff_json)),
      estimatedKm: Number(r.estimated_km),
      estimatedMin: Number(r.estimated_min),
      maxFare: r.max_fare == null ? null : Number(r.max_fare),
      currency: String(r.currency),
      seats: Number(r.seats),
      note: String(r.note),
      status: r.status as RideRequest['status'],
      driverId: r.driver_id == null ? null : String(r.driver_id),
      acceptedOfferId: r.accepted_offer_id == null ? null : String(r.accepted_offer_id),
      agreedFare: r.agreed_fare == null ? null : Number(r.agreed_fare),
      riderRating: r.rider_rating == null ? null : Number(r.rider_rating),
      driverRating: r.driver_rating == null ? null : Number(r.driver_rating),
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
    };
  }

  createRide(ride: RideRequest): RideRequest {
    this.db
      .prepare(
        `INSERT INTO rides (id, rider_id, pickup_json, dropoff_json, estimated_km, estimated_min, max_fare, currency,
         seats, note, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        ride.id,
        ride.riderId,
        JSON.stringify(ride.pickup),
        JSON.stringify(ride.dropoff),
        ride.estimatedKm,
        ride.estimatedMin,
        ride.maxFare,
        ride.currency,
        ride.seats,
        ride.note,
        ride.status,
        ride.createdAt,
        ride.updatedAt,
      );
    return this.getRide(ride.id)!;
  }

  getRide(id: string): RideRequest | null {
    const r = this.db.prepare('SELECT * FROM rides WHERE id = ?').get(id) as Row | undefined;
    return r ? this.toRide(r) : null;
  }

  updateRide(
    id: string,
    patch: Partial<Pick<RideRequest, 'status' | 'driverId' | 'acceptedOfferId' | 'agreedFare' | 'riderRating' | 'driverRating'>>,
  ): RideRequest {
    const cur = this.getRide(id);
    if (!cur) throw new Error('ride not found');
    const n = { ...cur, ...patch, updatedAt: new Date().toISOString() };
    this.db
      .prepare(
        `UPDATE rides SET status = ?, driver_id = ?, accepted_offer_id = ?, agreed_fare = ?, rider_rating = ?,
         driver_rating = ?, updated_at = ? WHERE id = ?`,
      )
      .run(n.status, n.driverId, n.acceptedOfferId, n.agreedFare, n.riderRating, n.driverRating, n.updatedAt, id);
    return this.getRide(id)!;
  }

  openRides(): RideRequest[] {
    const rows = this.db.prepare("SELECT * FROM rides WHERE status = 'open' ORDER BY created_at DESC").all() as Row[];
    return rows.map((r) => this.toRide(r));
  }

  ridesForUser(userId: string, limit = 50): RideRequest[] {
    const rows = this.db
      .prepare('SELECT * FROM rides WHERE rider_id = ? OR driver_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(userId, userId, limit) as Row[];
    return rows.map((r) => this.toRide(r));
  }

  /** The one ride a user is currently involved in, if any. */
  activeRideForUser(userId: string): RideRequest | null {
    const r = this.db
      .prepare(
        `SELECT * FROM rides WHERE (rider_id = ? OR driver_id = ?) AND status IN ('open','accepted','arrived','in_progress')
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(userId, userId) as Row | undefined;
    return r ? this.toRide(r) : null;
  }

  expireOpenRides(olderThanIso: string): string[] {
    const rows = this.db
      .prepare("SELECT id FROM rides WHERE status = 'open' AND created_at < ?")
      .all(olderThanIso) as Row[];
    const ids = rows.map((r) => String(r.id));
    if (ids.length) {
      const now = new Date().toISOString();
      const stmt = this.db.prepare("UPDATE rides SET status = 'cancelled', updated_at = ? WHERE id = ?");
      for (const id of ids) stmt.run(now, id);
    }
    return ids;
  }

  // ---- offers ----------------------------------------------------------

  private toOffer(r: Row): Offer {
    const driver = this.toUser(r);
    return {
      id: String(r.offer_id),
      rideId: String(r.ride_id),
      driverId: String(r.driver_id),
      fare: Number(r.fare),
      currency: String(r.currency),
      etaMin: Number(r.eta_min),
      message: String(r.message),
      status: r.status as Offer['status'],
      createdAt: String(r.offer_created_at),
      driver: {
        id: driver.id,
        displayName: driver.displayName,
        ratingAvg: driver.ratingAvg,
        ratingCount: driver.ratingCount,
        ridesCompleted: driver.ridesCompleted,
        vehicle: driver.vehicle,
      },
    };
  }

  private static OFFER_SELECT = `SELECT o.id AS offer_id, o.ride_id, o.driver_id, o.fare, o.currency, o.eta_min, o.message,
    o.status, o.created_at AS offer_created_at, u.* FROM offers o JOIN users u ON u.id = o.driver_id`;

  createOffer(o: Omit<Offer, 'driver'>): Offer {
    this.db
      .prepare(
        `INSERT INTO offers (id, ride_id, driver_id, fare, currency, eta_min, message, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(o.id, o.rideId, o.driverId, o.fare, o.currency, o.etaMin, o.message, o.status, o.createdAt);
    return this.getOffer(o.id)!;
  }

  getOffer(id: string): Offer | null {
    const r = this.db.prepare(`${Store.OFFER_SELECT} WHERE o.id = ?`).get(id) as Row | undefined;
    return r ? this.toOffer(r) : null;
  }

  offerByDriverForRide(rideId: string, driverId: string): Offer | null {
    const r = this.db
      .prepare(`${Store.OFFER_SELECT} WHERE o.ride_id = ? AND o.driver_id = ?`)
      .get(rideId, driverId) as Row | undefined;
    return r ? this.toOffer(r) : null;
  }

  offersForRide(rideId: string): Offer[] {
    const rows = this.db
      .prepare(`${Store.OFFER_SELECT} WHERE o.ride_id = ? ORDER BY o.fare ASC, o.eta_min ASC`)
      .all(rideId) as Row[];
    return rows.map((r) => this.toOffer(r));
  }

  setOfferStatus(id: string, status: Offer['status']): Offer {
    this.db.prepare('UPDATE offers SET status = ? WHERE id = ?').run(status, id);
    return this.getOffer(id)!;
  }

  declineOtherOffers(rideId: string, keepId: string): Offer[] {
    this.db
      .prepare("UPDATE offers SET status = 'declined' WHERE ride_id = ? AND id != ? AND status = 'pending'")
      .run(rideId, keepId);
    return this.offersForRide(rideId).filter((o) => o.id !== keepId);
  }

  // ---- governance -----------------------------------------------------

  createProposal(p: { id: string; authorId: string; title: string; body: string; closesAt: string }): void {
    this.db
      .prepare('INSERT INTO proposals (id, author_id, title, body, closes_at, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(p.id, p.authorId, p.title, p.body, p.closesAt, new Date().toISOString());
  }

  listProposals(viewerId: string): Proposal[] {
    const rows = this.db
      .prepare(
        `SELECT p.*, u.display_name AS author_name,
           (SELECT COUNT(*) FROM votes v WHERE v.proposal_id = p.id AND v.choice = 'yes') AS yes,
           (SELECT COUNT(*) FROM votes v WHERE v.proposal_id = p.id AND v.choice = 'no') AS no,
           (SELECT COUNT(*) FROM votes v WHERE v.proposal_id = p.id AND v.choice = 'abstain') AS abstain,
           (SELECT choice FROM votes v WHERE v.proposal_id = p.id AND v.user_id = ?) AS my_vote
         FROM proposals p JOIN users u ON u.id = p.author_id ORDER BY p.created_at DESC`,
      )
      .all(viewerId) as Row[];
    return rows.map((r) => ({
      id: String(r.id),
      authorId: String(r.author_id),
      authorName: String(r.author_name),
      title: String(r.title),
      body: String(r.body),
      closesAt: String(r.closes_at),
      yes: Number(r.yes),
      no: Number(r.no),
      abstain: Number(r.abstain),
      myVote: (r.my_vote as VoteChoice | null) ?? null,
      createdAt: String(r.created_at),
    }));
  }

  getProposal(id: string, viewerId: string): Proposal | null {
    return this.listProposals(viewerId).find((p) => p.id === id) ?? null;
  }

  castVote(proposalId: string, userId: string, choice: VoteChoice): void {
    this.db
      .prepare(
        `INSERT INTO votes (proposal_id, user_id, choice, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(proposal_id, user_id) DO UPDATE SET choice = excluded.choice, created_at = excluded.created_at`,
      )
      .run(proposalId, userId, choice, new Date().toISOString());
  }

  // ---- settings --------------------------------------------------------

  getSetting(key: string, fallback: string): string {
    const r = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as Row | undefined;
    return r ? String(r.value) : fallback;
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }
}

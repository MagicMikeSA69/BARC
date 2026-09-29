/**
 * Core domain types shared by the BARC mobile app and coordination node.
 *
 * BARC is built on one idea: the people who drive and the people who ride
 * own the network. There is no corporate middle layer that sets prices,
 * takes a cut, or decides who gets work. These types encode that.
 */

export type Role = 'rider' | 'driver' | 'both';

export interface LatLng {
  lat: number;
  lng: number;
}

export interface Place extends LatLng {
  /** Human readable label, e.g. "Cape Town Station". */
  label: string;
}

/**
 * A driver's own price list. Drivers set these themselves; the network never
 * overrides them and never applies surge multipliers on top.
 */
export interface DriverRates {
  /** Flat amount charged at the start of every trip. */
  base: number;
  /** Amount per kilometre travelled. */
  perKm: number;
  /** Amount per minute of trip time. */
  perMin: number;
  /** The driver will never charge less than this for a trip. */
  minimum: number;
  /** ISO 4217 currency code, e.g. "ZAR", "USD". */
  currency: string;
}

export interface Vehicle {
  make: string;
  model: string;
  colour: string;
  plate: string;
  seats: number;
}

export interface User {
  id: string;
  handle: string;
  displayName: string;
  role: Role;
  /** Where riders pay the driver directly, e.g. "SnapScan: 07x", "Cash", "Lightning: ...". */
  paymentHandle: string;
  rates: DriverRates | null;
  vehicle: Vehicle | null;
  /** Community reputation, computed from ratings — owned by the member, exportable. */
  ratingAvg: number;
  ratingCount: number;
  ridesCompleted: number;
  createdAt: string;
}

export interface DriverPresence {
  userId: string;
  online: boolean;
  location: LatLng | null;
  heading: number | null;
  updatedAt: string;
}

export type RideStatus =
  | 'open' // rider has posted a request, drivers can make offers
  | 'accepted' // rider chose an offer, driver is on the way
  | 'arrived' // driver at pickup
  | 'in_progress' // trip underway
  | 'completed'
  | 'cancelled';

export interface RideRequest {
  id: string;
  riderId: string;
  pickup: Place;
  dropoff: Place;
  /** Straight-line-derived estimate at request time. */
  estimatedKm: number;
  estimatedMin: number;
  /** Optional ceiling the rider is willing to pay. Drivers see it. */
  maxFare: number | null;
  currency: string;
  seats: number;
  note: string;
  status: RideStatus;
  /** Set once the rider accepts an offer. */
  driverId: string | null;
  acceptedOfferId: string | null;
  /** What the rider and driver agreed to. */
  agreedFare: number | null;
  /** Ratings are mutual and only visible after both submit or 24h. */
  riderRating: number | null;
  driverRating: number | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * A driver's answer to a request. Riders see every offer side by side —
 * price, ETA, rating, vehicle — and pick the one they want.
 */
export interface Offer {
  id: string;
  rideId: string;
  driverId: string;
  /** Total fare the driver proposes for the whole trip. */
  fare: number;
  currency: string;
  /** Minutes until the driver reaches pickup. */
  etaMin: number;
  message: string;
  status: 'pending' | 'accepted' | 'declined' | 'withdrawn';
  createdAt: string;
  /** Denormalised for display. */
  driver: Pick<
    User,
    'id' | 'displayName' | 'ratingAvg' | 'ratingCount' | 'ridesCompleted' | 'vehicle'
  >;
}

/** Cooperative governance: any member can propose, every member gets one vote. */
export interface Proposal {
  id: string;
  authorId: string;
  authorName: string;
  title: string;
  body: string;
  /** ISO timestamp after which voting closes. */
  closesAt: string;
  yes: number;
  no: number;
  abstain: number;
  /** The caller's vote, if any. */
  myVote: VoteChoice | null;
  createdAt: string;
}

export type VoteChoice = 'yes' | 'no' | 'abstain';

/** Real-time events pushed over the WebSocket from a node to its members. */
export type ServerEvent =
  | { type: 'hello'; userId: string; nodeName: string }
  | { type: 'ride.new'; ride: RideRequest }
  | { type: 'ride.updated'; ride: RideRequest }
  | { type: 'offer.new'; offer: Offer }
  | { type: 'offer.updated'; offer: Offer }
  | { type: 'driver.location'; rideId: string; location: LatLng; heading: number | null }
  | { type: 'error'; message: string };

export type ClientEvent =
  | { type: 'presence'; online: boolean; location: LatLng | null; heading: number | null }
  | { type: 'ping' };

/** Public information about a node, so members know whose server they are on. */
export interface NodeInfo {
  name: string;
  description: string;
  /** Always 0 on a BARC node — the protocol forbids a platform take. */
  networkTakeRate: number;
  /** Optional, member-voted contribution that funds hosting. Expressed as a fraction of fare. */
  communityContributionRate: number;
  currency: string;
  members: number;
  driversOnline: number;
  protocolVersion: string;
}

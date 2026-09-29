import type {
  ClientEvent,
  LatLng,
  NodeInfo,
  Offer,
  Place,
  Proposal,
  RideRequest,
  RideStatus,
  ServerEvent,
  User,
  Vehicle,
  DriverRates,
  FareBreakdown,
  VoteChoice,
} from '@barc/shared';

/**
 * Thin client for a BARC node. The node URL is chosen by the member, so the
 * same app works against any community's server.
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface Quote {
  driverId: string;
  displayName: string;
  ratingAvg: number;
  ratingCount: number;
  etaMin: number;
  fare: FareBreakdown;
}

export interface QuoteResponse {
  estimatedKm: number;
  estimatedMin: number;
  driversNearby: number;
  range: { min: number; max: number } | null;
  quotes: Quote[];
}

export interface OpenRide extends RideRequest {
  myOffer: Offer | null;
  suggestedFare: number | null;
  etaMin: number | null;
}

export interface PublicProfile {
  id: string;
  displayName: string;
  ratingAvg: number;
  ratingCount: number;
  ridesCompleted: number;
  vehicle: Vehicle | null;
  paymentHandle: string;
}

export interface RideDetail {
  ride: RideRequest;
  offers: Offer[];
  rider: PublicProfile | null;
  driver: PublicProfile | null;
}

export const DEMO_NODE_URL = 'demo://local';

export function normaliseNodeUrl(input: string): string {
  let url = input.trim();
  if (!url) return url;
  if (url.startsWith('demo://')) return DEMO_NODE_URL;
  if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
  return url.replace(/\/+$/, '');
}

export interface Channel {
  send(e: ClientEvent): void;
  close(): void;
}

/**
 * Everything the app needs from a node. `Api` talks to a real node over
 * HTTP; `DemoApi` (demo.ts) simulates one on the device.
 */
export interface NodeApi {
  baseUrl: string;
  token: string | null;
  /** Where to centre maps when the device gives no position (demo only). */
  defaultCentre: LatLng | null;
  nodeInfo(): Promise<NodeInfo>;
  register(body: { handle: string; displayName: string; role: User['role'] }): Promise<{ token: string; user: User }>;
  me(): Promise<{ user: User }>;
  updateMe(body: Partial<{ displayName: string; role: User['role']; paymentHandle: string; rates: DriverRates | null; vehicle: Vehicle | null }>): Promise<{ user: User }>;
  exportMe(): Promise<unknown>;
  setPresence(online: boolean, location: LatLng | null, heading?: number | null): Promise<{ ok: true }>;
  quotes(pickup: Place, dropoff: Place): Promise<QuoteResponse>;
  createRide(body: { pickup: Place; dropoff: Place; seats: number; note: string; maxFare: number | null; currency: string }): Promise<{ ride: RideRequest }>;
  myRides(): Promise<{ rides: RideRequest[]; active: RideRequest | null }>;
  openRides(here: LatLng | null): Promise<{ rides: OpenRide[] }>;
  ride(id: string): Promise<RideDetail>;
  makeOffer(rideId: string, body: { fare: number; etaMin: number; message: string }): Promise<{ offer: Offer }>;
  withdrawOffer(rideId: string, offerId: string): Promise<{ offer: Offer }>;
  acceptOffer(rideId: string, offerId: string): Promise<{ ride: RideRequest }>;
  setStatus(rideId: string, status: RideStatus): Promise<{ ride: RideRequest }>;
  rate(rideId: string, stars: number): Promise<{ ride: RideRequest }>;
  shareLocation(rideId: string, location: LatLng, heading: number | null): Promise<{ ok: true }>;
  proposals(): Promise<{ proposals: Proposal[]; members: number }>;
  createProposal(body: { title: string; body: string; days: number }): Promise<{ proposal: Proposal }>;
  vote(id: string, choice: VoteChoice): Promise<{ proposal: Proposal }>;
  connect(onEvent: (e: ServerEvent) => void): Channel;
}

export class Api implements NodeApi {
  readonly defaultCentre: LatLng | null = null;

  constructor(
    public baseUrl: string,
    public token: string | null = null,
  ) {}

  private async request<T>(path: string, init: { method?: string; body?: unknown; auth?: boolean } = {}): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    if (this.token && init.auth !== false) headers.authorization = `Bearer ${this.token}`;
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method: init.method ?? 'GET',
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      });
    } catch (e) {
      throw new ApiError(0, `Could not reach the node at ${this.baseUrl}`);
    }
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* non-JSON body */
    }
    if (!res.ok) {
      const msg = (json as { error?: string } | null)?.error ?? `Request failed (${res.status})`;
      throw new ApiError(res.status, msg);
    }
    return json as T;
  }

  // node
  nodeInfo() {
    return this.request<NodeInfo>('/', { auth: false });
  }

  // auth & profile
  register(body: { handle: string; displayName: string; role: User['role'] }) {
    return this.request<{ token: string; user: User }>('/auth/register', { method: 'POST', body, auth: false });
  }
  me() {
    return this.request<{ user: User }>('/me');
  }
  updateMe(body: Partial<{ displayName: string; role: User['role']; paymentHandle: string; rates: DriverRates | null; vehicle: Vehicle | null }>) {
    return this.request<{ user: User }>('/me', { method: 'PATCH', body });
  }
  exportMe() {
    return this.request<unknown>('/me/export');
  }
  setPresence(online: boolean, location: LatLng | null, heading: number | null = null) {
    return this.request<{ ok: true }>('/me/presence', { method: 'POST', body: { online, location, heading } });
  }

  // rides
  quotes(pickup: Place, dropoff: Place) {
    return this.request<QuoteResponse>('/quotes', { method: 'POST', body: { pickup, dropoff } });
  }
  createRide(body: { pickup: Place; dropoff: Place; seats: number; note: string; maxFare: number | null; currency: string }) {
    return this.request<{ ride: RideRequest }>('/rides', { method: 'POST', body });
  }
  myRides() {
    return this.request<{ rides: RideRequest[]; active: RideRequest | null }>('/rides');
  }
  openRides(here: LatLng | null) {
    const q = here ? `?lat=${here.lat}&lng=${here.lng}` : '';
    return this.request<{ rides: OpenRide[] }>(`/rides/open${q}`);
  }
  ride(id: string) {
    return this.request<RideDetail>(`/rides/${id}`);
  }
  makeOffer(rideId: string, body: { fare: number; etaMin: number; message: string }) {
    return this.request<{ offer: Offer }>(`/rides/${rideId}/offers`, { method: 'POST', body });
  }
  withdrawOffer(rideId: string, offerId: string) {
    return this.request<{ offer: Offer }>(`/rides/${rideId}/offers/${offerId}/withdraw`, { method: 'POST' });
  }
  acceptOffer(rideId: string, offerId: string) {
    return this.request<{ ride: RideRequest }>(`/rides/${rideId}/accept`, { method: 'POST', body: { offerId } });
  }
  setStatus(rideId: string, status: RideStatus) {
    return this.request<{ ride: RideRequest }>(`/rides/${rideId}/status`, { method: 'POST', body: { status } });
  }
  rate(rideId: string, stars: number) {
    return this.request<{ ride: RideRequest }>(`/rides/${rideId}/rate`, { method: 'POST', body: { stars } });
  }
  shareLocation(rideId: string, location: LatLng, heading: number | null) {
    return this.request<{ ok: true }>(`/rides/${rideId}/location`, { method: 'POST', body: { location, heading } });
  }

  // governance
  proposals() {
    return this.request<{ proposals: Proposal[]; members: number }>('/proposals');
  }
  createProposal(body: { title: string; body: string; days: number }) {
    return this.request<{ proposal: Proposal }>('/proposals', { method: 'POST', body });
  }
  vote(id: string, choice: VoteChoice) {
    return this.request<{ proposal: Proposal }>(`/proposals/${id}/vote`, { method: 'POST', body: { choice } });
  }

  /** Open the realtime channel. Reconnects with backoff until closed. */
  connect(onEvent: (e: ServerEvent) => void): Channel {
    const wsUrl = `${this.baseUrl.replace(/^http/, 'ws')}/ws?token=${encodeURIComponent(this.token ?? '')}`;
    let ws: WebSocket | null = null;
    let closed = false;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const open = () => {
      if (closed) return;
      ws = new WebSocket(wsUrl);
      ws.onopen = () => {
        attempt = 0;
      };
      ws.onmessage = (m) => {
        try {
          onEvent(JSON.parse(String(m.data)) as ServerEvent);
        } catch {
          /* ignore malformed frames */
        }
      };
      ws.onclose = () => {
        ws = null;
        if (closed) return;
        attempt += 1;
        timer = setTimeout(open, Math.min(30_000, 1000 * 2 ** attempt));
      };
      ws.onerror = () => {
        ws?.close();
      };
    };
    open();

    return {
      send(e) {
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(e));
      },
      close() {
        closed = true;
        if (timer) clearTimeout(timer);
        ws?.close();
      },
    };
  }
}

import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import { create } from 'zustand';
import type { LatLng, NodeInfo, RideRequest, ServerEvent, User } from '@barc/shared';
import { Api, normaliseNodeUrl } from './api.ts';

const SESSION_KEY = 'barc.session.v1';

interface Session {
  nodeUrl: string;
  token: string;
  user: User;
}

interface AppState {
  ready: boolean;
  session: Session | null;
  api: Api;
  node: NodeInfo | null;
  activeRide: RideRequest | null;
  /** Latest live position of the driver on the active ride, as seen by the rider. */
  driverLocation: LatLng | null;
  /** Bumped whenever a realtime event arrives that screens may want to refetch on. */
  eventTick: number;
  lastEvent: ServerEvent | null;
  online: boolean;

  boot(): Promise<void>;
  join(nodeUrl: string, body: { handle: string; displayName: string; role: User['role'] }): Promise<void>;
  signOut(): Promise<void>;
  setUser(user: User): void;
  refreshMe(): Promise<void>;
  refreshNode(): Promise<void>;
  refreshActiveRide(): Promise<void>;
  setActiveRide(ride: RideRequest | null): void;
  setOnline(online: boolean): void;
  handleEvent(e: ServerEvent): void;
}

/** Build-time default node. Override with EXPO_PUBLIC_NODE_URL or app.json `extra.defaultNodeUrl`. */
export const defaultNodeUrl: string =
  process.env.EXPO_PUBLIC_NODE_URL ||
  (Constants.expoConfig?.extra as { defaultNodeUrl?: string } | undefined)?.defaultNodeUrl ||
  'http://localhost:8787';

export const useApp = create<AppState>((set, get) => ({
  ready: false,
  session: null,
  api: new Api(defaultNodeUrl),
  node: null,
  activeRide: null,
  driverLocation: null,
  eventTick: 0,
  lastEvent: null,
  online: false,

  async boot() {
    try {
      const raw = await AsyncStorage.getItem(SESSION_KEY);
      if (raw) {
        const session = JSON.parse(raw) as Session;
        const api = new Api(session.nodeUrl, session.token);
        set({ session, api });
        // Refresh in the background; a stale profile is fine to start with.
        get().refreshMe().catch(() => undefined);
        get().refreshNode().catch(() => undefined);
        get().refreshActiveRide().catch(() => undefined);
      }
    } finally {
      set({ ready: true });
    }
  },

  async join(nodeUrlInput, body) {
    const nodeUrl = normaliseNodeUrl(nodeUrlInput);
    const api = new Api(nodeUrl);
    const node = await api.nodeInfo();
    const { token, user } = await api.register(body);
    api.token = token;
    const session = { nodeUrl, token, user };
    await AsyncStorage.setItem(SESSION_KEY, JSON.stringify(session));
    set({ session, api, node });
  },

  async signOut() {
    await AsyncStorage.removeItem(SESSION_KEY);
    set({ session: null, api: new Api(defaultNodeUrl), node: null, activeRide: null, online: false });
  },

  setUser(user) {
    const s = get().session;
    if (!s) return;
    const session = { ...s, user };
    set({ session });
    AsyncStorage.setItem(SESSION_KEY, JSON.stringify(session)).catch(() => undefined);
  },

  async refreshMe() {
    const { user } = await get().api.me();
    get().setUser(user);
  },

  async refreshNode() {
    set({ node: await get().api.nodeInfo() });
  },

  async refreshActiveRide() {
    const { active } = await get().api.myRides();
    set({ activeRide: active });
  },

  setActiveRide(ride) {
    set({ activeRide: ride });
  },

  setOnline(online) {
    set({ online });
  },

  handleEvent(e) {
    const s = get();
    if (e.type === 'ride.updated') {
      const mine = s.session && (e.ride.riderId === s.session.user.id || e.ride.driverId === s.session.user.id);
      if (mine) {
        const stillActive = !['completed', 'cancelled'].includes(e.ride.status);
        set({ activeRide: stillActive ? e.ride : null, driverLocation: stillActive ? s.driverLocation : null });
      }
    } else if (e.type === 'driver.location') {
      set({ driverLocation: e.location });
    }
    set({ eventTick: s.eventTick + 1, lastEvent: e });
  },
}));

export function useUser(): User | null {
  return useApp((s) => s.session?.user ?? null);
}

export function isDriver(user: User | null): boolean {
  return user?.role === 'driver' || user?.role === 'both';
}

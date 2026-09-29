import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import { REQUEST_TTL_MINUTES, type ClientEvent } from '@barc/shared';
import { Store } from './db.ts';
import { Hub } from './realtime.ts';
import { userFromRequest } from './auth.ts';
import { userRoutes } from './routes/users.ts';
import { rideRoutes } from './routes/rides.ts';
import { governanceRoutes } from './routes/governance.ts';
import { nodeRoutes } from './routes/node.ts';

export interface NodeConfig {
  dbPath?: string;
  nodeName?: string;
  nodeDescription?: string;
  currency?: string;
  logger?: boolean;
}

export interface BarcNode {
  app: FastifyInstance;
  store: Store;
  hub: Hub;
  close(): Promise<void>;
}

export async function buildNode(config: NodeConfig = {}): Promise<BarcNode> {
  const store = new Store(config.dbPath ?? ':memory:');
  if (config.nodeName) store.setSetting('node_name', config.nodeName);
  if (config.nodeDescription) store.setSetting('node_description', config.nodeDescription);
  if (config.currency) store.setSetting('currency', config.currency.toUpperCase());
  const hub = new Hub();

  const app = Fastify({ logger: config.logger ?? false });
  await app.register(cors, { origin: true });
  await app.register(websocket);

  nodeRoutes(app, store);
  userRoutes(app, store);
  rideRoutes(app, store, hub);
  governanceRoutes(app, store);

  app.get('/ws', { websocket: true }, (socket, req) => {
    const user = userFromRequest(store, req);
    if (!user) {
      socket.send(JSON.stringify({ type: 'error', message: 'sign in first' }));
      socket.close(4001, 'unauthorised');
      return;
    }
    hub.add(user.id, socket);
    socket.send(JSON.stringify({ type: 'hello', userId: user.id, nodeName: store.getSetting('node_name', 'BARC node') }));

    socket.on('message', (raw) => {
      let msg: ClientEvent;
      try {
        msg = JSON.parse(String(raw)) as ClientEvent;
      } catch {
        return;
      }
      if (msg.type === 'presence' && user.role !== 'rider') {
        store.setPresence(user.id, msg.online, msg.location?.lat ?? null, msg.location?.lng ?? null, msg.heading);
      } else if (msg.type === 'ping') {
        socket.send(JSON.stringify({ type: 'pong' }));
      }
    });

    socket.on('close', () => {
      hub.remove(user.id, socket);
      // A driver whose last connection dropped should not keep receiving requests.
      if (user.role !== 'rider' && !hub.isConnected(user.id)) {
        store.setPresence(user.id, false, null, null, null);
      }
    });
  });

  // Requests that nobody accepted within the TTL are closed so drivers see a live list.
  const sweeper = setInterval(() => {
    const cutoff = new Date(Date.now() - REQUEST_TTL_MINUTES * 60_000).toISOString();
    for (const id of store.expireOpenRides(cutoff)) {
      const ride = store.getRide(id);
      if (ride) hub.broadcast({ type: 'ride.updated', ride });
    }
  }, 60_000);
  sweeper.unref();

  return {
    app,
    store,
    hub,
    async close() {
      clearInterval(sweeper);
      await app.close();
      store.close();
    },
  };
}

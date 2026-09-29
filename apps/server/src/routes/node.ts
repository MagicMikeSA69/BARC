import type { FastifyInstance } from 'fastify';
import {
  MAX_COMMUNITY_CONTRIBUTION_RATE,
  NETWORK_TAKE_RATE,
  PRINCIPLES,
  PROTOCOL_VERSION,
  type NodeInfo,
} from '@barc/shared';
import type { Store } from '../db.ts';

/** Public, unauthenticated facts about this node. Anyone can inspect a node before joining. */
export function nodeRoutes(app: FastifyInstance, store: Store): void {
  app.get('/', async () => {
    const contribution = Math.min(
      Number(store.getSetting('community_contribution_rate', '0')) || 0,
      MAX_COMMUNITY_CONTRIBUTION_RATE,
    );
    const info: NodeInfo = {
      name: store.getSetting('node_name', 'BARC node'),
      description: store.getSetting('node_description', 'A community-run ride network.'),
      networkTakeRate: NETWORK_TAKE_RATE,
      communityContributionRate: contribution,
      currency: store.getSetting('currency', 'USD'),
      members: store.countUsers(),
      driversOnline: store.onlineDrivers().length,
      protocolVersion: PROTOCOL_VERSION,
    };
    return info;
  });

  app.get('/principles', async () => ({ principles: PRINCIPLES }));

  app.get('/health', async () => ({ ok: true }));
}

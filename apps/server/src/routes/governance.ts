import type { FastifyInstance } from 'fastify';
import type { VoteChoice } from '@barc/shared';
import { currentUser, newId, requireUser } from '../auth.ts';
import type { Store } from '../db.ts';

const CHOICES: VoteChoice[] = ['yes', 'no', 'abstain'];

/**
 * One member, one vote. A node's rules are whatever its members decide.
 * The protocol only fixes the floor: the take rate stays at zero.
 */
export function governanceRoutes(app: FastifyInstance, store: Store): void {
  const auth = { preHandler: requireUser(store) };

  app.get('/proposals', auth, async (req) => {
    const me = currentUser(req);
    return { proposals: store.listProposals(me.id), members: store.countUsers() };
  });

  app.post('/proposals', auth, async (req, reply) => {
    const me = currentUser(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const title = String(body.title ?? '').trim().slice(0, 120);
    const text = String(body.body ?? '').trim().slice(0, 4000);
    const days = Number(body.days ?? 7);
    if (title.length < 4) return reply.code(400).send({ error: 'title is too short' });
    if (text.length < 10) return reply.code(400).send({ error: 'say a little more about the proposal' });
    if (!Number.isFinite(days) || days < 1 || days > 60) return reply.code(400).send({ error: 'voting period must be 1-60 days' });
    const id = newId('prop');
    store.createProposal({
      id,
      authorId: me.id,
      title,
      body: text,
      closesAt: new Date(Date.now() + days * 86_400_000).toISOString(),
    });
    // The proposer's own vote counts as a yes unless they change it.
    store.castVote(id, me.id, 'yes');
    return reply.code(201).send({ proposal: store.getProposal(id, me.id) });
  });

  app.post('/proposals/:id/vote', auth, async (req, reply) => {
    const me = currentUser(req);
    const { id } = req.params as { id: string };
    const proposal = store.getProposal(id, me.id);
    if (!proposal) return reply.code(404).send({ error: 'no such proposal' });
    if (new Date(proposal.closesAt).getTime() < Date.now()) return reply.code(409).send({ error: 'voting has closed' });
    const { choice } = (req.body ?? {}) as { choice?: VoteChoice };
    if (!choice || !CHOICES.includes(choice)) return reply.code(400).send({ error: 'choice must be yes, no or abstain' });
    store.castVote(id, me.id, choice);
    return { proposal: store.getProposal(id, me.id) };
  });
}

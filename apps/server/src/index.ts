import { buildNode } from './app.ts';

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? '0.0.0.0';

const node = await buildNode({
  dbPath: process.env.BARC_DB ?? './barc.db',
  nodeName: process.env.BARC_NODE_NAME,
  nodeDescription: process.env.BARC_NODE_DESCRIPTION,
  currency: process.env.BARC_CURRENCY,
  logger: true,
});

await node.app.listen({ port, host });
console.log(`BARC node listening on http://${host}:${port}`);

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    node.close().finally(() => process.exit(0));
  });
}

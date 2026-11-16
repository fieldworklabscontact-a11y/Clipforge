import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { createApp } from './server/app.js';
import { createSqliteStore } from './server/store/sqlite.js';
import { createBatchStore } from './server/batch/schema.js';
import { createRenderer } from './server/batch/render.js';
import { createQueue } from './server/batch/queue.js';
import { createBatchRoutes } from './server/batch/routes.js';

mkdirSync('data', { recursive: true });
const db = new DatabaseSync('data/clipforge.sqlite');
const store = createSqliteStore(db);
const batchStore = createBatchStore(db);
const batchRenderer = createRenderer({ store: batchStore, rootDir: path.resolve('data/batches') });
const batchQueue = createQueue({ store: batchStore, renderer: batchRenderer });

const app = createApp({
  store,
  staticDir: process.env.NODE_ENV === 'production' ? 'dist' : null,
  mountApi: (server, { requireUser }) => server.use('/api', createBatchRoutes({ store: batchStore, renderer: batchRenderer, queue: batchQueue, requireUser })),
});

const port = Number(process.env.PORT || 3001);
app.listen(port, '127.0.0.1', () => {
  console.log(`ClipForge API listening on ${port}`);
  const recovered = batchQueue.recover();
  if (recovered) console.log(`Batch queue recovered jobs for ${recovered} batch(es).`);
});

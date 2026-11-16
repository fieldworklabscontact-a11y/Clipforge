import path from 'node:path';
import { getStore } from '@netlify/blobs';
import { createApp } from '../../server/app.js';
import { createBlobStore } from '../../server/store/blobs.js';
import { createLocalBlobs } from '../../server/store/local-blobs.js';
import { netlifyHandler } from '../../server/netlify.js';

let handler = null;

/** Netlify injects the Blobs context; `netlify dev --offline` does not, so fall back to disk there. */
function hostedBlobs() {
  try {
    return getStore({ name: 'clipforge' });
  } catch (error) {
    if (error?.name !== 'MissingBlobsEnvironmentError') throw error;
    console.warn('Netlify Blobs is not configured; using data/netlify-blobs for this offline session.');
    return createLocalBlobs(path.resolve('data/netlify-blobs'));
  }
}

/**
 * The hosted API: accounts, sessions, projects and captions on Netlify Blobs.
 * Batch Studio is not mounted here because it needs ffmpeg and a writable disk;
 * those routes answer 503 from the app factory instead of failing mysteriously.
 */
export async function handler_(event, context) {
  if (!handler) handler = netlifyHandler(createApp({ store: createBlobStore(hostedBlobs()) }));
  return handler(event, context);
}

export { handler_ as handler };

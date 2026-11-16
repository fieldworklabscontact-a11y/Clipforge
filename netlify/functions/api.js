import { getStore } from '@netlify/blobs';
import { createApp } from '../../server/app.js';
import { createBlobStore } from '../../server/store/blobs.js';
import { netlifyHandler } from '../../server/netlify.js';

let handler = null;

/**
 * The hosted API: accounts, sessions, projects and captions on Netlify Blobs.
 * Batch Studio is not mounted here because it needs ffmpeg and a writable disk;
 * those routes answer 503 from the app factory instead of failing mysteriously.
 */
export async function handler_(event, context) {
  if (!handler) handler = netlifyHandler(createApp({ store: createBlobStore(getStore({ name: 'clipforge' })) }));
  return handler(event, context);
}

export { handler_ as handler };

import os from 'node:os';
import path from 'node:path';
import { connectLambda, getStore } from '@netlify/blobs';
import { createApp } from '../../server/app.js';
import { createBlobStore } from '../../server/store/blobs.js';
import { createLocalBlobs } from '../../server/store/local-blobs.js';
import { netlifyHandler } from '../../server/netlify.js';

let handler = null;

/**
 * Netlify injects the Blobs context with the invocation. In the Lambda compatibility
 * runtime it arrives as `event.blobs` and has to be handed to the client explicitly;
 * `netlify dev --offline` has no context at all, so fall back to disk there.
 */
function hostedBlobs(event) {
  if (event?.blobs && !process.env.NETLIFY_BLOBS_CONTEXT) {
    try {
      connectLambda(event);
    } catch (error) {
      console.warn(`Could not attach the Netlify Blobs context: ${error?.message}`);
    }
  }
  try {
    return getStore({ name: 'clipforge' });
  } catch (error) {
    if (error?.name !== 'MissingBlobsEnvironmentError') throw error;
    // LAMBDA_TASK_ROOT is set inside a deployed function, where only /tmp is writable.
    const root = process.env.LAMBDA_TASK_ROOT
      ? path.join(os.tmpdir(), 'clipforge-blobs')
      : path.resolve('data/netlify-blobs');
    console.warn(`Netlify Blobs is not configured; using ${root} for this session.`);
    return createLocalBlobs(root);
  }
}

/**
 * The hosted API: accounts, sessions, projects and captions on Netlify Blobs.
 * Batch Studio is not mounted here because it needs ffmpeg and a writable disk;
 * those routes answer 503 from the app factory instead of failing mysteriously.
 */
export async function handler_(event, context) {
  if (!handler) handler = netlifyHandler(createApp({ store: createBlobStore(hostedBlobs(event)) }));
  return handler(event, context);
}

export { handler_ as handler };

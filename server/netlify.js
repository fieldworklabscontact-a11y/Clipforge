import serverless from 'serverless-http';

const FUNCTION_PREFIX = '/.netlify/functions/api';

/**
 * Netlify's redirect sends /api/* to /.netlify/functions/api/:splat, so the Express app
 * sees the function prefix instead of the /api routes it declares. Rewrite it back.
 */
export function toApiPath(pathname) {
  const raw = String(pathname || '/');
  const rest = raw.startsWith(FUNCTION_PREFIX) ? raw.slice(FUNCTION_PREFIX.length) : raw.replace(/^\/api/, '');
  return !rest || rest === '/' ? '/api' : `/api${rest.startsWith('/') ? rest : `/${rest}`}`;
}

export function netlifyHandler(app) {
  const run = serverless(app);
  return (event, context) => run({ ...event, path: toApiPath(event.path) }, context);
}

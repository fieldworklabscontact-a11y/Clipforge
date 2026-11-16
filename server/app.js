import express from 'express';
import path from 'node:path';
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';

const hash = value => createHash('sha256').update(value).digest('hex');
const SESSION_COOKIE = 'clipforge_session';
const COOKIE_MAX_AGE = 604800;
const BATCH_PATHS = /^\/api\/(batch|batches|segments|jobs|outputs|profiles)(\/|$)/;
const BATCH_UNAVAILABLE = 'Batch Studio renders with ffmpeg on the local server, so it is unavailable in this hosted preview. Accounts, projects and captions work normally.';

function readSessionToken(req) {
  return req.headers.cookie?.split(';').map(part => part.trim()).find(part => part.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1);
}

/**
 * The Express app shared by the local server and the Netlify function. Storage is injected,
 * and the ffmpeg-backed batch routes are mounted by the caller because they need both a
 * writable disk and the bundled ffmpeg binaries, which the hosted function does not have.
 */
export function createApp({ store, staticDir = null, mountApi = null }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const origin = req.get('origin');
      if (origin) {
        try {
          const parsed = new URL(origin);
          // Proxies (Netlify functions, deploy previews, custom domains) rewrite Host,
          // so accept the forwarded host too. Any loopback spelling counts as the same
          // origin: macOS proxies localhost as [::1] while the browser says localhost.
          const hosts = [req.get('host'), req.get('x-forwarded-host')].map(hostName).filter(Boolean);
          const originHost = hostName(parsed.host);
          const sameHost = hosts.includes(originHost) || (isLoopback(originHost) && hosts.some(isLoopback));
          if (!['http:', 'https:'].includes(parsed.protocol) || !sameHost) return res.status(403).json({ error: 'Request origin is not allowed.' });
        } catch { return res.status(403).json({ error: 'Request origin is not allowed.' }); }
      }
    }
    next();
  });

  /**
   * `netlify dev` proxies http://localhost and still reports x-forwarded-proto: https, which
   * makes us emit a Secure cookie the browser then drops over plain http. Treat loopback
   * hosts as insecure regardless of the proxy's claim.
   */
  const hostName = value => {
    const host = String(value || '').split(',')[0].trim().toLowerCase();
    if (host.startsWith('[')) return host.slice(1, host.indexOf(']'));
    return host.replace(/:\d+$/, '');
  };
  const isLoopback = host => host === 'localhost' || host === '127.0.0.1' || host === '::1';
  const isSecureRequest = req => {
    const host = hostName(req.get('x-forwarded-host') || req.get('host'));
    if (isLoopback(host)) return false;
    return req.secure || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
  };

  /**
   * A hosted preview runs the app inside an iframe, which is a third-party context:
   * a SameSite=Strict cookie is stored but never sent there, so every API call answers
   * "Please log in to continue." Over HTTPS we therefore issue SameSite=None; Secure,
   * and keep Strict for plain http development.
   */
  const sessionCookie = (req, token) => `clipforge_session${token ? `=${token}; Max-Age=${COOKIE_MAX_AGE}` : '=; Max-Age=0'}; HttpOnly; ${isSecureRequest(req) ? 'SameSite=None; Secure' : 'SameSite=Strict'}; Path=/`;

  const currentUser = async req => {
    const token = readSessionToken(req);
    return token ? store.findSession(hash(token), Date.now()) : null;
  };

  async function startSession(req, res, userId) {
    const token = randomBytes(32).toString('hex');
    await store.createSession(hash(token), userId, Date.now() + COOKIE_MAX_AGE * 1000);
    res.setHeader('Set-Cookie', sessionCookie(req, token));
  }

  async function requireUser(req, res, next) {
    req.user = await currentUser(req);
    if (!req.user) return res.status(401).json({ error: 'Please log in to continue.' });
    next();
  }

  app.get('/api/session', async (req, res) => res.json({ user: await currentUser(req) }));

  app.post('/api/signup', async (req, res) => {
    const { name, email, password, terms } = req.body || {};
    if (typeof name !== 'string' || !name.trim() || name.length > 100 || typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 || typeof password !== 'string' || password.length < 8 || password.length > 256 || terms !== true) return res.status(400).json({ error: 'Enter your name, a valid email, a password of at least 8 characters, and accept the terms.' });
    const salt = randomBytes(16).toString('hex'), id = randomBytes(16).toString('hex'), address = email.trim().toLowerCase();
    let user;
    try {
      user = await store.createUser({ id, name: name.trim(), email: address, salt, password: scryptSync(password, salt, 64).toString('hex') });
    } catch (error) {
      if (error.code === 'EMAIL_TAKEN') return res.status(409).json({ error: 'An account with that email already exists.' });
      throw error;
    }
    await startSession(req, res, user.id);
    res.status(201).json({ user });
  });

  app.post('/api/login', async (req, res) => {
    const { email, password } = req.body || {};
    if (typeof email !== 'string' || typeof password !== 'string' || password.length > 256) return res.status(400).json({ error: 'Enter your email and password.' });
    const user = await store.findUserByEmail(email.trim().toLowerCase());
    const stored = user ? Buffer.from(user.password, 'hex') : null;
    if (!user || !stored || stored.length !== 64 || !timingSafeEqual(stored, scryptSync(password, user.salt, 64))) return res.status(401).json({ error: 'Email or password is incorrect.' });
    await startSession(req, res, user.id);
    res.json({ user: { id: user.id, name: user.name, email: user.email, theme: user.theme } });
  });

  app.post('/api/logout', async (req, res) => {
    const token = readSessionToken(req);
    if (token) await store.deleteSession(hash(token));
    res.setHeader('Set-Cookie', sessionCookie(req, null));
    res.json({ ok: true });
  });

  app.patch('/api/settings', requireUser, async (req, res) => {
    const { theme } = req.body || {};
    if (!['dark', 'light', 'system'].includes(theme)) return res.status(400).json({ error: 'Choose a valid theme.' });
    await store.setTheme(req.user.id, theme);
    res.json({ user: { ...req.user, theme } });
  });

  app.get('/api/projects', requireUser, async (req, res) => res.json({ projects: await store.listProjects(req.user.id) }));

  app.post('/api/projects', requireUser, async (req, res) => {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, 100) : '';
    const data = req.body?.data ?? {};
    if (!name) return res.status(400).json({ error: 'Enter a project name.' });
    if (!data || typeof data !== 'object' || Array.isArray(data)) return res.status(400).json({ error: 'Project data must be an object.' });
    const project = { id: randomBytes(16).toString('hex'), userId: req.user.id, name, data, updated: new Date().toISOString() };
    await store.createProject(project);
    res.status(201).json({ project: { id: project.id, name: project.name, data: project.data, updated: project.updated } });
  });

  app.put('/api/projects/:id', requireUser, async (req, res) => {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, 100) : '';
    const data = req.body?.data;
    const expectedUpdated = req.body?.expectedUpdated;
    if (!name || !data || typeof data !== 'object' || Array.isArray(data) || (expectedUpdated !== undefined && typeof expectedUpdated !== 'string')) return res.status(400).json({ error: 'Project name and data are required.' });
    const result = await store.updateProject({ id: req.params.id, userId: req.user.id, name, data, expectedUpdated });
    if (result.ok) return res.json({ project: result.project });
    if (result.reason === 'missing') return res.status(404).json({ error: 'Project not found.' });
    return res.status(409).json({ error: 'This project changed elsewhere. Your local work was not overwritten; reopen the project to review it.' });
  });

  app.delete('/api/projects/:id', requireUser, async (req, res) => {
    if (!(await store.deleteProject(req.params.id, req.user.id))) return res.status(404).json({ error: 'Project not found.' });
    res.json({ ok: true });
  });

  if (mountApi) mountApi(app, { requireUser });
  else app.use((req, res, next) => BATCH_PATHS.test(req.path) ? res.status(503).json({ error: BATCH_UNAVAILABLE }) : next());

  if (staticDir) {
    app.use(express.static(staticDir));
    app.get('/{*path}', (req, res) => res.sendFile(path.resolve(staticDir, 'index.html')));
  }

  return app;
}

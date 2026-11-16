import express from 'express';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { createBatchStore } from './server/batch/schema.js';
import { createRenderer } from './server/batch/render.js';
import { createQueue } from './server/batch/queue.js';
import { createBatchRoutes } from './server/batch/routes.js';

mkdirSync('data', { recursive: true });
const db = new DatabaseSync('data/clipforge.sqlite');
db.exec(`PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL, salt TEXT NOT NULL, password TEXT NOT NULL, theme TEXT NOT NULL DEFAULT 'dark'); CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}', updated TEXT NOT NULL);`);
const batchStore = createBatchStore(db);
const batchRenderer = createRenderer({ store: batchStore, rootDir: path.resolve('data/batches') });
const batchQueue = createQueue({ store: batchStore, renderer: batchRenderer });

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    const origin = req.get('origin');
    if (origin) { try { const parsed = new URL(origin); if (!['http:', 'https:'].includes(parsed.protocol) || parsed.host !== req.get('host')) return res.status(403).json({ error: 'Request origin is not allowed.' }); } catch { return res.status(403).json({ error: 'Request origin is not allowed.' }); } }
  }
  next();
});
const hash = value => createHash('sha256').update(value).digest('hex');
function currentUser(req) {
  const raw = req.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith('clipforge_session='))?.slice('clipforge_session='.length);
  if (!raw) return null;
  return db.prepare('SELECT users.id, users.name, users.email, users.theme FROM sessions JOIN users ON users.id=sessions.user_id WHERE sessions.token=? AND sessions.expires>?').get(hash(raw), Date.now());
}
const isSecureRequest = req => req.secure || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';

/**
 * A hosted preview runs the app inside an iframe, which is a third-party context:
 * a SameSite=Strict cookie is stored but never sent there, so every API call
 * answers "Please log in to continue." over HTTPS we therefore issue
 * SameSite=None; Secure, and keep Strict for plain http development.
 */
function sessionCookie(req, token) {
  const https = isSecureRequest(req);
  const attributes = https ? 'SameSite=None; Secure' : 'SameSite=Strict';
  const value = token ? `=${token}; Max-Age=604800` : '=; Max-Age=0';
  return `clipforge_session${value}; HttpOnly; ${attributes}; Path=/`;
}
function setSession(req, res, userId) {
  const token = randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(hash(token), userId, Date.now() + 7 * 86400000);
  res.setHeader('Set-Cookie', sessionCookie(req, token));
}
function requireUser(req, res, next) { req.user = currentUser(req); if (!req.user) return res.status(401).json({ error: 'Please log in to continue.' }); next(); }
app.get('/api/session', (req, res) => res.json({ user: currentUser(req) }));
app.post('/api/signup', (req, res) => {
  const { name, email, password, terms } = req.body || {};
  if (typeof name !== 'string' || !name.trim() || name.length > 100 || typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 || typeof password !== 'string' || password.length < 8 || password.length > 256 || terms !== true) return res.status(400).json({ error: 'Enter your name, a valid email, a password of at least 8 characters, and accept the terms.' });
  const salt = randomBytes(16).toString('hex'), id = randomBytes(16).toString('hex');
  try { db.prepare('INSERT INTO users (id,name,email,salt,password) VALUES (?,?,?,?,?)').run(id, name.trim(), email.trim().toLowerCase(), salt, scryptSync(password, salt, 64).toString('hex')); }
  catch (error) { if (String(error.message).includes('UNIQUE')) return res.status(409).json({ error: 'An account with that email already exists.' }); throw error; }
  setSession(req, res, id); res.status(201).json({ user: { id, name: name.trim(), email: email.trim().toLowerCase(), theme: 'dark' } });
});
app.post('/api/login', (req, res) => {
  const { email, password } = req.body || {};
  if (typeof email !== 'string' || typeof password !== 'string' || password.length > 256) return res.status(400).json({ error: 'Enter your email and password.' });
  const user = db.prepare('SELECT * FROM users WHERE email=?').get(email.trim().toLowerCase());
  if (!user || !timingSafeEqual(Buffer.from(user.password, 'hex'), scryptSync(password, user.salt, 64))) return res.status(401).json({ error: 'Email or password is incorrect.' });
  setSession(req, res, user.id); res.json({ user: { id: user.id, name: user.name, email: user.email, theme: user.theme } });
});
app.post('/api/logout', (req, res) => { const raw = req.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith('clipforge_session='))?.slice('clipforge_session='.length); if (raw) db.prepare('DELETE FROM sessions WHERE token=?').run(hash(raw)); res.setHeader('Set-Cookie', sessionCookie(req, null)); res.json({ ok: true }); });
app.patch('/api/settings', requireUser, (req, res) => { const { theme } = req.body || {}; if (!['dark','light','system'].includes(theme)) return res.status(400).json({ error: 'Choose a valid theme.' }); db.prepare('UPDATE users SET theme=? WHERE id=?').run(theme, req.user.id); res.json({ user: { ...req.user, theme } }); });
app.get('/api/projects', requireUser, (req, res) => res.json({ projects: db.prepare('SELECT id,name,data,updated FROM projects WHERE user_id=? ORDER BY updated DESC').all(req.user.id).map(p => ({ ...p, data: JSON.parse(p.data) })) }));
app.post('/api/projects', requireUser, (req, res) => { const name = typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, 100) : ''; const data = req.body?.data ?? {}; if (!name) return res.status(400).json({ error: 'Enter a project name.' }); if (!data || typeof data !== 'object' || Array.isArray(data)) return res.status(400).json({ error: 'Project data must be an object.' }); const project = { id: randomBytes(16).toString('hex'), name, data, updated: new Date().toISOString() }; db.prepare('INSERT INTO projects VALUES (?,?,?,?,?)').run(project.id, req.user.id, project.name, JSON.stringify(data), project.updated); res.status(201).json({ project }); });
app.put('/api/projects/:id', requireUser, (req, res) => { const name = typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, 100) : ''; const data = req.body?.data; const expectedUpdated = req.body?.expectedUpdated; if (!name || !data || typeof data !== 'object' || Array.isArray(data) || (expectedUpdated !== undefined && typeof expectedUpdated !== 'string')) return res.status(400).json({ error: 'Project name and data are required.' }); const current = db.prepare('SELECT updated FROM projects WHERE id=? AND user_id=?').get(req.params.id, req.user.id); if (!current) return res.status(404).json({ error: 'Project not found.' }); if (expectedUpdated !== undefined && current.updated !== expectedUpdated) return res.status(409).json({ error: 'This project changed elsewhere. Your local work was not overwritten; reopen the project to review it.' }); const updated = new Date(Math.max(Date.now(), Date.parse(current.updated) + 1)).toISOString(); const result = db.prepare('UPDATE projects SET name=?, data=?, updated=? WHERE id=? AND user_id=? AND updated=?').run(name, JSON.stringify(data), updated, req.params.id, req.user.id, current.updated); if (!result.changes) return res.status(409).json({ error: 'This project changed elsewhere. Your local work was not overwritten.' }); res.json({ project: { id: req.params.id, name, data, updated } }); });
app.delete('/api/projects/:id', requireUser, (req, res) => { const result = db.prepare('DELETE FROM projects WHERE id=? AND user_id=?').run(req.params.id, req.user.id); if (!result.changes) return res.status(404).json({ error: 'Project not found.' }); res.json({ ok: true }); });
app.use('/api', createBatchRoutes({ store: batchStore, renderer: batchRenderer, queue: batchQueue, requireUser }));
if (process.env.NODE_ENV === 'production') { app.use(express.static('dist')); app.get('/{*path}', (req, res) => res.sendFile(path.resolve('dist/index.html'))); }
const port = Number(process.env.PORT || 3001);
app.listen(port, '127.0.0.1', () => { console.log(`ClipForge API listening on ${port}`); const recovered = batchQueue.recover(); if (recovered) console.log(`Batch queue recovered jobs for ${recovered} batch(es).`); });

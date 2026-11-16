/**
 * Local storage: the single-file SQLite database the development server has always used.
 * Every method is async so the Express app can be shared with the Netlify Blobs store.
 */
export function createSqliteStore(db) {
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL, salt TEXT NOT NULL, password TEXT NOT NULL, theme TEXT NOT NULL DEFAULT 'dark');
    CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}', updated TEXT NOT NULL);`);

  const publicUser = row => row ? { id: row.id, name: row.name, email: row.email, theme: row.theme } : null;

  return {
    async findSession(token, now) {
      return publicUser(db.prepare('SELECT users.id, users.name, users.email, users.theme FROM sessions JOIN users ON users.id=sessions.user_id WHERE sessions.token=? AND sessions.expires>?').get(token, now));
    },
    async createSession(token, userId, expires) {
      db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(token, userId, expires);
    },
    async deleteSession(token) {
      db.prepare('DELETE FROM sessions WHERE token=?').run(token);
    },
    async findUserByEmail(email) {
      return db.prepare('SELECT * FROM users WHERE email=?').get(email) || null;
    },
    async createUser({ id, name, email, salt, password }) {
      try {
        db.prepare('INSERT INTO users (id,name,email,salt,password) VALUES (?,?,?,?,?)').run(id, name, email, salt, password);
      } catch (error) {
        if (!String(error.message).includes('UNIQUE')) throw error;
        const taken = new Error('An account with that email already exists.');
        taken.code = 'EMAIL_TAKEN';
        throw taken;
      }
      return { id, name, email, theme: 'dark' };
    },
    async setTheme(userId, theme) {
      db.prepare('UPDATE users SET theme=? WHERE id=?').run(theme, userId);
    },
    async listProjects(userId) {
      return db.prepare('SELECT id,name,data,updated FROM projects WHERE user_id=? ORDER BY updated DESC').all(userId).map(row => ({ ...row, data: JSON.parse(row.data) }));
    },
    async createProject(project) {
      db.prepare('INSERT INTO projects VALUES (?,?,?,?,?)').run(project.id, project.userId, project.name, JSON.stringify(project.data), project.updated);
      return project;
    },
    async updateProject({ id, userId, name, data, expectedUpdated }) {
      const current = db.prepare('SELECT updated FROM projects WHERE id=? AND user_id=?').get(id, userId);
      if (!current) return { ok: false, reason: 'missing' };
      if (expectedUpdated !== undefined && current.updated !== expectedUpdated) return { ok: false, reason: 'conflict' };
      const updated = new Date(Math.max(Date.now(), Date.parse(current.updated) + 1)).toISOString();
      const result = db.prepare('UPDATE projects SET name=?, data=?, updated=? WHERE id=? AND user_id=? AND updated=?').run(name, JSON.stringify(data), updated, id, userId, current.updated);
      if (!result.changes) return { ok: false, reason: 'conflict' };
      return { ok: true, project: { id, name, data, updated } };
    },
    async deleteProject(id, userId) {
      return db.prepare('DELETE FROM projects WHERE id=? AND user_id=?').run(id, userId).changes > 0;
    },
  };
}

/**
 * Hosted storage: Netlify Blobs has no SQL and no transactions, so each record is a JSON
 * document. That is enough for accounts, sessions and project documents, but the
 * read-compare-write in updateProject is best-effort rather than atomic: two tabs saving
 * at the exact same millisecond could both win. Acceptable for a preview; a real
 * deployment should move this to Postgres (Netlify DB) before trusting it with client work.
 *
 * Blobs can also serve a read from a replica that has not seen the write yet, so a login
 * right after signup could miss the account. New users are therefore kept in a short-lived
 * in-memory map and lookups retry briefly before reporting "no such user".
 */
const key = {
  user: id => `users/${id}`,
  email: address => `emails/${address}`,
  session: token => `sessions/${token}`,
  project: (userId, id) => `projects/${userId}/${id}`,
};

const FRESH_USER_MS = 60_000;
const RETRY_DELAYS = [200, 600];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function createBlobStore(blobs) {
  const read = async (name) => (await blobs.get(name, { type: 'json' })) ?? null;

  // Bounded to a minute, and every write refreshes the entry, so a theme change is not masked for long.
  const freshUsers = new Map();

  function remember(user) {
    freshUsers.set(user.email, { user, expires: Date.now() + FRESH_USER_MS });
  }

  function recall(email) {
    const entry = freshUsers.get(email);
    if (!entry) return null;
    if (entry.expires <= Date.now()) {
      freshUsers.delete(email);
      return null;
    }
    return entry.user;
  }

  async function writeUser(user) {
    await Promise.all([blobs.setJSON(key.user(user.id), user), blobs.setJSON(key.email(user.email), user)]);
    remember(user);
  }

  return {
    async findSession(token, now) {
      const session = await read(key.session(token));
      if (!session || session.expires <= now) return null;
      const user = await read(key.user(session.userId));
      return user ? { id: user.id, name: user.name, email: user.email, theme: user.theme } : null;
    },
    async createSession(token, userId, expires) {
      await blobs.setJSON(key.session(token), { userId, expires });
    },
    async deleteSession(token) {
      await blobs.delete(key.session(token));
    },
    async findUserByEmail(email) {
      const cached = recall(email);
      if (cached) return cached;
      for (const delay of [0, ...RETRY_DELAYS]) {
        if (delay) await sleep(delay);
        const user = await read(key.email(email));
        if (user) {
          remember(user);
          return user;
        }
      }
      return null;
    },
    async createUser({ id, name, email, salt, password }) {
      // Cache first so a repeat from this instance is instant; the read covers other instances.
      if (recall(email) || await read(key.email(email))) {
        const taken = new Error('An account with that email already exists.');
        taken.code = 'EMAIL_TAKEN';
        throw taken;
      }
      const user = { id, name, email, salt, password, theme: 'dark' };
      await writeUser(user);
      return { id, name, email, theme: user.theme };
    },
    async setTheme(userId, theme) {
      const existing = await read(key.user(userId));
      if (!existing) return;
      await writeUser({ ...existing, theme });
    },
    async listProjects(userId) {
      const { blobs: entries = [] } = await blobs.list({ prefix: `projects/${userId}/` });
      const projects = await Promise.all(entries.map(entry => read(entry.key)));
      return projects.filter(Boolean).map(({ id, name, data, updated }) => ({ id, name, data, updated })).sort((a, b) => b.updated.localeCompare(a.updated));
    },
    async createProject(project) {
      await blobs.setJSON(key.project(project.userId, project.id), project);
      return project;
    },
    async updateProject({ id, userId, name, data, expectedUpdated }) {
      const existing = await read(key.project(userId, id));
      if (!existing) return { ok: false, reason: 'missing' };
      if (expectedUpdated !== undefined && existing.updated !== expectedUpdated) return { ok: false, reason: 'conflict' };
      const updated = new Date(Math.max(Date.now(), Date.parse(existing.updated) + 1)).toISOString();
      const project = { id, userId, name, data, updated };
      await blobs.setJSON(key.project(userId, project.id), project);
      return { ok: true, project: { id, name, data, updated } };
    },
    async deleteProject(id, userId) {
      if (!(await read(key.project(userId, id)))) return false;
      await blobs.delete(key.project(userId, id));
      return true;
    },
  };
}

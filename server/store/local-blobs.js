import { mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Netlify Blobs is only configured inside a linked site (or a deployed function).
 * `netlify dev --offline` has no context, so the function falls back to this small
 * file-backed store under data/netlify-blobs to keep the hosted code path testable.
 * It is never used on Netlify itself, where getStore() succeeds.
 */
export function createLocalBlobs(root) {
  const fileFor = key => path.join(root, encodeURIComponent(key));
  return {
    async get(key) {
      try { return JSON.parse(readFileSync(fileFor(key), 'utf8')); } catch { return null; }
    },
    async setJSON(key, value) {
      mkdirSync(root, { recursive: true });
      writeFileSync(fileFor(key), JSON.stringify(value));
    },
    async delete(key) {
      rmSync(fileFor(key), { force: true });
    },
    async list({ prefix = '' } = {}) {
      if (!existsSync(root)) return { blobs: [] };
      return { blobs: readdirSync(root).map(name => decodeURIComponent(name)).filter(key => key.startsWith(prefix)).map(key => ({ key })) };
    },
  };
}

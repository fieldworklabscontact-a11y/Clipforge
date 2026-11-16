import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProject, appendAsset, placeClip } from '../src/editor/model.js';
import { createSaveSession } from '../src/editor/session.js';
import { readRecovery, writeRecovery, removeRecovery, recoveryDisposition } from '../src/editor/recovery.js';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

function memoryStorage({ failWrites = false } = {}) {
  const map = new Map();
  return {
    map,
    setItem(key, value) { if (failWrites) throw new Error('QuotaExceededError'); map.set(key, value); },
    getItem(key) { return map.get(key) ?? null; },
    removeItem(key) { map.delete(key); },
  };
}

function baseProject() {
  return placeClip(appendAsset(createProject(), { id: 'a', name: 'source', frames: 300 }), 'a', 'clip');
}

const withCaption = (text) => ({ ...baseProject(), captions: [{ id: `caption-${text}`, text, start: 0, duration: 30 }] });

/** A server whose writes stay pending until the test resolves them. */
function fakeServer() {
  const calls = [];
  const server = {
    calls,
    project: { updated: 'v0', name: 'Cut', data: baseProject() },
    put(payload) {
      return new Promise((resolve, reject) => calls.push({ payload, resolve, reject }));
    },
    accept(index = calls.length - 1) {
      const call = calls[index];
      const updated = `v${index + 1}`;
      server.project = { updated, name: call.payload.name, data: structuredClone(call.payload.data) };
      call.resolve({ project: { id: 'p', name: call.payload.name, data: call.payload.data, updated } });
      return updated;
    },
    fail(index, error) { calls[index].reject(error); },
  };
  return server;
}

function setup({ storage = memoryStorage(), server = fakeServer() } = {}) {
  const snapshots = [];
  const session = createSaveSession({
    put: server.put,
    storage,
    userId: 'user-1',
    projectId: 'project-1',
    onChange: state => snapshots.push(state),
  });
  session.reset({ updated: server.project.updated, data: server.project.data, name: server.project.name });
  return { session, storage, server, snapshots, last: () => snapshots.at(-1), snap: () => session.getState() };
}

test('an edit made during an in-flight save is not reported saved until it is persisted', async () => {
  const t = setup();
  t.session.record(withCaption('first'), 'Cut');
  const flushing = t.session.flush();
  assert.equal(t.snap().status, 'Saving');
  assert.equal(t.server.calls.length, 1);

  t.session.record(withCaption('second'), 'Cut');
  assert.equal(t.snap().status, 'Unsaved changes');
  assert.equal(t.snap().dirty, true);

  t.server.accept(0);
  await tick();
  assert.equal(t.server.calls.length, 2, 'the later revision is written after the first acknowledges');
  assert.equal(t.server.calls[1].payload.expectedUpdated, 'v1', 'the second write uses the revision the server just returned');
  assert.equal(t.snap().status, 'Saving');

  t.server.accept(1);
  const result = await flushing;
  assert.equal(result.saved, true);
  assert.equal(t.snap().status, 'Saved');
  assert.equal(t.snap().dirty, false);
  assert.equal(t.server.project.data.captions[0].text, 'second');
  assert.equal(readRecovery(t.storage, 'user-1', 'project-1'), null);
});

test('a rename on a freshly loaded project is saved without any structural edit', async () => {
  const t = setup();
  t.session.rename('Renamed cut');
  assert.equal(t.snap().dirty, true);
  assert.equal(readRecovery(t.storage, 'user-1', 'project-1').name, 'Renamed cut');

  const flushing = t.session.flush();
  assert.equal(t.server.calls.length, 1);
  assert.equal(t.server.calls[0].payload.data.clips.length, 1, 'the loaded document is written, not an empty one');
  t.server.accept(0);
  assert.equal((await flushing).saved, true);
  assert.equal(t.server.project.name, 'Renamed cut');
  t.session.rename('Renamed again');
  const second = t.session.flush();
  assert.equal(t.server.calls[1].payload.expectedUpdated, 'v1');
  t.server.accept(1);
  assert.equal((await second).saved, true);
});

test('concurrent flushes share one write instead of double-saving', async () => {
  const t = setup();
  t.session.record(withCaption('once'), 'Cut');
  const a = t.session.flush();
  const b = t.session.flush();
  assert.equal(a, b);
  assert.equal(t.server.calls.length, 1);
  t.server.accept(0);
  assert.equal((await a).saved, true);
  assert.equal(t.server.calls.length, 1);
});

test('a failed save keeps the draft and dirty state, and the next flush retries', async () => {
  const t = setup();
  t.session.record(withCaption('kept'), 'Cut');
  const flushing = t.session.flush();
  t.server.fail(0, new Error('Network down'));
  const result = await flushing;

  assert.equal(result.saved, false);
  assert.equal(result.conflict, false);
  assert.match(result.error.message, /Network down/);
  assert.equal(t.snap().status, 'Save failed');
  assert.equal(t.snap().dirty, true);
  assert.equal(t.server.project.data.captions.length, 0);
  const draft = readRecovery(t.storage, 'user-1', 'project-1');
  assert.equal(draft.data.captions[0].text, 'kept');

  const retry = t.session.flush();
  assert.equal(t.server.calls.length, 2);
  assert.equal(t.server.calls[1].payload.expectedUpdated, 'v0');
  t.server.accept(1);
  assert.equal((await retry).saved, true);
  assert.equal(t.snap().status, 'Saved');
  assert.equal(t.server.project.data.captions[0].text, 'kept');
  assert.equal(readRecovery(t.storage, 'user-1', 'project-1'), null);
});

test('unavailable recovery storage is reported without discarding unsaved work', async () => {
  const t = setup({ storage: memoryStorage({ failWrites: true }) });
  t.session.record(withCaption('unsaved'), 'Cut');
  assert.match(t.snap().warning, /recovery copy/);
  assert.equal(t.snap().dirty, true);

  const flushing = t.session.flush();
  t.server.accept(0);
  assert.equal((await flushing).saved, true);
  assert.equal(t.snap().status, 'Saved');
  assert.equal(t.server.project.data.captions[0].text, 'unsaved');
});

test('a stale revision is rejected without overwriting the newer project and is not retried', async () => {
  const t = setup();
  t.server.project = { updated: 'v9', name: 'Cut', data: withCaption('elsewhere') };

  t.session.record(withCaption('mine'), 'Cut');
  const flushing = t.session.flush();
  t.server.fail(0, Object.assign(new Error('This project changed elsewhere.'), { status: 409 }));
  const result = await flushing;

  assert.equal(result.saved, false);
  assert.equal(result.conflict, true);
  assert.equal(t.snap().conflict, true);
  assert.equal(t.snap().status, 'Save failed');
  assert.equal(t.snap().dirty, true);

  const draft = readRecovery(t.storage, 'user-1', 'project-1');
  assert.equal(draft.data.captions[0].text, 'mine');
  assert.equal(draft.baseUpdated, 'v0');

  const again = await t.session.flush();
  assert.equal(again.conflict, true);
  assert.equal(t.server.calls.length, 1, 'a stale session does not send another overwrite');
  assert.equal(t.server.project.data.captions[0].text, 'elsewhere');

  assert.equal(recoveryDisposition(draft, t.server.project), 'conflict');
});

test('restoring a draft rebases it on the saved revision, writes it and clears the record', async () => {
  const t = setup();
  writeRecovery(t.storage, 'user-1', 'project-1', 'Recovered name', withCaption('restored'), 'v0');
  const draft = readRecovery(t.storage, 'user-1', 'project-1');
  assert.equal(recoveryDisposition(draft, { ...t.server.project, data: baseProject(), updated: 'v3' }), 'conflict');

  t.session.reset({ updated: 'v3', data: baseProject(), name: 'Cut' });
  t.session.restore({ data: draft.data, name: draft.name, updated: 'v3' });
  assert.equal(t.snap().status, 'Unsaved changes');
  assert.equal(t.snap().dirty, true);

  const flushing = t.session.flush();
  assert.equal(t.server.calls[0].payload.expectedUpdated, 'v3', 'the restore supersedes the current saved revision, not the stale draft base');
  assert.equal(t.server.calls[0].payload.name, 'Recovered name');
  assert.equal(t.server.calls[0].payload.data.captions[0].text, 'restored');
  t.server.accept(0);
  assert.equal((await flushing).saved, true);
  assert.equal(t.snap().status, 'Saved');
  assert.equal(readRecovery(t.storage, 'user-1', 'project-1'), null);
});

test('discarding a draft leaves the saved project untouched and writes nothing', async () => {
  const t = setup();
  writeRecovery(t.storage, 'user-1', 'project-1', 'Cut', withCaption('draft'), 'v0');
  assert.equal(recoveryDisposition(readRecovery(t.storage, 'user-1', 'project-1'), { ...t.server.project, data: baseProject(), updated: 'v0' }), 'available');

  removeRecovery(t.storage, 'user-1', 'project-1');

  assert.equal(readRecovery(t.storage, 'user-1', 'project-1'), null);
  assert.equal(t.server.calls.length, 0);
  assert.equal(t.server.project.data.captions.length, 0);
  assert.equal(recoveryDisposition(readRecovery(t.storage, 'user-1', 'project-1'), t.server.project), 'none');
});

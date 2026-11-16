import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crc32, zipChunks, zipSize, zipBlob } from '../src/editor/zip.js';
import { assemblePackage, captionSrt, describePackage, formatBytes, safeFileName, srtStamp } from '../src/editor/package.js';
import { advance, canTransition, createJob, drainQueue, queueKey, readQueue, writeQueue } from '../src/editor/queue.js';
import { createProject, appendAsset, placeClip } from '../src/editor/model.js';

const bytesOf = async (stream) => {
  const parts = [];
  for await (const chunk of stream) parts.push(chunk);
  return Buffer.concat(parts.map(part => Buffer.from(part)));
};

const projectWith = (assets = [{ id: 'a', name: 'B-Roll Final.MP4', frames: 300, size: 1024, mime: 'video/mp4' }]) => {
  let project = createProject();
  for (const asset of assets) project = appendAsset(project, asset);
  return placeClip(project, assets[0].id, 'clip-1');
};

test('crc32 matches the standard check value', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

test('zip stream writes a readable archive and exact size', async () => {
  const entries = [
    { name: 'project.json', blob: new Blob(['{"a":1}']) },
    { name: 'media/one.mp4', blob: new Blob([new Uint8Array([1, 2, 3, 4, 5])]) },
  ];
  const archive = await bytesOf(zipChunks(entries));
  assert.equal(archive.length, zipSize(entries));
  assert.equal(archive.readUInt32LE(0), 0x04034b50);
  const end = archive.length - 22;
  assert.equal(archive.readUInt32LE(end), 0x06054b50);
  assert.equal(archive.readUInt16LE(end + 8), 2);
  assert.equal(archive.readUInt16LE(end + 10), 2);
  const directoryOffset = archive.readUInt32LE(end + 16);
  assert.equal(archive.readUInt32LE(directoryOffset), 0x02014b50);
  assert.ok(archive.includes(Buffer.from('project.json')));
  // Stored (uncompressed) payload is present verbatim between descriptor fields.
  assert.ok(archive.includes(Buffer.from([1, 2, 3, 4, 5])));
  const blob = await zipBlob(entries);
  assert.equal(blob.size, zipSize(entries));
});

test('zip progress reports real byte counts', async () => {
  const entries = [{ name: 'big.bin', blob: new Blob([new Uint8Array(4096)]) }];
  const seen = [];
  const blob = await zipBlob(entries, (ratio, bytes) => seen.push([ratio, bytes]));
  assert.equal(seen.at(-1)[0], 1);
  assert.equal(seen.at(-1)[1], zipSize(entries));
  assert.equal(blob.size, zipSize(entries));
});

test('captions convert to ordered, padded SRT', () => {
  const project = projectWith();
  project.captions = [
    { id: 'c2', text: 'Second line', start: 45, duration: 30 },
    { id: 'c1', text: 'First line', start: 0, duration: 15 },
  ];
  assert.equal(srtStamp(0, 30), '00:00:00,000');
  assert.equal(srtStamp(45, 30), '00:00:01,500');
  const srt = captionSrt(project);
  assert.ok(srt.startsWith('1\n00:00:00,000 --> 00:00:00,500\nFirst line\n'));
  assert.ok(srt.includes('2\n00:00:01,500 --> 00:00:02,500\nSecond line\n'));
});

test('package description respects scope and reports missing sources', () => {
  const project = projectWith([
    { id: 'a', name: 'B-Roll Final.MP4', frames: 300, size: 1024, mime: 'video/mp4' },
    { id: 'b', name: 'Unused Clip.mov', frames: 120, size: 2048, mime: 'video/quicktime' },
  ]);
  const timeline = describePackage(project, { name: 'My Spot', scope: 'timeline', missing: ['a'] });
  assert.deepEqual(timeline.entries.map(entry => entry.name), [
    'project.json',
    'media/b-roll-final-a.mp4',
    'manifest.json',
  ]);
  assert.equal(timeline.entries[1].available, false);
  assert.equal(timeline.omitted.length, 1);
  assert.equal(timeline.fileName.startsWith('my-spot-'), true);
  assert.ok(timeline.fileName.endsWith('.zip'));
  const all = describePackage(project, { name: 'My Spot', scope: 'all' });
  assert.equal(all.entries.filter(entry => entry.kind === 'media').length, 2);
  const manifest = JSON.parse(all.entries.at(-1).text);
  assert.equal(manifest.files.some(file => file.file === 'media/unused-clip-b.mov'), true);
  assert.equal(manifest.note.includes('No rendered video'), true);
});

test('assembled packages skip media this browser cannot read', async () => {
  const project = projectWith([
    { id: 'a', name: 'one.mp4', frames: 300, size: 10, mime: 'video/mp4' },
    { id: 'b', name: 'two.mp4', frames: 300, size: 20, mime: 'video/mp4' },
  ]);
  project.clips = [...project.clips, { id: 'clip-2', assetId: 'b', start: 300, sourceIn: 0, duration: 300 }];
  const { entries, description } = await assemblePackage(project, {
    name: 'Two Clips', scope: 'timeline',
    loadAsset: async id => (id === 'a' ? null : new Blob([new Uint8Array(10)])),
  });
  assert.deepEqual(entries.map(entry => entry.name), ['project.json', 'media/two-b.mp4', 'manifest.json']);
  assert.deepEqual(description.omitted.map(entry => entry.label), ['one.mp4']);
  assert.equal(description.entries.find(entry => entry.name.includes('one-a')).available, false);
  assert.equal(entries.find(entry => entry.name === 'manifest.json').blob.type, 'application/json');
  assert.equal(safeFileName('  A/B: weird*name?.mp4'), 'b-weirdname');
  assert.equal(formatBytes(1536), '1.5 KB');
});

test('queue enforces real state transitions and persistence', () => {
  const storage = (() => { const map = new Map(); return { setItem: (k, v) => map.set(k, v), getItem: k => map.get(k) ?? null, removeItem: k => map.delete(k) }; })();
  const job = createJob({ snapshot: createProject(), name: 'Spot', now: () => new Date('2026-01-01T00:00:00Z') });
  assert.equal(job.state, 'queued');
  assert.equal(canTransition('queued', 'running'), true);
  assert.equal(canTransition('done', 'running'), false);
  const running = advance(job, 'running');
  assert.equal(running.state, 'running');
  assert.throws(() => advance(running, 'queued'));
  const done = advance(running, 'done', { bytes: 2048, packageName: 'spot.zip' });
  assert.equal(done.progress, 1);
  writeQueue(storage, 'u', 'p', [done]);
  assert.equal(readQueue(storage, 'u', 'p').length, 1);
  assert.equal(readQueue(storage, 'other', 'p').length, 0);
  storage.setItem(queueKey('u', 'p'), '[{"bad":true}]');
  assert.deepEqual(readQueue(storage, 'u', 'p'), []);
});

test('drainQueue runs jobs one at a time and records failures', async () => {
  const jobs = [
    createJob({ snapshot: createProject(), name: 'First' }),
    createJob({ snapshot: createProject(), name: 'Second' }),
    createJob({ snapshot: createProject(), name: 'Broken' }),
  ];
  const order = [];
  const final = await drainQueue({
    jobs,
    run: async (job, report) => {
      order.push(job.label);
      report(0.5);
      if (job.label.includes('Broken')) throw new Error('Media is unavailable');
      return { bytes: 10, packageName: `${job.id}.zip` };
    },
    onChange: () => {},
  });
  assert.deepEqual(order, ['Package First', 'Package Second', 'Package Broken']);
  assert.deepEqual(final.map(job => job.state), ['done', 'done', 'failed']);
  assert.equal(final[2].error, 'Media is unavailable');
  assert.equal(final[0].bytes, 10);
});

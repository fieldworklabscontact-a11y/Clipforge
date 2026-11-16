import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createBatchStore } from '../server/batch/schema.js';
import { createQueue } from '../server/batch/queue.js';
import {
  captionsForSegment, configHash, equalSegments, findOverlaps, mergeProfile, normalizeProfile,
  parseSrt, segmentSeconds, toSrt, validateBounds, DEFAULT_PROFILE,
} from '../server/batch/domain.js';
import { validateZip, writeZip } from '../server/batch/zip.js';
import { buildAudioFilter, buildVideoFilter, parseRate } from '../server/batch/media.js';

const wait = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms));

test('equal segmentation respects duration, overlap, minimum and short-tail policy', () => {
  const list = equalSegments({ totalFrames: 3000, fpsNum: 30, fpsDen: 1, targetSeconds: 5, overlapSeconds: 1 });
  assert.equal(list.length, 25);
  assert.deepEqual([list[0].startFrame, list[0].endFrame], [0, 150]);
  assert.deepEqual([list[1].startFrame, list[1].endFrame], [120, 270]);
  assert.equal(findOverlaps(list).length, 24, 'overlap is reported, not silently ignored');

  const noOverlap = equalSegments({ totalFrames: 3000, fpsNum: 30, fpsDen: 1, targetSeconds: 5 });
  assert.equal(noOverlap.length, 20);
  assert.equal(findOverlaps(noOverlap).length, 0);

  const dropTail = equalSegments({ totalFrames: 3100, fpsNum: 30, fpsDen: 1, targetSeconds: 5, minSeconds: 4, shortFinal: 'drop' });
  assert.equal(dropTail.at(-1).endFrame, 3000);
  const mergeTail = equalSegments({ totalFrames: 3100, fpsNum: 30, fpsDen: 1, targetSeconds: 5, minSeconds: 4, shortFinal: 'merge' });
  assert.equal(mergeTail.at(-1).endFrame, 3100);
  assert.equal(mergeTail.length, dropTail.length);
  const keepTail = equalSegments({ totalFrames: 3100, fpsNum: 30, fpsDen: 1, targetSeconds: 5, minSeconds: 4, shortFinal: 'keep' });
  assert.equal(keepTail.length, 21);
  assert.equal(keepTail.at(-1).endFrame, 3100);

  assert.throws(() => equalSegments({ totalFrames: 300, fpsNum: 30, fpsDen: 1, targetSeconds: 0 }), /greater than zero/);
  assert.throws(() => equalSegments({ totalFrames: 300, fpsNum: 30, fpsDen: 1, targetSeconds: 5, overlapSeconds: 5 }), /Overlap/);
  assert.throws(() => equalSegments({ totalFrames: 300, fpsNum: 30, fpsDen: 1, targetSeconds: 5, minSeconds: 6 }), /Minimum/);
});

test('segment bounds and frame/second conversion are validated, not guessed', () => {
  assert.throws(() => validateBounds({ startFrame: -1, endFrame: 10, totalFrames: 100 }), /before the source/);
  assert.throws(() => validateBounds({ startFrame: 10, endFrame: 10, totalFrames: 100 }), /end after it starts/);
  assert.throws(() => validateBounds({ startFrame: 0, endFrame: 101, totalFrames: 100 }), /after the source ends/);
  assert.throws(() => validateBounds({ startFrame: 0.5, endFrame: 10, totalFrames: 100 }), /whole frames/);
  const timing = segmentSeconds({ startFrame: 30, endFrame: 120 }, 30000, 1001);
  assert.ok(Math.abs(timing.start - 1.001) < 0.001);
  assert.ok(Math.abs(timing.duration - 3.003) < 0.001);
  assert.deepEqual(parseRate('30000/1001'), { num: 30000, den: 1001, fps: 30000 / 1001 });
  assert.equal(parseRate('0/0'), null);
  assert.equal(parseRate('abc'), null);
});

test('source transcript cues become clip-relative captions, clipped to the clip', () => {
  const entries = [
    { startMs: 0, endMs: 2000, text: 'Before the clip' },
    { startMs: 1500, endMs: 3200, text: 'Crossing the in point' },
    { startMs: 4500, endMs: 5200, text: 'Inside the clip' },
    { startMs: 6500, endMs: 7000, text: 'Past the out point' },
  ];
  const captions = captionsForSegment(entries, { startFrame: 60, endFrame: 180, fpsNum: 30, fpsDen: 1, group: 'phrase' });
  assert.equal(captions.length, 2);
  assert.deepEqual(captions.map(entry => entry.text), ['Crossing the in point', 'Inside the clip']);
  assert.equal(captions[0].startMs, 0, 'an entry starting before the clip begins at clip time zero');
  assert.equal(captions[0].endMs, 1200);
  assert.ok(captions.every(entry => entry.startMs >= 0 && entry.endMs <= 4000));
  assert.deepEqual(captionsForSegment(entries, { startFrame: 300, endFrame: 330, fpsNum: 30, fpsDen: 1 }), []);

  const words = captionsForSegment([{ startMs: 1000, endMs: 3000, text: 'one two', words: [{ text: 'one', startMs: 1000, endMs: 1800 }, { text: 'two', startMs: 2000, endMs: 2800 }] }],
    { startFrame: 30, endFrame: 120, fpsNum: 30, fpsDen: 1, group: 'word' });
  assert.deepEqual(words.map(entry => entry.text), ['one', 'two']);
});

test('subtitles round-trip through SRT and reject unusable files', () => {
  const entries = [{ startMs: 500, endMs: 2500, text: 'Hello' }, { startMs: 3600000, endMs: 3601500, text: 'Later' }];
  const srt = toSrt(entries);
  assert.match(srt, /00:00:00,500 --> 00:00:02,500/);
  assert.match(srt, /01:00:00,000/);
  assert.deepEqual(parseSrt(srt).map(entry => entry.text), ['Hello', 'Later']);
  assert.throws(() => parseSrt('not a subtitle'), /No usable subtitle cues/);
});

test('profiles are normalised and configuration hashes change only with render-relevant data', () => {
  const profile = normalizeProfile({ video: { width: 99999, height: 10, crf: 99 }, captions: { color: 'red', size: -5 }, audio: { volume: 9 } });
  assert.equal(profile.video.width, 3840);
  assert.equal(profile.video.height, 16);
  assert.equal(profile.video.crf, 51);
  assert.equal(profile.captions.color, '#ffffff');
  assert.equal(profile.captions.size, 12);
  assert.equal(profile.audio.volume, 4);
  const merged = mergeProfile(DEFAULT_PROFILE, { video: { width: 720 }, captions: { size: 60 } });
  assert.equal(merged.video.width, 720);
  assert.equal(merged.captions.size, 60);
  assert.equal(merged.video.height, DEFAULT_PROFILE.video.height);
  const a = configHash({ video: { width: 720, height: 1280 }, captions: [] });
  const b = configHash({ captions: [], video: { height: 1280, width: 720 } });
  assert.equal(a, b, 'hashing is key-order independent');
  assert.notEqual(a, configHash({ video: { width: 721, height: 1280 }, captions: [] }));
  const filter = buildVideoFilter({ width: 720, height: 1280, fit: 'cover', x: 0.5, y: 0.5, captionsPath: '/tmp/a.srt', style: { ...DEFAULT_PROFILE.captions, size: 42 } });
  assert.match(filter, /scale=720:1280/);
  assert.match(filter, /subtitles=filename=\/tmp\/a\.srt/);
  assert.match(buildAudioFilter({ volume: 0.5, fadeInMs: 200, fadeOutMs: 500 }, 4), /volume=0.5.*afade=t=in.*afade=t=out/);
});

test('zip writer and validator agree on contents and detect a tampered archive', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'clipforge-zip-'));
  try {
    const a = path.join(dir, 'a.txt'); const b = path.join(dir, 'b.txt');
    writeFileSync(a, 'alpha'); writeFileSync(b, 'beta');
    const zip = path.join(dir, 'out.zip');
    await writeZip(zip, [{ name: 'ClipForge_Batch/videos/a.mp4', path: a }, { name: 'ClipForge_Batch/manifest.json', path: b }]);
    const ok = validateZip(zip, ['ClipForge_Batch/videos/a.mp4', 'ClipForge_Batch/manifest.json']);
    assert.equal(ok.ok, true, ok.problems.join(' '));
    assert.equal(ok.names.length, 2);
    const missing = validateZip(zip, ['ClipForge_Batch/other.mp4']);
    assert.equal(missing.ok, false);
    const tampered = path.join(dir, 'bad.zip');
    writeFileSync(tampered, readFileSync(zip).subarray(0, 40));
    assert.equal(validateZip(tampered).ok, false);
    await assert.rejects(writeZip(path.join(dir, 'x.zip'), [{ name: 'gone.txt', path: path.join(dir, 'gone.txt') }]), /missing/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

function memoryStore() {
  const db = new DatabaseSync(':memory:');
  return createBatchStore(db);
}

function seed(store, userId = 'u1') {
  const batch = store.createBatch(userId, 'Queue batch');
  const profile = store.createProfile(userId, 'Profile', DEFAULT_PROFILE);
  store.updateBatch(batch.id, { profileId: profile.id });
  const source = store.saveSource(batch.id, userId, {
    filename: 'source.mp4', path: '/tmp/does-not-matter.mp4', size: 10, duration: 10,
    width: 640, height: 360, fpsNum: 30, fpsDen: 1, frames: 300, videoCodec: 'h264', audioCodec: 'aac', audioStreams: 1,
  });
  return { batch: store.getBatch(userId, batch.id), source, profile };
}

test('queue bounds concurrency, isolates failures, and retries only failed jobs', async () => {
  const store = memoryStore();
  const { batch, source } = seed(store);
  const segments = [];
  for (let index = 0; index < 5; index += 1) {
    const segment = store.addSegment(batch.id, source.id, { name: `Clip ${index}`, startFrame: index * 20, endFrame: index * 20 + 20, approval: 'approved' });
    segments.push(segment);
  }
  let running = 0; let maxRunning = 0; const attempts = new Map();
  const renderer = {
    async execute(job) {
      running += 1; maxRunning = Math.max(maxRunning, running);
      attempts.set(job.segmentId, (attempts.get(job.segmentId) || 0) + 1);
      await wait(25);
      running -= 1;
      if (job.segmentId === segments[2].id && attempts.get(job.segmentId) === 1) {
        store.updateJob(job.id, { state: 'failed', error: 'Encoder exploded.' });
        throw new Error('Encoder exploded.');
      }
      store.updateJob(job.id, { state: 'completed', progress: 1 });
    },
  };
  const queue = createQueue({ store, renderer, concurrency: 2 });
  for (const segment of segments) store.createJob({ batchId: batch.id, segmentId: segment.id, userId: 'u1', config: {}, configVersion: 'v1' });
  queue.schedule();
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const jobs = store.listJobs(batch.id);
    if (jobs.every(job => ['completed', 'failed', 'cancelled'].includes(job.state))) break;
    await wait(20);
  }
  const jobs = store.listJobs(batch.id);
  assert.equal(maxRunning, 2, 'never more than the configured concurrency');
  assert.equal(jobs.filter(job => job.state === 'completed').length, 4);
  assert.equal(jobs.filter(job => job.state === 'failed').length, 1);

  const failed = jobs.find(job => job.state === 'failed');
  assert.match(failed.error, /Encoder exploded/);
  const result = queue.retry(failed.id);
  assert.equal(result.job.state, 'waiting');
  assert.equal(result.job.retries, 1);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (store.getJob(failed.id).state === 'completed') break;
    await wait(20);
  }
  assert.equal(store.getJob(failed.id).state, 'completed');
  assert.equal(attempts.get(segments[2].id), 2, 'only the failed clip was re-rendered');
  assert.equal(attempts.get(segments[0].id), 1);
  assert.equal(queue.retry(failed.id).error, 'Only failed or cancelled jobs can be retried.');
});

test('paused batches stop starting jobs and cancellation is recorded', async () => {
  const store = memoryStore();
  const { batch, source } = seed(store);
  const first = store.addSegment(batch.id, source.id, { name: 'A', startFrame: 0, endFrame: 30, approval: 'approved' });
  const second = store.addSegment(batch.id, source.id, { name: 'B', startFrame: 30, endFrame: 60, approval: 'approved' });
  const started = [];
  const renderer = { async execute(job, { signal }) { started.push(job.id); await new Promise((resolve, reject) => { const timer = setTimeout(resolve, 120); signal?.addEventListener('abort', () => { clearTimeout(timer); reject(Object.assign(new Error('cancelled'), { cancelled: true })); }); }); store.updateJob(job.id, { state: 'completed' }); } };
  const queue = createQueue({ store, renderer, concurrency: 1 });
  queue.pause(batch.id);
  const jobA = store.createJob({ batchId: batch.id, segmentId: first.id, userId: 'u1', config: {}, configVersion: 'v1' });
  const jobB = store.createJob({ batchId: batch.id, segmentId: second.id, userId: 'u1', config: {}, configVersion: 'v1' });
  queue.schedule();
  await wait(60);
  assert.equal(started.length, 0, 'a paused batch starts nothing');
  assert.equal(store.getBatchById(batch.id).paused, true);

  queue.resume(batch.id);
  await wait(60);
  assert.equal(started.length, 1);
  queue.cancel(jobA.id);
  await wait(250);
  assert.equal(store.getJob(jobA.id).state, 'cancelled');
  assert.equal(store.getJob(jobB.id).state, 'completed');
});

test('restart recovery requeues interrupted jobs and keeps validated output', async () => {
  const store = memoryStore();
  const { batch, source } = seed(store);
  const interrupted = store.addSegment(batch.id, source.id, { name: 'Interrupted', startFrame: 0, endFrame: 30, approval: 'approved' });
  const finished = store.addSegment(batch.id, source.id, { name: 'Finished', startFrame: 30, endFrame: 60, approval: 'approved' });
  const dir = mkdtempSync(path.join(tmpdir(), 'clipforge-recover-'));
  try {
    const outputFile = path.join(dir, 'done.mp4');
    writeFileSync(outputFile, Buffer.alloc(1024));
    const doneJob = store.createJob({ batchId: batch.id, segmentId: finished.id, userId: 'u1', config: {}, configVersion: 'v1', state: 'rendering' });
    const output = store.createOutput({
      jobId: doneJob.id, segmentId: finished.id, batchId: batch.id, path: outputFile, filename: 'done.mp4',
      size: 1024, duration: 1, width: 640, height: 360, fpsNum: 30, fpsDen: 1, videoCodec: 'h264', audioCodec: null, configHash: 'v1',
    });
    store.updateJob(doneJob.id, { outputId: output.id });
    const pendingJob = store.createJob({ batchId: batch.id, segmentId: interrupted.id, userId: 'u1', config: {}, configVersion: 'v1', state: 'rendering' });

    const rendered = [];
    const queue = createQueue({ store, renderer: { cleanTemporaryFiles() {}, async execute(job) { rendered.push(job.segmentId); store.updateJob(job.id, { state: 'completed' }); } }, concurrency: 1 });
    const touched = queue.recover();
    assert.equal(touched, 1);
    assert.equal(store.getJob(doneJob.id).state, 'completed', 'validated output survives the restart');
    assert.equal(store.getJob(pendingJob.id).state === 'waiting' || rendered.includes(interrupted.id), true);
    for (let attempt = 0; attempt < 60; attempt += 1) { if (store.getJob(pendingJob.id).state === 'completed') break; await wait(20); }
    assert.equal(store.getJob(pendingJob.id).state, 'completed');
    assert.deepEqual(rendered, [interrupted.id], 'completed work is not re-rendered');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('batch storage persists segments, approval and captions across store instances', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'clipforge-store-'));
  try {
    const file = path.join(dir, 'batch.sqlite');
    const first = createBatchStore(new DatabaseSync(file));
    const { batch, source } = seed(first);
    const segment = first.addSegment(batch.id, source.id, { name: 'Persisted', startFrame: 0, endFrame: 45, approval: 'approved' });
    first.setTranscript(source.id, [{ startMs: 0, endMs: 1000, text: 'Hi' }]);
    first.setCaptions(segment.id, [{ startMs: 0, endMs: 900, text: 'Hello' }], 'edited');
    first.updateSegment(segment.id, { renderState: 'ready', configHash: 'abc' });

    const second = createBatchStore(new DatabaseSync(file));
    const reloaded = second.getBatch('u1', batch.id);
    assert.equal(reloaded.name, 'Queue batch');
    assert.equal(second.listSegments(batch.id)[0].approval, 'approved');
    assert.equal(second.listSegments(batch.id)[0].configHash, 'abc');
    assert.equal(second.getCaptions(segment.id).mode, 'edited');
    assert.equal(second.listTranscript(source.id).length, 1);
    assert.equal(second.listSegments(batch.id)[0].durationFrames, 45);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

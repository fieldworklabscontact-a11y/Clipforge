import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createBatchStore } from '../server/batch/schema.js';
import { createRenderer } from '../server/batch/render.js';
import { captionsForSegment, normalizeProfile, segmentSeconds, toAss } from '../server/batch/domain.js';
import { probe, renderClip, toolPaths, toolsAvailable, validateOutput } from '../server/batch/media.js';

const available = toolsAvailable();
const skip = available ? false : 'ffmpeg/ffprobe are not available in this environment';

/** Mean luma of the bottom band, used to prove burned captions changed pixels. */
function bandLuma(file, filter) {
  const { ffmpeg } = toolPaths();
  const result = spawnSync(ffmpeg, ['-hide_banner', '-ss', '0.6', '-i', file, '-vf', `${filter},format=gray,signalstats,metadata=print:key=lavfi.signalstats.YAVG`, '-frames:v', '3', '-f', 'null', '-'], { encoding: 'utf8' });
  const match = /YAVG=([0-9.]+)/.exec(result.stderr || '');
  return match ? Number(match[1]) : null;
}

test('a real render produces a validated clip and burned captions change the picture', { skip }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'clipforge-render-'));
  try {
    const { ffmpeg } = toolPaths();
    const source = path.join(dir, 'source.mp4');
    const made = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=320x240:r=30:d=3', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', source]);
    assert.equal(made.status, 0, String(made.stderr));
    const info = await probe(source);
    assert.equal(info.width, 320);
    assert.ok(info.frames >= 85 && info.frames <= 95);

    const profile = normalizeProfile({ video: { width: 240, height: 320, crf: 30 }, captions: { enabled: true, font: 'Anton', size: 70, position: 'center', color: '#ffffff', outline: '#000000', outlineWidth: 2 } });
    const srt = path.join(dir, 'captions.ass');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(srt, toAss([{ startMs: 200, endMs: 1800, text: 'BIG CAPTION' }], profile.captions, { width: 240, height: 320 }));
    const withCaptions = path.join(dir, 'with.mp4');
    const withoutCaptions = path.join(dir, 'without.mp4');
    await renderClip({ sourcePath: source, startSeconds: 0, durationSeconds: 2, profile, captionsPath: srt, outputPath: withCaptions });
    await renderClip({ sourcePath: source, startSeconds: 0, durationSeconds: 2, profile, captionsPath: null, outputPath: withoutCaptions });

    const validation = await validateOutput(withCaptions, { duration: 2, width: 240, height: 320, expectAudio: true });
    assert.equal(validation.ok, true, validation.problems.join(' '));
    assert.equal(validation.info.width, 240);
    assert.equal(validation.info.height, 320);
    assert.ok(Math.abs(validation.info.duration - 2) < 0.4);
    assert.equal(validation.info.audioCodec !== null, true);

    const captionLuma = bandLuma(withCaptions, 'null');
    const plainLuma = bandLuma(withoutCaptions, 'null');
    assert.ok(captionLuma !== null && plainLuma !== null);
    assert.ok(captionLuma > plainLuma + 0.5, `captions must render pixels (with ${captionLuma}, without ${plainLuma})`);

    const short = await validateOutput(withCaptions, { duration: 8, width: 240, height: 320, expectAudio: true });
    assert.equal(short.ok, false, 'a duration mismatch must fail validation');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the renderer runs a queued segment through every stage and records validated output', { skip }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'clipforge-engine-'));
  try {
    const { ffmpeg } = toolPaths();
    const sourceFile = path.join(dir, 'source.mp4');
    spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=navy:s=320x240:r=30:d=4', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=4', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', sourceFile]);

    const store = createBatchStore(new DatabaseSync(path.join(dir, 'db.sqlite')));
    const renderer = createRenderer({ store, rootDir: dir });
    const batch = store.createBatch('u1', 'Engine batch');
    const profile = store.createProfile('u1', 'Profile', normalizeProfile({ video: { width: 160, height: 240, crf: 30 }, audio: { volume: 0.8 } }));
    store.updateBatch(batch.id, { profileId: profile.id });
    const source = store.saveSource(batch.id, 'u1', { filename: 'source.mp4', path: sourceFile, size: 100, ...await probe(sourceFile) });
    const segment = store.addSegment(batch.id, source.id, { name: 'Engine clip', startFrame: 0, endFrame: 60, approval: 'approved' });
    const transcript = [{ startMs: 0, endMs: 1200, text: 'Rendered caption' }];
    store.setTranscript(source.id, transcript);
    store.setCaptions(segment.id, captionsForSegment(transcript, { startFrame: 0, endFrame: 60, fpsNum: source.fpsNum, fpsDen: source.fpsDen }), 'generated');

    const resolved = renderer.resolve({ batch: store.getBatch('u1', batch.id), source: store.getSource(batch.id), segment: store.getSegment(segment.id) });
    const job = store.createJob({ batchId: batch.id, segmentId: segment.id, userId: 'u1', config: resolved.config, configVersion: resolved.version });
    const progress = [];
    const output = await renderer.execute(job, { onProgress: ratio => progress.push(ratio) });

    assert.ok(existsSync(output.path));
    assert.equal(output.validated, true);
    assert.equal(output.width, 160);
    assert.equal(output.height, 240);
    assert.equal(store.getJob(job.id).state, 'completed');
    assert.equal(store.getSegment(segment.id).renderState, 'ready');
    assert.equal(store.getSegment(segment.id).configHash, resolved.version);
    assert.ok(progress.length >= 1);

    const timing = segmentSeconds(store.getSegment(segment.id), source.fpsNum, source.fpsDen);
    assert.ok(Math.abs(output.duration - timing.duration) < 0.4);

    // Changing boundaries invalidates the stored configuration version.
    const edited = store.updateSegment(segment.id, { endFrame: 30, approval: 'pending', renderState: 'stale' });
    const after = renderer.resolve({ batch: store.getBatch('u1', batch.id), source: store.getSource(batch.id), segment: edited });
    assert.notEqual(after.version, resolved.version, 'a trimmed clip must not reuse the previous render');

    // A missing source fails loudly instead of producing an empty clip.
    store.clearSource(batch.id);
    const failing = store.createJob({ batchId: batch.id, segmentId: segment.id, userId: 'u1', config: resolved.config, configVersion: resolved.version });
    await assert.rejects(renderer.execute(failing, {}), /no source video|approved|missing/i);
    assert.equal(store.getJob(failing.id).state, 'failed');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

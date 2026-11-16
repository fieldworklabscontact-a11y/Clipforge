import { existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_PROFILE, captionsForSegment, configHash, mergeProfile, segmentSeconds, toAss } from './domain.js';
import { makeThumbnail, probe, renderClip, sourceFingerprint, validateOutput } from './media.js';

const safeFile = (name, fallback) => {
  const cleaned = String(name || '').replace(/[^a-z0-9 _-]/gi, '').trim().replace(/\s+/g, '_');
  return (cleaned || fallback).slice(0, 60);
};
export const clipFileName = (segment) => `Clip_${String(segment.ordinal + 1).padStart(3, '0')}`;

/** `Clip_004_Hook` rather than `Clip_004_Clip_004` when a clip keeps its default name. */
export const outputBase = (segment) => {
  const label = clipFileName(segment);
  const slug = safeFile(segment.name, 'clip');
  return !slug || slug === label ? label : `${label}_${slug}`;
};

/**
 * Prepares and executes render jobs. Everything a job needs is snapshotted into
 * its configuration, so editing a profile or segment later cannot change work
 * that is already in flight.
 */
export function createRenderer({ store, rootDir }) {
  const batchRoot = batchId => path.join(rootDir, batchId);

  function resolve({ batch, source, segment }) {
    const profileRow = segment.profileId ? store.getProfile(segment.profileId) : (batch.profileId ? store.getProfile(batch.profileId) : null);
    const profile = mergeProfile((profileRow?.settings || DEFAULT_PROFILE), segment.overrides);
    const captions = store.getCaptions(segment.id);
    const timing = segmentSeconds(segment, source.fpsNum, source.fpsDen);
    const config = {
      segmentId: segment.id, batchId: batch.id, sourceId: source.id,
      sourcePath: source.path, sourceFingerprint: sourceFingerprint(source.path),
      startFrame: segment.startFrame, endFrame: segment.endFrame,
      fpsNum: source.fpsNum, fpsDen: source.fpsDen,
      startSeconds: timing.start, durationSeconds: timing.duration,
      expectAudio: source.audioStreams > 0,
      profile,
      captions: captions.entries,
      captionMode: captions.mode,
      name: segment.name,
      ordinal: segment.ordinal,
      fileName: `${outputBase(segment)}.mp4`,
    };
    return { config, version: configHash(config) };
  }

  /** Current configuration version for a saved segment, used to detect stale output. */
  function currentVersion({ batch, source, segment }) {
    return resolve({ batch, source, segment }).version;
  }

  async function execute(job, { signal, onProgress } = {}) {
    const batch = store.getBatch(job.userId, job.batchId);
    const source = batch ? store.getSource(batch.id) : null;
    const segment = store.getSegment(job.segmentId);
    const tmpDir = batch ? path.join(batchRoot(batch.id), 'tmp', job.id) : null;
    if (tmpDir) mkdirSync(tmpDir, { recursive: true });
    const tmpOutput = tmpDir ? path.join(tmpDir, 'render.mp4') : null;
    const finalOutput = batch ? path.join(batchRoot(batch.id), 'outputs', `${job.id}.mp4`) : null;

    try {
      if (!batch) throw new Error('The batch no longer exists.');
      if (!source) throw new Error('The batch has no source video. Import the source again.');
      if (!segment) throw new Error('The segment no longer exists.');
      if (segment.approval !== 'approved') throw new Error('This segment is not approved, so it cannot be rendered.');
      if (!existsSync(source.path)) throw new Error('The source file is missing from storage.');
      mkdirSync(path.join(batchRoot(batch.id), 'outputs'), { recursive: true });
      const snapshot = job.config || resolve({ batch, source, segment }).config;
      if (snapshot.sourceFingerprint && snapshot.sourceFingerprint !== sourceFingerprint(source.path)) {
        throw new Error('The source video changed after this job was queued. Queue the clip again.');
      }
      store.updateJob(job.id, { state: 'preparing', stage: 'Resolving source and settings', started: new Date().toISOString(), progress: 0, error: null });
      let captionsPath = null;
      if (snapshot.profile.captions.enabled && snapshot.captions.length) {
        store.updateJob(job.id, { state: 'processing', stage: 'Writing caption track' });
        captionsPath = path.join(tmpDir, 'captions.ass');
        writeFileSync(captionsPath, toAss(snapshot.captions, snapshot.profile.captions, {
          width: snapshot.profile.video.width, height: snapshot.profile.video.height,
        }));
      }
      if (signal?.aborted) throw Object.assign(new Error('Render cancelled.'), { cancelled: true });
      store.updateJob(job.id, { state: 'rendering', stage: 'Encoding clip' });
      await renderClip({
        sourcePath: snapshot.sourcePath,
        startSeconds: snapshot.startSeconds,
        durationSeconds: snapshot.durationSeconds,
        profile: snapshot.profile,
        captionsPath,
        outputPath: tmpOutput,
        onProgress: ratio => {
          onProgress?.(ratio);
          store.updateJob(job.id, { progress: Math.max(0, Math.min(0.98, ratio)), stage: 'Encoding clip' });
        },
        signal,
      });
      store.updateJob(job.id, { state: 'validating', stage: 'Validating output', progress: 0.99 });
      const validation = await validateOutput(tmpOutput, {
        duration: snapshot.durationSeconds,
        width: snapshot.profile.video.width,
        height: snapshot.profile.video.height,
        expectAudio: snapshot.expectAudio && snapshot.profile.audio.enabled !== false,
        fpsNum: snapshot.fpsNum, fpsDen: snapshot.fpsDen,
      });
      if (!validation.ok) throw new Error(`The rendered clip did not pass validation: ${validation.problems.join(' ')}`);

      renameSync(tmpOutput, finalOutput);
      const info = validation.info;
      const output = store.createOutput({
        jobId: job.id, segmentId: segment.id, batchId: batch.id,
        path: finalOutput, filename: snapshot.fileName, size: validation.size,
        duration: info.duration, width: info.width, height: info.height,
        fpsNum: info.fpsNum, fpsDen: info.fpsDen, videoCodec: info.videoCodec, audioCodec: info.audioCodec,
        configHash: job.configVersion || configHash(snapshot),
      });
      store.updateJob(job.id, { state: 'completed', stage: 'Complete', progress: 1, finished: new Date().toISOString(), outputId: output.id });
      store.updateSegment(segment.id, { renderState: 'ready', configHash: job.configVersion || configHash(snapshot) });
      return output;
    } catch (error) {
      const cancelled = error?.cancelled || error?.name === 'AbortError' || signal?.aborted;
      store.updateJob(job.id, {
        state: cancelled ? 'cancelled' : 'failed',
        stage: cancelled ? 'Cancelled' : 'Failed',
        error: cancelled ? 'Cancelled by user.' : (error?.message || 'The render failed.'),
        finished: new Date().toISOString(),
      });
      if (!cancelled && segment) store.updateSegment(segment.id, { renderState: 'failed' });
      throw error;
    } finally {
      if (tmpDir) { try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* temporary files are cleaned on next start */ } }
    }
  }

  /** Removes abandoned temporary directories left by an interrupted run. */
  function cleanTemporaryFiles(batchId) {
    const tmp = path.join(batchRoot(batchId), 'tmp');
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  }

  async function thumbnailFor(batch, source, atSeconds) {
    if (!source) return null;
    const dir = path.join(batchRoot(batch.id), 'thumbs');
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `source.jpg`);
    if (existsSync(file) && statSync(file).size > 0 && Math.abs(atSeconds - (source.thumbAt ?? 1)) < 0.01) return file;
    try { return await makeThumbnail(source.path, atSeconds, file); } catch { return null; }
  }

  async function probeSource(file) {
    return probe(file);
  }

  return { resolve, currentVersion, execute, cleanTemporaryFiles, thumbnailFor, probeSource, batchRoot };
}

import express from 'express';
import { createWriteStream, existsSync, mkdirSync, rmSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { batchCounts, captionsForSegment, DEFAULT_PROFILE, equalSegments, findOverlaps, manifestFor, mergeProfile, normalizeProfile, parseSrt, segmentSeconds, toSrt, validateBounds } from './domain.js';
import { outputBase } from './render.js';
import { makeThumbnail, toolsAvailable, toolPaths } from './media.js';
import { validateZip, writeZip } from './zip.js';

const MAX_UPLOAD = Number(process.env.BATCH_MAX_UPLOAD_BYTES || 4 * 1024 * 1024 * 1024);
const ALLOWED_EXT = new Set(['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi']);

export const BATCH_ROOT = path.resolve('data/batches');

const fail = (res, status, message) => res.status(status).json({ error: message });
const safeFileName = name => String(name || 'clip').replace(/[^a-z0-9 _.-]/gi, '').trim().replace(/\s+/g, '_').slice(0, 60) || 'clip';

export function createBatchRoutes({ store, renderer, queue, requireUser }) {
  const router = express.Router();
  const sourceStreamUrl = batch => `/api/batches/${batch.id}/source/stream`;

  function ownedBatch(req, res) {
    const batch = store.getBatch(req.user.id, req.params.id ?? req.params.batchId);
    if (!batch) { fail(res, 404, 'Batch not found.'); return null; }
    return batch;
  }
  function ownedSegment(req, res) {
    const segment = store.getSegment(req.params.id);
    if (!segment) { fail(res, 404, 'Segment not found.'); return null; }
    const batch = store.getBatch(req.user.id, segment.batchId);
    if (!batch) { fail(res, 404, 'Segment not found.'); return null; }
    return { segment, batch };
  }
  const profileFor = batch => (batch.profileId ? store.getProfile(batch.profileId) : null);
  function ensureProfile(batch) {
    const existing = profileFor(batch);
    if (existing) return existing;
    const profile = store.createProfile(batch.userId, 'Batch profile', DEFAULT_PROFILE);
    store.updateBatch(batch.id, { profileId: profile.id });
    return profile;
  }

  function invalidateOutputs(segmentId) {
    for (const file of store.deleteOutputsForSegment(segmentId)) {
      try { if (existsSync(file)) unlinkSync(file); } catch { /* the file may already be gone */ }
    }
  }

  function segmentDto(segment, source, batch) {
    const timing = source ? segmentSeconds(segment, source.fpsNum, source.fpsDen) : { start: 0, end: 0, duration: 0 };
    const captions = store.getCaptions(segment.id);
    return {
      ...segment,
      startSeconds: timing.start, endSeconds: timing.end, durationSeconds: timing.duration,
      captionCount: captions.entries.length,
      captionMode: captions.mode,
      thumbnailUrl: `/api/segments/${segment.id}/thumbnail`,
    };
  }

  /**
   * A retry re-resolves the clip against the current source and profile. Without
   * this, a job queued while the source was unreadable could never succeed, and
   * the stored configuration version would keep failing its own guard.
   */
  function refreshJobSnapshot(batch, job) {
    const source = store.getSource(batch.id);
    const segment = store.getSegment(job.segmentId);
    if (!source || !segment || !existsSync(source.path)) return;
    try {
      const resolved = renderer.resolve({ batch, source, segment });
      store.updateJob(job.id, { config: resolved.config, configVersion: resolved.version });
    } catch { /* keep the stored snapshot when it cannot be resolved yet */ }
  }

  function stateFor(req, batch) {
    const source = store.getSource(batch.id);
    const segments = store.listSegments(batch.id);
    const jobs = store.listJobs(batch.id);
    const outputs = store.listOutputs(batch.id);
    const profile = profileFor(batch);
    const counts = batchCounts(segments, jobs);
    const overlaps = findOverlaps(segments.filter(segment => segment.approval !== 'rejected'));
    return {
      batch: { ...batch, profileId: profile?.id ?? null, paused: batch.paused },
      source: source ? {
        ...source, path: undefined, probe: undefined,
        streamUrl: sourceStreamUrl(batch), thumbnailUrl: `/api/batches/${batch.id}/source/thumbnail`,
        missing: !existsSync(source.path),
        fps: source.fpsNum && source.fpsDen ? Number((source.fpsNum / source.fpsDen).toFixed(3)) : null,
      } : null,
      segments: segments.map(segment => {
        const dto = segmentDto(segment, source, batch);
        if (segment.renderState === 'ready' && source) {
          dto.renderStale = renderer.currentVersion({ batch, source, segment }) !== segment.configHash;
        }
        return dto;
      }),
      profile: profile ? { id: profile.id, name: profile.name, settings: mergeProfile(profile.settings) } : null,
      jobs,
      outputs: outputs.map(output => ({ ...output, path: undefined, downloadUrl: `/api/outputs/${output.id}/download` })),
      archive: store.latestArchive(batch.id),
      counts,
      overlaps: overlaps.length,
      transcriptCount: source ? store.listTranscript(source.id).length : 0,
      engine: { available: toolsAvailable(), ...toolPaths() },
      queue: queue.state(),
      limits: { maxUploadBytes: MAX_UPLOAD },
    };
  }

  router.get('/batch/status', requireUser, (req, res) => {
    res.json({ engine: { available: toolsAvailable(), ...toolPaths() }, queue: queue.state(), maxUploadBytes: MAX_UPLOAD });
  });

  router.get('/batches', requireUser, (req, res) => {
    res.json({ batches: store.listBatches(req.user.id).map(batch => {
      const segments = store.listSegments(batch.id);
      const jobs = store.listJobs(batch.id);
      const source = store.getSource(batch.id);
      return {
        id: batch.id, name: batch.name, updated: batch.updated, paused: batch.paused,
        sourceName: source?.filename ?? null, counts: batchCounts(segments, jobs),
        archive: store.latestArchive(batch.id)?.filename ?? null,
      };
    }) });
  });

  router.post('/batches', requireUser, (req, res) => {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, 80) : '';
    if (!name) return fail(res, 400, 'Enter a batch name.');
    const batch = store.createBatch(req.user.id, name);
    const profile = store.createProfile(req.user.id, `${name} profile`, normalizeProfile(req.body?.profile || {}));
    store.updateBatch(batch.id, { profileId: profile.id });
    res.status(201).json({ batch: { ...store.getBatch(req.user.id, batch.id), profileId: profile.id } });
  });

  router.get('/batches/:id', requireUser, (req, res) => {
    const batch = ownedBatch(req, res);
    if (!batch) return;
    res.json(stateFor(req, batch));
  });

  router.patch('/batches/:id', requireUser, (req, res) => {
    const batch = ownedBatch(req, res);
    if (!batch) return;
    const patch = {};
    if (typeof req.body?.name === 'string' && req.body.name.trim()) patch.name = req.body.name.trim().slice(0, 80);
    res.json({ batch: store.updateBatch(batch.id, patch) });
  });

  router.delete('/batches/:id', requireUser, (req, res) => {
    const batch = ownedBatch(req, res);
    if (!batch) return;
    for (const job of store.listActiveJobs(batch.id)) queue.cancel(job.id);
    const files = store.deleteBatch(req.user.id, batch.id) || [];
    for (const file of files) {
      if (file.startsWith('job:')) continue;
      try { if (existsSync(file)) unlinkSync(file); } catch { /* ignore */ }
    }
    try { rmSync(path.join(BATCH_ROOT, batch.id), { recursive: true, force: true }); } catch { /* ignore */ }
    res.json({ ok: true });
  });

  // ── Source ingestion ───────────────────────────────────────────────────────
  router.put('/batches/:id/source', requireUser, (req, res) => {
    const batch = ownedBatch(req, res);
    if (!batch) return;
    const filename = decodeURIComponent(String(req.get('x-filename') || 'recording.mp4'));
    const ext = path.extname(filename).toLowerCase();
    if (!ALLOWED_EXT.has(ext)) return fail(res, 400, 'Import an MP4, MOV, M4V, WebM, MKV or AVI file.');
    const declared = Number(req.get('content-length') || 0);
    if (declared > MAX_UPLOAD) return fail(res, 413, 'That file is larger than this server accepts.');
    const dir = path.join(BATCH_ROOT, batch.id);
    mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `upload-${Date.now()}${ext}`);
    let received = 0;
    const out = createWriteStream(tmp);
    req.on('data', chunk => {
      received += chunk.length;
      if (received > MAX_UPLOAD) { req.destroy(new Error('Upload limit exceeded.')); }
    });
    out.on('error', error => { try { unlinkSync(tmp); } catch { /* ignore */ } fail(res, 500, `The upload could not be stored: ${error.message}`); });
    req.on('error', () => { try { unlinkSync(tmp); } catch { /* ignore */ } });
    req.pipe(out);
    out.on('finish', async () => {
      try {
        if (received === 0) { unlinkSync(tmp); return fail(res, 400, 'The uploaded file was empty.'); }
        const info = await renderer.probeSource(tmp);
        const existing = store.getSource(batch.id);
        if (existing) {
          for (const segment of store.listSegments(batch.id)) {
            if (segment.endFrame > info.frames) {
              unlinkSync(tmp);
              return fail(res, 409, `The replacement source is shorter (${info.frames} frames). Remove or shorten segments that no longer fit, then try again.`);
            }
          }
        }
        const finalName = `source-${Date.now()}${ext}`;
        const finalPath = path.join(dir, finalName);
        const { renameSync } = await import('node:fs');
        renameSync(tmp, finalPath);
        const previous = store.getSource(batch.id);
        const source = store.saveSource(batch.id, req.user.id, { ...info, filename, path: finalPath, size: statSync(finalPath).size });
        if (previous && previous.path !== finalPath) { try { unlinkSync(previous.path); } catch { /* ignore */ } }
        let thumbnail = null;
        try {
          thumbnail = path.join(dir, 'source-thumb.jpg');
          await makeThumbnail(finalPath, Math.min(1, info.duration / 2), thumbnail);
          store.raw.prepare('UPDATE batch_sources SET thumbnail=? WHERE id=?').run(thumbnail, source.id);
        } catch { thumbnail = null; }
        for (const segment of store.listSegments(batch.id)) {
          invalidateOutputs(segment.id);
          store.updateSegment(segment.id, { renderState: 'stale' });
        }
        res.json(stateFor(req, store.getBatch(req.user.id, batch.id)));
      } catch (error) {
        try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* ignore */ }
        fail(res, 422, error.message || 'The source could not be read.');
      }
    });
  });

  router.delete('/batches/:id/source', requireUser, (req, res) => {
    const batch = ownedBatch(req, res);
    if (!batch) return;
    for (const segment of store.listSegments(batch.id)) invalidateOutputs(segment.id);
    for (const file of store.clearSource(batch.id)) { try { if (existsSync(file)) unlinkSync(file); } catch { /* ignore */ } }
    res.json(stateFor(req, store.getBatch(req.user.id, batch.id)));
  });

  function streamFrom(res, file, req, contentType = 'video/mp4') {
    if (!existsSync(file)) return fail(res, 404, 'That file is no longer on this server.');
    const size = statSync(file).size;
    const range = req.headers.range;
    if (range) {
      const match = /bytes=(\d*)-(\d*)/.exec(range);
      const start = match && match[1] ? Number(match[1]) : 0;
      const end = match && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
      if (start >= size || start > end) { res.setHeader('Content-Range', `bytes */${size}`); return res.status(416).end(); }
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Content-Length', String(end - start + 1));
      res.setHeader('Content-Type', contentType);
      return import('node:fs').then(({ createReadStream }) => createReadStream(file, { start, end }).pipe(res));
    }
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Length', String(size));
    res.setHeader('Content-Type', contentType);
    import('node:fs').then(({ createReadStream }) => createReadStream(file).pipe(res));
  }

  router.get('/batches/:id/source/stream', requireUser, (req, res) => {
    const batch = ownedBatch(req, res);
    if (!batch) return;
    const source = store.getSource(batch.id);
    if (!source) return fail(res, 404, 'Import a source first.');
    return streamFrom(res, source.path, req, source.filename.endsWith('.webm') ? 'video/webm' : 'video/mp4');
  });

  router.get('/batches/:id/source/thumbnail', requireUser, (req, res) => {
    const batch = ownedBatch(req, res);
    if (!batch) return;
    const source = store.getSource(batch.id);
    if (!source?.thumbnail || !existsSync(source.thumbnail)) return fail(res, 404, 'No thumbnail.');
    return streamFrom(res, source.thumbnail, req, 'image/jpeg');
  });

  router.get('/segments/:id/thumbnail', requireUser, (req, res) => {
    const found = ownedSegment(req, res);
    if (!found) return;
    return (async () => {
      const source = store.getSource(found.batch.id);
      if (!source || !existsSync(source.path)) return fail(res, 404, 'The source is missing.');
      const dir = path.join(BATCH_ROOT, found.batch.id, 'thumbs');
      mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `segment-${found.segment.id}.jpg`);
      if (!existsSync(file) || statSync(file).size === 0) {
        const timing = segmentSeconds(found.segment, source.fpsNum, source.fpsDen);
        try { await makeThumbnail(source.path, timing.start + Math.min(1, timing.duration / 2), file); }
        catch { return fail(res, 500, 'The thumbnail could not be generated.'); }
      }
      streamFrom(res, file, req, 'image/jpeg');
    })();
  });

  // ── Segmentation ──────────────────────────────────────────────────────────
  router.post('/batches/:id/segments', requireUser, (req, res) => {
    const batch = ownedBatch(req, res);
    if (!batch) return;
    const source = store.getSource(batch.id);
    if (!source) return fail(res, 400, 'Import a source before adding segments.');
    try {
      const startFrame = Number(req.body?.startFrame);
      const endFrame = Number(req.body?.endFrame);
      validateBounds({ startFrame, endFrame, totalFrames: source.frames });
      const count = store.listSegments(batch.id).length;
      const name = typeof req.body?.name === 'string' && req.body.name.trim() ? req.body.name.trim().slice(0, 80) : `Clip ${String(count + 1).padStart(3, '0')}`;
      store.addSegment(batch.id, source.id, { name, startFrame, endFrame });
      res.status(201).json(stateFor(req, store.getBatch(req.user.id, batch.id)));
    } catch (error) { fail(res, 422, error.message); }
  });

  router.post('/batches/:id/segments/equal', requireUser, (req, res) => {
    const batch = ownedBatch(req, res);
    if (!batch) return;
    const source = store.getSource(batch.id);
    if (!source) return fail(res, 400, 'Import a source before segmenting.');
    try {
      const list = equalSegments({
        totalFrames: source.frames, fpsNum: source.fpsNum, fpsDen: source.fpsDen,
        targetSeconds: Number(req.body?.targetSeconds),
        overlapSeconds: Number(req.body?.overlapSeconds || 0),
        minSeconds: Number(req.body?.minSeconds || 0),
        shortFinal: ['keep', 'merge', 'drop'].includes(req.body?.shortFinal) ? req.body.shortFinal : 'keep',
        namePrefix: typeof req.body?.namePrefix === 'string' && req.body.namePrefix.trim() ? req.body.namePrefix.trim().slice(0, 40) : 'Clip',
      });
      for (const segment of store.listSegments(batch.id)) invalidateOutputs(segment.id);
      store.replaceSegments(batch.id, source.id, list);
      res.status(201).json(stateFor(req, store.getBatch(req.user.id, batch.id)));
    } catch (error) { fail(res, 422, error.message); }
  });

  router.patch('/segments/:id', requireUser, (req, res) => {
    const found = ownedSegment(req, res);
    if (!found) return;
    const { segment, batch } = found;
    const source = store.getSource(batch.id);
    try {
      const patch = {};
      if (typeof req.body?.name === 'string') {
        if (!req.body.name.trim()) throw new Error('A segment needs a name.');
        patch.name = req.body.name.trim().slice(0, 80);
      }
      const changingBounds = 'startFrame' in (req.body || {}) || 'endFrame' in (req.body || {});
      if (changingBounds) {
        if (!source) throw new Error('This batch has no source.');
        const startFrame = 'startFrame' in req.body ? Number(req.body.startFrame) : segment.startFrame;
        const endFrame = 'endFrame' in req.body ? Number(req.body.endFrame) : segment.endFrame;
        validateBounds({ startFrame, endFrame, totalFrames: source.frames });
        patch.startFrame = startFrame;
        patch.endFrame = endFrame;
        invalidateOutputs(segment.id);
        patch.renderState = 'stale';
        if (segment.approval === 'approved') patch.approval = 'pending';
      }
      if ('overrides' in (req.body || {})) {
        const overrides = req.body.overrides === null ? {} : req.body.overrides;
        if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) throw new Error('Overrides must be an object of profile sections.');
        patch.overrides = overrides;
        invalidateOutputs(segment.id);
        patch.renderState = 'stale';
      }
      if ('approval' in (req.body || {})) {
        const approval = req.body.approval;
        if (!['approved', 'rejected', 'pending'].includes(approval)) throw new Error('Unknown approval state.');
        if (approval === 'approved' && !source) throw new Error('A segment cannot be approved without a source.');
        patch.approval = approval;
        if (approval === 'approved' && (patch.endFrame ?? segment.endFrame) > (source?.frames ?? 0)) throw new Error('This segment ends after the source.');
      }
      const updated = store.updateSegment(segment.id, patch);
      res.json({ segment: segmentDto(updated, source, batch), state: stateFor(req, store.getBatch(req.user.id, batch.id)) });
    } catch (error) { fail(res, 422, error.message); }
  });

  router.post('/segments/:id/split', requireUser, (req, res) => {
    const found = ownedSegment(req, res);
    if (!found) return;
    const { segment, batch } = found;
    try {
      const frame = Math.round(Number(req.body?.frame));
      if (!Number.isInteger(frame) || frame <= segment.startFrame || frame >= segment.endFrame) throw new Error('Place the playhead inside the segment before splitting.');
      const right = store.insertSegmentAt(batch.id, segment.sourceId, segment.ordinal + 1, {
        name: `${segment.name} B`, startFrame: frame, endFrame: segment.endFrame, overrides: segment.overrides,
      });
      invalidateOutputs(segment.id);
      store.updateSegment(segment.id, { endFrame: frame, approval: segment.approval === 'approved' ? 'pending' : segment.approval, renderState: 'stale' });
      res.status(201).json({ segments: [store.getSegment(segment.id), right], state: stateFor(req, store.getBatch(req.user.id, batch.id)) });
    } catch (error) { fail(res, 422, error.message); }
  });

  router.post('/segments/:id/duplicate', requireUser, (req, res) => {
    const found = ownedSegment(req, res);
    if (!found) return;
    const { segment, batch } = found;
    const copy = store.insertSegmentAt(batch.id, segment.sourceId, segment.ordinal + 1, {
      name: `${segment.name} copy`, startFrame: segment.startFrame, endFrame: segment.endFrame, overrides: segment.overrides,
    });
    res.status(201).json({ segment: copy, state: stateFor(req, store.getBatch(req.user.id, batch.id)) });
  });

  router.delete('/segments/:id', requireUser, (req, res) => {
    const found = ownedSegment(req, res);
    if (!found) return;
    for (const id of store.listJobs(found.batch.id).filter(job => job.segmentId === found.segment.id && !['completed', 'failed', 'cancelled'].includes(job.state)).map(job => job.id)) queue.cancel(id);
    invalidateOutputs(found.segment.id);
    store.deleteSegment(found.segment.id);
    res.json(stateFor(req, store.getBatch(req.user.id, found.batch.id)));
  });

  router.post('/batches/:id/segments/merge', requireUser, (req, res) => {
    const batch = ownedBatch(req, res);
    if (!batch) return;
    try {
      const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
      if (ids.length < 2) throw new Error('Select at least two segments to merge.');
      const segments = ids.map(id => store.getSegment(id)).filter(Boolean).sort((a, b) => a.startFrame - b.startFrame);
      if (segments.length < 2 || segments.some(segment => segment.batchId !== batch.id)) throw new Error('Those segments cannot be merged.');
      for (let index = 1; index < segments.length; index += 1) {
        if (segments[index].startFrame > segments[index - 1].endFrame) throw new Error('Only adjacent or overlapping segments can be merged.');
      }
      const first = segments[0];
      const last = segments[segments.length - 1];
      for (const segment of segments.slice(1)) { invalidateOutputs(segment.id); store.deleteSegment(segment.id); }
      invalidateOutputs(first.id);
      const merged = store.updateSegment(first.id, {
        endFrame: Math.max(...segments.map(segment => segment.endFrame)),
        name: first.name,
        approval: 'pending',
        renderState: 'stale',
      });
      res.json({ segment: merged, state: stateFor(req, store.getBatch(req.user.id, batch.id)) });
    } catch (error) { fail(res, 422, error.message); }
  });

  router.post('/batches/:id/approval', requireUser, (req, res) => {
    const batch = ownedBatch(req, res);
    if (!batch) return;
    const approval = req.body?.approval;
    if (!['approved', 'rejected', 'pending'].includes(approval)) return fail(res, 422, 'Unknown approval state.');
    const source = store.getSource(batch.id);
    const ids = Array.isArray(req.body?.ids) && req.body.ids.length ? req.body.ids : store.listSegments(batch.id).map(segment => segment.id);
    let changed = 0;
    for (const id of ids) {
      const segment = store.getSegment(id);
      if (!segment || segment.batchId !== batch.id) continue;
      if (approval === 'approved' && source && segment.endFrame > source.frames) continue;
      store.updateSegment(id, { approval });
      changed += 1;
    }
    res.json({ changed, state: stateFor(req, store.getBatch(req.user.id, batch.id)) });
  });

  // ── Transcripts and captions ───────────────────────────────────────────────
  router.get('/batches/:id/transcript', requireUser, (req, res) => {
    const batch = ownedBatch(req, res);
    if (!batch) return;
    const source = store.getSource(batch.id);
    res.json({ entries: source ? store.listTranscript(source.id) : [], provider: 'manual' });
  });

  router.put('/batches/:id/transcript', requireUser, (req, res) => {
    const batch = ownedBatch(req, res);
    if (!batch) return;
    const source = store.getSource(batch.id);
    if (!source) return fail(res, 400, 'Import a source first.');
    try {
      let entries;
      if (typeof req.body?.srt === 'string') entries = parseSrt(req.body.srt);
      else if (Array.isArray(req.body?.entries)) {
        entries = req.body.entries.map(entry => ({
          startMs: Math.round(Number(entry.startMs)), endMs: Math.round(Number(entry.endMs)),
          text: String(entry.text || '').trim(), words: entry.words ?? null,
          speaker: entry.speaker ?? null, confidence: entry.confidence ?? null,
        }));
        for (const entry of entries) {
          if (!Number.isFinite(entry.startMs) || !Number.isFinite(entry.endMs) || entry.endMs <= entry.startMs || !entry.text) throw new Error('Every transcript entry needs text and an end after its start.');
        }
      } else throw new Error('Provide subtitle text or transcript entries.');
      store.setTranscript(source.id, entries);
      for (const segment of store.listSegments(batch.id)) {
        const track = store.getCaptions(segment.id);
        if (track.mode === 'generated') {
          const profile = mergeProfile(profileFor(batch)?.settings || DEFAULT_PROFILE, segment.overrides);
          const regenerated = generateCaptions(store, source, segment, profile);
          store.setCaptions(segment.id, regenerated, 'generated');
          invalidateOutputs(segment.id);
          store.updateSegment(segment.id, { renderState: 'stale' });
        }
      }
      res.json({ count: entries.length, state: stateFor(req, store.getBatch(req.user.id, batch.id)) });
    } catch (error) { fail(res, 422, error.message); }
  });

  router.post('/batches/:id/captions/generate', requireUser, (req, res) => {
    const batch = ownedBatch(req, res);
    if (!batch) return;
    const source = store.getSource(batch.id);
    if (!source) return fail(res, 400, 'Import a source first.');
    const wanted = Array.isArray(req.body?.ids) && req.body.ids.length ? req.body.ids : store.listSegments(batch.id).map(segment => segment.id);
    let generated = 0;
    for (const id of wanted) {
      const segment = store.getSegment(id);
      if (!segment || segment.batchId !== batch.id) continue;
      const profile = mergeProfile(profileFor(batch)?.settings || DEFAULT_PROFILE, segment.overrides);
      const entries = generateCaptions(store, source, segment, profile);
      store.setCaptions(segment.id, entries, 'generated');
      invalidateOutputs(segment.id);
      store.updateSegment(segment.id, { renderState: 'stale' });
      generated += 1;
    }
    res.json({ generated, state: stateFor(req, store.getBatch(req.user.id, batch.id)) });
  });

  router.get('/segments/:id/captions', requireUser, (req, res) => {
    const found = ownedSegment(req, res);
    if (!found) return;
    res.json(store.getCaptions(found.segment.id));
  });

  router.put('/segments/:id/captions', requireUser, (req, res) => {
    const found = ownedSegment(req, res);
    if (!found) return;
    try {
      const entries = (Array.isArray(req.body?.entries) ? req.body.entries : []).map(entry => ({
        startMs: Math.round(Number(entry.startMs)), endMs: Math.round(Number(entry.endMs)), text: String(entry.text || '').trim(),
      }));
      for (const entry of entries) {
        if (!Number.isFinite(entry.startMs) || !Number.isFinite(entry.endMs) || entry.endMs <= entry.startMs) throw new Error('Each caption needs an end time after its start time.');
        if (!entry.text) throw new Error('A caption cannot be empty.');
      }
      store.setCaptions(found.segment.id, entries, 'edited');
      invalidateOutputs(found.segment.id);
      store.updateSegment(found.segment.id, { renderState: 'stale' });
      res.json({ captions: store.getCaptions(found.segment.id), state: stateFor(req, store.getBatch(req.user.id, found.batch.id)) });
    } catch (error) { fail(res, 422, error.message); }
  });

  // ── Profile ────────────────────────────────────────────────────────────────
  router.get('/profiles', requireUser, (req, res) => {
    res.json({ profiles: store.listProfiles(req.user.id).map(profile => ({ ...profile, settings: mergeProfile(profile.settings) })) });
  });

  router.put('/batches/:id/profile', requireUser, (req, res) => {
    const batch = ownedBatch(req, res);
    if (!batch) return;
    try {
      const profile = ensureProfile(batch);
      const settings = mergeProfile(req.body?.settings || profile.settings);
      const updated = store.updateProfile(profile.id, { settings, name: req.body?.name || profile.name });
      const ids = Array.isArray(req.body?.ids) && req.body.ids.length
        ? req.body.ids
        : (req.body?.applyTo === 'selected' && Array.isArray(req.body?.ids) ? req.body.ids : store.listSegments(batch.id).map(segment => segment.id));
      for (const id of ids) {
        const segment = store.getSegment(id);
        if (!segment || segment.batchId !== batch.id) continue;
        if (req.body?.applyTo === 'selected') store.updateSegment(id, { overrides: {} });
        invalidateOutputs(id);
        store.updateSegment(id, { renderState: 'stale' });
      }
      res.json({ profile: { ...updated, settings: mergeProfile(updated.settings) }, state: stateFor(req, store.getBatch(req.user.id, batch.id)) });
    } catch (error) { fail(res, 422, error.message); }
  });

  // ── Queue ─────────────────────────────────────────────────────────────────
  router.post('/batches/:id/queue', requireUser, (req, res) => {
    const batch = ownedBatch(req, res);
    if (!batch) return;
    const source = store.getSource(batch.id);
    if (!source) return fail(res, 400, 'Import a source first.');
    if (!toolsAvailable()) return fail(res, 503, 'The media engine is not installed on this server, so clips cannot be rendered.');
    const wanted = Array.isArray(req.body?.segmentIds) && req.body.segmentIds.length
      ? req.body.segmentIds.map(id => store.getSegment(id)).filter(segment => segment && segment.batchId === batch.id)
      : store.listSegments(batch.id);
    const created = [], skipped = [];
    const activeSegments = new Set(store.listActiveJobs(batch.id).map(job => job.segmentId));
    for (const segment of wanted) {
      if (segment.approval !== 'approved') { skipped.push({ segmentId: segment.id, name: segment.name, reason: `Segment is ${segment.approval}.` }); continue; }
      if (activeSegments.has(segment.id)) { skipped.push({ segmentId: segment.id, name: segment.name, reason: 'Already queued.' }); continue; }
      const { config, version } = renderer.resolve({ batch, source, segment });
      const completed = store.listJobs(batch.id).find(job => job.segmentId === segment.id && job.state === 'completed');
      if (completed && segment.configHash === version && segment.renderState === 'ready') {
        skipped.push({ segmentId: segment.id, name: segment.name, reason: 'Already rendered with the current settings.' });
        continue;
      }
      const job = store.createJob({ batchId: batch.id, segmentId: segment.id, userId: req.user.id, config, configVersion: version });
      store.updateSegment(segment.id, { renderState: 'queued' });
      created.push(job.id);
    }
    queue.schedule();
    res.status(created.length ? 201 : 200).json({ created, skipped, state: stateFor(req, store.getBatch(req.user.id, batch.id)) });
  });

  router.get('/batches/:id/jobs', requireUser, (req, res) => {
    const batch = ownedBatch(req, res);
    if (!batch) return;
    const segments = store.listSegments(batch.id);
    const jobs = store.listJobs(batch.id);
    res.json({ jobs, counts: batchCounts(segments, jobs), queue: queue.state(), paused: batch.paused });
  });

  router.post('/batches/:id/pause', requireUser, (req, res) => {
    const batch = ownedBatch(req, res);
    if (!batch) return;
    queue.pause(batch.id);
    res.json({ paused: true, queue: queue.state() });
  });

  router.post('/batches/:id/resume', requireUser, (req, res) => {
    const batch = ownedBatch(req, res);
    if (!batch) return;
    queue.resume(batch.id);
    res.json({ paused: false, queue: queue.state() });
  });

  router.post('/batches/:id/retry-failed', requireUser, (req, res) => {
    const batch = ownedBatch(req, res);
    if (!batch) return;
    const failed = store.listJobs(batch.id).filter(job => ['failed', 'cancelled'].includes(job.state));
    let retried = 0;
    for (const job of failed) {
      refreshJobSnapshot(batch, job);
      if (!queue.retry(job.id).error) retried += 1;
    }
    res.json({ retried, state: stateFor(req, store.getBatch(req.user.id, batch.id)) });
  });

  router.post('/jobs/:id/cancel', requireUser, (req, res) => {
    const job = store.getJob(req.params.id);
    if (!job) return fail(res, 404, 'Job not found.');
    if (!store.getBatch(req.user.id, job.batchId)) return fail(res, 404, 'Job not found.');
    const result = queue.cancel(job.id);
    if (result.error) return fail(res, 422, result.error);
    res.json({ job: result.job });
  });

  router.post('/jobs/:id/retry', requireUser, (req, res) => {
    const job = store.getJob(req.params.id);
    if (!job) return fail(res, 404, 'Job not found.');
    if (!store.getBatch(req.user.id, job.batchId)) return fail(res, 404, 'Job not found.');
    refreshJobSnapshot(store.getBatch(req.user.id, job.batchId), job);
    const result = queue.retry(job.id);
    if (result.error) return fail(res, 422, result.error);
    res.json({ job: result.job });
  });

  // ── Outputs and ZIP ───────────────────────────────────────────────────────
  router.get('/outputs/:id/download', requireUser, (req, res) => {
    const output = store.getOutput(req.params.id);
    if (!output) return fail(res, 404, 'Output not found.');
    if (!store.getBatch(req.user.id, output.batchId)) return fail(res, 404, 'Output not found.');
    if (!existsSync(output.path)) return fail(res, 410, 'That rendered file is no longer on this server.');
    res.setHeader('Content-Disposition', `attachment; filename="${output.filename}"`);
    return streamFrom(res, output.path, req, 'video/mp4');
  });

  router.post('/batches/:id/package', requireUser, async (req, res) => {
    const batch = ownedBatch(req, res);
    if (!batch) return;
    const source = store.getSource(batch.id);
    const segments = store.listSegments(batch.id);
    const outputs = store.listOutputs(batch.id);
    if (!outputs.length) return fail(res, 409, 'Render at least one clip before packaging.');
    const included = [], excluded = [], entries = [], clipMeta = [];
    for (const segment of segments) {
      const output = outputs.filter(item => item.segmentId === segment.id).sort((a, b) => b.created.localeCompare(a.created))[0];
      if (!output) {
        if (segment.approval === 'approved') excluded.push({ segmentId: segment.id, name: segment.name, reason: 'Not rendered yet.' });
        continue;
      }
      if (segment.approval !== 'approved') { excluded.push({ segmentId: segment.id, name: segment.name, reason: `Segment is ${segment.approval}.` }); continue; }
      let stale = false;
      if (source) stale = renderer.currentVersion({ batch, source, segment }) !== output.configHash;
      if (stale) { excluded.push({ segmentId: segment.id, name: segment.name, reason: 'Settings or boundaries changed after rendering.' }); continue; }
      if (!existsSync(output.path)) { excluded.push({ segmentId: segment.id, name: segment.name, reason: 'The rendered file is missing.' }); continue; }
      const base = outputBase(segment);
      entries.push({ name: `ClipForge_Batch/videos/${base}.mp4`, path: output.path });
      const captions = store.getCaptions(segment.id);
      let captionsIncluded = false;
      if (captions.entries.length) {
        const srtPath = path.join(BATCH_ROOT, batch.id, 'archives', `${segment.id}.srt`);
        mkdirSync(path.dirname(srtPath), { recursive: true });
        const { writeFileSync } = await import('node:fs');
        writeFileSync(srtPath, toSrt(captions.entries));
        entries.push({ name: `ClipForge_Batch/subtitles/${base}.srt`, path: srtPath });
        captionsIncluded = true;
      }
      const thumbPath = path.join(BATCH_ROOT, batch.id, 'archives', `${segment.id}.jpg`);
      try {
        mkdirSync(path.dirname(thumbPath), { recursive: true });
        await makeThumbnail(output.path, Math.min(1, output.duration / 2), thumbPath);
        entries.push({ name: `ClipForge_Batch/thumbnails/${base}.jpg`, path: thumbPath });
      } catch { /* thumbnails are optional */ }
      included.push({
        segmentId: segment.id, filename: `${base}.mp4`, duration: output.duration, width: output.width,
        height: output.height, fpsNum: output.fpsNum, fpsDen: output.fpsDen, captions: captionsIncluded,
      });
      clipMeta.push({
        segmentId: segment.id, name: segment.name,
        startSeconds: source ? (segment.startFrame * source.fpsDen) / source.fpsNum : null,
        endSeconds: source ? (segment.endFrame * source.fpsDen) / source.fpsNum : null,
      });
    }
    if (!included.length) return fail(res, 409, 'No validated, current renders are available to package.');
    const manifest = manifestFor({ batch, source, included, excluded, clipMeta });
    const manifestPath = path.join(BATCH_ROOT, batch.id, 'archives', 'manifest.json');
    mkdirSync(path.dirname(manifestPath), { recursive: true });
    const { writeFileSync } = await import('node:fs');
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    entries.push({ name: 'ClipForge_Batch/manifest.json', path: manifestPath });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `ClipForge_${safeFileName(batch.name)}_${manifest.partial ? 'partial_' : ''}${stamp}.zip`;
    const archivePath = path.join(BATCH_ROOT, batch.id, 'archives', fileName);
    try {
      await writeZip(archivePath, entries);
      const check = validateZip(archivePath, entries.map(entry => entry.name));
      if (!check.ok) { try { unlinkSync(archivePath); } catch { /* ignore */ } return fail(res, 500, `The archive did not validate: ${check.problems.join(' ')}`); }
      const archive = store.createArchive({
        batchId: batch.id, path: archivePath, filename: fileName, size: statSync(archivePath).size,
        partial: manifest.partial, included: included.map(item => item.filename), excluded, manifest,
      });
      res.status(201).json({ archive: { ...archive, downloadUrl: `/api/batches/${batch.id}/archive/download` }, included: included.length, excluded });
    } catch (error) {
      try { if (existsSync(archivePath)) unlinkSync(archivePath); } catch { /* ignore */ }
      fail(res, 500, `The archive could not be created: ${error.message}`);
    }
  });

  router.get('/batches/:id/archive', requireUser, (req, res) => {
    const batch = ownedBatch(req, res);
    if (!batch) return;
    const archive = store.latestArchive(batch.id);
    if (!archive) return fail(res, 404, 'No archive has been created for this batch.');
    res.json({ archive: { ...archive, downloadUrl: `/api/batches/${batch.id}/archive/download` } });
  });

  router.get('/batches/:id/archive/download', requireUser, (req, res) => {
    const batch = ownedBatch(req, res);
    if (!batch) return;
    const archive = store.latestArchive(batch.id);
    if (!archive || !existsSync(archive.path)) return fail(res, 404, 'No archive is available.');
    res.setHeader('Content-Disposition', `attachment; filename="${archive.filename}"`);
    return streamFrom(res, archive.path, req, 'application/zip');
  });

  return router;
}

/** Caption generation for one segment, shared by the transcript and generate routes. */
function generateCaptions(store, source, segment, profile) {
  return captionsForSegment(store.listTranscript(source.id), {
    startFrame: segment.startFrame, endFrame: segment.endFrame,
    fpsNum: source.fpsNum, fpsDen: source.fpsDen, group: profile.captions.group,
  });
}

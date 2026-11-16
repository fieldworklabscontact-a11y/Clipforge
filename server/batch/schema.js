import { randomBytes } from 'node:crypto';

export const BATCH_SCHEMA_VERSION = 1;
export const newId = () => randomBytes(12).toString('hex');
const now = () => new Date().toISOString();
const parse = (value, fallback) => { try { return value == null ? fallback : JSON.parse(value); } catch { return fallback; } };

/**
 * Persistent storage for Batch Studio. Every production record lives here so a
 * batch can be closed and reopened, and so the queue can recover after restart.
 */
export function createBatchStore(db) {
  db.exec(`
    PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS batch_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS batch_sources (
      id TEXT PRIMARY KEY, batch_id TEXT NOT NULL, user_id TEXT NOT NULL,
      filename TEXT NOT NULL, path TEXT NOT NULL, size INTEGER NOT NULL DEFAULT 0,
      duration REAL NOT NULL DEFAULT 0, width INTEGER NOT NULL DEFAULT 0, height INTEGER NOT NULL DEFAULT 0,
      fps_num INTEGER NOT NULL DEFAULT 0, fps_den INTEGER NOT NULL DEFAULT 1, frames INTEGER NOT NULL DEFAULT 0,
      video_codec TEXT, audio_codec TEXT, audio_streams INTEGER NOT NULL DEFAULT 0, rotation INTEGER NOT NULL DEFAULT 0,
      bitrate INTEGER NOT NULL DEFAULT 0, thumbnail TEXT, probe_json TEXT, created TEXT NOT NULL, updated TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS batches (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, source_id TEXT,
      profile_id TEXT, paused INTEGER NOT NULL DEFAULT 0, concurrency INTEGER,
      created TEXT NOT NULL, updated TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS segments (
      id TEXT PRIMARY KEY, batch_id TEXT NOT NULL, source_id TEXT NOT NULL, ordinal INTEGER NOT NULL,
      name TEXT NOT NULL, start_frame INTEGER NOT NULL, end_frame INTEGER NOT NULL,
      approval TEXT NOT NULL DEFAULT 'pending', caption_state TEXT NOT NULL DEFAULT 'empty',
      profile_id TEXT, overrides_json TEXT, render_state TEXT NOT NULL DEFAULT 'idle',
      config_hash TEXT, created TEXT NOT NULL, updated TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS transcript_entries (
      id TEXT PRIMARY KEY, source_id TEXT NOT NULL, start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL,
      text TEXT NOT NULL, words_json TEXT, speaker TEXT, confidence REAL
    );
    CREATE TABLE IF NOT EXISTS caption_tracks (
      segment_id TEXT PRIMARY KEY, entries_json TEXT NOT NULL, mode TEXT NOT NULL, updated TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS profiles (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, settings_json TEXT NOT NULL,
      created TEXT NOT NULL, updated TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY, batch_id TEXT NOT NULL, segment_id TEXT NOT NULL, user_id TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'render', state TEXT NOT NULL, progress REAL NOT NULL DEFAULT 0,
      stage TEXT, created TEXT NOT NULL, started TEXT, finished TEXT, retries INTEGER NOT NULL DEFAULT 0,
      error TEXT, config_version TEXT, config_json TEXT, output_id TEXT, cancelled INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS outputs (
      id TEXT PRIMARY KEY, job_id TEXT NOT NULL, segment_id TEXT NOT NULL, batch_id TEXT NOT NULL,
      path TEXT NOT NULL, filename TEXT NOT NULL, size INTEGER NOT NULL, duration REAL NOT NULL,
      width INTEGER NOT NULL, height INTEGER NOT NULL, fps_num INTEGER NOT NULL, fps_den INTEGER NOT NULL,
      video_codec TEXT, audio_codec TEXT, config_hash TEXT NOT NULL, validated INTEGER NOT NULL DEFAULT 0,
      created TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS archives (
      id TEXT PRIMARY KEY, batch_id TEXT NOT NULL, path TEXT NOT NULL, filename TEXT NOT NULL,
      size INTEGER NOT NULL, partial INTEGER NOT NULL DEFAULT 0, included_json TEXT, excluded_json TEXT,
      manifest_json TEXT, created TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_segments_batch ON segments(batch_id, ordinal);
    CREATE INDEX IF NOT EXISTS idx_jobs_batch ON jobs(batch_id, created);
    CREATE INDEX IF NOT EXISTS idx_transcript_source ON transcript_entries(source_id, start_ms);
  `);
  const current = db.prepare('SELECT value FROM batch_meta WHERE key=?').get('schema_version');
  if (!current) db.prepare('INSERT INTO batch_meta (key,value) VALUES (?,?)').run('schema_version', String(BATCH_SCHEMA_VERSION));
  else if (Number(current.value) > BATCH_SCHEMA_VERSION) throw new Error('This batch database was written by a newer ClipForge version.');

  const source = row => row && {
    id: row.id, batchId: row.batch_id, userId: row.user_id, filename: row.filename, path: row.path,
    size: row.size, duration: row.duration, width: row.width, height: row.height,
    fpsNum: row.fps_num, fpsDen: row.fps_den, frames: row.frames, videoCodec: row.video_codec,
    audioCodec: row.audio_codec, audioStreams: row.audio_streams, rotation: row.rotation,
    bitrate: row.bitrate, thumbnail: row.thumbnail, created: row.created, updated: row.updated,
  };
  const batch = row => row && {
    id: row.id, userId: row.user_id, name: row.name, sourceId: row.source_id,
    profileId: row.profile_id, paused: !!row.paused, concurrency: row.concurrency, created: row.created, updated: row.updated,
  };
  const segment = row => row && {
    id: row.id, batchId: row.batch_id, sourceId: row.source_id, ordinal: row.ordinal, name: row.name,
    startFrame: row.start_frame, endFrame: row.end_frame, approval: row.approval,
    captionState: row.caption_state, profileId: row.profile_id,
    overrides: parse(row.overrides_json, {}), renderState: row.render_state,
    configHash: row.config_hash, created: row.created, updated: row.updated,
    durationFrames: row.end_frame - row.start_frame,
  };
  const profile = row => row && {
    id: row.id, userId: row.user_id, name: row.name, settings: parse(row.settings_json, {}),
    created: row.created, updated: row.updated,
  };
  const job = row => row && {
    id: row.id, batchId: row.batch_id, segmentId: row.segment_id, userId: row.user_id, type: row.type,
    state: row.state, progress: row.progress, stage: row.stage, created: row.created,
    started: row.started, finished: row.finished, retries: row.retries, error: row.error,
    configVersion: row.config_version, config: parse(row.config_json, null), outputId: row.output_id,
    cancelled: !!row.cancelled,
  };
  const output = row => row && {
    id: row.id, jobId: row.job_id, segmentId: row.segment_id, batchId: row.batch_id, path: row.path,
    filename: row.filename, size: row.size, duration: row.duration, width: row.width, height: row.height,
    fpsNum: row.fps_num, fpsDen: row.fps_den, videoCodec: row.video_codec, audioCodec: row.audio_codec,
    configHash: row.config_hash, validated: !!row.validated, created: row.created,
  };
  const archive = row => row && {
    id: row.id, batchId: row.batch_id, path: row.path, filename: row.filename, size: row.size,
    partial: !!row.partial, included: parse(row.included_json, []), excluded: parse(row.excluded_json, []),
    manifest: parse(row.manifest_json, null), created: row.created,
  };

  return {
    raw: db,
    createBatch(userId, name) {
      const id = newId(), stamp = now();
      db.prepare('INSERT INTO batches (id,user_id,name,created,updated) VALUES (?,?,?,?,?)').run(id, userId, name, stamp, stamp);
      return this.getBatch(userId, id);
    },
    getBatch(userId, id) {
      return batch(db.prepare('SELECT * FROM batches WHERE id=? AND user_id=?').get(id, userId));
    },
    getBatchById(id) { return batch(db.prepare('SELECT * FROM batches WHERE id=?').get(id)); },
    insertSegmentAt(batchId, sourceId, ordinal, data) {
      const id = newId(), stamp = now();
      db.prepare('UPDATE segments SET ordinal=ordinal+1 WHERE batch_id=? AND ordinal>=?').run(batchId, ordinal);
      db.prepare(`INSERT INTO segments (id,batch_id,source_id,ordinal,name,start_frame,end_frame,approval,caption_state,profile_id,overrides_json,render_state,created,updated)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, batchId, sourceId, ordinal, data.name, data.startFrame, data.endFrame,
        'pending', 'empty', data.profileId ?? null, JSON.stringify(data.overrides || {}), 'idle', stamp, stamp);
      db.prepare('UPDATE batches SET updated=? WHERE id=?').run(stamp, batchId);
      return this.getSegment(id);
    },
    listBatches(userId) {
      return db.prepare('SELECT * FROM batches WHERE user_id=? ORDER BY updated DESC').all(userId).map(batch);
    },
    touchBatch(id) { db.prepare('UPDATE batches SET updated=? WHERE id=?').run(now(), id); },
    updateBatch(id, patch) {
      const row = db.prepare('SELECT * FROM batches WHERE id=?').get(id);
      if (!row) return null;
      const next = { source_id: row.source_id, profile_id: row.profile_id, paused: row.paused, name: row.name, ...{} };
      if ('sourceId' in patch) next.source_id = patch.sourceId;
      if ('profileId' in patch) next.profile_id = patch.profileId;
      if ('paused' in patch) next.paused = patch.paused ? 1 : 0;
      if ('name' in patch) next.name = patch.name;
      db.prepare('UPDATE batches SET name=?, source_id=?, profile_id=?, paused=?, updated=? WHERE id=?')
        .run(next.name, next.source_id, next.profile_id, next.paused, now(), id);
      return this.getBatch(row.user_id, id);
    },
    deleteBatch(userId, id) {
      const row = db.prepare('SELECT * FROM batches WHERE id=? AND user_id=?').get(id, userId);
      if (!row) return null;
      const files = [];
      const sourceRow = row.source_id ? db.prepare('SELECT * FROM batch_sources WHERE id=?').get(row.source_id) : null;
      if (sourceRow) files.push(sourceRow.path, sourceRow.thumbnail);
      for (const out of db.prepare('SELECT path FROM outputs WHERE batch_id=?').all(id)) files.push(out.path);
      for (const job of db.prepare("SELECT id FROM jobs WHERE batch_id=? AND state IN ('waiting','preparing','processing','rendering','validating')").all(id)) files.push(`job:${job.id}`);
      for (const arc of db.prepare('SELECT path FROM archives WHERE batch_id=?').all(id)) files.push(arc.path);
      db.prepare('DELETE FROM caption_tracks WHERE segment_id IN (SELECT id FROM segments WHERE batch_id=?)').run(id);
      db.prepare('DELETE FROM transcript_entries WHERE source_id=?').run(row.source_id || '');
      db.prepare('DELETE FROM outputs WHERE batch_id=?').run(id);
      db.prepare('DELETE FROM jobs WHERE batch_id=?').run(id);
      db.prepare('DELETE FROM segments WHERE batch_id=?').run(id);
      db.prepare('DELETE FROM archives WHERE batch_id=?').run(id);
      db.prepare('DELETE FROM batch_sources WHERE batch_id=?').run(id);
      db.prepare('DELETE FROM batches WHERE id=?').run(id);
      return files.filter(Boolean);
    },
    saveSource(batchId, userId, data) {
      const stamp = now();
      const existing = db.prepare('SELECT id FROM batch_sources WHERE batch_id=?').get(batchId);
      if (existing) db.prepare('DELETE FROM batch_sources WHERE batch_id=?').run(batchId);
      const id = data.id || newId();
      db.prepare(`INSERT INTO batch_sources (id,batch_id,user_id,filename,path,size,duration,width,height,fps_num,fps_den,frames,video_codec,audio_codec,audio_streams,rotation,bitrate,thumbnail,probe_json,created,updated)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        id, batchId, userId, data.filename, data.path, data.size, data.duration, data.width, data.height,
        data.fpsNum, data.fpsDen, data.frames, data.videoCodec ?? null, data.audioCodec ?? null,
        data.audioStreams ?? 0, data.rotation ?? 0, data.bitrate ?? 0, data.thumbnail ?? null,
        data.probe ? JSON.stringify(data.probe) : null, stamp, stamp,
      );
      db.prepare('UPDATE batches SET source_id=?, updated=? WHERE id=?').run(id, stamp, batchId);
      return this.getSource(batchId);
    },
    getSource(batchId) {
      return source(db.prepare('SELECT * FROM batch_sources WHERE batch_id=?').get(batchId));
    },
    getSourceById(id) { return source(db.prepare('SELECT * FROM batch_sources WHERE id=?').get(id)); },
    clearSource(batchId) {
      const current = db.prepare('SELECT * FROM batch_sources WHERE batch_id=?').get(batchId);
      db.prepare('DELETE FROM transcript_entries WHERE source_id=?').run(current?.id || '');
      db.prepare('DELETE FROM batch_sources WHERE batch_id=?').run(batchId);
      db.prepare('UPDATE batches SET source_id=NULL, updated=? WHERE id=?').run(now(), batchId);
      return current ? [current.path, current.thumbnail].filter(Boolean) : [];
    },
    addSegment(batchId, sourceId, data) {
      const id = newId(), stamp = now();
      const ordinal = (db.prepare('SELECT MAX(ordinal) AS max FROM segments WHERE batch_id=?').get(batchId)?.max ?? -1) + 1;
      db.prepare(`INSERT INTO segments (id,batch_id,source_id,ordinal,name,start_frame,end_frame,approval,caption_state,profile_id,overrides_json,render_state,created,updated)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, batchId, sourceId, ordinal, data.name, data.startFrame, data.endFrame,
        data.approval || 'pending', data.captionState || 'empty', data.profileId ?? null, JSON.stringify(data.overrides || {}), 'idle', stamp, stamp);
      db.prepare('UPDATE batches SET updated=? WHERE id=?').run(stamp, batchId);
      return this.getSegment(id);
    },
    getSegment(id) { return segment(db.prepare('SELECT * FROM segments WHERE id=?').get(id)); },
    listSegments(batchId) { return db.prepare('SELECT * FROM segments WHERE batch_id=? ORDER BY ordinal').all(batchId).map(segment); },
    updateSegment(id, patch) {
      const row = db.prepare('SELECT * FROM segments WHERE id=?').get(id);
      if (!row) return null;
      const next = {
        name: 'name' in patch ? patch.name : row.name,
        start_frame: 'startFrame' in patch ? patch.startFrame : row.start_frame,
        end_frame: 'endFrame' in patch ? patch.endFrame : row.end_frame,
        approval: 'approval' in patch ? patch.approval : row.approval,
        caption_state: 'captionState' in patch ? patch.captionState : row.caption_state,
        profile_id: 'profileId' in patch ? patch.profileId : row.profile_id,
        overrides_json: 'overrides' in patch ? JSON.stringify(patch.overrides || {}) : row.overrides_json,
        render_state: 'renderState' in patch ? patch.renderState : row.render_state,
        config_hash: 'configHash' in patch ? patch.configHash : row.config_hash,
        ordinal: 'ordinal' in patch ? patch.ordinal : row.ordinal,
      };
      db.prepare(`UPDATE segments SET name=?, start_frame=?, end_frame=?, approval=?, caption_state=?, profile_id=?, overrides_json=?, render_state=?, config_hash=?, ordinal=?, updated=? WHERE id=?`)
        .run(next.name, next.start_frame, next.end_frame, next.approval, next.caption_state, next.profile_id,
          next.overrides_json, next.render_state, next.config_hash, next.ordinal, now(), id);
      db.prepare('UPDATE batches SET updated=? WHERE id=?').run(now(), row.batch_id);
      return this.getSegment(id);
    },
    deleteSegment(id) {
      const row = db.prepare('SELECT * FROM segments WHERE id=?').get(id);
      if (!row) return false;
      db.prepare('DELETE FROM caption_tracks WHERE segment_id=?').run(id);
      db.prepare('DELETE FROM jobs WHERE segment_id=?').run(id);
      const outputs = db.prepare('SELECT * FROM outputs WHERE segment_id=?').all(id);
      db.prepare('DELETE FROM outputs WHERE segment_id=?').run(id);
      db.prepare('DELETE FROM segments WHERE id=?').run(id);
      db.prepare('UPDATE batches SET updated=? WHERE id=?').run(now(), row.batch_id);
      return outputs.map(r => r.path);
    },
    replaceSegments(batchId, sourceId, list) {
      const old = db.prepare('SELECT id FROM segments WHERE batch_id=?').all(batchId);
      for (const row of old) {
        db.prepare('DELETE FROM caption_tracks WHERE segment_id=?').run(row.id);
        db.prepare('DELETE FROM jobs WHERE segment_id=?').run(row.id);
        db.prepare('DELETE FROM outputs WHERE segment_id=?').run(row.id);
      }
      db.prepare('DELETE FROM segments WHERE batch_id=?').run(batchId);
      return list.map((item, index) => {
        const id = newId(), stamp = now();
        db.prepare(`INSERT INTO segments (id,batch_id,source_id,ordinal,name,start_frame,end_frame,approval,caption_state,profile_id,overrides_json,render_state,created,updated)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, batchId, sourceId, index, item.name, item.startFrame, item.endFrame,
          'pending', 'empty', item.profileId ?? null, JSON.stringify(item.overrides || {}), 'idle', stamp, stamp);
        return id;
      });
    },
    setTranscript(sourceId, entries) {
      db.prepare('DELETE FROM transcript_entries WHERE source_id=?').run(sourceId);
      const insert = db.prepare('INSERT INTO transcript_entries (id,source_id,start_ms,end_ms,text,words_json,speaker,confidence) VALUES (?,?,?,?,?,?,?,?)');
      for (const entry of entries) insert.run(newId(), sourceId, entry.startMs, entry.endMs, entry.text,
        entry.words ? JSON.stringify(entry.words) : null, entry.speaker ?? null, entry.confidence ?? null);
    },
    listTranscript(sourceId) {
      return db.prepare('SELECT * FROM transcript_entries WHERE source_id=? ORDER BY start_ms').all(sourceId).map(row => ({
        id: row.id, startMs: row.start_ms, endMs: row.end_ms, text: row.text,
        words: parse(row.words_json, null), speaker: row.speaker, confidence: row.confidence,
      }));
    },
    setCaptions(segmentId, entries, mode) {
      db.prepare('INSERT INTO caption_tracks (segment_id,entries_json,mode,updated) VALUES (?,?,?,?) ON CONFLICT(segment_id) DO UPDATE SET entries_json=excluded.entries_json, mode=excluded.mode, updated=excluded.updated')
        .run(segmentId, JSON.stringify(entries), mode, now());
      db.prepare('UPDATE segments SET caption_state=?, updated=? WHERE id=?').run(entries.length ? mode : 'empty', now(), segmentId);
    },
    getCaptions(segmentId) {
      const row = db.prepare('SELECT * FROM caption_tracks WHERE segment_id=?').get(segmentId);
      return row ? { entries: parse(row.entries_json, []), mode: row.mode, updated: row.updated } : { entries: [], mode: null, updated: null };
    },
    listProfiles(userId) { return db.prepare('SELECT * FROM profiles WHERE user_id=? ORDER BY created').all(userId).map(profile); },
    getProfile(id) { return profile(db.prepare('SELECT * FROM profiles WHERE id=?').get(id)); },
    createProfile(userId, name, settings) {
      const id = newId(), stamp = now();
      db.prepare('INSERT INTO profiles (id,user_id,name,settings_json,created,updated) VALUES (?,?,?,?,?,?)').run(id, userId, name, JSON.stringify(settings), stamp, stamp);
      return this.getProfile(id);
    },
    updateProfile(id, patch) {
      const row = db.prepare('SELECT * FROM profiles WHERE id=?').get(id);
      if (!row) return null;
      db.prepare('UPDATE profiles SET name=?, settings_json=?, updated=? WHERE id=?')
        .run(patch.name ?? row.name, JSON.stringify(patch.settings ?? parse(row.settings_json, {})), now(), id);
      return this.getProfile(id);
    },
    createJob({ batchId, segmentId, userId, state = 'waiting', config, configVersion, outputId = null }) {
      const id = newId();
      db.prepare('INSERT INTO jobs (id,batch_id,segment_id,user_id,type,state,progress,created,config_version,config_json,output_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, batchId, segmentId, userId, 'render', state, 0, now(), configVersion, JSON.stringify(config), outputId);
      return this.getJob(id);
    },
    getJob(id) { return job(db.prepare('SELECT * FROM jobs WHERE id=?').get(id)); },
    listJobs(batchId) { return db.prepare('SELECT * FROM jobs WHERE batch_id=? ORDER BY created').all(batchId).map(job); },
    listActiveJobs(batchId) { return db.prepare("SELECT * FROM jobs WHERE batch_id=? AND state IN ('waiting','preparing','processing','rendering','validating') ORDER BY created").all(batchId).map(job); },
    listUnfinishedJobs() { return db.prepare("SELECT * FROM jobs WHERE state IN ('preparing','processing','rendering','validating')").all().map(job); },
    listWaitingJobs() { return db.prepare("SELECT * FROM jobs WHERE state='waiting' ORDER BY created").all().map(job); },
    updateJob(id, patch) {
      const row = db.prepare('SELECT * FROM jobs WHERE id=?').get(id);
      if (!row) return null;
      const next = {
        state: 'state' in patch ? patch.state : row.state,
        progress: 'progress' in patch ? patch.progress : row.progress,
        stage: 'stage' in patch ? patch.stage : row.stage,
        started: 'started' in patch ? patch.started : row.started,
        finished: 'finished' in patch ? patch.finished : row.finished,
        retries: 'retries' in patch ? patch.retries : row.retries,
        error: 'error' in patch ? patch.error : row.error,
        output_id: 'outputId' in patch ? patch.outputId : row.output_id,
        cancelled: 'cancelled' in patch ? (patch.cancelled ? 1 : 0) : row.cancelled,
        config_json: 'config' in patch ? JSON.stringify(patch.config) : row.config_json,
        config_version: 'configVersion' in patch ? patch.configVersion : row.config_version,
      };
      db.prepare('UPDATE jobs SET state=?,progress=?,stage=?,started=?,finished=?,retries=?,error=?,output_id=?,cancelled=?,config_json=?,config_version=? WHERE id=?')
        .run(next.state, next.progress, next.stage, next.started, next.finished, next.retries, next.error,
          next.output_id, next.cancelled, next.config_json, next.config_version, id);
      return this.getJob(id);
    },
    createOutput({ jobId, segmentId, batchId, path, filename, size, duration, width, height, fpsNum, fpsDen, videoCodec, audioCodec, configHash }) {
      const id = newId();
      db.prepare(`INSERT INTO outputs (id,job_id,segment_id,batch_id,path,filename,size,duration,width,height,fps_num,fps_den,video_codec,audio_codec,config_hash,validated,created)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, jobId, segmentId, batchId, path, filename, size, duration, width, height,
        fpsNum, fpsDen, videoCodec ?? null, audioCodec ?? null, configHash, 1, now());
      return this.getOutput(id);
    },
    getOutput(id) { return output(db.prepare('SELECT * FROM outputs WHERE id=?').get(id)); },
    listOutputs(batchId) { return db.prepare('SELECT * FROM outputs WHERE batch_id=? ORDER BY created').all(batchId).map(output); },
    deleteOutputsForSegment(segmentId) {
      const rows = db.prepare('SELECT * FROM outputs WHERE segment_id=?').all(segmentId);
      db.prepare('DELETE FROM outputs WHERE segment_id=?').run(segmentId);
      return rows.map(r => r.path);
    },
    createArchive({ batchId, path, filename, size, partial, included, excluded, manifest }) {
      const id = newId();
      db.prepare('INSERT INTO archives (id,batch_id,path,filename,size,partial,included_json,excluded_json,manifest_json,created) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(id, batchId, path, filename, size, partial ? 1 : 0, JSON.stringify(included), JSON.stringify(excluded), JSON.stringify(manifest), now());
      return this.getArchive(id);
    },
    getArchive(id) { return archive(db.prepare('SELECT * FROM archives WHERE id=?').get(id)); },
    latestArchive(batchId) { return archive(db.prepare('SELECT * FROM archives WHERE batch_id=? ORDER BY created DESC LIMIT 1').get(batchId)); },
  };
}

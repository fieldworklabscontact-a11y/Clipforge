import { createHash } from 'node:crypto';

export const DEFAULT_PROFILE = {
  video: { width: 1080, height: 1920, fit: 'cover', x: 0.5, y: 0.5, fps: null, codec: 'h264', crf: 23, preset: 'veryfast', bitrateKbps: null },
  captions: { enabled: true, font: 'Anton', size: 46, position: 'bottom', marginV: 120, color: '#ffffff', outline: '#000000', outlineWidth: 3, group: 'phrase', animation: 'none' },
  branding: { watermark: '', watermarkPosition: 'top-right', watermarkSize: 28 },
  audio: { enabled: true, volume: 1, fadeInMs: 0, fadeOutMs: 0, bitrateKbps: 160 },
};

const clone = value => JSON.parse(JSON.stringify(value));
const finite = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function normalizeProfile(input = {}) {
  const profile = clone(DEFAULT_PROFILE);
  const video = input.video || {};
  profile.video.width = clamp(Math.round(finite(video.width, 1080)), 16, 3840);
  profile.video.height = clamp(Math.round(finite(video.height, 1920)), 16, 3840);
  profile.video.fit = video.fit === 'contain' ? 'contain' : 'cover';
  profile.video.x = clamp(finite(video.x, 0.5), 0, 1);
  profile.video.y = clamp(finite(video.y, 0.5), 0, 1);
  profile.video.fps = video.fps ? clamp(finite(video.fps, 30), 1, 120) : null;
  profile.video.codec = 'h264';
  profile.video.crf = clamp(Math.round(finite(video.crf, 23)), 0, 51);
  profile.video.preset = typeof video.preset === 'string' && video.preset.length < 20 ? video.preset : 'veryfast';
  profile.video.bitrateKbps = video.bitrateKbps ? clamp(Math.round(finite(video.bitrateKbps, 0)), 100, 100000) : null;
  const captions = input.captions || {};
  profile.captions.enabled = captions.enabled !== false;
  profile.captions.font = captions.font === 'IBM Plex Mono' ? 'IBM Plex Mono' : 'Anton';
  profile.captions.size = clamp(Math.round(finite(captions.size, 46)), 12, 200);
  profile.captions.position = ['top', 'center', 'bottom'].includes(captions.position) ? captions.position : 'bottom';
  profile.captions.marginV = clamp(Math.round(finite(captions.marginV, 120)), 0, 800);
  profile.captions.color = /^#[0-9a-f]{6}$/i.test(captions.color || '') ? captions.color : '#ffffff';
  profile.captions.outline = /^#[0-9a-f]{6}$/i.test(captions.outline || '') ? captions.outline : '#000000';
  profile.captions.outlineWidth = clamp(finite(captions.outlineWidth, 3), 0, 12);
  profile.captions.group = captions.group === 'word' ? 'word' : 'phrase';
  profile.captions.animation = 'none';
  const branding = input.branding || {};
  profile.branding.watermark = typeof branding.watermark === 'string' ? branding.watermark.slice(0, 80) : '';
  profile.branding.watermarkPosition = ['top-left', 'top-right', 'bottom-left', 'bottom-right'].includes(branding.watermarkPosition) ? branding.watermarkPosition : 'top-right';
  profile.branding.watermarkSize = clamp(Math.round(finite(branding.watermarkSize, 28)), 10, 120);
  const audio = input.audio || {};
  profile.audio.enabled = audio.enabled !== false;
  profile.audio.volume = clamp(finite(audio.volume, 1), 0, 4);
  profile.audio.fadeInMs = clamp(Math.round(finite(audio.fadeInMs, 0)), 0, 60000);
  profile.audio.fadeOutMs = clamp(Math.round(finite(audio.fadeOutMs, 0)), 0, 60000);
  profile.audio.bitrateKbps = clamp(Math.round(finite(audio.bitrateKbps, 160)), 32, 512);
  return profile;
}

export function mergeProfile(base, override = {}) {
  const merged = clone(base || DEFAULT_PROFILE);
  for (const section of Object.keys(override || {})) {
    if (!merged[section] || typeof override[section] !== 'object') continue;
    Object.assign(merged[section], override[section]);
  }
  return normalizeProfile(merged);
}

const stable = value => JSON.stringify(value, Object.keys(value || {}).sort());
export function configHash(config) {
  return createHash('sha256').update(JSON.stringify(config, (key, value) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) return Object.keys(value).sort().reduce((acc, item) => { acc[item] = value[item]; return acc; }, {});
    return value;
  })).digest('hex');
}

export const segmentSeconds = (segment, fpsNum, fpsDen) => ({
  start: (segment.startFrame * fpsDen) / fpsNum,
  end: (segment.endFrame * fpsDen) / fpsNum,
  duration: ((segment.endFrame - segment.startFrame) * fpsDen) / fpsNum,
});

export function validateBounds({ startFrame, endFrame, totalFrames }) {
  if (!Number.isInteger(startFrame) || !Number.isInteger(endFrame)) throw new Error('Segment boundaries must be whole frames.');
  if (startFrame < 0) throw new Error('A segment cannot start before the source begins.');
  if (endFrame <= startFrame) throw new Error('A segment must end after it starts.');
  if (endFrame > totalFrames) throw new Error(`A segment cannot end after the source ends (${totalFrames} frames).`);
  return true;
}

export function findOverlaps(segments) {
  const sorted = [...segments].sort((a, b) => a.startFrame - b.startFrame);
  const conflicts = [];
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index].startFrame < sorted[index - 1].endFrame) {
      conflicts.push([sorted[index - 1].id, sorted[index].id]);
    }
  }
  return conflicts;
}

/**
 * Equal-duration segmentation. `shortFinal` decides what happens to a tail that
 * would be shorter than the minimum: keep it, merge it into the previous clip,
 * or drop it. Overlap is allowed and counted in frames.
 */
export function equalSegments({ totalFrames, fpsNum, fpsDen, targetSeconds, overlapSeconds = 0, minSeconds = 0, shortFinal = 'keep', namePrefix = 'Clip' }) {
  if (!Number.isFinite(targetSeconds) || targetSeconds <= 0) throw new Error('Enter a target clip duration greater than zero.');
  const target = Math.max(1, Math.round(targetSeconds * (fpsNum / fpsDen)));
  const overlap = Math.max(0, Math.round((overlapSeconds || 0) * (fpsNum / fpsDen)));
  const minimum = Math.max(0, Math.round((minSeconds || 0) * (fpsNum / fpsDen)));
  if (overlap >= target) throw new Error('Overlap must be shorter than the target clip duration.');
  if (minimum >= target) throw new Error('Minimum duration must be shorter than the target clip duration.');
  const step = Math.max(1, target - overlap);
  const list = [];
  for (let start = 0; start < totalFrames; start += step) {
    const end = Math.min(totalFrames, start + target);
    if (end - start < 1) break;
    const tooShort = minimum > 0 && end - start < minimum;
    if (tooShort) {
      if (shortFinal === 'drop') break;
      if (shortFinal === 'merge' && list.length) { list[list.length - 1].endFrame = totalFrames; break; }
      if (shortFinal === 'merge') { list.push({ startFrame: start, endFrame: totalFrames }); break; }
    }
    list.push({ startFrame: start, endFrame: end });
    if (list.length >= 500) break;
  }
  return list.map((item, index) => ({ ...item, name: `${namePrefix} ${String(index + 1).padStart(3, '0')}` }));
}

const pad = (value, size = 2) => String(value).padStart(size, '0');
export function msToSrtTime(ms) {
  const total = Math.max(0, Math.round(ms));
  const hours = Math.floor(total / 3600000);
  const minutes = Math.floor((total % 3600000) / 60000);
  const seconds = Math.floor((total % 60000) / 1000);
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)},${pad(total % 1000, 3)}`;
}

const assTime = ms => {
  const total = Math.max(0, Math.round(ms));
  const hours = Math.floor(total / 3600000);
  const minutes = Math.floor((total % 3600000) / 60000);
  const seconds = Math.floor((total % 60000) / 1000);
  const centis = Math.floor((total % 1000) / 10);
  return `${hours}:${pad(minutes)}:${pad(seconds)}.${pad(centis)}`;
};
const assColour = value => {
  const match = /^#?([0-9a-f]{6})$/i.exec(String(value || '').trim());
  const rgb = match ? match[1] : 'ffffff';
  return `&H00${rgb.slice(4, 6)}${rgb.slice(2, 4)}${rgb.slice(0, 2)}`.toUpperCase();
};
const assText = text => String(text).replace(/\r?\n/g, '\\N').replace(/\{/g, '(').replace(/\}/g, ')');

/**
 * Burned captions are authored as ASS rather than overriding an SRT style: with
 * PlayRes set to the output size, font size and alignment map to real pixels.
 */
export function toAss(entries, style, { width, height }) {
  const alignment = style.position === 'top' ? 8 : style.position === 'center' ? 5 : 2;
  const fontSize = Math.max(12, Math.round(style.size * height / 1080));
  const marginV = Math.round((style.marginV || 0) * height / 1080);
  const marginH = Math.round(width * 0.06);
  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Default,${style.font},${fontSize},${assColour(style.color)},&H000000FF,${assColour(style.outline)},&H00000000,0,0,0,0,100,100,0,0,1,${Number(style.outlineWidth) || 0},0,${alignment},${marginH},${marginH},${marginV},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ].join('\n');
  const events = (entries || []).filter(entry => entry.endMs > entry.startMs && entry.text).map(entry =>
    `Dialogue: 0,${assTime(entry.startMs)},${assTime(entry.endMs)},Default,,0,0,0,,${assText(entry.text)}`).join('\n');
  return `${header}\n${events}\n`;
}

export function toSrt(entries) {
  return entries.map((entry, index) => `${index + 1}\n${msToSrtTime(entry.startMs)} --> ${msToSrtTime(entry.endMs)}\n${entry.text}\n`).join('\n');
}

const srtTime = value => {
  const match = /(\d+):(\d+):(\d+)[,.](\d+)/.exec(value || '');
  if (!match) return null;
  return ((Number(match[1]) * 3600) + (Number(match[2]) * 60) + Number(match[3])) * 1000 + Number(match[4].padEnd(3, '0').slice(0, 3));
};

export function parseSrt(text) {
  const blocks = String(text || '').replace(/\r\n/g, '\n').trim().split(/\n{2,}/);
  const entries = [];
  for (const block of blocks) {
    const lines = block.split('\n').filter(line => line.trim() !== '');
    if (!lines.length) continue;
    const timingIndex = lines.findIndex(line => line.includes('-->'));
    if (timingIndex === -1) continue;
    const [from, to] = lines[timingIndex].split('-->').map(part => part.trim().split(' ')[0]);
    const startMs = srtTime(from);
    const endMs = srtTime(to);
    const textLines = lines.slice(timingIndex + 1);
    if (startMs == null || endMs == null || endMs <= startMs || !textLines.length) continue;
    entries.push({ startMs, endMs, text: textLines.join('\n') });
  }
  if (!entries.length) throw new Error('No usable subtitle cues were found in that file.');
  return entries.sort((a, b) => a.startMs - b.startMs);
}

/**
 * Convert source-level transcript entries into clip-relative captions:
 * clip_timestamp = source_timestamp - segment_start, then clamped to the clip.
 */
export function captionsForSegment(entries, { startFrame, endFrame, fpsNum, fpsDen, group = 'phrase', maxGapMs = 280 }) {
  const startMs = Math.round((startFrame * fpsDen * 1000) / fpsNum);
  const endMs = Math.round((endFrame * fpsDen * 1000) / fpsNum);
  const durationMs = endMs - startMs;
  const picked = [];
  for (const entry of entries || []) {
    const from = Math.max(entry.startMs, startMs);
    const to = Math.min(entry.endMs, endMs);
    if (to <= from) continue;
    const text = String(entry.text || '').trim();
    if (!text) continue;
    if (group === 'word' && Array.isArray(entry.words) && entry.words.length) {
      for (const word of entry.words) {
        const wordFrom = Math.max(word.startMs ?? entry.startMs, startMs);
        const wordTo = Math.min(word.endMs ?? entry.endMs, endMs);
        if (wordTo <= wordFrom || !word.text) continue;
        picked.push({ startMs: wordFrom - startMs, endMs: wordTo - startMs, text: String(word.text).trim(), speaker: word.speaker ?? entry.speaker ?? null });
      }
      continue;
    }
    picked.push({ startMs: from - startMs, endMs: to - startMs, text, speaker: entry.speaker ?? null });
  }
  const sorted = picked.sort((a, b) => a.startMs - b.startMs);
  if (group === 'word') return sorted.filter(entry => entry.endMs <= durationMs && entry.endMs > entry.startMs);
  const merged = [];
  for (const entry of sorted) {
    const previous = merged[merged.length - 1];
    if (previous && entry.startMs - previous.endMs <= maxGapMs) {
      previous.text = `${previous.text} ${entry.text}`.replace(/\s+/g, ' ').trim();
      previous.endMs = Math.max(previous.endMs, entry.endMs);
    } else merged.push({ ...entry });
  }
  return merged.map(entry => ({
    startMs: clamp(entry.startMs, 0, durationMs),
    endMs: clamp(entry.endMs, 0, durationMs),
    text: entry.text,
    speaker: entry.speaker ?? null,
  })).filter(entry => entry.endMs > entry.startMs && entry.text);
}

export function manifestFor({ batch, source, included, excluded, clipMeta }) {
  return {
    batchId: batch.id,
    batchName: batch.name,
    source: { filename: source?.filename ?? null, duration: source?.duration ?? null, width: source?.width ?? null, height: source?.height ?? null },
    createdAt: new Date().toISOString(),
    partial: excluded.length > 0,
    clips: included.map((item, index) => {
      const meta = clipMeta.find(entry => entry.segmentId === item.segmentId) || {};
      return {
        file: `videos/${item.filename}`,
        segmentId: item.segmentId,
        name: meta.name ?? item.filename,
        sourceStartSeconds: meta.startSeconds ?? null,
        sourceEndSeconds: meta.endSeconds ?? null,
        durationSeconds: item.duration,
        width: item.width,
        height: item.height,
        fps: item.fpsNum && item.fpsDen ? Number((item.fpsNum / item.fpsDen).toFixed(3)) : null,
        captionsIncluded: !!item.captions,
        jobStatus: 'completed',
      };
    }),
    excluded: excluded.map(item => ({ segmentId: item.segmentId, name: item.name ?? null, reason: item.reason })),
    archiveStructure: ['videos/', 'subtitles/', 'thumbnails/', 'manifest.json'],
  };
}

export function batchCounts(segments, jobs) {
  const active = new Set(['waiting', 'preparing', 'processing', 'rendering', 'validating']);
  return {
    total: segments.length,
    approved: segments.filter(segment => segment.approval === 'approved').length,
    pending: segments.filter(segment => segment.approval === 'pending').length,
    rejected: segments.filter(segment => segment.approval === 'rejected').length,
    rendered: segments.filter(segment => segment.renderState === 'ready').length,
    stale: segments.filter(segment => segment.renderState === 'stale').length,
    queued: jobs.filter(job => active.has(job.state)).length,
    completed: jobs.filter(job => job.state === 'completed').length,
    failed: jobs.filter(job => job.state === 'failed').length,
    cancelled: jobs.filter(job => job.state === 'cancelled').length,
  };
}

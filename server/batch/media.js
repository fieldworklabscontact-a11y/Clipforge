import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const optional = name => { try { return require(name); } catch { return null; } };

/** Resolve the media engine without requiring a system install. */
export function toolPaths() {
  const ffmpegPath = optional('ffmpeg-static');
  const ffprobePath = optional('ffprobe-static')?.path;
  const ffmpeg = process.env.FFMPEG_PATH || (typeof ffmpegPath === 'string' ? ffmpegPath : null);
  const ffprobe = process.env.FFPROBE_PATH || ffprobePath || null;
  return { ffmpeg, ffprobe };
}

export function toolsAvailable() {
  const { ffmpeg, ffprobe } = toolPaths();
  return !!(ffmpeg && ffprobe && existsSync(ffmpeg) && existsSync(ffprobe));
}

export const FONTS_DIR = path.resolve('assets/fonts');
const FONT_CACHE = path.resolve('data/fontcache');
const FONT_CONF = path.join(FONT_CACHE, 'fonts.conf');

/**
 * libass needs fontconfig to resolve the bundled fonts, but it treats every file
 * inside `fontsdir` as a font, so the config must live outside that directory.
 */
const fontEnv = () => {
  const conf = `<?xml version="1.0"?>\n<!DOCTYPE fontconfig SYSTEM "fonts.dtd">\n<fontconfig>\n  <dir>${FONTS_DIR}</dir>\n  <cachedir>${FONT_CACHE}</cachedir>\n</fontconfig>\n`;
  try {
    mkdirSync(FONT_CACHE, { recursive: true });
    if (!existsSync(FONT_CONF) || readFileSync(FONT_CONF, 'utf8') !== conf) writeFileSync(FONT_CONF, conf);
  } catch { /* libass may still find the fonts through fontsdir */ }
  return { FONTCONFIG_FILE: FONT_CONF, FONTCONFIG_PATH: FONT_CACHE };
};

function runCapture(bin, args, { timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Media inspection timed out.')); }, timeoutMs);
    child.stdout.on('data', chunk => { out += chunk; });
    child.stderr.on('data', chunk => { err += chunk; });
    child.on('error', error => { clearTimeout(timer); reject(new Error(`Could not start the media engine: ${error.message}`)); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(err.trim().split('\n').slice(-3).join(' ') || `Media engine exited with code ${code}.`));
      resolve(out);
    });
  });
}

export function parseRate(value) {
  if (typeof value !== 'string') return null;
  const [num, den] = value.split('/').map(Number);
  if (!Number.isFinite(num) || !Number.isFinite(den) || num <= 0 || den <= 0) return null;
  const fps = num / den;
  if (!Number.isFinite(fps) || fps <= 0 || fps > 240) return null;
  return { num: Math.round(num), den: Math.round(den), fps };
}

export const frameToSeconds = (frame, num, den) => (frame * den) / num;
export const msToFrame = (ms, num, den) => Math.floor((ms / 1000) * (num / den));
export const secondsToFrame = (seconds, num, den) => Math.floor(seconds * (num / den));

/** Inspect a media file. Rejects when the browser/engine cannot read usable video. */
export async function probe(file) {
  const { ffprobe } = toolPaths();
  if (!ffprobe || !existsSync(ffprobe)) throw new Error('The media engine is not installed, so media cannot be inspected.');
  if (!existsSync(file)) throw new Error('The source file is missing from storage.');
  const raw = await runCapture(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
  const info = JSON.parse(raw);
  const streams = Array.isArray(info.streams) ? info.streams : [];
  const video = streams.find(stream => stream.codec_type === 'video' && stream.disposition?.attached_pic !== 1);
  const audio = streams.find(stream => stream.codec_type === 'audio');
  const duration = Number(info.format?.duration ?? video?.duration);
  if (!video) throw new Error('This file has no video track that ClipForge can read.');
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('This file has no usable duration.');
  const rate = parseRate(video.avg_frame_rate) || parseRate(video.r_frame_rate) || { num: 30, den: 1, fps: 30 };
  const rotation = Number(video.tags?.rotate ?? video.side_data_list?.find(item => item.rotation !== undefined)?.rotation ?? 0) || 0;
  const frames = Math.max(1, Math.floor(duration * (rate.num / rate.den)));
  return {
    duration, width: Number(video.width) || 0, height: Number(video.height) || 0,
    fpsNum: rate.num, fpsDen: rate.den, fps: rate.fps, frames,
    videoCodec: video.codec_name ?? null, audioCodec: audio?.codec_name ?? null,
    audioStreams: streams.filter(stream => stream.codec_type === 'audio').length,
    rotation, bitrate: Number(info.format?.bit_rate) || 0, probe: info,
  };
}

export async function makeThumbnail(sourcePath, atSeconds, outPath) {
  const { ffmpeg } = toolPaths();
  await runCapture(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(Math.max(0, atSeconds)), '-i', sourcePath,
    '-frames:v', '1', '-vf', 'scale=360:-2', '-q:v', '4', outPath], { timeoutMs: 60000 });
  if (!existsSync(outPath) || statSync(outPath).size === 0) throw new Error('The thumbnail could not be written.');
  return outPath;
}

const escapeFilterPath = value => value.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'").replace(/,/g, '\\,').replace(/\[/g, '\\[').replace(/\]/g, '\\]');

/** Build the ffmpeg filter graph for a clip. Exported for tests. */
export function buildVideoFilter({ width, height, fit = 'cover', x = 0.5, y = 0.5, fps = null, captionsPath = null, style = null }) {
  const parts = [];
  if (fit === 'contain') {
    parts.push(`scale=${width}:${height}:force_original_aspect_ratio=decrease:flags=lanczos`);
    parts.push(`pad=${width}:${height}:(ow-iw)*${x}:(oh-ih)*${y}:color=black`);
  } else {
    parts.push(`scale=${width}:${height}:force_original_aspect_ratio=increase:flags=lanczos`);
    parts.push(`crop=${width}:${height}:(iw-ow)*${x}:(ih-oh)*${y}`);
  }
  parts.push('setsar=1');
  if (fps) parts.push(`fps=${fps}`);
  if (captionsPath) parts.push(`subtitles=filename=${escapeFilterPath(captionsPath)}:fontsdir=${escapeFilterPath(FONTS_DIR)}`);
  return parts.join(',');
}

export function buildAudioFilter({ volume = 1, fadeInMs = 0, fadeOutMs = 0 }, durationSeconds) {
  const parts = [];
  if (Number(volume) && Number(volume) !== 1) parts.push(`volume=${Number(volume)}`);
  if (fadeInMs > 0) parts.push(`afade=t=in:st=0:d=${(fadeInMs / 1000).toFixed(3)}`);
  if (fadeOutMs > 0) {
    const start = Math.max(0, durationSeconds - fadeOutMs / 1000);
    parts.push(`afade=t=out:st=${start.toFixed(3)}:d=${(fadeOutMs / 1000).toFixed(3)}`);
  }
  return parts.join(',');
}

/**
 * Render one segment. Progress is reported from ffmpeg's own progress stream.
 * The output is written to `outputPath` only after ffmpeg exits successfully;
 * callers still validate the file before treating it as complete.
 */
export function renderClip({ sourcePath, startSeconds, durationSeconds, profile, captionsPath, outputPath, onProgress, signal }) {
  const { ffmpeg } = toolPaths();
  if (!ffmpeg || !existsSync(ffmpeg)) return Promise.reject(new Error('The media engine is not installed, so clips cannot be rendered.'));
  const videoFilter = buildVideoFilter({
    width: profile.video.width, height: profile.video.height, fit: profile.video.fit,
    x: profile.video.x, y: profile.video.y, fps: profile.video.fps || null,
    captionsPath: captionsPath && profile.captions.enabled ? captionsPath : null,
    style: profile.captions,
  });
  const audioFilter = buildAudioFilter(profile.audio, durationSeconds);
  const args = ['-hide_banner', '-loglevel', 'error', '-y',
    '-ss', Math.max(0, startSeconds).toFixed(3), '-i', sourcePath, '-t', Math.max(0.05, durationSeconds).toFixed(3),
    '-vf', videoFilter,
    '-c:v', 'libx264', '-preset', profile.video.preset || 'veryfast', '-crf', String(profile.video.crf ?? 23),
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart'];
  if (audioFilter) args.push('-af', audioFilter);
  if (profile.audio.enabled === false) args.push('-an');
  else args.push('-c:a', 'aac', '-b:a', `${profile.audio.bitrateKbps || 160}k`);
  args.push('-progress', 'pipe:1', '-nostats', outputPath);

  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...fontEnv() } });
    let stderr = '', buffer = '';
    const abort = () => { try { child.kill('SIGKILL'); } catch { /* already stopped */ } };
    if (signal?.aborted) { abort(); return reject(Object.assign(new Error('Render cancelled.'), { cancelled: true })); }
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', chunk => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const [key, value] = line.split('=');
        if (key === 'out_time_us' && Number(value) > 0 && durationSeconds > 0) {
          onProgress?.(Math.min(0.99, Number(value) / 1e6 / durationSeconds));
        }
      }
    });
    child.stderr.on('data', chunk => { stderr += chunk; if (stderr.length > 8000) stderr = stderr.slice(-8000); });
    child.on('error', error => { signal?.removeEventListener('abort', abort); reject(new Error(`Could not start the media engine: ${error.message}`)); });
    child.on('close', code => {
      signal?.removeEventListener('abort', abort);
      if (signal?.aborted) return reject(Object.assign(new Error('Render cancelled.'), { cancelled: true }));
      if (code !== 0) return reject(new Error(stderr.trim().split('\n').slice(-4).join(' ') || `Encoding failed with exit code ${code}.`));
      onProgress?.(1);
      resolve({ code });
    });
  });
}

/** Validate a finished render before it is allowed into the ZIP. */
export async function validateOutput(file, expected) {
  const problems = [];
  if (!existsSync(file)) return { ok: false, problems: ['The output file is missing.'] };
  const size = statSync(file).size;
  if (size === 0) problems.push('The output file is empty.');
  let info = null;
  try { info = await probe(file); } catch (error) { problems.push(error.message); }
  if (info) {
    const tolerance = Math.max(0.4, (expected.fpsDen ?? 1) / (expected.fpsNum ?? 30) * 4);
    if (Math.abs(info.duration - expected.duration) > tolerance) problems.push(`Expected ${expected.duration.toFixed(2)}s but the output is ${info.duration.toFixed(2)}s.`);
    if (expected.width && info.width !== expected.width) problems.push(`Expected ${expected.width}px wide but the output is ${info.width}px.`);
    if (expected.height && info.height !== expected.height) problems.push(`Expected ${expected.height}px high but the output is ${info.height}px.`);
    if (expected.expectAudio && !info.audioCodec) problems.push('The source has audio but the output does not.');
    if (!expected.expectAudio && info.audioCodec) problems.push('The output has audio that the profile did not request.');
  }
  return { ok: problems.length === 0, problems, size, info };
}

/** Cheap source fingerprint so jobs can notice a replaced source file. */
export function sourceFingerprint(file) {
  if (!existsSync(file)) return 'missing';
  const stat = statSync(file);
  return `${stat.size}:${Math.round(stat.mtimeMs)}`;
}

import { activeClip, endFrame } from './model.js';
export function clampFrame(project, frame) { return Math.max(0, Math.min(Math.max(0, endFrame(project)-1), Math.round(frame))); }
export function sourceTime(clip, frame, fps) { return (clip.sourceIn + frame - clip.start) / fps; }
export function frameFromSource(clip, time, fps) { return Math.min(clip.start + clip.duration, Math.max(clip.start, clip.start + Math.floor(time * fps) - clip.sourceIn)); }
export function playbackStep(project, frame, video, elapsedMs) {
  const clip = activeClip(project, frame);
  if (!clip) return { frame: Math.min(endFrame(project), frame + Math.floor(elapsedMs * project.settings.fps / 1000)), blocked: false };
  if (!video || video.readyState < 3 || video.seeking || video.paused) return { frame, blocked: true };
  return { frame: frameFromSource(clip, video.currentTime, project.settings.fps), blocked: false };
}

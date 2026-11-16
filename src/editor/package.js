// Export packaging: a ZIP of the project document, captions and the original
// source media. Nothing here encodes video; that remains a separate pipeline.
const encoder = new TextEncoder();
export const textBytes = text => encoder.encode(text).length;

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${(bytes / 1073741824).toFixed(2)} GB`;
}

export function safeFileName(name, fallback = 'asset') {
  const base = String(name ?? '').split(/[\\/]/).pop().replace(/\.[^.]+$/, '');
  const cleaned = base.normalize('NFKD').replace(/[^A-Za-z0-9 _-]+/g, '').trim().replace(/[ _]+/g, '-');
  return (cleaned || fallback).slice(0, 60).toLowerCase();
}

const extensions = { 'video/webm': '.webm', 'video/mp4': '.mp4', 'video/quicktime': '.mov', 'video/ogg': '.ogv', 'video/x-matroska': '.mkv' };
export function mediaExtension(asset) {
  const named = String(asset?.name ?? '').match(/\.([a-z0-9]{2,5})$/i);
  if (named) return `.${named[1].toLowerCase()}`;
  return extensions[asset?.mime] || '.bin';
}

const pad = value => String(value).padStart(2, '0');
export function srtStamp(frame, fps) {
  const ms = Math.max(0, Math.round((frame / fps) * 1000));
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor(ms / 60000) % 60;
  const seconds = Math.floor(ms / 1000) % 60;
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)},${String(ms % 1000).padStart(3, '0')}`;
}

export function captionSrt(project) {
  const fps = project.settings.fps;
  return [...project.captions]
    .sort((a, b) => a.start - b.start)
    .map((caption, index) => `${index + 1}\n${srtStamp(caption.start, fps)} --> ${srtStamp(caption.start + caption.duration, fps)}\n${caption.text}\n`)
    .join('\n');
}

const stamp = () => new Date().toISOString().slice(0, 10);

export function describePackage(project, { name = 'project', scope = 'timeline', missing = [] } = {}) {
  const missingSet = new Set(missing);
  const used = new Set(project.clips.map(clip => clip.assetId));
  const assets = project.assets.filter(asset => scope === 'all' || used.has(asset.id));
  const projectText = JSON.stringify({
    application: 'ClipForge Studio',
    exportedAt: new Date().toISOString(),
    name,
    note: 'This package contains the project document, captions and original source media. It is not a rendered video.',
    schema: project.schema,
    data: project,
  }, null, 2);
  const srt = captionSrt(project);
  const entries = [
    { kind: 'project', name: 'project.json', label: 'Project document', bytes: textBytes(projectText), available: true, text: projectText },
    ...(project.captions.length ? [{ kind: 'captions', name: 'captions.srt', label: 'Captions', bytes: textBytes(srt), available: true, text: srt }] : []),
    ...assets.map(asset => ({
      kind: 'media',
      name: `media/${safeFileName(asset.name)}-${asset.id.slice(0, 6)}${mediaExtension(asset)}`,
      label: asset.name,
      assetId: asset.id,
      bytes: Number(asset.size) || 0,
      available: !missingSet.has(asset.id),
      reason: missingSet.has(asset.id) ? 'Source file is not in this browser’s storage' : '',
    })),
  ];
  const manifestText = JSON.stringify({
    application: 'ClipForge Studio',
    exportedAt: new Date().toISOString(),
    project: name,
    scope,
    note: 'Original source media only. No rendered video is included.',
    files: entries.map(({ kind, name: file, bytes, available, reason }) => ({ kind, file, bytes, included: available, ...(reason ? { reason } : {}) })),
  }, null, 2);
  entries.push({ kind: 'manifest', name: 'manifest.json', label: 'Package manifest', bytes: textBytes(manifestText), available: true, text: manifestText });
  const totalBytes = entries.filter(entry => entry.available).reduce((sum, entry) => sum + entry.bytes, 0);
  return {
    fileName: `${safeFileName(name, 'project')}-${stamp()}.zip`,
    scope,
    entries,
    omitted: entries.filter(entry => entry.kind === 'media' && !entry.available),
    totalBytes,
  };
}

// Loads the actual media blobs, so a package only contains files this browser can
// still read. Missing sources are reported rather than silently dropped.
export async function assemblePackage(project, { name, scope = 'timeline', loadAsset } = {}) {
  const used = new Set(project.clips.map(clip => clip.assetId));
  const assets = project.assets.filter(asset => scope === 'all' || used.has(asset.id));
  const blobs = new Map();
  const missing = [];
  for (const asset of assets) {
    const blob = await loadAsset(asset.id);
    if (blob) blobs.set(asset.id, blob); else missing.push(asset.id);
  }
  const description = describePackage(project, { name, scope, missing });
  const entries = description.entries
    .filter(entry => entry.available)
    .map(entry => ({
      name: entry.name,
      bytes: entry.bytes,
      blob: entry.kind === 'media'
        ? blobs.get(entry.assetId)
        : new Blob([entry.text], { type: entry.kind === 'captions' ? 'text/plain' : 'application/json' }),
    }))
    .filter(entry => entry.blob instanceof Blob);
  return { description, entries };
}

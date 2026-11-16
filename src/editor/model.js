export const SCHEMA = 1;
export const defaultSettings = { width: 1080, height: 1920, fps: 30, audioSampleRate: 48000 };
export function createProject(settings = defaultSettings) {
  return { schema: SCHEMA, settings: { ...settings }, assets: [], clips: [], captions: [] };
}
export function validateProject(data) {
  if (!data || data.schema !== SCHEMA) throw new Error('This project uses an unsupported editor version. Its data was not changed.');
  const s = data.settings;
  if (!s || !Number.isInteger(s.width) || !Number.isInteger(s.height) || s.width < 16 || s.height < 16 || s.width > 3840 || s.height > 3840 || !Number.isFinite(s.fps) || s.fps < 1 || s.fps > 60 || !Number.isInteger(s.audioSampleRate) || s.audioSampleRate < 8000 || s.audioSampleRate > 192000 || !Array.isArray(data.assets) || !Array.isArray(data.clips) || !Array.isArray(data.captions)) throw new Error('Project data is invalid. The original project has not been changed.');
  const ids = new Set();
  for (const asset of data.assets) {
    if (typeof asset.id !== 'string' || !asset.id || ids.has(asset.id) || typeof asset.name !== 'string' || !Number.isSafeInteger(asset.frames) || asset.frames < 1) throw new Error('Invalid project asset. The original project has not been changed.');
    ids.add(asset.id);
  }
  const sorted = [...data.clips].sort((a,b)=>a.start-b.start);
  const clipIds = new Set();
  let end = 0;
  for (const clip of sorted) {
    const asset = data.assets.find(a=>a.id===clip.assetId);
    if (typeof clip.id !== 'string' || !clip.id || clipIds.has(clip.id) || !asset || !Number.isSafeInteger(clip.start) || !Number.isSafeInteger(clip.sourceIn) || !Number.isSafeInteger(clip.duration) || !Number.isSafeInteger(clip.start + clip.duration) || clip.start < end || clip.sourceIn < 0 || clip.duration < 1 || clip.sourceIn + clip.duration > asset.frames) throw new Error('Invalid timeline clip. The original project has not been changed.');
    clipIds.add(clip.id); end = clip.start + clip.duration;
  }
  const captionIds = new Set();
  for (const caption of data.captions) { if (typeof caption.id !== 'string' || !caption.id || captionIds.has(caption.id) || typeof caption.text !== 'string' || !Number.isSafeInteger(caption.start) || !Number.isSafeInteger(caption.duration) || !Number.isSafeInteger(caption.start + caption.duration) || caption.start < 0 || caption.duration < 1) throw new Error('Invalid caption. The original project has not been changed.'); captionIds.add(caption.id); }
  return data;
}
export const endFrame = project => Math.max(0, ...project.clips.map(c=>c.start+c.duration), ...project.captions.map(c=>c.start+c.duration));
export const activeClip = (project, frame) => project.clips.find(c=>frame>=c.start && frame<c.start+c.duration);
export function appendAsset(project, asset) {
  if (project.assets.some(a=>a.id===asset.id)) return project;
  return { ...project, assets: [...project.assets, asset] };
}
export function placeClip(project, assetId, id) {
  const asset=project.assets.find(a=>a.id===assetId); if (!asset) throw new Error('Media not found.');
  const start=Math.max(0,...project.clips.map(c=>c.start+c.duration));
  return {...project,clips:[...project.clips,{id,assetId,start,sourceIn:0,duration:asset.frames}]};
}
export function changeClip(project, id, patch) {
  const clip=project.clips.find(c=>c.id===id); if (!clip) return project;
  const next={...clip,...patch};
  const result={...project,clips:project.clips.map(c=>c.id===id?next:c)};
  return validateProject(result);
}
export function splitClip(project,id,frame,newId) {
  const clip=project.clips.find(c=>c.id===id); if (!clip || frame<=clip.start || frame>=clip.start+clip.duration) throw new Error('Place the playhead inside the selected clip before splitting.');
  const left=frame-clip.start;
  return validateProject({...project, clips:project.clips.flatMap(c=>c.id!==id?[c]:[{...c,duration:left},{...c,id:newId,start:frame,sourceIn:c.sourceIn+left,duration:c.duration-left}])});
}
export function removeClip(project,id) { return {...project,clips:project.clips.filter(c=>c.id!==id)}; }
export function frameTime(frame, fps) { const seconds=frame/fps; const totalSeconds=Math.floor(seconds); const m=Math.floor(totalSeconds/60),s=totalSeconds%60,f=frame-Math.ceil(totalSeconds*fps); return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}:${String(Math.max(0,f)).padStart(2,'0')}`; }

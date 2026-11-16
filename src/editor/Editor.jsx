import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useBlocker, useNavigate } from 'react-router-dom';
import { createProject, validateProject, appendAsset, placeClip, changeClip, splitClip, removeClip, activeClip, endFrame, frameTime } from './model.js';
import { putMedia, getMedia, inspectVideo, deleteMedia, putPackage, getPackage, deletePackage } from './media.js';
import { readRecovery, removeRecovery, recoveryDisposition } from './recovery.js';
import { createSaveSession } from './session.js';
import { clampFrame, sourceTime, playbackStep } from './playback.js';
import { describePackage, assemblePackage, formatBytes } from './package.js';
import { downloadZip, zipBlob } from './zip.js';
import { createJob, advance, drainQueue, readQueue, writeQueue } from './queue.js';
import './editor.css';

const presets = { Vertical:[1080,1920], 'Full HD':[1920,1080], Square:[1080,1080], QHD:[2560,1440], UHD:[3840,2160], Custom:null };
const id = () => crypto.randomUUID();
const SAVE_STATE = { Saved:'ok', Saving:'busy', 'Unsaved changes':'dirty', 'Save failed':'bad' };

function Kicker({ children, right }) {
  return <div className="ed-kicker">{children}{right && <span>{right}</span>}</div>;
}

function PanelHead({ index, label, meta }) {
  return <div className="ed-panel-head"><span>{index} / {label}</span><span>{meta}</span></div>;
}

function Stepper({ label, value, min = 0, max = Number.MAX_SAFE_INTEGER, onChange, unit = 'F' }) {
  const set = next => { const rounded = Math.round(next); if (Number.isFinite(rounded)) onChange(Math.min(max, Math.max(min, rounded))); };
  return (
    <label className="ed-field">
      <span>{label}</span>
      <span className="ed-stepper">
        <button type="button" aria-label={`Decrease ${label}`} onClick={() => set(value - 1)} disabled={value <= min}>−</button>
        <input type="number" value={value} min={min} max={max} onChange={event => set(Number(event.target.value))} />
        <em>{unit}</em>
        <button type="button" aria-label={`Increase ${label}`} onClick={() => set(value + 1)} disabled={value >= max}>+</button>
      </span>
    </label>
  );
}

function Setup({ onCreate, busy, error }) {
  const [name,setName]=useState('Untitled project'); const [preset,setPreset]=useState('Vertical'); const [width,setWidth]=useState(1080); const [height,setHeight]=useState(1920); const [fps,setFps]=useState(30); const [sampleRate,setSampleRate]=useState(48000);
  function setFormat(value){setPreset(value); if(presets[value]){setWidth(presets[value][0]);setHeight(presets[value][1]);}}
  function submit(e){e.preventDefault();onCreate(name.trim(),{width:Number(width),height:Number(height),fps:Number(fps),audioSampleRate:Number(sampleRate)});}
  return <div className="ed-setup">
    <div className="ed-setup-intro">
      <Kicker right="STUDIO / NEW PROJECT">01 / FORMAT</Kicker>
      <h1>START WITH<br/>A <em>FRAME.</em></h1>
      <p>Set the format for this cut, then bring footage into a local editing workspace. One video track, frame-accurate trims, manual captions and source packages.</p>
      <div className="ed-setup-facts">
        <div><span>01</span><strong>LOCAL MEDIA</strong><small>Footage stays in this browser and is never uploaded.</small></div>
        <div><span>02</span><strong>FRAME BASED</strong><small>Every trim and caption is stored as project frames.</small></div>
        <div><span>03</span><strong>SOURCE PACKAGES</strong><small>Export a ZIP of the project, captions and original files.</small></div>
      </div>
    </div>
    <form className="ed-setup-form" onSubmit={submit}>
      <Kicker right="LOCAL WORKSPACE">PROJECT SETTINGS</Kicker>
      <label>Project name<input required maxLength={100} value={name} onChange={e=>setName(e.target.value)}/></label>
      <label>Format<select value={preset} onChange={e=>setFormat(e.target.value)}>{Object.keys(presets).map(x=><option key={x}>{x}</option>)}</select></label>
      <div className="ed-pair"><label>Width<input type="number" min="16" max="3840" required value={width} disabled={preset!=='Custom'} onChange={e=>setWidth(e.target.value)}/></label><label>Height<input type="number" min="16" max="3840" required value={height} disabled={preset!=='Custom'} onChange={e=>setHeight(e.target.value)}/></label></div>
      <div className="ed-pair"><label>Frame rate<select value={fps} onChange={e=>setFps(e.target.value)}>{[23.976,24,25,29.97,30,50,59.94,60].map(x=><option key={x} value={x}>{x} fps</option>)}</select></label><label>Audio sample rate<select value={sampleRate} onChange={e=>setSampleRate(e.target.value)}><option value="48000">48 kHz</option><option value="44100">44.1 kHz</option></select></label></div>
      {error&&<p role="alert" className="ed-setup-error">{error}</p>}
      <button className="ed-submit" disabled={busy}>{busy?'CREATING…':'CREATE PROJECT'}<span>→</span></button>
      <p className="ed-fineprint">No rendered video is produced yet. Export packages the originals and the project document.</p>
    </form>
  </div>;
}

export default function Editor({ user, selected, refresh, api }) {
  const navigate=useNavigate();
  const [project,setProject]=useState(null); const [name,setName]=useState(''); const [error,setError]=useState(''); const [busy,setBusy]=useState(false);
  const [saving,setSaving]=useState('Saved'); const [revision,setRevision]=useState(0); const [savedRevision,setSavedRevision]=useState(0);
  const [selectedClip,setSelectedClip]=useState(null); const [playhead,setPlayhead]=useState(0); const [playing,setPlaying]=useState(false);
  const [urls,setUrls]=useState({}); const [missing,setMissing]=useState([]); const [history,setHistory]=useState({past:[],future:[]});
  const [zoom,setZoom]=useState(5); const [captionText,setCaptionText]=useState('');
  const [recovery,setRecovery]=useState(null); const [recoveryWarning,setRecoveryWarning]=useState(''); const [mediaReady,setMediaReady]=useState(false);
  const [dock,setDock]=useState(null); const [assetFocus,setAssetFocus]=useState(null); const [trim,setTrim]=useState(null);
  const [tab,setTab]=useState('package'); const [bandOpen,setBandOpen]=useState(false); const [scope,setScope]=useState('timeline');
  const [zipBusy,setZipBusy]=useState(false); const [zipProgress,setZipProgress]=useState(0); const [zipBytes,setZipBytes]=useState(0); const [zipError,setZipError]=useState('');
  const [jobs,setJobs]=useState([]);
  const [inspectorTab,setInspectorTab]=useState('clip');
  const [timelineHeight,setTimelineHeight]=useState(300);
  const fileInput=useRef(null); const relinkInput=useRef(null); const relinkId=useRef(null); const player=useRef(null);
  const projectRef=useRef(null); const urlsRef=useRef({}); const alive=useRef(true);
  const navigateAllowed=useRef(false); const playheadRef=useRef(0);
  const zipAbort=useRef(null); const jobsRef=useRef([]); const runningQueue=useRef(false); const stageBody=useRef(null); const [stageBox,setStageBox]=useState({width:0,height:0});

  const selectedId=selected?.id||null;
  const session=useMemo(()=>selectedId?createSaveSession({ put:payload=>api(`/projects/${selectedId}`,{method:'PUT',body:JSON.stringify(payload)}), storage:typeof localStorage==='undefined'?null:localStorage, userId:user.id, projectId:selectedId, onChange:state=>{setSaving(state.status);setRevision(state.revision);setSavedRevision(state.savedRevision);if(state.warning)setRecoveryWarning(state.warning);} }):null,[selectedId,api,user.id]);
  const dirty=revision!==savedRevision || !!recovery;
  const blocker=useBlocker(({currentLocation,nextLocation})=>dirty&&!navigateAllowed.current&&(currentLocation.pathname!==nextLocation.pathname||currentLocation.search!==nextLocation.search));
  useEffect(()=>{if(blocker.state==='blocked'){if(window.confirm('Your project has unsaved changes. Leave without saving?'))blocker.proceed();else blocker.reset();}},[blocker]);
  useEffect(()=>{const warn=e=>{if(dirty){e.preventDefault();e.returnValue='';}};window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn);},[dirty]);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;Object.values(urlsRef.current).forEach(URL.revokeObjectURL);};},[]);

  useEffect(()=>{if(!selected)return;try {const data=validateProject(structuredClone(selected.data));setProject(data);projectRef.current=data;session.reset({updated:selected.updated,data,name:selected.name});setName(selected.name);setError('');try {const draft=readRecovery(localStorage,user.id,selected.id);const disposition=recoveryDisposition(draft,selected);if(disposition==='identical')removeRecovery(localStorage,user.id,selected.id);else if(disposition==='available'||disposition==='conflict')setRecovery({...draft,disposition});else if(disposition==='invalid')setRecoveryWarning('A recovery copy is invalid and was not loaded. The saved project is unchanged.');}catch{setRecoveryWarning('Browser recovery storage is unavailable. Unsaved changes may be lost if this tab closes.');}} catch(e){setError(e.message);setProject(null);}},[selected?.id,user.id,session]);

  useEffect(()=>{if(!project||!selected)return;let cancelled=false;(async()=>{const next={...urlsRef.current};const absent=[];for(const asset of project.assets){if(next[asset.id])continue;try{const blob=await getMedia(user.id,asset.id);if(blob)next[asset.id]=URL.createObjectURL(blob);else absent.push(asset.id);}catch{absent.push(asset.id);}}if(cancelled){for(const [key,url] of Object.entries(next))if(!urlsRef.current[key])URL.revokeObjectURL(url);return;}urlsRef.current=next;setUrls({...next});setMissing(absent);})();return()=>{cancelled=true;};},[project?.assets,user.id,selected?.id]);

  useEffect(()=>{const element=stageBody.current;if(!element||typeof ResizeObserver==='undefined')return;const observer=new ResizeObserver(entries=>{const box=entries[0].contentRect;setStageBox({width:box.width,height:box.height});});observer.observe(element);return()=>observer.disconnect();},[project]);
  useEffect(()=>{if(!selected?.id){setJobs([]);jobsRef.current=[];return;}const stored=readQueue(localStorage,user.id,selected.id);setJobs(stored);jobsRef.current=stored;},[selected?.id,user.id]);

  function recordChange(next,nextName=name){projectRef.current=next;setProject(next);session?.record(next,nextName);}
  function update(next){try{validateProject(next);const previous=projectRef.current;setHistory(h=>({past:[...h.past.slice(-49),previous],future:[]}));recordChange(next);setError('');}catch(e){setError(e.message);}}
  function rename(value){setName(value);session?.rename(value);}

  const save=useCallback(async()=>{if(!session||recovery)return;const result=await session.flush();if(result.saved){try{await refresh();}catch{if(alive.current)setRecoveryWarning('Project saved, but the project list could not be refreshed.');}}else if(result.error&&alive.current){setError(`Project changes remain in this tab. ${result.error.message}`);}},[session,refresh,recovery]);
  useEffect(()=>{if(!session||!dirty||!project||recovery||saving==='Save failed'||saving==='Saving')return;const timer=setTimeout(save,1200);return()=>clearTimeout(timer);},[session,dirty,project,save,saving,recovery]);

  async function create(projectName,settings){setBusy(true);setError('');try{if(!projectName)throw new Error('Enter a project name.');const data=validateProject(createProject(settings));const result=await api('/projects',{method:'POST',body:JSON.stringify({name:projectName,data})});await refresh();navigate(`/studio?project=${result.project.id}`,{replace:true});}catch(e){setError(e.message);}finally{setBusy(false);}}

  async function importFiles(files,relink=false){if(!project)return;setBusy(true);setError('');try{for(const file of files){const metadata=await inspectVideo(file,project.settings.fps);if(relink){const old=projectRef.current.assets.find(a=>a.id===relinkId.current);if(!old || metadata.frames<old.frames || metadata.width!==old.width || metadata.height!==old.height || file.size!==old.size || file.name!==old.name)throw new Error('The selected file does not match this asset’s name, size, dimensions and duration. The project was not changed.');await putMedia(user.id,old.id,file);if(urlsRef.current[old.id])URL.revokeObjectURL(urlsRef.current[old.id]);urlsRef.current={...urlsRef.current,[old.id]:URL.createObjectURL(file)};setUrls({...urlsRef.current});setMissing(m=>m.filter(x=>x!==old.id));}else{if(projectRef.current.assets.some(a=>a.name===file.name&&a.size===file.size&&a.duration===metadata.duration)){setError(`${file.name} was already imported. No duplicate was added.`);continue;}const asset={...metadata,id:id()};await putMedia(user.id,asset.id,file);const url=URL.createObjectURL(file);urlsRef.current={...urlsRef.current,[asset.id]:url};setUrls({...urlsRef.current});update(appendAsset(projectRef.current,asset));setAssetFocus(asset.id);}}}catch(e){setError(`Import failed. Your existing project and original files are unchanged. ${e.message}`);}finally{setBusy(false);}}

  function addToTimeline(asset){try{const next=placeClip(projectRef.current,asset.id,id());update(next);setSelectedClip(next.clips.at(-1).id);setAssetFocus(asset.id);}catch(e){setError(e.message);}}
  function removeAsset(asset){if(projectRef.current.clips.some(c=>c.assetId===asset.id)){setError('This asset is used on the timeline. Remove its clips first.');return;}try{update({...projectRef.current,assets:projectRef.current.assets.filter(a=>a.id!==asset.id)});if(urlsRef.current[asset.id]){URL.revokeObjectURL(urlsRef.current[asset.id]);const next={...urlsRef.current};delete next[asset.id];urlsRef.current=next;setUrls({...next});}deleteMedia(user.id,asset.id).catch(()=>{});}catch(e){setError(e.message);}}
  function applyPatch(patch){try{update(changeClip(projectRef.current,selectedClip,patch));}catch(e){setError(e.message);}}
  function split(){try{const next=splitClip(projectRef.current,selectedClip,playhead,id());update(next);}catch(e){setError(e.message);}}
  function undo(){if(!history.past.length)return;const previous=history.past.at(-1);setHistory({past:history.past.slice(0,-1),future:[projectRef.current,...history.future]});recordChange(previous);}
  function redo(){if(!history.future.length)return;const next=history.future[0];setHistory({past:[...history.past,projectRef.current],future:history.future.slice(1)});recordChange(next);}

  useEffect(()=>{function handle(e){if(recovery)return;if(e.target instanceof HTMLElement && (e.target.isContentEditable||['INPUT','TEXTAREA','SELECT'].includes(e.target.tagName)))return;if(e.key==='Escape'){if(bandOpen)setBandOpen(false);else if(dock)setDock(null);else setSelectedClip(null);return;}if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='z'){e.preventDefault();e.shiftKey?redo():undo();}else if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='s'){e.preventDefault();save();}else if(e.key===' '){e.preventDefault();setPlaying(x=>!x);}else if(e.key.toLowerCase()==='s'&&selectedClip){e.preventDefault();split();}else if(e.key==='Delete'&&selectedClip){update(removeClip(projectRef.current,selectedClip));setSelectedClip(null);}}window.addEventListener('keydown',handle);return()=>window.removeEventListener('keydown',handle);});

  const clip=project&&activeClip(project,playhead); const chosen=project?.clips.find(c=>c.id===selectedClip); const length=project?endFrame(project):0;
  const caption=project?.captions.find(c=>playhead>=c.start&&playhead<c.start+c.duration);

  useEffect(()=>{setMediaReady(false);if(!clip)return;if(!urls[clip.assetId]){if(playing&&missing.includes(clip.assetId)){setPlaying(false);setError('Playback stopped because the source video is missing. Relink it to continue.');}return;}const video=player.current;if(!video)return;const desired=sourceTime(clip,playhead,project.settings.fps);let cancelled=false;const prepare=()=>{if(cancelled)return;try{if(Math.abs(video.currentTime-desired)>0.02){video.currentTime=desired;}else setMediaReady(true);}catch{setPlaying(false);setError('The source video could not be positioned. Your project is unchanged.');}};const ready=()=>setMediaReady(true);video.addEventListener('loadedmetadata',prepare);video.addEventListener('seeked',ready);if(video.readyState>=1)prepare();return()=>{cancelled=true;video.removeEventListener('loadedmetadata',prepare);video.removeEventListener('seeked',ready);};},[clip?.id,urls[clip?.assetId],missing,playing]);
  useEffect(()=>{const video=player.current;if(!video||!clip)return;if(!playing){video.pause();return;}if(!mediaReady)return;video.play().catch(()=>{setPlaying(false);setError('Video playback failed. The project is unchanged.');});},[clip?.id,urls[clip?.assetId],playing,mediaReady]);
  useEffect(()=>{if(!playing||!project)return;let raf;let last=performance.now();let carry=0;let stopped=false;function tick(now){const elapsed=Math.min(now-last,100);last=now;const current=projectRef.current;const currentClip=activeClip(current,playheadRef.current);let next;if(currentClip){next=playbackStep(current,playheadRef.current,player.current,elapsed).frame;carry=0;}else{carry+=elapsed*current.settings.fps/1000;const advance=Math.floor(carry);carry-=advance;next=playheadRef.current+advance;}if(next>=endFrame(current)){stopped=true;setPlaying(false);next=Math.max(0,endFrame(current)-1);}if(next!==playheadRef.current){playheadRef.current=next;setPlayhead(next);}if(!stopped)raf=requestAnimationFrame(tick);}raf=requestAnimationFrame(tick);return()=>cancelAnimationFrame(raf);},[playing,project]);

  const fps=project?.settings.fps||30;
  const framePx=useMemo(()=>((zoom*10)/(fps||30)),[zoom,fps]);
  function seek(frame){const f=clampFrame(project,frame);playheadRef.current=f;setPlayhead(f);const target=activeClip(project,f);if(player.current&&target?.id===clip?.id){try{const desired=sourceTime(target,f,project.settings.fps);if(Math.abs(player.current.currentTime-desired)>0.005){setMediaReady(false);player.current.currentTime=desired;}}catch{setPlaying(false);setError('Seeking failed. The project is unchanged.');}}}
  function seekAt(clientX,element){const rect=element.getBoundingClientRect();seek((clientX-rect.left)/framePx);}
  function beginScrub(event){const element=event.currentTarget;const move=ev=>seekAt(ev.clientX,element);move(event);const up=()=>{window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',up);};window.addEventListener('pointermove',move);window.addEventListener('pointerup',up);}
  function resizeTimelineBy(delta){setTimelineHeight(current=>Math.max(180,Math.min(Math.round(window.innerHeight*0.62),current+delta)));}
  function beginTimelineResize(event){if(event.button)return;event.preventDefault();const startY=event.clientY;const startHeight=timelineHeight;const move=ev=>{const next=Math.max(180,Math.min(window.innerHeight*0.62,startHeight+(startY-ev.clientY)));setTimelineHeight(Math.round(next));};const up=()=>{window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',up);};window.addEventListener('pointermove',move);window.addEventListener('pointerup',up,{once:true});}
  function beginTrim(event,sourceClip,edge){if(event.button)return;event.preventDefault();event.stopPropagation();const asset=project.assets.find(a=>a.id===sourceClip.assetId);const startX=event.clientX;const origin={...sourceClip};const previousEnd=Math.max(0,...project.clips.filter(c=>c.id!==origin.id&&c.start<origin.start).map(c=>c.start+c.duration));const nextStart=Math.min(Infinity,...project.clips.filter(c=>c.id!==origin.id&&c.start>=origin.start+origin.duration).map(c=>c.start));let preview=origin;const move=ev=>{const delta=Math.round((ev.clientX-startX)/framePx);if(edge==='left'){const start=Math.max(previousEnd,Math.min(origin.start+delta,origin.start+origin.duration-1));preview={...origin,start,sourceIn:origin.sourceIn+(start-origin.start),duration:origin.duration-(start-origin.start)};}else{const limit=Math.min(asset?asset.frames-origin.sourceIn:origin.duration+delta,nextStart-origin.start);const duration=Math.max(1,Math.min(origin.duration+delta,limit));preview={...origin,duration};}setTrim(preview);};const up=()=>{window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',up);setTrim(null);if(preview.start===origin.start&&preview.duration===origin.duration)return;try{update(changeClip(projectRef.current,origin.id,{start:preview.start,sourceIn:preview.sourceIn,duration:preview.duration}));}catch(e){setError(e.message);}};window.addEventListener('pointermove',move);window.addEventListener('pointerup',up,{once:true});}

  const description=useMemo(()=>project?describePackage(project,{name,scope,missing}):null,[project,name,scope,missing]);
  const jobCounts=useMemo(()=>({queued:jobs.filter(j=>j.state==='queued').length,running:jobs.filter(j=>j.state==='running').length,done:jobs.filter(j=>j.state==='done').length}),[jobs]);

  async function streamZip(){if(zipBusy)return;setZipError('');setZipBusy(true);setZipProgress(0);setZipBytes(0);const controller=new AbortController();zipAbort.current=controller;try{const {description:packed,entries}=await assemblePackage(projectRef.current,{name,scope,loadAsset:assetId=>getMedia(user.id,assetId)});if(!entries.length)throw new Error('There is nothing to package.');await downloadZip(entries,packed.fileName,{signal:controller.signal,onProgress:(ratio,bytes)=>{setZipProgress(ratio);setZipBytes(bytes);}});}catch(e){if(e.name!=='AbortError')setZipError(e.detail||e.message||'The package could not be created.');}finally{zipAbort.current=null;setZipBusy(false);}}
  function queuePackage(){try{const job=createJob({snapshot:structuredClone(projectRef.current),name,scope});const next=[job,...jobsRef.current].slice(0,20);writeQueue(localStorage,user.id,selected.id,next);setJobs(next);jobsRef.current=next;setTab('queue');setBandOpen(true);setZipError('');}catch(e){setError(`The job could not be queued. ${e.message}`);}}
  function retryJob(job){try{const next=jobsRef.current.map(j=>j.id===job.id?advance(j,'queued',{error:'',progress:0}):j);writeQueue(localStorage,user.id,selected.id,next);setJobs(next);jobsRef.current=next;}catch(e){setError(e.message);}}
  async function removeJob(job){try{const next=jobsRef.current.filter(j=>j.id!==job.id);writeQueue(localStorage,user.id,selected.id,next);setJobs(next);jobsRef.current=next;await deletePackage(user.id,job.id);}catch(e){setError(`The job could not be removed. ${e.message}`);}}
  async function downloadJob(job){try{const blob=await getPackage(user.id,job.id);if(!blob)throw new Error('The stored archive is no longer in this browser. Queue the package again.');const url=URL.createObjectURL(blob);const link=document.createElement('a');link.href=url;link.download=job.packageName||`${job.id}.zip`;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);}catch(e){setError(e.message);}}

  useEffect(()=>{if(runningQueue.current)return;if(!jobs.some(j=>j.state==='queued'))return;runningQueue.current=true;(async()=>{try{await drainQueue({jobs:jobsRef.current,run:async(job,report)=>{const {description:packed,entries}=await assemblePackage(job.snapshot.data,{name:job.snapshot.name,scope:job.snapshot.scope||'timeline',loadAsset:assetId=>getMedia(user.id,assetId)});if(!entries.length)throw new Error('The snapshot has nothing to package.');const blob=await zipBlob(entries,(ratio)=>report(ratio));await putPackage(user.id,job.id,blob);return {bytes:blob.size,packageName:packed.fileName};},onChange:next=>{jobsRef.current=next;try{writeQueue(localStorage,user.id,selected.id,next);}catch{/* storage may be unavailable; the queue stays in memory */}setJobs(next);}});}finally{runningQueue.current=false;}})();},[jobs,user.id,selected?.id]);

  const frameBox=useMemo(()=>{if(!project)return {};const ratio=project.settings.width/project.settings.height;if(!stageBox.width||!stageBox.height)return {};const height=Math.max(60,Math.min(stageBox.height-4,(stageBox.width-4)/ratio));return {width:Math.round(height*ratio),height:Math.round(height)};},[project,stageBox]);

  if(!selected)return <Setup onCreate={create} busy={busy} error={error}/>;
  if(!project)return <div className="ed-message" role="alert">{error||'Loading project…'}</div>;
  if(recovery)return <div className="ed-message ed-recovery" role="alert"><div className="ed-recovery-mark">RECOVERY / 01</div><h2>{recovery.disposition==='conflict'?'THIS DRAFT IS OLDER THAN THE SAVED CUT.':'AN UNSAVED DRAFT WAS FOUND.'}</h2><p>{recovery.disposition==='conflict'?'The saved project changed elsewhere since this draft was made. Restoring replaces that newer saved version; discarding keeps the saved project.':'Restoring saves this draft to the project; discarding keeps the saved version.'}</p><div className="ed-recovery-actions"><button className="ed-btn ed-btn-primary" onClick={()=>{if(recovery.disposition==='conflict'&&!window.confirm('The saved project changed elsewhere. Restore the local draft and replace that newer version?'))return;setName(recovery.name);setRecovery(null);setHistory({past:[],future:[]});projectRef.current=recovery.data;setProject(recovery.data);session?.restore({data:recovery.data,name:recovery.name,updated:selected.updated});}}>RESTORE DRAFT</button><button className="ed-btn" onClick={()=>{try{removeRecovery(localStorage,user.id,selected.id);setRecovery(null);}catch{setRecoveryWarning('Could not remove the recovery copy.');}}}>DISCARD DRAFT</button></div>{recoveryWarning&&<p className="ed-recovery-warning">{recoveryWarning}</p>}</div>;

  const contentWidth=Math.max(720,(length+3*project.settings.fps)*framePx);
  const tickFrames=[1,2,5,10,15,30,60,120,300,600,1800].map(s=>s*project.settings.fps).find(f=>f*framePx>=72)||1800*project.settings.fps;
  const ticks=[];for(let frame=0;frame<=Math.max(length,project.settings.fps*10);frame+=tickFrames)ticks.push(frame);
  const usedAssets=new Set(project.clips.map(c=>c.assetId));

  return <div className="editor" data-dock={dock||undefined}>
    <header className="ed-top">
      <div className="ed-top-left">
        <Link to="/app" className="ed-back">← WORKSPACE</Link>
        <div className="ed-title-block">
          <Kicker right={project.schema===1?'TIMELINE 01':'PROJECT'}>STUDIO</Kicker>
          <input className="ed-title" aria-label="Project name" value={name} maxLength={100} onChange={event=>rename(event.target.value)}/>
        </div>
      </div>
      <div className="ed-top-right">
        <span className={`ed-save ed-save-${SAVE_STATE[saving]||'dirty'}`}><i/>{saving}</span>
        <div className="ed-dock-toggle">
          <button className="ed-btn" aria-pressed={dock==='media'} onClick={()=>setDock(dock==='media'?null:'media')}>MEDIA</button>
          <button className="ed-btn" aria-pressed={dock==='inspect'} onClick={()=>setDock(dock==='inspect'?null:'inspect')}>INSPECTOR</button>
        </div>
        <button className="ed-btn" onClick={undo} disabled={!!recovery||!history.past.length}>UNDO</button>
        <button className="ed-btn" onClick={redo} disabled={!!recovery||!history.future.length}>REDO</button>
        <button className="ed-btn" onClick={()=>{setTab('package');setBandOpen(true);}}>PACKAGE</button>
        <button className="ed-btn" onClick={()=>{setTab('queue');setBandOpen(true);}}>QUEUE{jobCounts.queued+jobCounts.running?` (${jobCounts.queued+jobCounts.running})`:''}</button>
        <button className="ed-btn ed-btn-primary" onClick={save} disabled={!dirty||saving==='Saving'||!!recovery}>SAVE</button>
      </div>
    </header>

    {recoveryWarning&&<div className="ed-error"><span>{recoveryWarning}</span><button onClick={()=>setRecoveryWarning('')}>DISMISS</button></div>}
    {error&&<div className="ed-error" role="alert"><span>{error}</span><button onClick={()=>setError('')}>DISMISS</button></div>}
    {zipError&&<div className="ed-error" role="alert"><span>{zipError}</span><button onClick={()=>setZipError('')}>DISMISS</button></div>}

    <div className="ed-workspace">
      <aside className="ed-media">
        <PanelHead index="01" label="MEDIA" meta={`${project.assets.length} FILES`}/>
        <input ref={fileInput} type="file" accept="video/*" multiple hidden onChange={e=>{importFiles([...e.target.files]);e.target.value='';}}/>
        <input ref={relinkInput} type="file" accept="video/*" hidden onChange={e=>{if(e.target.files[0])importFiles([e.target.files[0]],true);e.target.value='';}}/>
        <button className="ed-drop" disabled={busy} onClick={()=>fileInput.current.click()}><span className="ed-drop-plus">+</span><span>{busy?'IMPORTING…':'IMPORT FOOTAGE'}</span><small>DROP FILES HERE OR CHOOSE FROM THIS DEVICE</small></button>
        <div className="ed-assets" onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault();importFiles([...e.dataTransfer.files]);}}>
          {project.assets.map(asset=>{
            const isMissing=missing.includes(asset.id);
            return <div key={asset.id} className={`ed-asset${assetFocus===asset.id?' is-focused':''}`} onClick={()=>setAssetFocus(asset.id)}>
              <div className="ed-asset-main"><strong title={asset.name}>{asset.name}</strong><small>{asset.width}×{asset.height} / {Number(asset.duration||0).toFixed(1)}S / {formatBytes(asset.size)}</small></div>
              <div className="ed-asset-actions">
                {isMissing?<><span className="ed-tag ed-tag-alert">MISSING</span><button onClick={()=>{relinkId.current=asset.id;relinkInput.current.click();}}>RELINK</button></>
                  :<button onClick={()=>addToTimeline(asset)}>ADD TO V1 →</button>}
                {!usedAssets.has(asset.id)&&<button className="ed-quiet" onClick={()=>removeAsset(asset)}>REMOVE</button>}
              </div>
            </div>;
          })}
          {!project.assets.length&&<p className="ed-note">No media yet. Files are copied into this browser, never uploaded.</p>}
        </div>
        <p className="ed-note ed-note-foot">Browser storage can be cleared or evicted. Keep your originals.</p>
      </aside>

      <main className="ed-stage">
        <PanelHead index="02" label="PREVIEW" meta={`${project.settings.width} × ${project.settings.height} / ${project.settings.fps} FPS`}/>
        <div className="ed-stage-body">
          <div className="ed-frame-wrap" ref={stageBody}>
            <div className="ed-frame" style={frameBox}>
              {clip&&urls[clip.assetId]
                ? <video key={clip.id} ref={player} src={urls[clip.assetId]} playsInline onSeeked={()=>setMediaReady(true)} onWaiting={()=>setMediaReady(false)} onCanPlay={()=>{if(!player.current?.seeking)setMediaReady(true)}} onEnded={()=>{const next=clip.start+clip.duration;playheadRef.current=next;setPlayhead(next);}} onError={()=>{setPlaying(false);setError('The browser could not decode this media. Your project is unchanged.');}}/>
                : <div className="ed-stage-empty"><strong>{clip?'SOURCE OFFLINE.':'YOUR FOOTAGE GOES HERE.'}</strong><span>{clip?'RELINK THE FILE TO PREVIEW':'IMPORT A VIDEO TO START EDITING'}</span></div>}
              {caption&&<div className="ed-caption" aria-live="off">{caption.text}</div>}
              <span className="ed-corner tl"/><span className="ed-corner tr"/><span className="ed-corner bl"/><span className="ed-corner br"/>
              <span className="ed-ratio">{project.settings.width} × {project.settings.height}</span>
            </div>
          </div>
          <div className="ed-transport">
            <button className="ed-step" onClick={()=>seek(0)} title="Beginning">|◀</button>
            <button className="ed-step" onClick={()=>seek(playhead-1)} title="Previous frame">◀</button>
            <button className="ed-disc" onClick={()=>setPlaying(v=>!v)} disabled={!length} aria-label={playing?'Pause':'Play'}>{playing?'❙❙':'▶'}</button>
            <button className="ed-step" onClick={()=>seek(playhead+1)} title="Next frame">▶</button>
            <button className="ed-step" onClick={()=>seek(length-1)} title="End">▶|</button>
            <span className="ed-time">{frameTime(playhead,project.settings.fps)} <em>/ {frameTime(length,project.settings.fps)}</em></span>
            <span className="ed-time ed-frame-count">FRAME {String(playhead).padStart(5,'0')}</span>
          </div>
        </div>
      </main>

      <aside className="ed-inspector">
        <PanelHead index="03" label="INSPECTOR" meta={chosen?'CLIP':'PROJECT'}/>
        <div className="ed-insp-tabs" role="tablist" aria-label="Inspector">
          {['clip','captions','project'].map(name=><button key={name} role="tab" aria-selected={inspectorTab===name} className={inspectorTab===name?'is-active':''} onClick={()=>setInspectorTab(name)}>{name.toUpperCase()}</button>)}
        </div>
        <div className="ed-insp-body">
        {inspectorTab==='clip'&&(chosen?<>
          <Kicker right={`${chosen.duration} FRAMES`}>TIMING</Kicker>
          <Stepper label="Timeline start" value={chosen.start} max={Math.max(0,length-1)} onChange={value=>applyPatch({start:value})}/>
          <Stepper label="Source in" value={chosen.sourceIn} max={Math.max(0,(project.assets.find(a=>a.id===chosen.assetId)?.frames||1)-chosen.duration)} onChange={value=>applyPatch({sourceIn:value})}/>
          <Stepper label="Duration" value={chosen.duration} min={1} max={Math.max(1,(project.assets.find(a=>a.id===chosen.assetId)?.frames||1)-chosen.sourceIn)} onChange={value=>applyPatch({duration:value})}/>
          <div className="ed-row-actions"><button className="ed-btn" onClick={split}>SPLIT AT PLAYHEAD</button><button className="ed-btn" onClick={()=>{update(removeClip(projectRef.current,selectedClip));setSelectedClip(null);}}>DELETE CLIP</button></div>
          <p className="ed-note">Clips cannot overlap. Drag a clip edge on the timeline to trim; the end frame is clamped to the source.</p>
        </>:<p className="ed-note">Select a clip on the timeline to edit its start, source in or duration.</p>)}

        {inspectorTab==='captions'&&<>
        <Kicker right={`${project.captions.length} LINES`}>CAPTIONS</Kicker>
        <label className="ed-field ed-field-stack"><span>Caption text</span><input className="ed-input" value={captionText} maxLength={300} onChange={e=>setCaptionText(e.target.value)} placeholder="Add text at the playhead"/></label>
        <button className="ed-btn ed-btn-wide" disabled={!captionText.trim()} onClick={()=>{update({...projectRef.current,captions:[...projectRef.current.captions,{id:id(),text:captionText.trim(),start:playhead,duration:Math.round(3*project.settings.fps)}]});setCaptionText('');}}>ADD 3-SECOND CAPTION</button>
        <div className="ed-captions">
          {project.captions.map((item,index)=><div className="ed-caption-row" key={item.id}>
            <input className="ed-input" aria-label={`Caption ${index+1} text`} value={item.text} onChange={e=>update({...projectRef.current,captions:projectRef.current.captions.map(c=>c.id===item.id?{...c,text:e.target.value}:c)})}/>
            <div className="ed-caption-meta">
              <span className="ed-mono">{frameTime(item.start,project.settings.fps)}</span>
              <label>START<input type="number" min="0" value={item.start} onChange={e=>update({...projectRef.current,captions:projectRef.current.captions.map(c=>c.id===item.id?{...c,start:Math.max(0,Math.round(Number(e.target.value)||0))}:c)})}/></label>
              <label>LEN<input type="number" min="1" value={item.duration} onChange={e=>update({...projectRef.current,captions:projectRef.current.captions.map(c=>c.id===item.id?{...c,duration:Math.max(1,Math.round(Number(e.target.value)||1))}:c)})}/></label>
              <button className="ed-quiet" aria-label={`Remove caption ${index+1}`} onClick={()=>update({...projectRef.current,captions:projectRef.current.captions.filter(c=>c.id!==item.id)})}>REMOVE</button>
            </div>
          </div>)}
        </div>
        </>}

        {inspectorTab==='project'&&<>
        <div className="ed-readout"><span>FORMAT</span><strong>{project.settings.width} × {project.settings.height}</strong></div>
        <div className="ed-readout"><span>FRAME RATE</span><strong>{project.settings.fps} FPS</strong></div>
        <div className="ed-readout"><span>AUDIO</span><strong>{project.settings.audioSampleRate/1000} KHZ</strong></div>
        <div className="ed-readout"><span>ASSETS</span><strong>{project.assets.length} / {project.clips.length} CLIPS</strong></div>
        </>}
        </div>
      </aside>
    </div>

    <div className="ed-timeline-resizer" role="separator" tabIndex={0} aria-orientation="horizontal" aria-label="Resize timeline" aria-valuemin={180} aria-valuemax={Math.round(window.innerHeight*0.62)} aria-valuenow={Math.round(timelineHeight)} title="Drag to resize the timeline, or use ↑ ↓" onPointerDown={beginTimelineResize} onKeyDown={event=>{
      if(event.key==='ArrowUp'||event.key==='ArrowDown'){event.preventDefault();resizeTimelineBy((event.key==='ArrowUp'?1:-1)*(event.shiftKey?48:16));}
      else if(event.key==='Home'){event.preventDefault();setTimelineHeight(180);}
      else if(event.key==='End'){event.preventDefault();setTimelineHeight(Math.round(window.innerHeight*0.62));}
    }}/>
    <section className="ed-timeline" style={{height:timelineHeight}}>
      <div className="ed-tl-head">
        <strong>04 / TIMELINE</strong>
        <span>{project.clips.length} CLIPS / {frameTime(length,project.settings.fps)}</span>
        <div className="ed-zoom"><button onClick={()=>setZoom(z=>Math.max(2,z-1))} aria-label="Zoom out">−</button><input type="range" min="2" max="20" value={zoom} onChange={e=>setZoom(Number(e.target.value))} aria-label="Timeline zoom"/><button onClick={()=>setZoom(z=>Math.min(20,z+1))} aria-label="Zoom in">+</button><em>{zoom}×</em></div>
      </div>
      <div className="ed-tl-scroll">
        <div className="ed-tl-content" style={{width:contentWidth}}>
          <div className="ed-ruler">
            <div className="ed-track-label ed-ruler-label">TIME</div>
            <div className="ed-ruler-body" onPointerDown={beginScrub}>
              {ticks.map(frame=><span className="ed-tick" key={frame} style={{left:frame*framePx}}>{frameTime(frame,project.settings.fps)}</span>)}
              <div className="ed-playhead" style={{left:playhead*framePx}}/>
            </div>
          </div>
          <div className="ed-lane">
            <div className="ed-track-label">V1</div>
            <div className="ed-lane-body" onPointerDown={e=>{if(e.target===e.currentTarget)beginScrub(e);}}>
              {project.clips.map(item=>{
                const asset=project.assets.find(a=>a.id===item.assetId);
                const shown=trim&&trim.id===item.id?trim:item;
                return <div key={item.id} className={`ed-clip${item.id===selectedClip?' is-selected':''}`} style={{left:shown.start*framePx,width:Math.max(2,shown.duration*framePx)}} role="button" tabIndex={0} aria-label={`${asset?.name||'Clip'} from frame ${item.start}, ${item.duration} frames`} onClick={()=>{setSelectedClip(item.id);seek(item.start);}} onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();setSelectedClip(item.id);seek(item.start);}}}>
                  <strong>{asset?.name||'Clip'}</strong>
                  <small>{frameTime(item.start,project.settings.fps)} / {item.duration}F</small>
                  <span className="ed-trim left" onPointerDown={e=>beginTrim(e,item,'left')} title="Trim start"/>
                  <span className="ed-trim right" onPointerDown={e=>beginTrim(e,item,'right')} title="Trim end"/>
                </div>;
              })}
              {!project.clips.length&&<div className="ed-lane-empty">IMPORT FOOTAGE TO GET STARTED</div>}
              <div className="ed-playhead" style={{left:playhead*framePx}}/>
            </div>
          </div>
        </div>
      </div>
    </section>

    {bandOpen&&<>
    <div className="ed-drawer-scrim" onClick={()=>setBandOpen(false)}/>
    <section className="ed-band ed-drawer">
      <div className="ed-band-head">
        <div className="ed-tabs">
          <button className={`ed-tab${tab==='package'?' is-active':''}`} onClick={()=>{setTab('package');setBandOpen(true);}}>05 / STREAM-TO-ZIP</button>
          <button className={`ed-tab${tab==='queue'?' is-active':''}`} onClick={()=>{setTab('queue');setBandOpen(true);}}>06 / RENDER QUEUE{jobCounts.queued+jobCounts.running?` (${jobCounts.queued+jobCounts.running})`:''}</button>
        </div>
        <div className="ed-band-tools">
          <span className="ed-kicker">{tab==='package'?'SOURCE PACKAGE':'PACKAGE JOBS'}</span>
          <button className="ed-btn ed-btn-ghost" onClick={()=>setBandOpen(!bandOpen)}>{bandOpen?'COLLAPSE':'EXPAND'}</button>
        </div>
      </div>
      {bandOpen&&(tab==='package'?<>
        <div className="ed-band-body">
          <div className="ed-scope">
            <div className="ed-segmented" role="group" aria-label="Package scope">
              <button className={scope==='timeline'?'is-active':''} onClick={()=>setScope('timeline')}>TIMELINE MEDIA</button>
              <button className={scope==='all'?'is-active':''} onClick={()=>setScope('all')}>ALL MEDIA</button>
            </div>
            <span className="ed-kicker">{description?.entries.filter(e=>e.kind==='media').length||0} SOURCE FILES / {formatBytes(description?.totalBytes||0)}</span>
          </div>
          {(description?.entries||[]).map((entry,index)=><div className="ed-index-row" key={entry.name}>
            <span className="ed-index-num">{String(index+1).padStart(2,'0')}</span>
            <span className="ed-index-title" title={entry.name}>{entry.name}</span>
            <span className="ed-index-desc">{entry.kind==='media'?'SOURCE VIDEO':entry.kind==='captions'?'CAPTION SIDECAR':entry.kind==='project'?'PROJECT DOCUMENT':'MANIFEST'} / {formatBytes(entry.bytes)}{entry.reason?` / ${entry.reason}`:''}</span>
            <span className="ed-state" data-state={entry.available?'ready':'failed'}><i/>{entry.available?'INCLUDED':'OMITTED'}</span>
            <span className="ed-index-actions"/>
          </div>)}
          <p className="ed-note">A package contains the project document, captions and original source files. It is not a rendered video.</p>
        </div>
        <div className="ed-band-foot">
          <span className="ed-kicker">{zipBusy?`STREAMING ${Math.round(zipProgress*100)}% / ${formatBytes(zipBytes)}`:`${formatBytes(description?.totalBytes||0)} ACROSS ${description?.entries.filter(e=>e.available).length||0} FILES`}</span>
          {zipBusy?<><div className="ed-progress"><i style={{width:`${Math.max(2,zipProgress*100)}%`}}/></div><button className="ed-btn" onClick={()=>zipAbort.current?.abort()}>CANCEL</button></>
            :<button className="ed-block" onClick={streamZip}>STREAM ZIP<span>→</span></button>}
        </div>
      </>:<>
        <div className="ed-band-body">
          {!jobs.length&&<p className="ed-note">No jobs yet. Queue a package to run in the background; each job snapshots the project as it is now.</p>}
          {jobs.map((job,index)=><div className="ed-index-row" key={job.id}>
            <span className="ed-index-num">{String(index+1).padStart(2,'0')}</span>
            <span className="ed-index-title">{job.label}</span>
            <span className="ed-index-desc">{job.state==='failed'?job.error:`${job.scope==='all'?'ALL MEDIA':'TIMELINE MEDIA'}${job.state==='done'?` / ${formatBytes(job.bytes)}`:''}${job.state==='running'?` / ${Math.round(job.progress*100)}%`:''}`}</span>
            <span className="ed-state" data-state={job.state}><i/>{job.state.toUpperCase()}</span>
            <span className="ed-index-actions">
              {job.state==='done'&&<button onClick={()=>downloadJob(job)}>DOWNLOAD</button>}
              {job.state==='failed'&&<button onClick={()=>retryJob(job)}>RETRY</button>}
              <button className="ed-quiet" onClick={()=>removeJob(job)}>REMOVE</button>
            </span>
          </div>)}
          {jobs.some(j=>j.state==='running')&&<div className="ed-progress ed-progress-inline"><i style={{width:`${Math.max(2,(jobs.find(j=>j.state==='running')?.progress||0)*100)}%`}}/></div>}
        </div>
        <div className="ed-band-foot">
          <span className="ed-kicker">{jobCounts.queued} QUEUED / {jobCounts.running} RUNNING / {jobCounts.done} READY</span>
          <button className="ed-block" onClick={queuePackage}>QUEUE PACKAGE JOB<span>+</span></button>
        </div>
      </>)}
    </section>
    </>}
  </div>;
}

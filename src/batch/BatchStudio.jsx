import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './batch.css';

const clock = seconds => {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00.00';
  const minutes = Math.floor(seconds / 60);
  const rest = seconds - minutes * 60;
  return `${String(minutes).padStart(2, '0')}:${rest.toFixed(2).padStart(5, '0')}`;
};
const bytes = value => {
  if (!Number.isFinite(value)) return '—';
  if (value > 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)} GB`;
  if (value > 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.max(0, Math.round(value / 1024))} KB`;
};
const stateClass = value => `bt-state bt-state-${String(value || '').replace(/\s+/g, '-')}`;
const JOB_LABEL = { waiting: 'Waiting', preparing: 'Preparing', processing: 'Preparing', rendering: 'Rendering', validating: 'Validating', completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled' };

export default function BatchStudio({ api }) {
  const [batches, setBatches] = useState([]);
  const [batchId, setBatchId] = useState(() => new URLSearchParams(window.location.search).get('batch'));
  const [state, setState] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  const [name, setName] = useState('');
  const [selected, setSelected] = useState([]);
  const [openCaptions, setOpenCaptions] = useState(null);
  const [captions, setCaptions] = useState([]);
  const [srtText, setSrtText] = useState('');
  const [playhead, setPlayhead] = useState(0);
  const [profileDraft, setProfileDraft] = useState(null);
  const [manual, setManual] = useState({ start: '0', end: '10', name: '' });
  const [equal, setEqual] = useState({ targetSeconds: '5', overlapSeconds: '0', minSeconds: '2', shortFinal: 'keep' });
  const video = useRef(null);
  const editingName = useRef(false);

  const load = useCallback(async (id = batchId) => {
    const list = await api('/batches');
    setBatches(list.batches);
    if (!id && list.batches[0]) id = list.batches[0].id;
    if (!id) { setState(null); return null; }
    const next = await api(`/batches/${id}`);
    setState(next);
    setBatchId(id);
    return next;
  }, [api, batchId]);

  useEffect(() => {
    load().catch(e => setError(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!batchId) return undefined;
    let alive = true;
    const timer = setInterval(async () => {
      try {
        const next = await api(`/batches/${batchId}`);
        if (alive) setState(current => {
          if (!current || !editingName.current) return next;
          return { ...next, segments: next.segments.map(segment => {
            const previous = current.segments.find(item => item.id === segment.id);
            return previous ? { ...segment, name: previous.name } : segment;
          }) };
        });
      } catch { /* a transient poll failure must not clear the workspace */ }
    }, 2000);
    return () => { alive = false; clearInterval(timer); };
  }, [api, batchId]);

  useEffect(() => {
    if (!state?.profile) { setProfileDraft(null); return; }
    setProfileDraft(JSON.parse(JSON.stringify(state.profile.settings)));
  }, [state?.profile?.id]);

  const source = state?.source;
  const segments = state?.segments ?? [];
  const jobs = state?.jobs ?? [];
  const counts = state?.counts ?? {};
  const fps = source ? source.fpsNum / source.fpsDen : 30;
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const segmentName = useMemo(() => Object.fromEntries(segments.map(segment => [segment.id, segment.name])), [segments]);
  const latestJob = useMemo(() => {
    const map = {};
    for (const job of jobs) map[job.segmentId] = job;
    return map;
  }, [jobs]);
  const approved = segments.filter(segment => segment.approval === 'approved');

  const run = async (label, action) => {
    setBusy(label); setError(''); setNotice('');
    try {
      const result = await action();
      if (result?.batch && result?.segments) setState(result);
      return result;
    }
    catch (e) { setError(e.message); return null; }
    finally { setBusy(''); }
  };
  const patchSegment = (id, patch) => run('Saving segment', async () => (await api(`/segments/${id}`, { method: 'PATCH', body: JSON.stringify(patch) })).state);
  const refresh = () => run('Refreshing', async () => api(`/batches/${batchId}`));

  async function createBatch(event) {
    event.preventDefault();
    if (!name.trim()) return;
    const result = await run('Creating batch', () => api('/batches', { method: 'POST', body: JSON.stringify({ name: name.trim() }) }));
    if (result?.batch) { setName(''); await load(result.batch.id); }
  }

  async function importSource(file) {
    if (!file || !batchId) return;
    setBusy('Importing source'); setError(''); setNotice('');
    try {
      const response = await fetch(`/api/batches/${batchId}/source`, {
        method: 'PUT',
        headers: { 'Content-Type': file.type || 'application/octet-stream', 'x-filename': encodeURIComponent(file.name), 'content-length': String(file.size) },
        body: file,
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'The source could not be imported.');
      setState(body);
      setNotice(`Imported ${file.name}.`);
    } catch (e) { setError(e.message); } finally { setBusy(''); }
  }

  function addManual(event) {
    event.preventDefault();
    if (!source) return;
    const startFrame = Math.round(Number(manual.start) * fps);
    const endFrame = Math.round(Number(manual.end) * fps);
    run('Adding segment', async () => api(`/batches/${batchId}/segments`, { method: 'POST', body: JSON.stringify({ startFrame, endFrame, name: manual.name || undefined }) }));
  }

  function generateEqual(event) {
    event.preventDefault();
    run('Generating segments', async () => api(`/batches/${batchId}/segments/equal`, { method: 'POST', body: JSON.stringify(equal) }));
  }

  function splitAtPlayhead() {
    const target = segments.find(segment => segment.id === selected[0]);
    if (!target) { setError('Select one segment to split it at the playhead.'); return; }
    const frame = Math.round(playhead * fps);
    run('Splitting segment', async () => (await api(`/segments/${target.id}/split`, { method: 'POST', body: JSON.stringify({ frame }) })).state);
  }

  function mergeSelected() {
    if (selected.length < 2) { setError('Select at least two adjacent segments to merge.'); return; }
    run('Merging segments', async () => (await api(`/batches/${batchId}/segments/merge`, { method: 'POST', body: JSON.stringify({ ids: selected }) })).state);
  }

  const toggle = id => setSelected(current => current.includes(id) ? current.filter(item => item !== id) : [...current, id]);
  const allSelected = segments.length > 0 && selected.length === segments.length;

  async function openCaptionEditor(segment) {
    setOpenCaptions(segment.id); setError('');
    try { const track = await api(`/segments/${segment.id}/captions`); setCaptions(track.entries); }
    catch (e) { setError(e.message); }
  }
  function editCaption(index, patch) { setCaptions(current => current.map((entry, position) => position === index ? { ...entry, ...patch } : entry)); }
  function addCaption() { setCaptions(current => [...current, { startMs: 0, endMs: 1500, text: '' }]); }
  function removeCaption(index) { setCaptions(current => current.filter((_, position) => position !== index)); }
  function saveCaptions() {
    run('Saving captions', async () => (await api(`/segments/${openCaptions}/captions`, { method: 'PUT', body: JSON.stringify({ entries: captions }) })).state);
  }
  function importSrt() {
    run('Importing subtitles', async () => (await api(`/batches/${batchId}/transcript`, { method: 'PUT', body: JSON.stringify({ srt: srtText }) })).state);
  }
  function generateCaptions(ids) {
    run('Generating captions', async () => (await api(`/batches/${batchId}/captions/generate`, { method: 'POST', body: JSON.stringify({ ids }) })).state);
  }

  function applyProfile(scope) {
    if (!profileDraft) return;
    const ids = scope === 'selected' ? selected : [];
    if (scope === 'selected' && !ids.length) { setError('Select segments before applying the profile to a selection.'); return; }
    run('Applying profile', async () => (await api(`/batches/${batchId}/profile`, { method: 'PUT', body: JSON.stringify({ settings: profileDraft, applyTo: scope === 'selected' ? 'selected' : 'all', ids }) })).state);
  }
  function setProfile(path, value) {
    setProfileDraft(current => {
      const next = JSON.parse(JSON.stringify(current));
      const [section, key] = path.split('.');
      next[section][key] = value;
      return next;
    });
  }
  function overrideSegment(clipId, patch) {
    const segment = segments.find(item => item.id === clipId);
    if (!segment) return;
    patchSegment(clipId, { overrides: { ...segment.overrides, ...patch } });
  }

  function queueSelected() {
    const ids = selected.length ? selected : approved.map(segment => segment.id);
    run('Queueing renders', async () => {
      const result = await api(`/batches/${batchId}/queue`, { method: 'POST', body: JSON.stringify({ segmentIds: ids }) });
      if (result.skipped?.length) setNotice(`Queued ${result.created.length}. Skipped: ${result.skipped.map(item => `${item.name} — ${item.reason}`).join('; ')}`);
      return result.state;
    });
  }
  const jobAction = (job, action) => run('Updating job', async () => { await api(`/jobs/${job.id}/${action}`, { method: 'POST' }); return api(`/batches/${batchId}`); });
  const batchAction = action => run('Updating queue', async () => { await api(`/batches/${batchId}/${action}`, { method: 'POST' }); return api(`/batches/${batchId}`); });
  const packageBatch = () => run('Packaging archive', async () => {
    const result = await api(`/batches/${batchId}/package`, { method: 'POST' });
    setNotice(`Archive ${result.archive.filename} created with ${result.included} clip(s)${result.excluded.length ? `, ${result.excluded.length} excluded` : ''}.`);
    return api(`/batches/${batchId}`);
  });

  return <div className="bt">
    <header className="bt-head">
      <div>
        <div className="bt-kicker">STREAM TO ZIP / LOCAL RENDER ENGINE</div>
        <p>One recording in, reviewed clips and a validated archive out. Rendering runs on this server, one job at a time by default.</p>
      </div>
      <form className="bt-new" onSubmit={createBatch}>
        <label>NEW BATCH<input value={name} maxLength={80} placeholder="Episode 14" onChange={event => setName(event.target.value)} /></label>
        <button className="bt-btn bt-btn-primary" disabled={!!busy || !name.trim()}>{busy === 'Creating batch' ? 'CREATING…' : 'CREATE BATCH'}</button>
      </form>
    </header>

    {batches.length > 1 && <div className="bt-tabs" role="tablist">{batches.map(item => <button key={item.id} role="tab" aria-selected={item.id === batchId} className={item.id === batchId ? 'active' : ''} onClick={() => { setSelected([]); setOpenCaptions(null); load(item.id).catch(e => setError(e.message)); }}>{item.name}<span>{item.counts.total} clips · {item.counts.completed} rendered</span></button>)}</div>}

    {error && <div className="bt-banner bt-banner-error" role="alert">{error}<button onClick={() => setError('')}>DISMISS</button></div>}
    {notice && <div className="bt-banner" role="status">{notice}<button onClick={() => setNotice('')}>DISMISS</button></div>}
    {state && !state.engine.available && <div className="bt-banner bt-banner-error" role="alert">The media engine is not installed on this server, so metadata, rendering and packaging are unavailable. Set FFMPEG_PATH and FFPROBE_PATH, or install the bundled binaries with <code>npm ci</code>.</div>}

    {!state && <div className="bt-empty"><h2>No batch yet.</h2><p>Create a batch above, then import the recording you want to cut.</p></div>}

    {state && <div className="bt-body">
      {/* 01 SOURCE */}
      <section className="bt-panel">
        <div className="bt-panel-head"><span>01 / SOURCE</span><span>{source ? (source.missing ? 'FILE MISSING' : 'READY') : 'EMPTY'}</span></div>
        {!source ? <div className="bt-drop">
          <input id="bt-source" type="file" accept="video/*" onChange={event => importSource(event.target.files?.[0])} hidden />
          <label htmlFor="bt-source" className="bt-drop-label">+ IMPORT SOURCE<small>MP4, MOV, M4V, WebM, MKV, AVI · original stays unchanged</small></label>
        </div> : <>
          <video className="bt-preview" ref={video} src={source.streamUrl} controls preload="metadata" onTimeUpdate={event => setPlayhead(event.currentTarget.currentTime)} />
          <dl className="bt-meta">
            <div><dt>FILE</dt><dd title={source.filename}>{source.filename}</dd></div>
            <div><dt>DURATION</dt><dd>{clock(source.duration)}</dd></div>
            <div><dt>FRAME</dt><dd>{source.width}×{source.height} · {source.fps} fps</dd></div>
            <div><dt>CODECS</dt><dd>{source.videoCodec || '—'} / {source.audioCodec || 'no audio'}</dd></div>
            <div><dt>SIZE</dt><dd>{bytes(source.size)}</dd></div>
            <div><dt>FRAMES</dt><dd>{source.frames}</dd></div>
            <div><dt>PLAYHEAD</dt><dd>{clock(playhead)} · frame {Math.round(playhead * fps)}</dd></div>
          </dl>
          <div className="bt-row">
            <input id="bt-replace" type="file" accept="video/*" onChange={event => importSource(event.target.files?.[0])} hidden />
            <label htmlFor="bt-replace" className="bt-btn">REPLACE SOURCE</label>
            <button className="bt-btn" disabled={!!busy} onClick={() => run('Removing source', () => api(`/batches/${batchId}/source`, { method: 'DELETE' }))}>REMOVE SOURCE</button>
          </div>
        </>}
      </section>

      {/* 02 SEGMENTS */}
      <section className="bt-panel">
        <div className="bt-panel-head"><span>02 / SEGMENTS</span><span>{segments.length} ON TIMELINE</span></div>
        <form className="bt-form" onSubmit={generateEqual}>
          <h3>Equal duration</h3>
          <div className="bt-grid">
            <label>CLIP SECONDS<input type="number" min="0.5" step="0.5" value={equal.targetSeconds} onChange={event => setEqual({ ...equal, targetSeconds: event.target.value })} /></label>
            <label>OVERLAP SECONDS<input type="number" min="0" step="0.25" value={equal.overlapSeconds} onChange={event => setEqual({ ...equal, overlapSeconds: event.target.value })} /></label>
            <label>MINIMUM SECONDS<input type="number" min="0" step="0.5" value={equal.minSeconds} onChange={event => setEqual({ ...equal, minSeconds: event.target.value })} /></label>
            <label>FINAL SHORT CLIP<select value={equal.shortFinal} onChange={event => setEqual({ ...equal, shortFinal: event.target.value })}>
              <option value="keep">Keep it</option><option value="merge">Merge into previous</option><option value="drop">Drop it</option>
            </select></label>
          </div>
          <button className="bt-btn bt-btn-primary" disabled={!source || !!busy}>GENERATE SEGMENTS</button>
          <p className="bt-fine">Replaces the current list. Every generated clip still needs review.</p>
        </form>

        <form className="bt-form" onSubmit={addManual}>
          <h3>Manual segment</h3>
          <div className="bt-grid">
            <label>START SECONDS<input type="number" min="0" step="0.1" value={manual.start} onChange={event => setManual({ ...manual, start: event.target.value })} /></label>
            <label>END SECONDS<input type="number" min="0" step="0.1" value={manual.end} onChange={event => setManual({ ...manual, end: event.target.value })} /></label>
            <label>NAME<input value={manual.name} placeholder="Optional" onChange={event => setManual({ ...manual, name: event.target.value })} /></label>
          </div>
          <div className="bt-row">
            <button className="bt-btn" disabled={!source || !!busy}>ADD SEGMENT</button>
            <button type="button" className="bt-btn" disabled={!selected.length} onClick={splitAtPlayhead}>SPLIT AT PLAYHEAD</button>
            <button type="button" className="bt-btn" disabled={selected.length < 2} onClick={mergeSelected}>MERGE SELECTED</button>
          </div>
        </form>

        {state.overlaps > 0 && <p className="bt-warn">{state.overlaps} overlapping pair(s). Overlap is allowed and rendered as authored.</p>}
      </section>

      {/* 03 REVIEW */}
      <section className="bt-panel bt-panel-wide">
        <div className="bt-panel-head"><span>03 / REVIEW</span><span>{counts.approved ?? 0} APPROVED · {counts.pending ?? 0} PENDING · {counts.rejected ?? 0} REJECTED</span></div>
        <div className="bt-row">
          <button className="bt-btn" disabled={!segments.length} onClick={() => setSelected(allSelected ? [] : segments.map(segment => segment.id))}>{allSelected ? 'CLEAR SELECTION' : 'SELECT ALL'}</button>
          <button className="bt-btn" disabled={!selected.length || !!busy} onClick={() => run('Approving', async () => (await api(`/batches/${batchId}/approval`, { method: 'POST', body: JSON.stringify({ ids: selected, approval: 'approved' }) })).state)}>APPROVE SELECTED</button>
          <button className="bt-btn" disabled={!selected.length || !!busy} onClick={() => run('Rejecting', async () => (await api(`/batches/${batchId}/approval`, { method: 'POST', body: JSON.stringify({ ids: selected, approval: 'rejected' }) })).state)}>REJECT SELECTED</button>
          <button className="bt-btn" disabled={!selected.length || !!busy} onClick={() => generateCaptions(selected)}>GENERATE CAPTIONS</button>
          <button className="bt-btn bt-btn-primary" disabled={!segments.length || !!busy} onClick={queueSelected}>QUEUE {selected.length ? 'SELECTED' : 'APPROVED'}</button>
        </div>
        {!segments.length ? <p className="bt-empty-line">No segments yet. Generate an equal split or add one manually.</p> : <div className="bt-table-wrap">
          <table className="bt-table">
            <thead><tr><th /><th>CLIP</th><th>SOURCE IN</th><th>SOURCE OUT</th><th>DURATION</th><th>APPROVAL</th><th>CAPTIONS</th><th>RENDER</th><th /></tr></thead>
            <tbody>{segments.map(segment => {
              const job = latestJob[segment.id];
              return <tr key={segment.id} className={selectedSet.has(segment.id) ? 'selected' : ''}>
                <td><input type="checkbox" aria-label={`Select ${segment.name}`} checked={selectedSet.has(segment.id)} onChange={() => toggle(segment.id)} /></td>
                <td className="bt-clip-cell">
                  <img src={segment.thumbnailUrl} alt="" loading="lazy" />
                  <input className="bt-name" value={segment.name} aria-label={`Name for ${segment.name}`} onFocus={() => { editingName.current = true; }} onChange={event => setState(current => ({ ...current, segments: current.segments.map(item => item.id === segment.id ? { ...item, name: event.target.value } : item) }))} onBlur={event => { editingName.current = false; patchSegment(segment.id, { name: event.target.value }); }} />
                </td>
                <td>{clock(segment.startSeconds)}</td>
                <td>{clock(segment.endSeconds)}</td>
                <td>{clock(segment.durationSeconds)}</td>
                <td><span className={stateClass(segment.approval)}>{segment.approval.toUpperCase()}</span></td>
                <td><span className={stateClass(segment.captionCount ? 'ready' : 'empty')}>{segment.captionCount ? `${segment.captionCount} CUES` : 'NONE'}</span></td>
                <td><span className={stateClass(segment.renderStale ? 'stale' : segment.renderState)}>{segment.renderStale ? 'STALE' : segment.renderState.toUpperCase()}{job && ['waiting', 'rendering', 'preparing', 'processing', 'validating'].includes(job.state) ? ` · ${Math.round((job.progress || 0) * 100)}%` : ''}</span></td>
                <td className="bt-actions">
                  <button onClick={() => openCaptionEditor(segment)}>CAPTIONS</button>
                  <button onClick={() => run('Duplicating', async () => (await api(`/segments/${segment.id}/duplicate`, { method: 'POST' })).state)}>DUPLICATE</button>
                  <button onClick={() => run('Removing segment', async () => { await api(`/segments/${segment.id}`, { method: 'DELETE' }); return api(`/batches/${batchId}`); })}>REMOVE</button>
                </td>
              </tr>;
            })}</tbody>
          </table>
        </div>}

        {openCaptions && <div className="bt-captions">
          <h3>Captions / {segmentName[openCaptions]}</h3>
          {!captions.length && <p className="bt-fine">No cues yet. Import a transcript below, generate from it, or add cues by hand.</p>}
          {captions.map((entry, index) => <div className="bt-cue" key={index}>
            <input type="number" min="0" value={Math.round(entry.startMs)} onChange={event => editCaption(index, { startMs: Number(event.target.value) })} aria-label="Cue start milliseconds" />
            <input type="number" min="0" value={Math.round(entry.endMs)} onChange={event => editCaption(index, { endMs: Number(event.target.value) })} aria-label="Cue end milliseconds" />
            <input value={entry.text} onChange={event => editCaption(index, { text: event.target.value })} aria-label="Cue text" />
            <button onClick={() => removeCaption(index)}>×</button>
          </div>)}
          <div className="bt-row">
            <button className="bt-btn" onClick={addCaption}>ADD CUE</button>
            <button className="bt-btn bt-btn-primary" onClick={saveCaptions}>SAVE CAPTIONS</button>
            <button className="bt-btn" onClick={() => setOpenCaptions(null)}>CLOSE</button>
          </div>
          <p className="bt-fine">Times are clip-relative milliseconds. Saving marks the clip for re-rendering.</p>
        </div>}

        <div className="bt-transcript">
          <h3>Source transcript (SRT)</h3>
          <textarea rows={4} value={srtText} placeholder={'1\n00:00:00,000 --> 00:00:02,000\nText from the recording'} onChange={event => setSrtText(event.target.value)} />
          <div className="bt-row">
            <button className="bt-btn" disabled={!source || !srtText.trim() || !!busy} onClick={importSrt}>IMPORT TRANSCRIPT</button>
            <button className="bt-btn" disabled={!source || !state.transcriptCount || !!busy} onClick={() => generateCaptions([])}>GENERATE FOR ALL CLIPS</button>
            <span className="bt-fine">{state.transcriptCount} cues stored against the source</span>
          </div>
        </div>
      </section>

      {/* 04 PROFILE */}
      <section className="bt-panel">
        <div className="bt-panel-head"><span>04 / PRODUCTION PROFILE</span><span>{state.profile?.name ?? 'NONE'}</span></div>
        {profileDraft ? <div className="bt-form">
          <h3>Video</h3>
          <div className="bt-grid">
            <label>WIDTH<input type="number" min="16" max="3840" value={profileDraft.video.width} onChange={event => setProfile('video.width', Number(event.target.value))} /></label>
            <label>HEIGHT<input type="number" min="16" max="3840" value={profileDraft.video.height} onChange={event => setProfile('video.height', Number(event.target.value))} /></label>
            <label>FIT<select value={profileDraft.video.fit} onChange={event => setProfile('video.fit', event.target.value)}><option value="cover">Crop to fill</option><option value="contain">Letterbox</option></select></label>
            <label>QUALITY (CRF)<input type="number" min="0" max="51" value={profileDraft.video.crf} onChange={event => setProfile('video.crf', Number(event.target.value))} /></label>
          </div>
          <h3>Captions</h3>
          <div className="bt-grid">
            <label>FONT<select value={profileDraft.captions.font} onChange={event => setProfile('captions.font', event.target.value)}><option>Anton</option><option>IBM Plex Mono</option></select></label>
            <label>SIZE<input type="number" min="12" max="200" value={profileDraft.captions.size} onChange={event => setProfile('captions.size', Number(event.target.value))} /></label>
            <label>POSITION<select value={profileDraft.captions.position} onChange={event => setProfile('captions.position', event.target.value)}><option value="bottom">Bottom</option><option value="center">Centre</option><option value="top">Top</option></select></label>
            <label>GROUPING<select value={profileDraft.captions.group} onChange={event => setProfile('captions.group', event.target.value)}><option value="phrase">Phrase</option><option value="word">Word</option></select></label>
            <label>TEXT<div className="bt-colour"><input type="color" value={profileDraft.captions.color} onChange={event => setProfile('captions.color', event.target.value)} /><input value={profileDraft.captions.color} onChange={event => setProfile('captions.color', event.target.value)} /></div></label>
            <label>OUTLINE<div className="bt-colour"><input type="color" value={profileDraft.captions.outline} onChange={event => setProfile('captions.outline', event.target.value)} /><input value={profileDraft.captions.outline} onChange={event => setProfile('captions.outline', event.target.value)} /></div></label>
          </div>
          <h3>Audio</h3>
          <div className="bt-grid">
            <label>VOLUME<input type="number" min="0" max="4" step="0.05" value={profileDraft.audio.volume} onChange={event => setProfile('audio.volume', Number(event.target.value))} /></label>
            <label>FADE IN ms<input type="number" min="0" step="50" value={profileDraft.audio.fadeInMs} onChange={event => setProfile('audio.fadeInMs', Number(event.target.value))} /></label>
            <label>FADE OUT ms<input type="number" min="0" step="50" value={profileDraft.audio.fadeOutMs} onChange={event => setProfile('audio.fadeOutMs', Number(event.target.value))} /></label>
          </div>
          <div className="bt-row">
            <button className="bt-btn bt-btn-primary" disabled={!!busy} onClick={() => applyProfile('all')}>APPLY TO ALL</button>
            <button className="bt-btn" disabled={!!busy || !selected.length} onClick={() => applyProfile('selected')}>APPLY TO SELECTED</button>
          </div>
          <p className="bt-fine">Applying a profile invalidates existing renders so stale output is never packaged. Watermark and logo overlays are not implemented yet.</p>
        </div> : <p className="bt-empty-line">Create a batch to get a production profile.</p>}

        {selected.length === 1 && (() => {
          const segment = segments.find(item => item.id === selected[0]);
          if (!segment) return null;
          return <div className="bt-override">
            <h3>Per-clip override / {segment.name}</h3>
            <div className="bt-grid">
              <label>WIDTH<input type="number" min="16" max="3840" value={segment.overrides?.video?.width ?? profileDraft?.video.width ?? 1080} onChange={event => overrideSegment(segment.id, { video: { ...(segment.overrides?.video || {}), width: Number(event.target.value) } })} /></label>
              <label>HEIGHT<input type="number" min="16" max="3840" value={segment.overrides?.video?.height ?? profileDraft?.video.height ?? 1920} onChange={event => overrideSegment(segment.id, { video: { ...(segment.overrides?.video || {}), height: Number(event.target.value) } })} /></label>
              <label>CRF<input type="number" min="0" max="51" value={segment.overrides?.video?.crf ?? profileDraft?.video.crf ?? 23} onChange={event => overrideSegment(segment.id, { video: { ...(segment.overrides?.video || {}), crf: Number(event.target.value) } })} /></label>
            </div>
            <button className="bt-btn" disabled={!!busy} onClick={() => patchSegment(segment.id, { overrides: {} })}>CLEAR OVERRIDES</button>
          </div>;
        })()}
      </section>

      {/* 05 QUEUE + EXPORT */}
      <section className="bt-panel bt-panel-wide">
        <div className="bt-panel-head"><span>05 / QUEUE &amp; EXPORT</span><span>{counts.queued ?? 0} ACTIVE · {counts.completed ?? 0} DONE · {counts.failed ?? 0} FAILED</span></div>
        <div className="bt-counts">
          {[['TOTAL', counts.total], ['APPROVED', counts.approved], ['QUEUED', counts.queued], ['COMPLETED', counts.completed], ['FAILED', counts.failed], ['CANCELLED', counts.cancelled]].map(([label, value]) => <div key={label}><span>{label}</span><strong>{String(value ?? 0).padStart(2, '0')}</strong></div>)}
        </div>
        <div className="bt-row">
          <button className="bt-btn" disabled={!!busy} onClick={() => batchAction(state.batch.paused ? 'resume' : 'pause')}>{state.batch.paused ? 'RESUME QUEUE' : 'PAUSE QUEUE'}</button>
          <button className="bt-btn" disabled={!!busy || !counts.failed} onClick={() => batchAction('retry-failed')}>RETRY ALL FAILED</button>
          <button className="bt-btn bt-btn-primary" disabled={!!busy || !counts.completed} onClick={packageBatch}>PACKAGE &amp; ZIP</button>
          {state.archive && <a className="bt-btn" href={state.archive.downloadUrl || `/api/batches/${batchId}/archive/download`}>DOWNLOAD {state.archive.partial ? 'PARTIAL ' : ''}ZIP</a>}
        </div>
        {state.batch.paused && <p className="bt-warn">Queue paused. Running clips finish; nothing new starts.</p>}
        {!jobs.length ? <p className="bt-empty-line">Nothing queued. Approve clips, then queue them.</p> : <div className="bt-table-wrap">
          <table className="bt-table bt-jobs">
            <thead><tr><th>JOB</th><th>CLIP</th><th>STATE</th><th>PROGRESS</th><th>DETAIL</th><th /></tr></thead>
            <tbody>{jobs.slice().reverse().map(job => <tr key={job.id}>
              <td className="bt-mono">{job.id.slice(0, 6)}</td>
              <td>{segmentName[job.segmentId] || job.segmentId.slice(0, 6)}</td>
              <td><span className={stateClass(job.state)}>{JOB_LABEL[job.state] || job.state}</span></td>
              <td><div className="bt-progress"><i style={{ width: `${Math.round((job.progress || 0) * 100)}%` }} /><span>{Math.round((job.progress || 0) * 100)}%</span></div></td>
              <td className="bt-error">{job.error || job.stage || '—'}{job.retries ? ` · retry ${job.retries}` : ''}</td>
              <td className="bt-actions">
                {['failed', 'cancelled'].includes(job.state) && <button onClick={() => jobAction(job, 'retry')}>RETRY</button>}
                {['waiting', 'preparing', 'processing', 'rendering', 'validating'].includes(job.state) && <button onClick={() => jobAction(job, 'cancel')}>CANCEL</button>}
              </td>
            </tr>)}</tbody>
          </table>
        </div>}
        {state.archive && <div className="bt-archive">
          <div><span>ARCHIVE</span><strong>{state.archive.filename}</strong></div>
          <div><span>SIZE</span><strong>{bytes(state.archive.size)}</strong></div>
          <div><span>CLIPS</span><strong>{state.archive.included.length}</strong></div>
          <div><span>PARTIAL</span><strong>{state.archive.partial ? 'YES' : 'NO'}</strong></div>
          {state.archive.excluded.length > 0 && <ul className="bt-excluded">{state.archive.excluded.map((item, index) => <li key={index}>{item.name || item.segmentId} — {item.reason}</li>)}</ul>}
        </div>}
        {busy && <p className="bt-fine" role="status">{busy}…</p>}
      </section>
    </div>}
  </div>;
}

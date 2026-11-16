# Studio architecture

## Implemented

Studio lives at the full-window `/studio` route; `/app/studio` redirects while preserving the query string and fragment. The visual system is the site's own editorial language — see `DESIGN_SYSTEM.md`.

`src/editor/model.js` holds project validation and pure single-track timeline operations. `src/editor/media.js` stores browser-decodable video and finished package archives in IndexedDB. `src/editor/Editor.jsx` coordinates project state, undo history, autosave, recovery, a single-video preview, the timeline, captions, package assembly and the job queue.

Surfaces:

1. **Top bar** — editable project name, save state, undo/redo, package and queue shortcuts.
2. **Media browser** (`01`) — import/drop, per-file metadata, add to V1, relink missing media, remove unused assets.
3. **Preview monitor** (`02`) — aspect-correct stage with crop marks, format readout, transport, frame stepping, caption overlay.
4. **Inspector** (`03`) — frame-based start/source-in/duration steppers, split, delete, caption text and timing, project readouts.
5. **Timeline** (`04`) — mono ruler, seek by click or drag, zoom, clip selection, edge-drag trimming with source and overlap clamps, playhead.
6. **Stream-to-ZIP** (`05`) — scope switch (timeline media or all media), manifest with included/omitted states, streamed archive with byte progress and cancel.
7. **Render queue** (`06`) — persisted package jobs with real `queued → running → done/failed` transitions, stored archives, download, retry and remove.

## Packaging and jobs

`src/editor/package.js` builds the manifest, the project document and an SRT sidecar, and resolves the original media blobs this browser still holds. `src/editor/zip.js` streams a stored (uncompressed) ZIP with a real data descriptor, CRC32 and byte counting, so progress reflects bytes written. `src/editor/queue.js` owns job creation, the transition table, persistence and sequential draining.

A package contains `project.json`, `captions.srt` when captions exist, `media/…` originals and `manifest.json`. It does **not** contain rendered video: there is no encoder or compositor in this application.

Queue jobs snapshot the project when queued, run one at a time, and store their archive in IndexedDB. Job records live in `localStorage` under `clipforge:queue:v1:<userId>:<projectId>`; packages live in the `packages` object store keyed by `<userId>:<jobId>`.

## Not implemented

Multitrack compositing, audio mixing, effects, transitions, keyframes, drag-to-move clips, timeline thumbnails/waveforms, encoded video export and rendering are not implemented. The preview is not a composition engine. The history keeps up to 50 project snapshots in memory.

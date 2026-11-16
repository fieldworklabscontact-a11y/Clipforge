# Batch Studio (Stream-to-ZIP)

One recording in, reviewed clips out. The pipeline is server-side and provider-independent: manual
segmentation, manual/SRT captions, FFmpeg rendering, a persistent queue and a validated ZIP archive
work with no AI service configured.

## Surfaces

| Piece | File |
| --- | --- |
| UI (five numbered panels) | `src/batch/BatchStudio.jsx`, `src/batch/batch.css` |
| SQLite schema + store | `server/batch/schema.js` |
| Domain rules (timing, captions, profiles, manifest) | `server/batch/domain.js` |
| Media engine wrapper | `server/batch/media.js` |
| Job execution and validation | `server/batch/render.js` |
| Persistent queue | `server/batch/queue.js` |
| ZIP writer/validator | `server/batch/zip.js` |
| HTTP API | `server/batch/routes.js` (mounted at `/api`) |

## Data model

`batch_sources`, `batches`, `segments`, `transcript_entries`, `caption_tracks`, `profiles`, `jobs`,
`outputs`, `archives` in the existing `data/clipforge.sqlite`. Media lives under
`data/batches/<batchId>/{source-*, thumbs/, outputs/, archives/, tmp/}`; the original upload is never
modified and is referenced, not copied, during rendering.

Timing is stored as integer source frames with a rational frame rate (`fpsNum` / `fpsDen`); seconds are
derived. A segment carries approval, caption state, render state, its profile and optional per-clip
overrides.

## Job lifecycle

`waiting → preparing → processing → rendering → validating → completed`, with `failed` and `cancelled`
as terminal states. Each job snapshots its fully resolved configuration plus a `configVersion` hash, so
later edits cannot change work that is already queued. Concurrency is bounded by
`BATCH_CONCURRENCY` (default `1`); pause stops new jobs while running ones finish, cancel records the
state immediately and aborts the process.

A job only completes after `validateOutput` confirms the file exists, is non-empty, probes, matches the
expected duration within tolerance and has the expected video/audio streams. Outputs are written to
`tmp/`, then renamed into `outputs/`.

## Recovery and failure handling

On start the server calls `queue.recover()`: interrupted jobs are requeued, completed work is kept,
and stale `tmp/` directories are removed. Missing source files, unreadable media, unapproved segments,
changed sources and encoder failures all fail the single job with a message, leaving other jobs intact.

Retrying a failed or cancelled job re-resolves its configuration against the current source and
profile before it is rescheduled, so retries never dead-end on a stale source fingerprint.

## Captions

One source-level transcript (manual entries or imported SRT). Per-clip tracks are derived with
`clip_ms = source_ms - segment_start_ms`, filtered to overlapping cues and clamped to the clip. Manual
edits are stored as `edited` tracks and are not overwritten by later regeneration.

Burned captions are authored as ASS with `PlayResX/Y` equal to the output size, so font size, margins
and position (bottom/centre/top) map to real pixels. libass needs fontconfig: `media.js` writes
`data/fontcache/fonts.conf` pointing at `assets/fonts` (Anton + IBM Plex Mono, both OFL). The config
must stay outside the fonts directory — libass treats every file in a `fontsdir` as a font.

## Production profiles

Defaults: 1080×1920 cover crop, CRF 23 `veryfast`, Anton 46 px captions at the bottom with outline,
audio volume 1.0. Profiles are reusable rows; applying one to all or selected clips invalidates their
previous outputs, and a clip whose stored `configHash` differs from the current resolved hash is
excluded from packaging. Overrides are stored per segment and merged into the resolved configuration.

## Packaging

`POST /api/batches/:id/package` writes `ClipForge_Batch/{videos,subtitles,thumbnails}` plus
`manifest.json` (batch id, source name, timestamps, durations, resolutions, frame rates, caption
inclusion, per-job status). Only validated, current renders are included; anything else is listed under
`excluded` with a reason and the archive is named `..._partial_...zip`. The archive is validated after
writing with entry counts and CRCs.

## Configuration

| Variable | Purpose |
| --- | --- |
| `BATCH_CONCURRENCY` | Maximum simultaneous renders (default `1`) |
| `FFMPEG_PATH`, `FFPROBE_PATH` | Override the bundled binaries |
| `PORT` | API port (default `3001`) |

`ffmpeg-static` and `ffprobe-static` ship the engine; `npm ci` restores both. When the engine is
missing, the API reports `engine.available: false` and the UI shows a banner instead of pretending to
render.

## Known limits

- No watermark/logo overlay, facecam layout, caption animation presets or silence-based cutting.
- Caption text is burned in; the archive also carries matching `.srt` sidecars.
- No AI provider is wired in. The transcript table and provider-independent caption conversion are the
  extension points; nothing in the render or packaging path imports an AI client.
- Remaining-time estimates are intentionally absent; only per-job progress reported by the encoder is
  shown.

## Verification

- `node --test test/batch.test.js` — segmentation, bounds, caption conversion, SRT round-trip, profile
  hashing, ZIP write/validate, queue concurrency, failure isolation, retry-only-failed, pause/cancel,
  restart recovery, SQLite persistence.
- `node --test test/batch-render.test.js` — real FFmpeg renders: validated output, audio stream,
  caption pixels actually changed, full job lifecycle, invalidation after a boundary change, missing
  source fails the job.
- Manual browser run on a 90 s 640×360 recording: 9 segments, approval, SRT import, per-clip captions,
  profile change to 720 px, pause while queued, bounded rendering (max 1 active), 9/9 completed in 43 s,
  ZIP download (16.6 MB, 9 videos + 9 SRTs + 9 thumbs, manifest matching), forced failure with a hidden
  source (`The source file is missing from storage.`), retry after restore, and a partial archive that
  excluded the eight clips left stale.

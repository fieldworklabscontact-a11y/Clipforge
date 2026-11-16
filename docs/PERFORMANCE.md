# Studio performance

No representative media performance benchmarks have been run and no frame-rate, latency, memory or export-time target is claimed. Preview uses the browser's native video decoder and a requestAnimationFrame-driven playhead. Only one source is played at a time. Video blobs are stored in IndexedDB; object URLs are revoked when the editor unmounts. Project edits are autosaved after a 1.2-second debounce and undo retains up to 50 in-memory project snapshots.

Metadata probing and IndexedDB operations are asynchronous, but are not explicitly dispatched to application workers. There is no timeline virtualization, proxy generation, waveform cache, frame cache, render process, background export or long-media testing. Browser storage capacity and eviction vary. The requested 30-minute, multitrack and large-library performance acceptance remains unverified.

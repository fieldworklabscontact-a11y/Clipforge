// Minimal streaming ZIP writer (store method, no compression) so packages can be
// produced from browser-held media without loading every file into memory.
const encoder = new TextEncoder();
const table = (() => {
  const values = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    values[i] = c >>> 0;
  }
  return values;
})();

export const crcStart = () => 0xffffffff;
export function crcUpdate(state, bytes) {
  let c = state;
  for (let i = 0; i < bytes.length; i++) c = table[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return c >>> 0;
}
export const crcFinish = state => (state ^ 0xffffffff) >>> 0;
export function crc32(bytes) { return crcFinish(crcUpdate(crcStart(), bytes)); }

const nameBytes = name => encoder.encode(name);
const dosStamp = (date = new Date()) => ({
  time: ((date.getHours() & 31) << 11) | ((date.getMinutes() & 63) << 5) | ((date.getSeconds() / 2) & 31),
  date: (((date.getFullYear() - 1980) & 127) << 9) | (((date.getMonth() + 1) & 15) << 5) | (date.getDate() & 31),
});

function localHeader(name, stamp) {
  const bytes = nameBytes(name);
  const header = new Uint8Array(30 + bytes.length);
  const view = new DataView(header.buffer);
  view.setUint32(0, 0x04034b50, true);
  view.setUint16(4, 20, true);
  view.setUint16(6, 0x0808, true); // UTF-8 names + trailing data descriptor
  view.setUint16(8, 0, true); // stored
  view.setUint16(10, stamp.time, true);
  view.setUint16(12, stamp.date, true);
  view.setUint32(14, 0, true);
  view.setUint32(18, 0, true);
  view.setUint32(22, 0, true);
  view.setUint16(26, bytes.length, true);
  view.setUint16(28, 0, true);
  header.set(bytes, 30);
  return { header, bytes };
}

function centralHeader(entry, stamp) {
  const header = new Uint8Array(46 + entry.bytes.length);
  const view = new DataView(header.buffer);
  view.setUint32(0, 0x02014b50, true);
  view.setUint16(4, 20, true);
  view.setUint16(6, 20, true);
  view.setUint16(8, 0x0808, true);
  view.setUint16(10, 0, true);
  view.setUint16(12, stamp.time, true);
  view.setUint16(14, stamp.date, true);
  view.setUint32(16, entry.crc, true);
  view.setUint32(20, entry.size, true);
  view.setUint32(24, entry.size, true);
  view.setUint16(28, entry.bytes.length, true);
  view.setUint16(30, 0, true);
  view.setUint16(32, 0, true);
  view.setUint16(34, 0, true);
  view.setUint16(36, 0, true);
  view.setUint32(38, 0, true);
  view.setUint32(42, entry.offset, true);
  header.set(entry.bytes, 46);
  return header;
}

const entrySize = entry => entry.bytes ?? entry.blob.size;

export function zipSize(entries) {
  let total = 22;
  for (const entry of entries) total += 30 + nameBytes(entry.name).length + entrySize(entry) + 16 + 46 + nameBytes(entry.name).length;
  return total;
}

export async function* zipChunks(entries, signal) {
  const stamp = dosStamp();
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    if (signal?.aborted) throw new DOMException('Package export canceled.', 'AbortError');
    const bytes = nameBytes(entry.name);
    const { header } = localHeader(entry.name, stamp);
    const start = offset;
    yield header; offset += header.length;
    let state = crcStart();
    let size = 0;
    const reader = entry.blob.stream().getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
        state = crcUpdate(state, chunk);
        size += chunk.length;
        offset += chunk.length;
        yield chunk;
        if (signal?.aborted) throw new DOMException('Package export canceled.', 'AbortError');
      }
    } finally { reader.releaseLock(); }
    const descriptor = new Uint8Array(16);
    const dv = new DataView(descriptor.buffer);
    dv.setUint32(0, 0x08074b50, true);
    dv.setUint32(4, crcFinish(state), true);
    dv.setUint32(8, size, true);
    dv.setUint32(12, size, true);
    yield descriptor; offset += descriptor.length;
    central.push({ bytes, crc: crcFinish(state), size, offset: start });
  }
  const directoryStart = offset;
  for (const entry of central) {
    const header = centralHeader(entry, stamp);
    yield header; offset += header.length;
  }
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, central.length, true);
  ev.setUint16(10, central.length, true);
  ev.setUint32(12, offset - directoryStart, true);
  ev.setUint32(16, directoryStart, true);
  yield end;
}

export function zipStream(entries, signal) {
  const iterator = zipChunks(entries, signal);
  return new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await iterator.next();
        if (done) controller.close(); else controller.enqueue(value);
      } catch (error) { controller.error(error); }
    },
    async cancel() { await iterator.return?.(); },
  });
}

export async function zipBlob(entries, onProgress, signal) {
  const total = zipSize(entries);
  let sent = 0;
  const parts = [];
  for await (const chunk of zipChunks(entries, signal)) {
    parts.push(chunk);
    sent += chunk.length;
    onProgress?.(total ? Math.min(1, sent / total) : 0, sent);
  }
  return new Blob(parts, { type: 'application/zip' });
}

export async function downloadZip(entries, fileName, { onProgress, signal } = {}) {
  const total = zipSize(entries);
  let sent = 0;
  const counted = zipStream(entries, signal).pipeThrough(new TransformStream({
    transform(chunk, controller) { sent += chunk.length; onProgress?.(total ? Math.min(1, sent / total) : 0, sent); controller.enqueue(chunk); },
  }));
  if (typeof window !== 'undefined' && window.showSaveFilePicker) {
    const handle = await window.showSaveFilePicker({ suggestedName: fileName, types: [{ description: 'ZIP archive', accept: { 'application/zip': ['.zip'] } }] });
    const writable = await handle.createWritable();
    try { await counted.pipeTo(writable); } catch (error) { try { await writable.abort(); } catch { /* already closed */ } throw error; }
    return { bytes: sent, saved: true };
  }
  const blob = await new Response(counted).blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url; link.download = fileName; link.rel = 'noopener';
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  return { bytes: blob.size, saved: true };
}

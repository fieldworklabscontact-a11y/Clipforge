import { existsSync, openSync, closeSync, readSync, statSync } from 'node:fs';
import { open } from 'node:fs/promises';

const encoder = new TextEncoder();
const table = (() => {
  const values = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    values[i] = c >>> 0;
  }
  return values;
})();
const crcState = () => 0xffffffff;
const crcUpdate = (state, bytes) => {
  let c = state;
  for (let i = 0; i < bytes.length; i += 1) c = table[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return c >>> 0;
};
const crcFinish = state => (state ^ 0xffffffff) >>> 0;

const dosStamp = (date = new Date()) => ({
  time: ((date.getHours() & 31) << 11) | ((date.getMinutes() & 63) << 5) | (Math.floor(date.getSeconds() / 2) & 31),
  date: (((date.getFullYear() - 1980) & 127) << 9) | (((date.getMonth() + 1) & 15) << 5) | (date.getDate() & 31),
});

function localHeader(nameBytes, stamp) {
  const header = Buffer.alloc(30 + nameBytes.length);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0x0808, 6);
  header.writeUInt16LE(0, 8);
  header.writeUInt16LE(stamp.time, 10);
  header.writeUInt16LE(stamp.date, 12);
  header.writeUInt32LE(0, 14);
  header.writeUInt32LE(0, 18);
  header.writeUInt32LE(0, 22);
  header.writeUInt16LE(nameBytes.length, 26);
  header.writeUInt16LE(0, 28);
  Buffer.from(nameBytes).copy(header, 30);
  return header;
}

function centralHeader(entry, stamp) {
  const header = Buffer.alloc(46 + entry.nameBytes.length);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(0x0808, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(stamp.time, 12);
  header.writeUInt16LE(stamp.date, 14);
  header.writeUInt32LE(entry.crc, 16);
  header.writeUInt32LE(entry.size, 20);
  header.writeUInt32LE(entry.size, 24);
  header.writeUInt16LE(entry.nameBytes.length, 28);
  header.writeUInt16LE(0, 30);
  header.writeUInt16LE(0, 32);
  header.writeUInt16LE(0, 34);
  header.writeUInt16LE(0, 36);
  header.writeUInt32LE(0, 38);
  header.writeUInt32LE(entry.offset, 42);
  Buffer.from(entry.nameBytes).copy(header, 46);
  return header;
}

/**
 * Streaming store-method ZIP writer. Files are copied in chunks, so a batch with
 * many clips is never loaded into memory at once.
 */
export async function writeZip(outputPath, entries) {
  const handle = await open(outputPath, 'w');
  const stamp = dosStamp();
  const central = [];
  let offset = 0;
  const writeAll = async buffer => { await handle.write(buffer, 0, buffer.length, offset); offset += buffer.length; };
  try {
    for (const entry of entries) {
      if (!existsSync(entry.path)) throw new Error(`Cannot add ${entry.name}: the file is missing.`);
      const nameBytes = encoder.encode(entry.name);
      const start = offset;
      await writeAll(Buffer.from(localHeader(nameBytes, stamp)));
      const input = await open(entry.path, 'r');
      let state = crcState();
      let size = 0;
      try {
        const buffer = Buffer.alloc(1 << 20);
        for (;;) {
          const { bytesRead } = await input.read(buffer, 0, buffer.length, size);
          if (!bytesRead) break;
          const chunk = buffer.subarray(0, bytesRead);
          state = crcUpdate(state, chunk);
          size += bytesRead;
          await writeAll(Buffer.from(chunk));
        }
      } finally { await input.close(); }
      const crc = crcFinish(state);
      const descriptor = Buffer.alloc(16);
      descriptor.writeUInt32LE(0x08074b50, 0);
      descriptor.writeUInt32LE(crc, 4);
      descriptor.writeUInt32LE(size, 8);
      descriptor.writeUInt32LE(size, 12);
      await writeAll(descriptor);
      central.push({ nameBytes, crc, size, offset: start });
    }
    const directoryStart = offset;
    for (const entry of central) await writeAll(Buffer.from(centralHeader(entry, stamp)));
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(central.length, 8);
    end.writeUInt16LE(central.length, 10);
    end.writeUInt32LE(offset - directoryStart, 12);
    end.writeUInt32LE(directoryStart, 16);
    await writeAll(end);
  } finally { await handle.close(); }
  return { size: offset, entries: central.length };
}

/** Structural validation of a finished archive: EOCD, directory and names. */
export function validateZip(file, expectedNames = []) {
  const problems = [];
  if (!existsSync(file)) return { ok: false, problems: ['The archive is missing.'], names: [] };
  const size = statSync(file).size;
  if (size < 22) return { ok: false, problems: ['The archive is too small to be a ZIP file.'], names: [] };
  const tailLength = Math.min(size, 66000);
  const tail = Buffer.alloc(tailLength);
  const fd = openSync(file, 'r');
  try { readSync(fd, tail, 0, tailLength, size - tailLength); } finally { closeSync(fd); }
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i -= 1) if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd === -1) return { ok: false, problems: ['The archive has no end-of-central-directory record.'], names: [] };
  const count = tail.readUInt16LE(eocd + 10);
  const directorySize = tail.readUInt32LE(eocd + 12);
  const directoryOffset = tail.readUInt32LE(eocd + 16);
  if (directoryOffset + directorySize + 22 !== size) problems.push('The archive central directory does not line up with the file size.');
  const directory = Buffer.alloc(directorySize);
  const dirFd = openSync(file, 'r');
  try { readSync(dirFd, directory, 0, directorySize, directoryOffset); } finally { closeSync(dirFd); }
  const names = [];
  let cursor = 0;
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > directory.length || directory.readUInt32LE(cursor) !== 0x02014b50) { problems.push('A central directory entry is malformed.'); break; }
    const nameLength = directory.readUInt16LE(cursor + 28);
    names.push(directory.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8'));
    cursor += 46 + nameLength + directory.readUInt16LE(cursor + 30) + directory.readUInt16LE(cursor + 32);
  }
  if (expectedNames.length) {
    for (const name of expectedNames) if (!names.includes(name)) problems.push(`The archive is missing ${name}.`);
    if (count !== expectedNames.length) problems.push(`The archive reports ${count} entries but ${expectedNames.length} were expected.`);
  }
  return { ok: problems.length === 0, problems, names, size };
}

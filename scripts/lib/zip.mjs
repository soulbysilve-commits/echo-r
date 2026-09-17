// Minimal, dependency-free ZIP writer (standard PKZIP format, DEFLATE
// via Node's built-in zlib) -- used only to assemble the ECHO Agent
// release package from the Nuitka build output directories into one
// customer-facing .zip. No `zip` binary or third-party package
// required. Only what this repo's packaging script needs: a flat list
// of {name, data} entries, no encryption, no ZIP64 (release is ~80MB,
// nowhere near the 4GB ZIP64 threshold).

import { deflateRawSync } from "node:zlib";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  const time = ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((date.getSeconds() >> 1) & 0x1f);
  const dosDate = (((date.getFullYear() - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0xf) << 5) | (date.getDate() & 0x1f);
  return { time, dosDate };
}

// Names that must never ship in a customer release, even if a local
// build/test workspace happens to contain them at packaging time --
// mirrors the same exclusion list already established in
// ECHODiscord版's own docs/DEVELOPER_RELEASE_MANIFEST.md and
// .gitignore (WAL/task-store/receipts, real resident state, local
// secrets). A compiled binary's default state root is relative to its
// own bundle directory, so running/smoke-testing a build in place
// (exactly what this session's own verification did) can leave this
// behind right next to the binary -- exclude it unconditionally
// rather than relying on every operator remembering to clean it up
// first.
const EXCLUDED_DIR_NAMES = new Set(["real_account_agent_state", ".env_users", "backups", "logs", "__pycache__"]);
const EXCLUDED_FILE_PATTERNS = [/^\.env(\..*)?$/, /\.log$/, /\.db(-shm|-wal)?$/, /\.sqlite$/];

function isExcluded(name, isDirectory) {
  if (isDirectory) return EXCLUDED_DIR_NAMES.has(name);
  return EXCLUDED_FILE_PATTERNS.some((pattern) => pattern.test(name));
}

/** Recursively lists files under `dir`, returning [{ absPath, relPath }]
 * with POSIX-style relative paths (forward slashes), rooted at
 * `baseName` inside the archive (so the zip contains
 * `<baseName>/...` rather than bare file names). Skips
 * EXCLUDED_DIR_NAMES/EXCLUDED_FILE_PATTERNS entirely. */
export function listFilesForZip(dir, baseName) {
  const out = [];
  function walk(current, relPrefix) {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (isExcluded(entry.name, entry.isDirectory())) {
        console.warn(`[zip] excluding ${relPrefix ? relPrefix + "/" : ""}${entry.name} from release package`);
        continue;
      }
      const absPath = path.join(current, entry.name);
      const relPath = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(absPath, relPath);
      } else if (entry.isFile()) {
        out.push({ absPath, relPath: `${baseName}/${relPath}` });
      }
    }
  }
  walk(dir, "");
  return out;
}

/** Builds a ZIP archive (Buffer) from a list of {absPath, relPath}
 * entries. Files ending in `.bin` get the unix executable bit set in
 * their external file attributes (harmless on Windows, needed for a
 * direct chmod +x expectation on Linux/macOS after extraction). */
export function buildZip(entries) {
  const now = new Date();
  const { time, dosDate } = dosDateTime(now);
  const localChunks = [];
  const centralChunks = [];
  let offset = 0;

  for (const { absPath, relPath } of entries) {
    const data = readFileSync(absPath);
    const compressed = deflateRawSync(data);
    const useDeflate = compressed.length < data.length;
    const method = useDeflate ? 8 : 0;
    const payload = useDeflate ? compressed : data;
    const crc = crc32(data);
    const nameBuf = Buffer.from(relPath.replace(/\\/g, "/"), "utf8");
    const isExecutable = relPath.endsWith(".bin");
    const unixMode = isExecutable ? 0o100755 : 0o100644;

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(time, 10);
    localHeader.writeUInt16LE(dosDate, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(payload.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);

    localChunks.push(localHeader, nameBuf, payload);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(time, 12);
    centralHeader.writeUInt16LE(dosDate, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(payload.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE((unixMode << 16) >>> 0, 38);
    centralHeader.writeUInt32LE(offset, 42);

    centralChunks.push(centralHeader, nameBuf);

    offset += localHeader.length + nameBuf.length + payload.length;
  }

  const centralDirStart = offset;
  const centralDirBuf = Buffer.concat(centralChunks);
  const centralDirSize = centralDirBuf.length;

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirSize, 12);
  eocd.writeUInt32LE(centralDirStart, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localChunks, centralDirBuf, eocd]);
}

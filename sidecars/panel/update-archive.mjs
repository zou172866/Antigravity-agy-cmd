import { createHash, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { inflateRaw } from "node:zlib";

export class UpdateError extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

const ALLOWED_HOSTS = new Set([
  "api.github.com",
  "github.com",
  "codeload.github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com"
]);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const inflateRawAsync = promisify(inflateRaw);

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

export function computeCrc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) {
    crc = CRC32_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function getHeader(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === "function") return headers.get(name);
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return v == null ? null : String(v);
  }
  return null;
}

/**
 * Verify a downloaded archive buffer against an expected hex SHA-256 digest.
 */
export function verifyArchiveSha256(buffer, expectedSha256) {
  if (typeof expectedSha256 !== "string" || !/^[0-9a-f]{64}$/i.test(expectedSha256)) {
    throw new UpdateError("integrity");
  }
  const actual = createHash("sha256").update(buffer).digest();
  const expected = Buffer.from(expectedSha256.toLowerCase(), "hex");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new UpdateError("integrity");
  }
}

/**
 * Download a GitHub release archive with strict HTTPS host allowlist, manual redirect checks,
 * timeout, bounded byte size, and optional SHA-256 digest verification.
 */
export async function downloadArchive(
  startUrl,
  {
    fetchImpl = (...args) => fetch(...args),
    timeoutMs = 30_000,
    maxBytes = 16 * 1024 * 1024,
    expectedSha256 = ""
  } = {}
) {
  const signal = AbortSignal.timeout(timeoutMs);

  function approvedUrl(value, base) {
    if (typeof value !== "string" || !value.trim()) {
      throw new UpdateError("redirect");
    }
    let url = null;
    try {
      url = base ? new URL(value, base) : new URL(value);
    } catch {
      throw new UpdateError("redirect");
    }
    if (
      !url ||
      url.protocol !== "https:" ||
      !ALLOWED_HOSTS.has(url.hostname) ||
      url.port ||
      url.username ||
      url.password
    ) {
      throw new UpdateError("redirect");
    }
    return url.href;
  }

  try {
    let url = approvedUrl(startUrl);
    for (let i = 0; i <= 4; i++) {
      const res = await fetchImpl(url, {
        redirect: "manual",
        signal,
        headers: { "User-Agent": "agy-cmd" }
      });
      if (res.url) {
        try {
          approvedUrl(res.url);
        } catch (error) {
          void res.body?.cancel?.().catch(() => {});
          throw error;
        }
      }
      if (REDIRECT_STATUSES.has(res.status)) {
        void res.body?.cancel?.().catch(() => {});
        url = approvedUrl(getHeader(res.headers, "location"), url);
        continue;
      }
      if (!res.ok) {
        void res.body?.cancel?.().catch(() => {});
        throw new UpdateError("download");
      }
      const declaredLength = Number(getHeader(res.headers, "content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        void res.body?.cancel?.().catch(() => {});
        throw new UpdateError("size");
      }
      if (!res.body) {
        if (typeof res.arrayBuffer === "function") {
          const buf = Buffer.from(await res.arrayBuffer());
          if (buf.byteLength > maxBytes) throw new UpdateError("size");
          if (expectedSha256) verifyArchiveSha256(buf, expectedSha256);
          return buf;
        }
        throw new UpdateError("download");
      }

      const chunks = [];
      let size = 0;
      const reader = res.body.getReader();
      try {
        while (true) {
          signal.throwIfAborted();
          const { value, done } = await reader.read();
          if (done) {
            const buf = Buffer.concat(chunks, size);
            if (expectedSha256) verifyArchiveSha256(buf, expectedSha256);
            return buf;
          }
          size += value.byteLength;
          if (size > maxBytes) throw new UpdateError("size");
          chunks.push(Buffer.from(value));
        }
      } catch (error) {
        void reader.cancel?.().catch(() => {});
        throw error;
      } finally {
        reader.releaseLock();
      }
    }
    throw new UpdateError("redirect");
  } catch (error) {
    if (error instanceof UpdateError) throw error;
    throw new UpdateError(
      signal.aborted || error?.name === "TimeoutError" || error?.name === "AbortError" ? "timeout" : "download"
    );
  }
}

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function safePath(rawPath) {
  const parts = rawPath.split("/");
  if (
    parts.some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        /[\\:*?"<>|\x00-\x1f\x7f]/.test(part) ||
        /[ .]$/.test(part) ||
        /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(part)
    )
  ) {
    throw new UpdateError("archive");
  }
  return parts;
}

/**
 * Pure-JS ZIP reader (Stored + Deflate) with EOCD/Central Directory/Local Header cross-checks,
 * CRC-32 verification, symlink/encryption rejection, and strict path/size bounds.
 * Strips the single top-level directory and returns Map<relPath, Buffer>.
 */
export async function readZipArchive(buffer, maxBytes = 48 * 1024 * 1024) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (buf.length < 22) throw new UpdateError("archive");

  const minEocdPos = Math.max(0, buf.length - 22 - 65535);
  let eocdPos = -1;
  for (let i = buf.length - 22; i >= minEocdPos; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      const commentLen = buf.readUInt16LE(i + 20);
      if (i + 22 + commentLen === buf.length) {
        eocdPos = i;
        break;
      }
    }
  }
  if (eocdPos < 0) throw new UpdateError("archive");

  const diskNum = buf.readUInt16LE(eocdPos + 4);
  const cdDisk = buf.readUInt16LE(eocdPos + 6);
  const entriesOnDisk = buf.readUInt16LE(eocdPos + 8);
  const totalEntries = buf.readUInt16LE(eocdPos + 10);
  const cdSize = buf.readUInt32LE(eocdPos + 12);
  const cdOffset = buf.readUInt32LE(eocdPos + 16);

  if (
    diskNum !== 0 ||
    cdDisk !== 0 ||
    entriesOnDisk !== totalEntries ||
    totalEntries === 0xffff ||
    totalEntries > 4096 ||
    cdSize === 0xffffffff ||
    cdOffset === 0xffffffff ||
    cdOffset + cdSize !== eocdPos
  ) {
    throw new UpdateError("archive");
  }

  const files = new Map();
  const seen = new Set();
  let archiveRoot;
  let totalExtracted = 0;
  let pos = cdOffset;

  for (let i = 0; i < totalEntries; i++) {
    if (pos + 46 > eocdPos || buf.readUInt32LE(pos) !== 0x02014b50) {
      throw new UpdateError("archive");
    }

    const versionMadeBy = buf.readUInt16LE(pos + 4);
    const flags = buf.readUInt16LE(pos + 8);
    const method = buf.readUInt16LE(pos + 10);
    const expectedCrc = buf.readUInt32LE(pos + 16);
    const compSize = buf.readUInt32LE(pos + 20);
    const uncompSize = buf.readUInt32LE(pos + 24);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const entryDisk = buf.readUInt16LE(pos + 34);
    const extAttr = buf.readUInt32LE(pos + 38);
    const localOffset = buf.readUInt32LE(pos + 42);

    const nextPos = pos + 46 + nameLen + extraLen + commentLen;
    if (nextPos > eocdPos || entryDisk !== 0) throw new UpdateError("archive");

    // Reject encrypted entries, unsupported methods, or ZIP64 sentinel sizes
    if (
      (flags & 0x0041) !== 0 ||
      (method !== 0 && method !== 8) ||
      compSize === 0xffffffff ||
      uncompSize === 0xffffffff ||
      localOffset === 0xffffffff
    ) {
      throw new UpdateError("archive");
    }

    // Reject Unix symlinks / FIFOs / device nodes when Unix external attributes are present
    const hostOs = versionMadeBy >>> 8;
    const unixType = (extAttr >>> 16) & 0o170000;
    if (hostOs === 3 && unixType !== 0 && unixType !== 0o100000 && unixType !== 0o040000) {
      throw new UpdateError("archive");
    }

    const nameBytes = buf.subarray(pos + 46, pos + 46 + nameLen);
    let rawPath;
    try {
      rawPath = utf8.decode(nameBytes);
    } catch {
      throw new UpdateError("archive");
    }
    pos = nextPos;

    // Cross-check Local File Header to prevent local-vs-central-directory spoofing
    if (localOffset + 30 > cdOffset || buf.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new UpdateError("archive");
    }
    const localFlags = buf.readUInt16LE(localOffset + 6);
    const localMethod = buf.readUInt16LE(localOffset + 8);
    const localCrc = buf.readUInt32LE(localOffset + 14);
    const localCompSize = buf.readUInt32LE(localOffset + 18);
    const localUncompSize = buf.readUInt32LE(localOffset + 22);
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);

    const localNameStart = localOffset + 30;
    const dataStart = localNameStart + localNameLen + localExtraLen;
    const dataEnd = dataStart + compSize;
    if (
      localMethod !== method ||
      localNameLen !== nameLen ||
      dataEnd > cdOffset ||
      !buf.subarray(localNameStart, localNameStart + localNameLen).equals(nameBytes)
    ) {
      throw new UpdateError("archive");
    }
    if ((flags & 0x0008) === 0 && (localFlags & 0x0008) === 0) {
      if (localCrc !== expectedCrc || localCompSize !== compSize || localUncompSize !== uncompSize) {
        throw new UpdateError("archive");
      }
    }

    const isDirectory = rawPath.endsWith("/") || (hostOs === 3 && unixType === 0o040000);
    if (isDirectory && uncompSize !== 0) throw new UpdateError("archive");

    if (uncompSize > maxBytes - totalExtracted) {
      throw new UpdateError("size");
    }

    const cleanedPath = isDirectory ? rawPath.replace(/\/$/, "") : rawPath;
    const parts = safePath(cleanedPath);
    archiveRoot ??= parts[0];
    if (parts[0] !== archiveRoot) throw new UpdateError("archive");

    const key = parts.join("/").normalize("NFC").toLowerCase();
    if (seen.has(key)) throw new UpdateError("archive");
    seen.add(key);

    if (isDirectory || parts.length < 2) continue;

    const rawSlice = buf.subarray(dataStart, dataEnd);
    let contents;
    if (method === 0) {
      if (compSize !== uncompSize) throw new UpdateError("archive");
      contents = Buffer.from(rawSlice);
    } else {
      const remainingBudget = maxBytes - totalExtracted;
      try {
        contents = await inflateRawAsync(rawSlice, { maxOutputLength: Math.max(1, remainingBudget) });
      } catch (error) {
        throw new UpdateError(error?.code === "ERR_BUFFER_TOO_LARGE" ? "size" : "archive");
      }
      if (contents.length !== uncompSize) {
        throw new UpdateError(contents.length > remainingBudget ? "size" : "archive");
      }
    }

    if (computeCrc32(contents) !== expectedCrc) {
      throw new UpdateError("archive");
    }

    totalExtracted += contents.length;
    if (totalExtracted > maxBytes) throw new UpdateError("size");

    const relative = parts.slice(1).join("/");
    files.set(relative, contents);
  }

  if (pos !== eocdPos) throw new UpdateError("archive");
  return files;
}

/**
 * Validate ZIP magic bytes and extract safely into Map<relPath, Buffer>.
 */
export async function readReleaseArchive(compressed, maxBytes = 48 * 1024 * 1024) {
  const buf = Buffer.isBuffer(compressed) ? compressed : Buffer.from(compressed || []);
  if (buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 0x03 || buf[2] === 0x05)) {
    return readZipArchive(buf, maxBytes);
  }
  throw new UpdateError("archive");
}

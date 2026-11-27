import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { nonEmptyString, sanitizeConversationId } from "./common.mjs";

const DIAGNOSTICS_FILENAME = "diagnostics.json";
const WORKER_IDENTITIES_FILENAME = "worker-identities.json";
const MAX_HOST_BUCKETS = 32;
const MAX_WORKER_ENTRIES = 200;
const WORKER_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const HEAD_FINGERPRINT_BYTES = 4096;

const ALLOWED_DIAGNOSTIC_REASONS = new Set([
  "unknown_transcript_receipt",
  "pending_receipt_out_of_window",
  "transcript_parse_unknown",
  "transcript_rolled_over_unknown",
  "optional_role_unavailable",
  "worker_identity_unknown"
]);

function writeJsonAtomicBestEffort(filePath, obj) {
  let tmpPath = "";
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    tmpPath = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(obj, null, 2) + "\n", "utf8");
    fs.renameSync(tmpPath, filePath);
  } catch {
    if (tmpPath) {
      try {
        fs.unlinkSync(tmpPath);
      } catch {}
    }
  }
}

function readJsonSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function sanitizeHostToken(raw, fallback = "unknown") {
  const s = nonEmptyString(raw).replace(/[^A-Za-z0-9._-]/g, "").slice(0, 32);
  return s || fallback;
}

export function detectHostVersion(payload = {}, env = process.env) {
  const p = payload && typeof payload === "object" ? payload : {};
  const e = env && typeof env === "object" ? env : {};
  const raw =
    nonEmptyString(p.hostVersion) ||
    nonEmptyString(p.host_version) ||
    nonEmptyString(p.appVersion) ||
    nonEmptyString(p.app_version) ||
    nonEmptyString(p.metadata?.hostVersion) ||
    nonEmptyString(p.metadata?.host_version) ||
    nonEmptyString(e.ANTIGRAVITY_VERSION) ||
    nonEmptyString(e.ANTIGRAVITY_HOST_VERSION);
  return sanitizeHostToken(raw, "unknown");
}

/**
 * Record privacy-safe local diagnostic counters grouped by host surface and version.
 * Stores strictly aggregate integer counts (zero chat text, zero logs, zero paths).
 */
export function recordHostDiagnostic(
  stateDir,
  { surface = "unknown", hostVersion = "unknown", reason = "", count = 1, nowIso = null } = {}
) {
  if (!stateDir || !ALLOWED_DIAGNOSTIC_REASONS.has(reason)) return false;
  const inc = Number.isFinite(Number(count)) && Number(count) > 0 ? Math.floor(Number(count)) : 1;
  const filePath = path.join(stateDir, DIAGNOSTICS_FILENAME);
  const store = readJsonSafe(filePath, { version: 1, updatedAt: "", buckets: {} });
  const buckets = store.buckets && typeof store.buckets === "object" && !Array.isArray(store.buckets)
    ? { ...store.buckets }
    : {};
  const bucketKey = `${sanitizeHostToken(surface)}@${sanitizeHostToken(hostVersion)}`;
  const ts = typeof nowIso === "string" && nowIso.trim() ? nowIso.trim() : new Date().toISOString();

  const existing =
    buckets[bucketKey] && typeof buckets[bucketKey] === "object" && !Array.isArray(buckets[bucketKey])
      ? { ...buckets[bucketKey] }
      : { surface: sanitizeHostToken(surface), hostVersion: sanitizeHostToken(hostVersion), counts: {}, lastSeenAt: ts };
  const counts =
    existing.counts && typeof existing.counts === "object" && !Array.isArray(existing.counts)
      ? { ...existing.counts }
      : {};
  counts[reason] = (Number.isFinite(Number(counts[reason])) ? Math.floor(Number(counts[reason])) : 0) + inc;
  existing.counts = counts;
  existing.lastSeenAt = ts;
  buckets[bucketKey] = existing;

  const keys = Object.keys(buckets);
  if (keys.length > MAX_HOST_BUCKETS) {
    keys
      .sort((a, b) => String(buckets[a]?.lastSeenAt || "").localeCompare(String(buckets[b]?.lastSeenAt || "")))
      .slice(0, keys.length - MAX_HOST_BUCKETS)
      .forEach((k) => {
        delete buckets[k];
      });
  }

  writeJsonAtomicBestEffort(filePath, { version: 1, updatedAt: ts, buckets });
  return true;
}

export function readHostDiagnostics(stateDir) {
  if (!stateDir) return { version: 1, updatedAt: "", totals: {}, buckets: {} };
  const filePath = path.join(stateDir, DIAGNOSTICS_FILENAME);
  const store = readJsonSafe(filePath, { version: 1, updatedAt: "", buckets: {} });
  const buckets = store.buckets && typeof store.buckets === "object" && !Array.isArray(store.buckets)
    ? store.buckets
    : {};
  const totals = {};
  for (const bucket of Object.values(buckets)) {
    if (!bucket || typeof bucket !== "object" || !bucket.counts || typeof bucket.counts !== "object") continue;
    for (const [reason, rawVal] of Object.entries(bucket.counts)) {
      if (!ALLOWED_DIAGNOSTIC_REASONS.has(reason)) continue;
      const n = Number(rawVal);
      if (Number.isFinite(n) && n > 0) {
        totals[reason] = (totals[reason] || 0) + Math.floor(n);
      }
    }
  }
  return {
    version: 1,
    updatedAt: typeof store.updatedAt === "string" ? store.updatedAt : "",
    totals,
    buckets
  };
}

/**
 * Compute a generation fingerprint for a transcript file so positive Worker identity
 * evidence stays bound to the exact conversation trajectory and invalidates on rewind/truncation.
 */
export function computeTranscriptGeneration(transcriptPath) {
  if (!transcriptPath) return null;
  let fd = null;
  try {
    const st = fs.statSync(transcriptPath);
    if (!st.isFile() || st.size === 0) return null;
    const readLen = Math.min(st.size, HEAD_FINGERPRINT_BYTES);
    const buf = Buffer.allocUnsafe(readLen);
    fd = fs.openSync(transcriptPath, "r");
    const bytesRead = fs.readSync(fd, buf, 0, readLen, 0);
    const normPath = process.platform === "win32" ? path.resolve(transcriptPath).toLowerCase() : path.resolve(transcriptPath);
    return {
      pathHash: crypto.createHash("sha256").update(normPath).digest("hex").slice(0, 20),
      headDigest: crypto.createHash("sha256").update(buf.subarray(0, bytesRead)).digest("hex").slice(0, 20),
      fileSize: st.size
    };
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}

export function recordConfirmedWorkerIdentity(
  stateDir,
  convId,
  generation,
  source = "transcript",
  nowMs = Date.now()
) {
  const safeId = sanitizeConversationId(convId);
  if (!stateDir || !safeId || !generation?.pathHash || !generation?.headDigest) return false;
  const filePath = path.join(stateDir, WORKER_IDENTITIES_FILENAME);
  const store = readJsonSafe(filePath, { version: 1, entries: {} });
  const entries = store.entries && typeof store.entries === "object" && !Array.isArray(store.entries)
    ? { ...store.entries }
    : {};

  // Prune expired entries opportunistically
  for (const [k, v] of Object.entries(entries)) {
    if (!v || typeof v !== "object" || nowMs - Number(v.updatedAtMs || 0) > WORKER_TTL_MS) {
      delete entries[k];
    }
  }

  const prev = entries[safeId];
  const sameGen = prev && prev.pathHash === generation.pathHash && prev.headDigest === generation.headDigest;
  entries[safeId] = {
    pathHash: generation.pathHash,
    headDigest: generation.headDigest,
    minSize: sameGen ? Math.min(Number(prev.minSize || generation.fileSize), generation.fileSize) : generation.fileSize,
    lastSize: generation.fileSize,
    source: sanitizeHostToken(source, "transcript"),
    updatedAtMs: nowMs
  };

  const keys = Object.keys(entries);
  if (keys.length > MAX_WORKER_ENTRIES) {
    keys
      .sort((a, b) => Number(entries[a]?.updatedAtMs || 0) - Number(entries[b]?.updatedAtMs || 0))
      .slice(0, keys.length - MAX_WORKER_ENTRIES)
      .forEach((k) => {
        delete entries[k];
      });
  }

  writeJsonAtomicBestEffort(filePath, { version: 1, entries });
  return true;
}

/**
 * Look up persisted positive Worker evidence for a session & transcript generation.
 * Automatically invalidates and clears stale evidence if the transcript was rewound or replaced.
 */
export function lookupConfirmedWorkerIdentity(stateDir, convId, generation, nowMs = Date.now()) {
  const safeId = sanitizeConversationId(convId);
  if (!stateDir || !safeId || !generation?.pathHash || !generation?.headDigest) return null;
  const filePath = path.join(stateDir, WORKER_IDENTITIES_FILENAME);
  const store = readJsonSafe(filePath, { version: 1, entries: {} });
  const entries = store.entries && typeof store.entries === "object" && !Array.isArray(store.entries)
    ? store.entries
    : {};
  const entry = entries[safeId];
  if (!entry || typeof entry !== "object") return null;
  if (nowMs - Number(entry.updatedAtMs || 0) > WORKER_TTL_MS) return null;

  const samePath = entry.pathHash === generation.pathHash;
  const sameHead = entry.headDigest === generation.headDigest;
  const notRewound = generation.fileSize >= Number(entry.minSize || 0);

  if (samePath && sameHead && notRewound) {
    return {
      confirmed: true,
      source: entry.source || "persisted_evidence"
    };
  }

  // Transcript was replaced or rewound to an earlier generation: invalidate stale evidence
  const nextEntries = { ...entries };
  delete nextEntries[safeId];
  writeJsonAtomicBestEffort(filePath, { version: 1, entries: nextEntries });
  return null;
}

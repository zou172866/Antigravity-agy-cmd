import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const WAIT_BUF = new Int32Array(new SharedArrayBuffer(4));
const activeReentrantLocks = new Set();

export function sleepSyncMs(ms) {
  if (ms <= 0) return;
  try {
    Atomics.wait(WAIT_BUF, 0, 0, ms);
  } catch {}
}

export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

export function readLockInfo(lockPath) {
  try {
    const raw = fs.readFileSync(lockPath, "utf8");
    const parsed = JSON.parse(raw.replace(/^\uFEFF/, ""));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {}
  return null;
}

export function resolveLockWaitMs({ optionWaitMs, envVarName = "", defaultWaitMs = 1000 } = {}) {
  const opt = Number(optionWaitMs);
  if (Number.isFinite(opt) && opt >= 0) return Math.floor(opt);
  if (envVarName) {
    const envVal = Number(process.env[envVarName]);
    if (Number.isFinite(envVal) && envVal >= 0) return Math.floor(envVal);
  }
  return defaultWaitMs;
}

function isLockStale(lockPath, staleMs, deadPidGraceMs, pidAliveFn) {
  let st;
  try {
    st = fs.statSync(lockPath);
  } catch {
    return { stale: false, token: null };
  }
  const ageMs = Date.now() - st.mtimeMs;
  const info = readLockInfo(lockPath);
  if (info && Number.isInteger(info.pid)) {
    const tsAge = Number.isFinite(info.ts) ? Date.now() - info.ts : ageMs;
    if (info.pid !== process.pid && !pidAliveFn(info.pid) && ageMs >= deadPidGraceMs) {
      return { stale: true, token: typeof info.token === "string" ? info.token : null };
    }
    if (tsAge > staleMs && ageMs > staleMs) {
      return { stale: true, token: typeof info.token === "string" ? info.token : null };
    }
    return { stale: false, token: typeof info.token === "string" ? info.token : null };
  }
  if (ageMs > staleMs) {
    return { stale: true, token: null };
  }
  return { stale: false, token: null };
}

function tryReclaimStaleLock(lockPath, expectedToken, staleMs, deadPidGraceMs, pidAliveFn) {
  const check = isLockStale(lockPath, staleMs, deadPidGraceMs, pidAliveFn);
  if (!check.stale) return false;
  if (expectedToken !== null && check.token !== expectedToken) return false;
  try {
    fs.unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Exclusive cross-process file lock using O_EXCL (`wx`) with dead-PID / stale-timestamp
 * reclamation, owner-token verification on release, and optional same-process re-entrancy.
 */
export function withFileLock(
  lockPath,
  fn,
  {
    maxWaitMs = 1000,
    staleMs = 2000,
    deadPidGraceMs = 100,
    stepMs = 8,
    isPidAliveFn = isPidAlive,
    reentrant = false,
    createTimeoutError = () => {
      const err = new Error("File is busy (lock timeout); please retry.");
      err.code = "FILE_LOCK_TIMEOUT";
      err.statusCode = 503;
      err.retryable = true;
      return err;
    }
  } = {}
) {
  if (!lockPath) return fn();

  const lockKey = reentrant
    ? process.platform === "win32"
      ? path.resolve(lockPath).toLowerCase()
      : path.resolve(lockPath)
    : "";
  if (reentrant && activeReentrantLocks.has(lockKey)) {
    return fn();
  }

  const pidAliveFn = typeof isPidAliveFn === "function" ? isPidAliveFn : isPidAlive;
  const token = crypto.randomBytes(8).toString("hex");
  let acquired = false;

  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + Math.max(0, Number(maxWaitMs) || 0);
  while (true) {
    let lockFd = null;
    try {
      lockFd = fs.openSync(lockPath, "wx");
      try {
        const record = JSON.stringify({ pid: process.pid, token, ts: Date.now() }) + "\n";
        fs.writeFileSync(lockFd, record, "utf8");
      } finally {
        try {
          fs.closeSync(lockFd);
        } catch {}
      }
      acquired = true;
      break;
    } catch (err) {
      if (err?.code !== "EEXIST") {
        throw err;
      }
      const { stale, token: staleToken } = isLockStale(lockPath, staleMs, deadPidGraceMs, pidAliveFn);
      if (stale && tryReclaimStaleLock(lockPath, staleToken, staleMs, deadPidGraceMs, pidAliveFn)) {
        continue;
      }
      if (Date.now() >= deadline) {
        throw createTimeoutError();
      }
      sleepSyncMs(stepMs);
    }
  }

  if (reentrant) activeReentrantLocks.add(lockKey);
  try {
    return fn();
  } finally {
    if (reentrant) activeReentrantLocks.delete(lockKey);
    if (acquired) {
      try {
        const current = readLockInfo(lockPath);
        if (current && current.token === token) {
          fs.unlinkSync(lockPath);
        }
      } catch {}
    }
  }
}

/**
 * Atomically replace a UTF-8 file via sibling temp file + rename, with Windows
 * EPERM/EBUSY/EACCES retry backoff and guaranteed temp cleanup on error.
 */
export function writeFileAtomic(
  filePath,
  content,
  { maxAttempts = 8, retryBaseMs = 10, busyCode = "FILE_WRITE_BUSY", label = "file" } = {}
) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpName = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(tmpName, content, "utf8");
    let lastErr = null;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        fs.renameSync(tmpName, filePath);
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        const retryable =
          process.platform === "win32" &&
          (err?.code === "EPERM" || err?.code === "EBUSY" || err?.code === "EACCES");
        if (!retryable) {
          throw err;
        }
        sleepSyncMs(retryBaseMs * (attempt + 1));
      }
    }
    if (lastErr) {
      const wrapped = new Error(`Failed to atomically replace ${label}: ${lastErr.message}`);
      wrapped.code = lastErr.code || busyCode;
      wrapped.statusCode = 503;
      wrapped.retryable = true;
      wrapped.cause = lastErr;
      throw wrapped;
    }
  } catch (err) {
    try {
      fs.unlinkSync(tmpName);
    } catch {}
    throw err;
  }
}

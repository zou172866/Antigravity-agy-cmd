import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { sanitizeConversationId } from "./common.mjs";

const MAX_EVENT_LINES = 120;
const COMPACT_TRIGGER_LINES = 180;
const COMPACT_TRIGGER_BYTES = 64 * 1024;
const GC_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const SESSION_LOCK_STALE_MS = 5000;
const SESSION_LOCK_DEAD_PID_GRACE_MS = 100;
const SESSION_LOCK_DEFAULT_WAIT_MS = 1000;
const SESSION_LOCK_STEP_MS = 8;
const WAIT_BUF = new Int32Array(new SharedArrayBuffer(4));
const activeSessionLocks = new Set();

export class SessionLockTimeoutError extends Error {
  constructor(message = "Session state is busy (lock timeout); please retry.") {
    super(message);
    this.name = "SessionLockTimeoutError";
    this.code = "SESSION_LOCK_TIMEOUT";
    this.statusCode = 503;
    this.retryable = true;
  }
}

function sleepSyncMs(ms) {
  if (ms <= 0) return;
  try {
    Atomics.wait(WAIT_BUF, 0, 0, ms);
  } catch {}
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

function readLockInfo(lockPath) {
  try {
    const raw = fs.readFileSync(lockPath, "utf8");
    const parsed = JSON.parse(raw.replace(/^\uFEFF/, ""));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {}
  return null;
}

function resolveSessionLockWaitMs(options = {}) {
  const opt = Number(options.maxWaitMs);
  if (Number.isFinite(opt) && opt >= 0) return Math.floor(opt);
  const envVal = Number(process.env.AGY_CMD_SESSION_LOCK_WAIT_MS);
  if (Number.isFinite(envVal) && envVal >= 0) return Math.floor(envVal);
  return SESSION_LOCK_DEFAULT_WAIT_MS;
}

function isSessionLockStale(lockPath, staleMs, pidAliveFn) {
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
    if (info.pid !== process.pid && !pidAliveFn(info.pid) && ageMs >= SESSION_LOCK_DEAD_PID_GRACE_MS) {
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

function tryReclaimStaleSessionLock(lockPath, expectedToken, staleMs, pidAliveFn) {
  const check = isSessionLockStale(lockPath, staleMs, pidAliveFn);
  if (!check.stale) return false;
  if (expectedToken !== null && check.token !== expectedToken) return false;
  try {
    fs.unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

export function hashLegacyUserInput(rawText) {
  if (typeof rawText !== "string" || !rawText.trim()) return "";
  return crypto.createHash("sha256").update(rawText.trim()).digest("hex").slice(0, 24);
}

export function createDefaultState() {
  return {
    version: 1,
    rev: 0,
    userTurnCount: 0,
    lastInitialNumSteps: null,
    lastTurnInitialSteps: null,
    lastUserInputHash: "",
    lastTurnSignals: null,
    debugTurnStreak: 0,
    boostDetected: false,
    lastBoostDetectedTurn: 0,
    lastBoostDetectedEventTs: 0,
    boostAlerted: false,
    lastPaidBoostTurn: null,
    lastBoostAlertTurn: 0,
    lastBoostAlertEventTs: 0,
    lastBoostPassTs: 0,
    lastGoalAlertTurn: 0,
    lastTeamworkAlertTurn: 0,
    lastPlanBlockAlertKey: "",
    lastPlanBoostKey: "",
    lastPlanBoostNoticeHash: "",
    lastPlanBoostPromptKey: "",
    freePlan: null,
    deliveryGate: null,
    swarmActive: false,
    swarmLastActivityKey: "",
    swarmLastActivityStep: null,
    swarmClearedAfterKey: "",
    swarmClearedAtStep: null,
    lastTurnUserInputKey: "",
    lastTurnStartTs: 0,
    turnUnattendedGoal: false,
    turnRetryOverride: null,
    turnAutoRetries: 0,
    turnBaseExecutionNum: null,
    lastContinueEventSig: "",
    testAuditNoticedSig: "",
    turnAllowTestWeakening: false,
    turnAuditFloorTs: 0,
    turnAuditFloorStep: -1,
    resolvedSteps: {}
  };
}

function getSessionsDir(stateDir) {
  return path.join(stateDir, "sessions");
}

function getSessionLockPath(stateDir, convId) {
  const safeKey = sanitizeConversationId(convId);
  if (!safeKey) return "";
  return path.join(getSessionsDir(stateDir), `${safeKey}.lock`);
}

function getEventLogPath(stateDir, convId) {
  const safeKey = sanitizeConversationId(convId);
  if (!safeKey) return "";
  return path.join(getSessionsDir(stateDir), `${safeKey}.events.jsonl`);
}

function getStateFilePath(stateDir, convId) {
  const safeKey = sanitizeConversationId(convId);
  if (!safeKey) return "";
  return path.join(getSessionsDir(stateDir), `${safeKey}.state.json`);
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

export function withSessionLock(stateDir, convId, fn, options = {}) {
  const lockPath = getSessionLockPath(stateDir, convId);
  if (!lockPath) {
    return fn();
  }
  const lockKey = process.platform === "win32" ? path.resolve(lockPath).toLowerCase() : path.resolve(lockPath);
  if (activeSessionLocks.has(lockKey)) {
    return fn();
  }

  const maxWaitMs = resolveSessionLockWaitMs(options);
  const staleMs =
    Number.isFinite(Number(options.staleMs)) && Number(options.staleMs) > 0
      ? Number(options.staleMs)
      : SESSION_LOCK_STALE_MS;
  const pidAliveFn = typeof options.isPidAlive === "function" ? options.isPidAlive : isPidAlive;
  const token = crypto.randomBytes(8).toString("hex");
  let acquired = false;

  ensureDir(path.dirname(lockPath));
  const deadline = Date.now() + maxWaitMs;
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
      const { stale, token: staleToken } = isSessionLockStale(lockPath, staleMs, pidAliveFn);
      if (stale && tryReclaimStaleSessionLock(lockPath, staleToken, staleMs, pidAliveFn)) {
        continue;
      }
      if (Date.now() >= deadline) {
        throw new SessionLockTimeoutError();
      }
      sleepSyncMs(SESSION_LOCK_STEP_MS);
    }
  }

  activeSessionLocks.add(lockKey);
  try {
    return fn();
  } finally {
    activeSessionLocks.delete(lockKey);
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

function writeFileAtomic(filePath, content) {
  ensureDir(path.dirname(filePath));
  const tmpName = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(tmpName, content, "utf8");
    let lastErr = null;
    for (let attempt = 0; attempt < 8; attempt++) {
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
        sleepSyncMs(10 * (attempt + 1));
      }
    }
    if (lastErr) {
      const wrapped = new Error(`Failed to atomically replace session file: ${lastErr.message}`);
      wrapped.code = lastErr.code || "SESSION_WRITE_BUSY";
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

function readEventLogSnapshot(logPath) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const stat = fs.statSync(logPath);
      if (!stat.isFile() || stat.size === 0) return { parsed: [], fileBytes: 0 };
      const raw = fs.readFileSync(logPath, "utf8");
      const lines = raw.split(/\r?\n/);
      const parsed = [];
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const obj = JSON.parse(trimmed);
          if (obj && typeof obj === "object" && !Array.isArray(obj)) {
            parsed.push(obj);
          }
        } catch {
          // Ignore malformed/partial lines safely
        }
      }
      return { parsed, fileBytes: stat.size };
    } catch (err) {
      if (err?.code === "ENOENT") return { parsed: [], fileBytes: 0 };
      const retryable =
        attempt < 3 && (err?.code === "EBUSY" || err?.code === "EPERM" || err?.code === "EACCES");
      if (retryable) {
        sleepSyncMs(8 * (attempt + 1));
        continue;
      }
      return { parsed: [], fileBytes: 0 };
    }
  }
  return { parsed: [], fileBytes: 0 };
}

export function appendEvents(stateDir, convId, events) {
  if (!Array.isArray(events) || events.length === 0) return;
  const logPath = getEventLogPath(stateDir, convId);
  if (!logPath) return;
  withSessionLock(stateDir, convId, () => {
    ensureDir(path.dirname(logPath));
    const payload = events.map((ev) => JSON.stringify(ev)).join("\n") + "\n";
    fs.appendFileSync(logPath, payload, "utf8");
  });
}

export function readEvents(stateDir, convId, options = {}) {
  const maxLines = options.maxLines ?? MAX_EVENT_LINES;
  const compact = options.compact !== false;
  const logPath = getEventLogPath(stateDir, convId);
  if (!logPath) return [];

  const initial = readEventLogSnapshot(logPath);
  const needsCompact =
    compact && (initial.parsed.length > COMPACT_TRIGGER_LINES || initial.fileBytes > COMPACT_TRIGGER_BYTES);
  if (!needsCompact) {
    return initial.parsed.length > maxLines ? initial.parsed.slice(-maxLines) : initial.parsed;
  }

  try {
    return withSessionLock(stateDir, convId, () => {
      // Re-read inside the session lock so appends made while waiting are never lost.
      const fresh = readEventLogSnapshot(logPath);
      const trimmed = fresh.parsed.length > maxLines ? fresh.parsed.slice(-maxLines) : fresh.parsed;
      if (fresh.parsed.length > COMPACT_TRIGGER_LINES || fresh.fileBytes > COMPACT_TRIGGER_BYTES) {
        const compacted = trimmed.map((ev) => JSON.stringify(ev)).join("\n") + "\n";
        writeFileAtomic(logPath, compacted);
      }
      return trimmed;
    });
  } catch {
    return initial.parsed.length > maxLines ? initial.parsed.slice(-maxLines) : initial.parsed;
  }
}

export function clearEvents(stateDir, convId) {
  const logPath = getEventLogPath(stateDir, convId);
  if (!logPath) return;
  withSessionLock(stateDir, convId, () => {
    try {
      if (fs.existsSync(logPath)) {
        fs.unlinkSync(logPath);
      }
    } catch {}
  });
}

export function readState(stateDir, convId) {
  const def = createDefaultState();
  const statePath = getStateFilePath(stateDir, convId);
  if (!statePath) return def;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      if (!fs.existsSync(statePath)) return def;
      const raw = fs.readFileSync(statePath, "utf8");
      if (!raw.trim() && attempt < 3) {
        sleepSyncMs(8 * (attempt + 1));
        continue;
      }
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return def;
      const merged = { ...def, ...parsed };
      if (!merged.lastUserInputHash && typeof parsed.lastUserInput === "string" && parsed.lastUserInput.trim()) {
        merged.lastUserInputHash = hashLegacyUserInput(parsed.lastUserInput);
      }
      delete merged.lastUserInput;
      const rawRev = Number(merged.rev);
      merged.rev = Number.isFinite(rawRev) && rawRev >= 0 ? Math.floor(rawRev) : 0;
      return merged;
    } catch (err) {
      const retryable =
        attempt < 3 && (err?.code === "EBUSY" || err?.code === "EPERM" || err?.code === "EACCES");
      if (retryable) {
        sleepSyncMs(8 * (attempt + 1));
        continue;
      }
      return def;
    }
  }
  return def;
}

export function writeState(stateDir, convId, state) {
  const statePath = getStateFilePath(stateDir, convId);
  if (!statePath) return;
  withSessionLock(stateDir, convId, () => {
    const clean = { ...(state && typeof state === "object" ? state : createDefaultState()) };
    delete clean.lastUserInput;
    const prevRev = Number(clean.rev);
    clean.rev = (Number.isFinite(prevRev) && prevRev >= 0 ? Math.floor(prevRev) : 0) + 1;
    writeFileAtomic(statePath, JSON.stringify(clean) + "\n");
  });
}

export function maybeGcStaleSessions(stateDir, nowMs = Date.now(), maxAgeMs = DEFAULT_TTL_MS) {
  const sessionsDir = getSessionsDir(stateDir);
  const stampPath = path.join(sessionsDir, ".last-gc");
  try {
    if (!fs.existsSync(sessionsDir)) return 0;
    try {
      const st = fs.statSync(stampPath);
      if (nowMs - st.mtimeMs < GC_INTERVAL_MS) return 0;
    } catch {}

    let removed = 0;
    const entries = fs.readdirSync(sessionsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (
        !entry.name.endsWith(".events.jsonl") &&
        !entry.name.endsWith(".state.json") &&
        !entry.name.endsWith(".lock")
      ) {
        continue;
      }
      const fullPath = path.join(sessionsDir, entry.name);
      try {
        const st = fs.statSync(fullPath);
        if (nowMs - st.mtimeMs > maxAgeMs) {
          fs.unlinkSync(fullPath);
          removed += 1;
        }
      } catch {}
    }

    try {
      fs.writeFileSync(stampPath, String(nowMs), "utf8");
    } catch {}
    return removed;
  } catch {
    return 0;
  }
}

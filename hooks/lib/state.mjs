import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { sanitizeConversationId } from "./common.mjs";
import { resolveLockWaitMs, sleepSyncMs, withFileLock, writeFileAtomic as writeFileAtomicShared } from "./fs-atomic.mjs";

const MAX_EVENT_LINES = 120;
const COMPACT_TRIGGER_LINES = 180;
const COMPACT_TRIGGER_BYTES = 64 * 1024;
const GC_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const BOOTSTRAP_LOG_MAX_BYTES = 64 * 1024;
const BOOTSTRAP_LOG_KEEP_BYTES = 32 * 1024;

const SESSION_LOCK_STALE_MS = 5000;
const SESSION_LOCK_DEAD_PID_GRACE_MS = 100;
const SESSION_LOCK_DEFAULT_WAIT_MS = 1000;
const SESSION_LOCK_STEP_MS = 8;

export class SessionLockTimeoutError extends Error {
  constructor(message = "Session state is busy (lock timeout); please retry.") {
    super(message);
    this.name = "SessionLockTimeoutError";
    this.code = "SESSION_LOCK_TIMEOUT";
    this.statusCode = 503;
    this.retryable = true;
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
    lastStopOutcome: null,
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
  const maxWaitMs = resolveLockWaitMs({
    optionWaitMs: options.maxWaitMs,
    envVarName: "AGY_CMD_SESSION_LOCK_WAIT_MS",
    defaultWaitMs: SESSION_LOCK_DEFAULT_WAIT_MS
  });
  const staleMs =
    Number.isFinite(Number(options.staleMs)) && Number(options.staleMs) > 0
      ? Number(options.staleMs)
      : SESSION_LOCK_STALE_MS;
  return withFileLock(lockPath, fn, {
    maxWaitMs,
    staleMs,
    deadPidGraceMs: SESSION_LOCK_DEAD_PID_GRACE_MS,
    stepMs: SESSION_LOCK_STEP_MS,
    isPidAliveFn: options.isPidAlive,
    reentrant: true,
    createTimeoutError: () => new SessionLockTimeoutError()
  });
}

function writeFileAtomic(filePath, content) {
  return writeFileAtomicShared(filePath, content, {
    maxAttempts: 8,
    retryBaseMs: 10,
    busyCode: "SESSION_WRITE_BUSY",
    label: "session file"
  });
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

function trimBootstrapLogIfNeeded(stateDir) {
  const logPath = path.join(stateDir, "hook-bootstrap.log");
  try {
    const st = fs.statSync(logPath);
    if (!st.isFile() || st.size <= BOOTSTRAP_LOG_MAX_BYTES) return false;
    const fd = fs.openSync(logPath, "r");
    let tailBuf;
    try {
      const offset = Math.max(0, st.size - BOOTSTRAP_LOG_KEEP_BYTES);
      const len = st.size - offset;
      tailBuf = Buffer.allocUnsafe(len);
      const bytesRead = fs.readSync(fd, tailBuf, 0, len, offset);
      tailBuf = tailBuf.subarray(0, bytesRead);
    } finally {
      try {
        fs.closeSync(fd);
      } catch {}
    }
    const firstNl = tailBuf.indexOf(0x0a);
    const trimmed = firstNl >= 0 && firstNl + 1 < tailBuf.length ? tailBuf.subarray(firstNl + 1) : tailBuf;
    writeFileAtomic(logPath, trimmed.toString("utf8"));
    return true;
  } catch {
    return false;
  }
}

export function maybeGcStaleSessions(stateDir, nowMs = Date.now(), maxAgeMs = DEFAULT_TTL_MS) {
  const sessionsDir = getSessionsDir(stateDir);
  const stampPath = path.join(sessionsDir, ".last-gc");
  try {
    if (!fs.existsSync(sessionsDir)) {
      trimBootstrapLogIfNeeded(stateDir);
      return 0;
    }
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

    trimBootstrapLogIfNeeded(stateDir);

    try {
      fs.writeFileSync(stampPath, String(nowMs), "utf8");
    } catch {}
    return removed;
  } catch {
    return 0;
  }
}

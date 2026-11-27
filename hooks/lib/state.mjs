import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { sanitizeConversationId } from "./common.mjs";

const MAX_EVENT_LINES = 120;
const COMPACT_TRIGGER_LINES = 180;
const COMPACT_TRIGGER_BYTES = 64 * 1024;
const GC_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function createDefaultState() {
  return {
    version: 1,
    userTurnCount: 0,
    lastInitialNumSteps: null,
    lastTurnInitialSteps: null,
    lastUserInput: "",
    debugTurnStreak: 0,
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
    lastTurnUserInputKey: "",
    lastTurnStartTs: 0,
    turnUnattendedGoal: false,
    turnRetryOverride: null,
    turnAutoRetries: 0,
    turnBaseExecutionNum: null,
    lastContinueEventSig: "",
    resolvedSteps: {}
  };
}

function getSessionsDir(stateDir) {
  return path.join(stateDir, "sessions");
}

function getEventLogPath(stateDir, convId) {
  const safeKey = sanitizeConversationId(convId);
  return path.join(getSessionsDir(stateDir), `${safeKey}.events.jsonl`);
}

function getStateFilePath(stateDir, convId) {
  const safeKey = sanitizeConversationId(convId);
  return path.join(getSessionsDir(stateDir), `${safeKey}.state.json`);
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeFileAtomic(filePath, content) {
  ensureDir(path.dirname(filePath));
  const tmpName = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(tmpName, content, "utf8");
    try {
      fs.renameSync(tmpName, filePath);
    } catch (err) {
      if (process.platform === "win32" && (err?.code === "EPERM" || err?.code === "EBUSY")) {
        fs.writeFileSync(filePath, content, "utf8");
        try {
          fs.unlinkSync(tmpName);
        } catch {}
      } else {
        throw err;
      }
    }
  } catch (err) {
    try {
      fs.unlinkSync(tmpName);
    } catch {}
    throw err;
  }
}

export function appendEvents(stateDir, convId, events) {
  if (!Array.isArray(events) || events.length === 0) return;
  const logPath = getEventLogPath(stateDir, convId);
  ensureDir(path.dirname(logPath));
  const payload = events.map((ev) => JSON.stringify(ev)).join("\n") + "\n";
  fs.appendFileSync(logPath, payload, "utf8");
}

export function readEvents(stateDir, convId, options = {}) {
  const maxLines = options.maxLines ?? MAX_EVENT_LINES;
  const compact = options.compact !== false;
  const logPath = getEventLogPath(stateDir, convId);
  let raw = "";
  let fileBytes = 0;
  try {
    const stat = fs.statSync(logPath);
    if (!stat.isFile() || stat.size === 0) return [];
    fileBytes = stat.size;
    raw = fs.readFileSync(logPath, "utf8");
  } catch {
    return [];
  }

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

  const trimmedEvents = parsed.length > maxLines ? parsed.slice(-maxLines) : parsed;
  if (compact && (parsed.length > COMPACT_TRIGGER_LINES || fileBytes > COMPACT_TRIGGER_BYTES)) {
    try {
      const compacted = trimmedEvents.map((ev) => JSON.stringify(ev)).join("\n") + "\n";
      writeFileAtomic(logPath, compacted);
    } catch {}
  }

  return trimmedEvents;
}

export function clearEvents(stateDir, convId) {
  const logPath = getEventLogPath(stateDir, convId);
  try {
    if (fs.existsSync(logPath)) {
      fs.unlinkSync(logPath);
    }
  } catch {}
}

export function readState(stateDir, convId) {
  const statePath = getStateFilePath(stateDir, convId);
  const def = createDefaultState();
  try {
    if (!fs.existsSync(statePath)) return def;
    const raw = fs.readFileSync(statePath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return def;
    return { ...def, ...parsed };
  } catch {
    return def;
  }
}

export function writeState(stateDir, convId, state) {
  const statePath = getStateFilePath(stateDir, convId);
  writeFileAtomic(statePath, JSON.stringify(state) + "\n");
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
      if (!entry.name.endsWith(".events.jsonl") && !entry.name.endsWith(".state.json")) continue;
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

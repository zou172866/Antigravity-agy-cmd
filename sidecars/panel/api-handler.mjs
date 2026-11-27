import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sanitizeConversationId } from "../../hooks/lib/common.mjs";
import {
  evaluateStarPrompt,
  formatDeliveryGateSummaryZh,
  formatRetrySummaryZh,
  readSettings,
  setStarPromptState,
  STAR_PROMPT_TERMINAL_STATES,
  updateAutoUpdateState,
  updateSettings
} from "../../hooks/lib/settings.mjs";
import { readState } from "../../hooks/lib/state.mjs";
import { createVersionChecker, parseVersion, readLocalVersion } from "./version-check.mjs";
import { createPluginUpdater, evaluateAutoInstallEligibility } from "./version-update.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const NO_STORE_HEADERS = Object.freeze({
  "Cache-Control": "no-store, no-cache, must-revalidate",
  "X-Content-Type-Options": "nosniff"
});

const LOCAL_HOST_RE = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/i;
const LOCAL_HTTP_ORIGIN_RE = /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/i;
const VSCODE_WEBVIEW_RE = /^vscode-webview:\/\/[a-z0-9._-]+(?:\/.*)?$/i;
export const AUTO_UPDATE_ACK_ROUTE = "/api/auto-update-ack";

const STAR_PROMPT_ALLOWED_KEYS = new Set(["state"]);
const STAR_PROMPT_ALLOWED_STATES = new Set(STAR_PROMPT_TERMINAL_STATES);
const VERSION_CHECK_ALLOWED_KEYS = new Set(["mode", "fresh"]);
const PLUGIN_UPDATE_ALLOWED_KEYS = new Set(["version"]);
const AUTO_UPDATE_ACK_ALLOWED_KEYS = new Set(["dismissNotice"]);
const NON_CIRCUIT_AUTO_FAIL_REASONS = new Set(["gitCheckout", "notInstalled", "managedByHost", "busy", "releaseChanged"]);

let _defaultVersionChecker = null;
let _defaultPluginUpdater = null;
let _updateInFlight = false;
let _updateRestartScheduled = false;
let _autoCycleInFlight = null;

export function isPluginUpdateBusy() {
  return _updateInFlight || _updateRestartScheduled;
}

export function resetUpdateRuntimeFlags() {
  _updateInFlight = false;
  _updateRestartScheduled = false;
  _autoCycleInFlight = null;
}

function parseOptionalEnvBool(raw) {
  if (raw === undefined || raw === null) return undefined;
  const s = String(raw).trim().toLowerCase();
  if (!s) return undefined;
  if (s === "1" || s === "true" || s === "yes" || s === "on") return true;
  if (s === "0" || s === "false" || s === "no" || s === "off") return false;
  return undefined;
}

export function isAutoUpdateCheckEnabled(stateDir, env = process.env) {
  if (parseOptionalEnvBool(env?.AGY_CMD_DISABLE_AUTO_UPDATE_CHECK) === true) {
    return false;
  }
  const envVal = parseOptionalEnvBool(env?.AGY_CMD_AUTO_UPDATE_CHECK);
  if (envVal !== undefined) return envVal;
  try {
    return readSettings(stateDir).autoUpdateCheck !== false;
  } catch {
    return true;
  }
}

export function isAutoUpdateInstallEnabled(stateDir, env = process.env) {
  if (!isAutoUpdateCheckEnabled(stateDir, env)) return false;
  if (parseOptionalEnvBool(env?.AGY_CMD_DISABLE_AUTO_UPDATE_INSTALL) === true) {
    return false;
  }
  const envVal = parseOptionalEnvBool(env?.AGY_CMD_AUTO_UPDATE_INSTALL);
  if (envVal !== undefined) return envVal;
  try {
    const s = readSettings(stateDir);
    return s.autoUpdateCheck !== false && s.autoUpdateInstall === true;
  } catch {
    return false;
  }
}

export function getDefaultVersionChecker() {
  if (!_defaultVersionChecker) {
    _defaultVersionChecker = createVersionChecker({
      getCurrentVersion: () => readLocalVersion()
    });
  }
  return _defaultVersionChecker;
}

export function getDefaultPluginUpdater() {
  if (!_defaultPluginUpdater) {
    _defaultPluginUpdater = createPluginUpdater({
      sidecarDirectory: __dirname,
      checkVersion: getDefaultVersionChecker()
    });
  }
  return _defaultPluginUpdater;
}

function isPlainJsonObject(val) {
  if (!val || typeof val !== "object" || Array.isArray(val)) return false;
  const proto = Object.getPrototypeOf(val);
  return proto === Object.prototype || proto === null;
}

function matchesSameLoopbackHostPort(headerUrlStr, hostHeader) {
  try {
    const parsed = new URL(headerUrlStr);
    if (parsed.protocol !== "http:" || !LOCAL_HTTP_ORIGIN_RE.test(parsed.origin)) {
      return false;
    }
    if (!hostHeader) {
      return false;
    }
    const hUrl = new URL(`http://${hostHeader}`);
    if (parsed.hostname.toLowerCase() !== hUrl.hostname.toLowerCase()) return false;
    const pPort = parsed.port || "80";
    const hPort = hUrl.port || "80";
    if (pPort !== hPort) return false;
    return true;
  } catch {
    return false;
  }
}

export function isAllowedLocalRequest(req) {
  if (!req?.headers) return true;
  const host = String(req.headers.host || "").trim();
  if (!host || !LOCAL_HOST_RE.test(host)) {
    return false;
  }

  const secFetchSite = String(req.headers["sec-fetch-site"] || "").trim().toLowerCase();
  if (secFetchSite && secFetchSite !== "same-origin" && secFetchSite !== "none") {
    return false;
  }

  const origin = String(req.headers.origin || "").trim();
  if (origin) {
    if (!VSCODE_WEBVIEW_RE.test(origin) && !matchesSameLoopbackHostPort(origin, host)) {
      return false;
    }
  }

  const referer = String(req.headers.referer || "").trim();
  if (referer) {
    if (!VSCODE_WEBVIEW_RE.test(referer) && !matchesSameLoopbackHostPort(referer, host)) {
      return false;
    }
  }

  return true;
}

export function timingSafeEqualStr(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || !a || !b) return false;
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function countTrackedSessions(stateDir) {
  try {
    const dir = path.join(stateDir, "sessions");
    if (!fs.existsSync(dir)) return 0;
    return fs.readdirSync(dir).filter((f) => f.endsWith(".state.json")).length;
  } catch {
    return 0;
  }
}

export function buildPanelStatePayload(stateDir, rawConvId = "", { markStarTriggered = true } = {}) {
  const starPrompt = evaluateStarPrompt(stateDir, { markTriggered: markStarTriggered });
  const settings = readSettings(stateDir);
  const trackedSessions = countTrackedSessions(stateDir);
  let activeSession = null;

  if (typeof rawConvId === "string" && rawConvId.trim()) {
    const safeId = sanitizeConversationId(rawConvId.trim());
    const statePath = path.join(stateDir, "sessions", `${safeId}.state.json`);
    if (fs.existsSync(statePath)) {
      const st = readState(stateDir, safeId);
      activeSession = {
        conversationId: safeId.slice(0, 12),
        userTurnCount: st.userTurnCount || 0,
        turnAutoRetries: st.turnAutoRetries || 0,
        debugTurnStreak: st.debugTurnStreak || 0
      };
    }
  }

  const localVersion = readLocalVersion();
  const autoState = settings.autoUpdateState || {};
  const autoUpdateNotice =
    autoState.lastAutoUpdatedVersion && (!localVersion || autoState.lastAutoUpdatedVersion === localVersion)
      ? {
          version: autoState.lastAutoUpdatedVersion,
          previousVersion: autoState.lastAutoUpdatedFrom || "",
          updatedAt: autoState.lastAutoUpdatedAt || "",
          releaseUrl: autoState.lastAutoUpdatedUrl || ""
        }
      : null;

  return {
    ok: true,
    version: localVersion,
    autoUpdateInstallEffective: isAutoUpdateInstallEnabled(stateDir),
    autoUpdateNotice,
    settings,
    starPrompt,
    summaryZh: formatRetrySummaryZh(settings),
    deliveryGateStatusZh: formatDeliveryGateSummaryZh(settings),
    boostStatusZh:
      settings.planTier === "paid" && settings.boostEnabled
        ? "Pro/Ultra 会员 · 已开启 /boost 自动接入"
        : settings.planTier === "paid"
          ? "Pro/Ultra 会员 · 已手动关闭 /boost 自动接入"
          : "免费版安全模式 · 已屏蔽付费口令防报错",
    trackedSessions,
    activeSession
  };
}

export function handleStarPromptMutation(stateDir, rawData) {
  const proto = rawData && typeof rawData === "object" ? Object.getPrototypeOf(rawData) : null;
  if (
    !rawData ||
    typeof rawData !== "object" ||
    Array.isArray(rawData) ||
    (proto !== Object.prototype && proto !== null)
  ) {
    return {
      status: 400,
      body: { ok: false, error: "Request body must be a JSON object" }
    };
  }
  for (const key of Object.keys(rawData)) {
    if (!STAR_PROMPT_ALLOWED_KEYS.has(key)) {
      return {
        status: 400,
        body: { ok: false, error: `Unexpected field '${key}' in request body` }
      };
    }
  }
  const stateVal = Object.prototype.hasOwnProperty.call(rawData, "state") ? rawData.state : undefined;
  if (typeof stateVal !== "string" || !STAR_PROMPT_ALLOWED_STATES.has(stateVal)) {
    return {
      status: 400,
      body: {
        ok: false,
        error: "Invalid 'state' value: expected 'clicked', 'dismissed', or 'copied_cli'"
      }
    };
  }
  const res = setStarPromptState(stateDir, stateVal);
  if (!res.ok) {
    return {
      status: 400,
      body: { ok: false, error: res.error }
    };
  }
  return {
    status: 200,
    body: {
      ok: true,
      starPrompt: res.starPrompt,
      alreadyResolved: Boolean(res.alreadyResolved)
    }
  };
}

export async function handleVersionCheck(
  rawData,
  { stateDir = "", checker = null, autoCheckEnabled = null, env = process.env } = {}
) {
  const data = rawData === undefined ? {} : rawData;
  if (!isPlainJsonObject(data)) {
    return {
      status: 400,
      body: { ok: false, error: "Request body must be a JSON object" }
    };
  }
  for (const key of Object.keys(data)) {
    if (!VERSION_CHECK_ALLOWED_KEYS.has(key)) {
      return {
        status: 400,
        body: { ok: false, error: `Unexpected field '${key}' in request body` }
      };
    }
  }
  const mode = data.mode === undefined ? "manual" : data.mode;
  if (mode !== "manual" && mode !== "auto") {
    return {
      status: 400,
      body: { ok: false, error: "Invalid 'mode' value: expected 'manual' or 'auto'" }
    };
  }
  if (data.fresh !== undefined && typeof data.fresh !== "boolean") {
    return {
      status: 400,
      body: { ok: false, error: "Field 'fresh' must be a boolean" }
    };
  }
  const allowAuto =
    typeof autoCheckEnabled === "boolean" ? autoCheckEnabled : isAutoUpdateCheckEnabled(stateDir, env);
  if (mode === "auto" && !allowAuto) {
    return {
      status: 200,
      body: {
        ok: true,
        status: "idle",
        currentVersion: readLocalVersion(),
        disabled: true
      }
    };
  }
  const resolvedChecker = checker || getDefaultVersionChecker();
  const result = await resolvedChecker(mode, { fresh: Boolean(data.fresh) });
  return {
    status: 200,
    body: result
  };
}

export async function handlePluginUpdate(
  rawData,
  { stateDir = "", updater = null, onUpdated = null, automatic = false, nowIso = null } = {}
) {
  if (!isPlainJsonObject(rawData)) {
    return {
      status: 400,
      body: { ok: false, error: "Request body must be a JSON object" }
    };
  }
  for (const key of Object.keys(rawData)) {
    if (!PLUGIN_UPDATE_ALLOWED_KEYS.has(key)) {
      return {
        status: 400,
        body: { ok: false, error: `Unexpected field '${key}' in request body` }
      };
    }
  }
  const parsed = typeof rawData.version === "string" ? parseVersion(rawData.version) : null;
  if (!parsed) {
    return {
      status: 400,
      body: { ok: false, error: "Invalid or missing 'version' SemVer string" }
    };
  }
  const resolvedUpdater = updater || getDefaultPluginUpdater();
  let result;
  _updateInFlight = true;
  try {
    result = await resolvedUpdater(parsed.version);
  } finally {
    _updateInFlight = false;
  }
  if (result?.status === "updated") {
    if (stateDir) {
      const ts = typeof nowIso === "string" && nowIso.trim() ? nowIso.trim() : new Date().toISOString();
      if (automatic) {
        updateAutoUpdateState(stateDir, {
          lastAutoUpdatedVersion: result.version || parsed.version,
          lastAutoUpdatedFrom: result.previousVersion || "",
          lastAutoUpdatedAt: ts,
          lastAutoUpdatedUrl: result.releaseUrl || "",
          failedVersion: "",
          failedReason: "",
          failedAt: ""
        });
      } else {
        updateAutoUpdateState(stateDir, {
          lastAutoUpdatedVersion: "",
          lastAutoUpdatedFrom: "",
          lastAutoUpdatedAt: "",
          lastAutoUpdatedUrl: "",
          failedVersion: "",
          failedReason: "",
          failedAt: ""
        });
      }
    }
    if (typeof onUpdated === "function") {
      _updateRestartScheduled = true;
      try {
        onUpdated(result);
      } catch {
        _updateRestartScheduled = false;
      }
    }
  }
  return {
    status: 200,
    body: result
  };
}

export function handleAutoUpdateAck(stateDir, rawData) {
  const data = rawData === undefined ? {} : rawData;
  if (!isPlainJsonObject(data)) {
    return {
      status: 400,
      body: { ok: false, error: "Request body must be a JSON object" }
    };
  }
  for (const key of Object.keys(data)) {
    if (!AUTO_UPDATE_ACK_ALLOWED_KEYS.has(key)) {
      return {
        status: 400,
        body: { ok: false, error: `Unexpected field '${key}' in request body` }
      };
    }
  }
  if (data.dismissNotice !== undefined && data.dismissNotice !== true) {
    return {
      status: 400,
      body: { ok: false, error: "Field 'dismissNotice' must be true" }
    };
  }
  if (stateDir) {
    updateAutoUpdateState(stateDir, {
      lastAutoUpdatedVersion: "",
      lastAutoUpdatedFrom: "",
      lastAutoUpdatedAt: "",
      lastAutoUpdatedUrl: ""
    });
  }
  return {
    status: 200,
    body: { ok: true, autoUpdateNotice: null }
  };
}

export async function runAutoUpdateCycle({
  stateDir = "",
  checker = null,
  updater = null,
  onUpdated = null,
  env = process.env,
  nowIso = null,
  currentVersion = null
} = {}) {
  if (_autoCycleInFlight) return _autoCycleInFlight;

  const task = (async () => {
    if (!isAutoUpdateCheckEnabled(stateDir, env)) {
      return { ok: true, action: "skipped", reason: "checkDisabled" };
    }
    const resolvedChecker = checker || getDefaultVersionChecker();
    const release = await resolvedChecker("auto");
    if (!isAutoUpdateInstallEnabled(stateDir, env)) {
      return { ok: true, action: "checked", release, autoInstallSkipped: "installDisabled" };
    }
    if (isPluginUpdateBusy()) {
      return { ok: true, action: "skipped", reason: "busy", release };
    }
    const settings = stateDir ? readSettings(stateDir) : null;
    const curVer =
      typeof currentVersion === "string" && currentVersion.trim()
        ? currentVersion.trim()
        : release?.currentVersion || readLocalVersion();
    const eligibility = evaluateAutoInstallEligibility({
      release,
      currentVersion: curVer,
      failedVersion: settings?.autoUpdateState?.failedVersion || ""
    });
    if (!eligibility.eligible) {
      return { ok: true, action: "checked", release, autoInstallSkipped: eligibility.skipReason };
    }

    const updOut = await handlePluginUpdate(
      { version: eligibility.targetVersion },
      { stateDir, updater, onUpdated, automatic: true, nowIso }
    );
    const updBody = updOut?.body;
    if (updBody?.status === "updated") {
      return { ok: true, action: "updated", result: updBody };
    }
    const failReason = updBody?.reason || "install";
    if (stateDir && !NON_CIRCUIT_AUTO_FAIL_REASONS.has(failReason)) {
      const ts = typeof nowIso === "string" && nowIso.trim() ? nowIso.trim() : new Date().toISOString();
      updateAutoUpdateState(stateDir, {
        failedVersion: eligibility.targetVersion,
        failedReason: failReason,
        failedAt: ts
      });
    }
    return { ok: false, action: "failed", result: updBody };
  })().finally(() => {
    _autoCycleInFlight = null;
  });

  _autoCycleInFlight = task;
  return task;
}

export function dispatchPanelApi(pathname, rawData, { stateDir, defaultConvId = "" } = {}) {
  if (pathname === "/api/star-prompt") {
    return handleStarPromptMutation(stateDir, rawData);
  }

  const data =
    rawData === undefined || rawData === null
      ? {}
      : typeof rawData === "object" && !Array.isArray(rawData)
        ? rawData
        : null;

  if (!data) {
    return {
      status: 400,
      body: { ok: false, error: "Request body must be a JSON object" }
    };
  }

  const convId =
    typeof data.conversationId === "string" && data.conversationId.trim()
      ? data.conversationId.trim()
      : defaultConvId;

  if (pathname === "/api/state") {
    return {
      status: 200,
      body: buildPanelStatePayload(stateDir, convId)
    };
  }

  if (pathname === "/api/settings") {
    try {
      updateSettings(stateDir, data, { markConfigured: true });
      return {
        status: 200,
        body: buildPanelStatePayload(stateDir, convId, { markStarTriggered: false })
      };
    } catch (err) {
      return {
        status: err?.statusCode || 400,
        body: { ok: false, error: err?.message || "Invalid settings payload" }
      };
    }
  }

  if (pathname === "/api/dismiss-onboarding") {
    updateSettings(
      stateDir,
      { configuredByUser: true, onboardingShown: true },
      { markConfigured: true }
    );
    return {
      status: 200,
      body: buildPanelStatePayload(stateDir, convId, { markStarTriggered: false })
    };
  }

  return {
    status: 404,
    body: { ok: false, error: "Not found" }
  };
}

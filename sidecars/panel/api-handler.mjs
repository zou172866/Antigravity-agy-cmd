import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { sanitizeConversationId } from "../../hooks/lib/common.mjs";
import {
  evaluateStarPrompt,
  formatRetrySummaryZh,
  readSettings,
  setStarPromptState,
  STAR_PROMPT_TERMINAL_STATES,
  updateSettings
} from "../../hooks/lib/settings.mjs";
import { readState } from "../../hooks/lib/state.mjs";

export const NO_STORE_HEADERS = Object.freeze({
  "Cache-Control": "no-store, no-cache, must-revalidate",
  "X-Content-Type-Options": "nosniff"
});

const LOCAL_HOST_RE = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/i;
const LOCAL_HTTP_ORIGIN_RE = /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/i;
const VSCODE_WEBVIEW_RE = /^vscode-webview:\/\/[a-z0-9._-]+(?:\/.*)?$/i;
const STAR_PROMPT_ALLOWED_KEYS = new Set(["state"]);
const STAR_PROMPT_ALLOWED_STATES = new Set(STAR_PROMPT_TERMINAL_STATES);

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

  return {
    ok: true,
    settings,
    starPrompt,
    summaryZh: formatRetrySummaryZh(settings),
    boostStatusZh:
      settings.planTier === "paid" && settings.boostEnabled
        ? "Pro/Ultra 会员 · 已开启 /boost 自动接入"
        : settings.planTier === "paid"
          ? "Pro/Ultra 会员 · 已手动关闭 /boost 提示"
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

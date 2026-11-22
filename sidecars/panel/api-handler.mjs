import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { sanitizeConversationId } from "../../hooks/lib/common.mjs";
import {
  formatRetrySummaryZh,
  readSettings,
  updateSettings
} from "../../hooks/lib/settings.mjs";
import { readState } from "../../hooks/lib/state.mjs";

export const NO_STORE_HEADERS = Object.freeze({
  "Cache-Control": "no-store, no-cache, must-revalidate",
  "X-Content-Type-Options": "nosniff"
});

const LOCAL_HOST_RE = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/i;
const LOCAL_ORIGIN_RE = /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/i;

export function isAllowedLocalRequest(req) {
  if (!req?.headers) return true;
  const host = String(req.headers.host || "").trim();
  if (host && !LOCAL_HOST_RE.test(host)) {
    return false;
  }

  const secFetchSite = String(req.headers["sec-fetch-site"] || "").trim().toLowerCase();
  if (secFetchSite && secFetchSite !== "same-origin" && secFetchSite !== "none") {
    return false;
  }

  const origin = String(req.headers.origin || "").trim();
  if (origin) {
    if (/^vscode-webview:\/\/[a-z0-9._-]+$/i.test(origin)) {
      return true;
    }
    if (!LOCAL_ORIGIN_RE.test(origin)) {
      return false;
    }
    if (host) {
      try {
        const oUrl = new URL(origin);
        const hUrl = new URL(`http://${host}`);
        if (oUrl.hostname.toLowerCase() !== hUrl.hostname.toLowerCase()) return false;
        if ((oUrl.port || "80") !== (hUrl.port || "80")) return false;
      } catch {
        return false;
      }
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

export function buildPanelStatePayload(stateDir, rawConvId = "") {
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

export function dispatchPanelApi(pathname, rawData, { stateDir, defaultConvId = "" } = {}) {
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
        body: buildPanelStatePayload(stateDir, convId)
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
      body: buildPanelStatePayload(stateDir, convId)
    };
  }

  return {
    status: 404,
    body: { ok: false, error: "Not found" }
  };
}
